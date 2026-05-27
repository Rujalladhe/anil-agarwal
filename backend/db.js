// SQLite + sqlite-vec setup. Single file at backend/data.db.
// - `resumes`        : one row per scored resume (raw text + AI review JSON)
// - `chunks`         : resume text split into retrieval-sized pieces
// - `chunk_vectors`  : sqlite-vec virtual table, embedding per chunk (rowid = chunks.id)
// - `chat_threads`   : conversations (resume_id NULL = "all resumes" thread)
// - `chat_messages`  : messages inside a thread
//
// Vector dimension is fixed at table-creation time. Default 768 matches
// Google text-embedding-004. If you change EMBED_DIM later you must drop
// the data.db file (or just the chunk_vectors table) and re-index.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, 'data.db');
const EMBED_DIM = Number(process.env.EMBED_DIM) || 768;

let _db;

export function getDb() {
  if (_db) return _db;

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Load the sqlite-vec extension. Throws if the platform binary is missing.
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS resumes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      email_id        TEXT,
      attachment_id   TEXT,
      filename        TEXT NOT NULL,
      candidate_name  TEXT,
      raw_text        TEXT NOT NULL,
      score           INTEGER,
      category        TEXT,
      role_title      TEXT,
      review_json     TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_resumes_unique_attachment
      ON resumes(email_id, attachment_id)
      WHERE email_id IS NOT NULL AND attachment_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS chunks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      resume_id    INTEGER NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
      chunk_index  INTEGER NOT NULL,
      text         TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_resume ON chunks(resume_id);

    CREATE TABLE IF NOT EXISTS chat_threads (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      resume_id   INTEGER REFERENCES resumes(id) ON DELETE CASCADE,
      title       TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id   INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_msgs_thread ON chat_messages(thread_id, id);
  `);

  // vec0 virtual table can only be created with a fixed dimension. Use
  // CREATE VIRTUAL TABLE IF NOT EXISTS so re-runs are no-ops.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
      embedding FLOAT[${EMBED_DIM}]
    );
  `);

  // --- Lightweight migrations for DBs created before category existed ----
  migrateAddColumnIfMissing(db, 'resumes', 'category', 'TEXT');
  migrateAddColumnIfMissing(db, 'resumes', 'role_title', 'TEXT');
  // Candidate detail columns (extracted by the AI / regex fallbacks)
  migrateAddColumnIfMissing(db, 'resumes', 'email', 'TEXT');
  migrateAddColumnIfMissing(db, 'resumes', 'phone', 'TEXT');
  migrateAddColumnIfMissing(db, 'resumes', 'location', 'TEXT');
  migrateAddColumnIfMissing(db, 'resumes', 'linkedin', 'TEXT');
  migrateAddColumnIfMissing(db, 'resumes', 'github', 'TEXT');
  migrateAddColumnIfMissing(db, 'resumes', 'portfolio', 'TEXT');
  migrateAddColumnIfMissing(db, 'resumes', 'current_title', 'TEXT');
  migrateAddColumnIfMissing(db, 'resumes', 'current_company', 'TEXT');
  migrateAddColumnIfMissing(db, 'resumes', 'years_experience', 'REAL');
  migrateAddColumnIfMissing(db, 'resumes', 'highest_education', 'TEXT');
  migrateAddColumnIfMissing(db, 'resumes', 'top_skills', 'TEXT');
  migrateAddColumnIfMissing(db, 'resumes', 'languages', 'TEXT');
  migrateAddColumnIfMissing(db, 'resumes', 'notice_period', 'TEXT');
  migrateAddColumnIfMissing(db, 'resumes', 'expected_salary', 'TEXT');
  // Path on disk to the original PDF/DOCX bytes (relative to backend/).
  migrateAddColumnIfMissing(db, 'resumes', 'file_path', 'TEXT');
  migrateAddColumnIfMissing(db, 'resumes', 'content_type', 'TEXT');

  // --- L2: enriched recruiter-grade columns ----------------------------------
  // All list/object fields stored as JSON strings.
  migrateAddColumnIfMissing(db, 'resumes', 'work_locations',   'TEXT');   // JSON array
  migrateAddColumnIfMissing(db, 'resumes', 'companies',        'TEXT');   // JSON array
  migrateAddColumnIfMissing(db, 'resumes', 'domains',          'TEXT');   // JSON array (lowercased)
  migrateAddColumnIfMissing(db, 'resumes', 'remote_worked',    'INTEGER');// 0/1
  migrateAddColumnIfMissing(db, 'resumes', 'remote_years',     'REAL');
  migrateAddColumnIfMissing(db, 'resumes', 'remote_evidence',  'TEXT');
  migrateAddColumnIfMissing(db, 'resumes', 'managed_people',   'INTEGER');// 0/1
  migrateAddColumnIfMissing(db, 'resumes', 'team_size_managed','INTEGER');
  migrateAddColumnIfMissing(db, 'resumes', 'open_to_relocate', 'INTEGER');// 0/1
  migrateAddColumnIfMissing(db, 'resumes', 'education_json',   'TEXT');   // JSON array
  migrateAddColumnIfMissing(db, 'resumes', 'certifications',   'TEXT');   // JSON array
  migrateAddColumnIfMissing(db, 'resumes', 'publications',     'INTEGER');// 0/1

  // Indexes that depend on migrated columns -- create AFTER migrations.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_resumes_category_score
      ON resumes(category, score DESC);
    CREATE INDEX IF NOT EXISTS idx_resumes_remote
      ON resumes(remote_worked);
  `);

  // --- L4: FTS5 over chunk text for BM25/keyword retrieval ------------------
  // External-content FTS5 table mirrors `chunks` via triggers. CRITICAL: use
  // CREATE TRIGGER IF NOT EXISTS, never DROP+CREATE -- dropping triggers on
  // every connect mutates the schema cookie. If two processes (server + a
  // script) both reconnect, FTS5's internal index goes out of sync with the
  // data and SQLite reports "database disk image is malformed". With IF NOT
  // EXISTS the triggers are created exactly once and survive forever.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      content='chunks',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
  `);

  // First-run backfill + drift-repair. If FTS row count diverges from the
  // chunks table, rebuild the index. The rebuild operation is built into
  // FTS5 for exactly this situation -- it re-reads `chunks` and re-emits
  // every term, fixing any "malformed" state from earlier mishaps.
  try {
    const ftsCount = db.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get().n;
    const chunkCount = db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
    if (ftsCount === 0 && chunkCount > 0) {
      db.exec(`INSERT INTO chunks_fts(rowid, text) SELECT id, text FROM chunks`);
    } else if (ftsCount !== chunkCount) {
      console.warn(`[db] FTS5 drift detected (${ftsCount} fts rows vs ${chunkCount} chunks). Rebuilding...`);
      db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`);
    }
  } catch (err) {
    // Likely "database disk image is malformed" from a prior race. Hard
    // reset the FTS5 index from chunks -- safe, doesn't touch resumes /
    // chunks / vectors / chats.
    console.warn(`[db] FTS5 check failed (${err.message}); hard-resetting chunks_fts.`);
    db.exec(`DROP TABLE IF EXISTS chunks_fts`);
    db.exec(`
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        text,
        content='chunks',
        content_rowid='id',
        tokenize='porter unicode61'
      );
      INSERT INTO chunks_fts(rowid, text) SELECT id, text FROM chunks;
    `);
  }

  _db = db;
  return db;
}

function migrateAddColumnIfMissing(db, table, column, typeDecl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDecl}`);
  }
}

// Float32 array -> Buffer that sqlite-vec accepts as a vector blob.
export function floatsToBlob(arr) {
  return Buffer.from(new Float32Array(arr).buffer);
}

// ---------------------------------------------------------------------------
// Resume CRUD

export function insertResume({
  emailId, attachmentId, filename, candidateName, rawText, score, category, roleTitle, reviewJson,
  candidate, filePath, contentType
}) {
  const db = getDb();
  const c = candidate || {};
  const topSkillsJson    = Array.isArray(c.topSkills)     ? JSON.stringify(c.topSkills)     : null;
  const languagesJson    = Array.isArray(c.languages)     ? JSON.stringify(c.languages)     : null;
  const workLocsJson     = Array.isArray(c.workLocations) ? JSON.stringify(c.workLocations) : null;
  const companiesJson    = Array.isArray(c.companies)     ? JSON.stringify(c.companies)     : null;
  const domainsJson      = Array.isArray(c.domains)       ? JSON.stringify(c.domains)       : null;
  const educationJson    = Array.isArray(c.education)     ? JSON.stringify(c.education)     : null;
  const certsJson        = Array.isArray(c.certifications)? JSON.stringify(c.certifications): null;
  const rem              = c.remoteExperience || {};
  const remoteWorked     = (rem.worked === true) ? 1 : (rem.worked === false ? 0 : null);
  const remoteYears      = Number.isFinite(Number(rem.years)) ? Number(rem.years) : null;
  const remoteEvidence   = rem.evidence ? String(rem.evidence) : null;
  const managedPeopleInt = (c.managedPeople  === true) ? 1 : (c.managedPeople  === false ? 0 : null);
  const openToRelocInt   = (c.openToRelocate === true) ? 1 : (c.openToRelocate === false ? 0 : null);
  const publicationsInt  = (c.publications   === true) ? 1 : (c.publications   === false ? 0 : null);
  const teamSize         = Number.isFinite(Number(c.teamSizeManaged)) ? Number(c.teamSizeManaged) : null;

  // Upsert: if (email_id, attachment_id) collide, return the existing id.
  const existing = (emailId && attachmentId)
    ? db.prepare('SELECT id FROM resumes WHERE email_id = ? AND attachment_id = ?').get(emailId, attachmentId)
    : null;
  if (existing) {
    db.prepare(`
      UPDATE resumes
      SET category          = COALESCE(?, category),
          role_title        = COALESCE(?, role_title),
          score             = COALESCE(?, score),
          review_json       = ?,
          candidate_name    = COALESCE(?, candidate_name),
          email             = COALESCE(?, email),
          phone             = COALESCE(?, phone),
          location          = COALESCE(?, location),
          linkedin          = COALESCE(?, linkedin),
          github            = COALESCE(?, github),
          portfolio         = COALESCE(?, portfolio),
          current_title     = COALESCE(?, current_title),
          current_company   = COALESCE(?, current_company),
          years_experience  = COALESCE(?, years_experience),
          highest_education = COALESCE(?, highest_education),
          top_skills        = COALESCE(?, top_skills),
          languages         = COALESCE(?, languages),
          notice_period     = COALESCE(?, notice_period),
          expected_salary   = COALESCE(?, expected_salary),
          file_path         = COALESCE(?, file_path),
          content_type      = COALESCE(?, content_type),
          work_locations    = COALESCE(?, work_locations),
          companies         = COALESCE(?, companies),
          domains           = COALESCE(?, domains),
          remote_worked     = COALESCE(?, remote_worked),
          remote_years      = COALESCE(?, remote_years),
          remote_evidence   = COALESCE(?, remote_evidence),
          managed_people    = COALESCE(?, managed_people),
          team_size_managed = COALESCE(?, team_size_managed),
          open_to_relocate  = COALESCE(?, open_to_relocate),
          education_json    = COALESCE(?, education_json),
          certifications    = COALESCE(?, certifications),
          publications      = COALESCE(?, publications)
      WHERE id = ?
    `).run(
      category || null, roleTitle || null,
      Number.isFinite(score) ? score : null,
      JSON.stringify(reviewJson),
      candidateName || c.name || null,
      c.email || null, c.phone || null, c.location || null,
      c.linkedin || null, c.github || null, c.portfolio || null,
      c.currentTitle || null, c.currentCompany || null,
      Number.isFinite(c.yearsExperience) ? c.yearsExperience : null,
      c.highestEducation || null,
      topSkillsJson, languagesJson,
      c.noticePeriod || null, c.expectedSalary || null,
      filePath || null, contentType || null,
      workLocsJson, companiesJson, domainsJson,
      remoteWorked, remoteYears, remoteEvidence,
      managedPeopleInt, teamSize, openToRelocInt,
      educationJson, certsJson, publicationsInt,
      existing.id
    );
    return { id: existing.id, isNew: false };
  }

  const info = db.prepare(`
    INSERT INTO resumes
      (email_id, attachment_id, filename, candidate_name, raw_text, score, category, role_title, review_json, created_at,
       email, phone, location, linkedin, github, portfolio,
       current_title, current_company, years_experience, highest_education,
       top_skills, languages, notice_period, expected_salary,
       file_path, content_type,
       work_locations, companies, domains,
       remote_worked, remote_years, remote_evidence,
       managed_people, team_size_managed, open_to_relocate,
       education_json, certifications, publications)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?)
  `).run(
    emailId || null,
    attachmentId || null,
    filename,
    candidateName || c.name || null,
    rawText,
    Number.isFinite(score) ? score : null,
    category || null,
    roleTitle || null,
    JSON.stringify(reviewJson),
    Date.now(),
    c.email || null, c.phone || null, c.location || null,
    c.linkedin || null, c.github || null, c.portfolio || null,
    c.currentTitle || null, c.currentCompany || null,
    Number.isFinite(c.yearsExperience) ? c.yearsExperience : null,
    c.highestEducation || null,
    topSkillsJson, languagesJson,
    c.noticePeriod || null, c.expectedSalary || null,
    filePath || null, contentType || null,
    workLocsJson, companiesJson, domainsJson,
    remoteWorked, remoteYears, remoteEvidence,
    managedPeopleInt, teamSize, openToRelocInt,
    educationJson, certsJson, publicationsInt
  );
  return { id: Number(info.lastInsertRowid), isNew: true };
}

export function listResumes() {
  return getDb().prepare(`
    SELECT id, filename, candidate_name, score, category, role_title, created_at
    FROM resumes
    ORDER BY created_at DESC
  `).all();
}

// Returns resumes grouped by category, each group sorted by score DESC.
// Shape: [ { category, label, resumes: [...] }, ... ]
// Categories are emitted in a fixed display order; empty ones are skipped.
export function listResumesByCategory() {
  const CATEGORY_ORDER = [
    'frontend','backend','fullstack','mobile','data','ml-ai',
    'devops','security','qa','design','product',
    'marketing','sales','hr','other', null
  ];
  const CATEGORY_LABELS = {
    frontend: 'Frontend', backend: 'Backend', fullstack: 'Full-stack',
    mobile: 'Mobile', data: 'Data', 'ml-ai': 'ML / AI',
    devops: 'DevOps / SRE', security: 'Security', qa: 'QA / Test',
    design: 'Design', product: 'Product', marketing: 'Marketing',
    sales: 'Sales', hr: 'HR', other: 'Other', null: 'Uncategorized'
  };

  const rows = getDb().prepare(`
    SELECT id, filename, candidate_name, score, category, role_title, created_at
    FROM resumes
    ORDER BY COALESCE(score, 0) DESC, created_at DESC
  `).all();

  const buckets = new Map();
  for (const r of rows) {
    const key = r.category || null;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }

  const groups = [];
  for (const cat of CATEGORY_ORDER) {
    if (!buckets.has(cat)) continue;
    groups.push({
      category: cat,
      label: CATEGORY_LABELS[cat],
      count: buckets.get(cat).length,
      resumes: buckets.get(cat)
    });
  }
  return groups;
}

export function getResume(id) {
  const row = getDb().prepare('SELECT * FROM resumes WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, review: JSON.parse(row.review_json) };
}

// Full rows for spreadsheet export. Returns rows in score-desc order so the
// exported sheet ranks candidates from best to worst.
export function listResumesForExport() {
  const rows = getDb().prepare(`
    SELECT id, filename, candidate_name, score, category, role_title, created_at,
           email, phone, location, linkedin, github, portfolio,
           current_title, current_company, years_experience, highest_education,
           top_skills, languages, notice_period, expected_salary,
           file_path, content_type, email_id
    FROM resumes
    ORDER BY COALESCE(score, 0) DESC, created_at DESC
  `).all();
  return rows.map((r) => ({
    ...r,
    top_skills: safeJsonParse(r.top_skills) || [],
    languages: safeJsonParse(r.languages) || []
  }));
}

function safeJsonParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export function getResumeSummaries(ids) {
  if (!ids || ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return getDb().prepare(`
    SELECT id, filename, candidate_name, score, review_json
    FROM resumes WHERE id IN (${placeholders})
  `).all(...ids).map((r) => ({
    id: r.id, filename: r.filename, candidate_name: r.candidate_name, score: r.score,
    review: JSON.parse(r.review_json)
  }));
}

export function getAllResumesForChat() {
  return getDb().prepare(`
    SELECT id, filename, candidate_name, score, review_json
    FROM resumes
  `).all().map((r) => ({
    id: r.id, filename: r.filename, candidate_name: r.candidate_name, score: r.score,
    review: JSON.parse(r.review_json)
  }));
}

// ---------------------------------------------------------------------------
// Chunk + vector insertion (called as one transaction per resume)

export function replaceChunksForResume(resumeId, chunksWithEmbeddings) {
  const db = getDb();
  const deleteOldChunks = db.prepare('DELETE FROM chunks WHERE resume_id = ?');
  const deleteOldVectors = db.prepare(`
    DELETE FROM chunk_vectors WHERE rowid IN (SELECT id FROM chunks WHERE resume_id = ?)
  `);
  const insertChunk = db.prepare(`
    INSERT INTO chunks (resume_id, chunk_index, text) VALUES (?, ?, ?)
  `);
  const insertVector = db.prepare(`
    INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)
  `);

  const tx = db.transaction((rid, items) => {
    deleteOldVectors.run(rid);
    deleteOldChunks.run(rid);
    for (let i = 0; i < items.length; i++) {
      const { text, embedding } = items[i];
      const info = insertChunk.run(rid, i, text);
      // sqlite-vec's vec0 virtual table only accepts INTEGER-typed bindings
      // for rowid. better-sqlite3 binds JS Number as REAL here, which vec0
      // rejects ("Only integers are allows ... on chunk_vectors"). BigInt
      // forces SQLITE_INTEGER binding.
      insertVector.run(BigInt(info.lastInsertRowid), floatsToBlob(embedding));
    }
  });
  tx(resumeId, chunksWithEmbeddings);
}

// ---------------------------------------------------------------------------
// Vector search
//
// We use a plain join with vec_distance_cosine. sqlite-vec also supports
// `WHERE embedding MATCH ? AND k = ?` for ANN, but that path doesn't
// compose cleanly with a resume_id filter. At MVP scale (<10k chunks) a
// full scan is well under 100ms.

export function searchChunks({ queryEmbedding, topK = 8, resumeId = null }) {
  const db = getDb();
  const blob = floatsToBlob(queryEmbedding);

  if (resumeId != null) {
    return db.prepare(`
      SELECT
        c.id           AS chunk_id,
        c.resume_id    AS resume_id,
        c.chunk_index  AS chunk_index,
        c.text         AS text,
        r.candidate_name, r.filename, r.score,
        vec_distance_cosine(v.embedding, ?) AS distance
      FROM chunk_vectors v
      JOIN chunks  c ON c.id = v.rowid
      JOIN resumes r ON r.id = c.resume_id
      WHERE c.resume_id = ?
      ORDER BY distance ASC
      LIMIT ?
    `).all(blob, resumeId, topK);
  }

  return db.prepare(`
    SELECT
      c.id           AS chunk_id,
      c.resume_id    AS resume_id,
      c.chunk_index  AS chunk_index,
      c.text         AS text,
      r.candidate_name, r.filename, r.score,
      vec_distance_cosine(v.embedding, ?) AS distance
    FROM chunk_vectors v
    JOIN chunks  c ON c.id = v.rowid
    JOIN resumes r ON r.id = c.resume_id
    ORDER BY distance ASC
    LIMIT ?
  `).all(blob, topK);
}

// ---------------------------------------------------------------------------
// BM25 / keyword search over chunks (L4). FTS5 MATCH on the porter-tokenized
// virtual table. Returns the same shape as searchChunks() so the merger can
// treat both result sets uniformly.

export function searchChunksBM25({ query, topK = 10, resumeId = null }) {
  if (!query || !query.trim()) return [];
  const db = getDb();
  const ftsQuery = ftsSafeQuery(query);
  if (!ftsQuery) return [];

  if (resumeId != null) {
    return db.prepare(`
      SELECT
        c.id           AS chunk_id,
        c.resume_id    AS resume_id,
        c.chunk_index  AS chunk_index,
        c.text         AS text,
        r.candidate_name, r.filename, r.score,
        bm25(chunks_fts) AS rank_score
      FROM chunks_fts
      JOIN chunks  c ON c.id = chunks_fts.rowid
      JOIN resumes r ON r.id = c.resume_id
      WHERE chunks_fts MATCH ? AND c.resume_id = ?
      ORDER BY rank_score ASC
      LIMIT ?
    `).all(ftsQuery, resumeId, topK);
  }

  return db.prepare(`
    SELECT
      c.id           AS chunk_id,
      c.resume_id    AS resume_id,
      c.chunk_index  AS chunk_index,
      c.text         AS text,
      r.candidate_name, r.filename, r.score,
      bm25(chunks_fts) AS rank_score
    FROM chunks_fts
    JOIN chunks  c ON c.id = chunks_fts.rowid
    JOIN resumes r ON r.id = c.resume_id
    WHERE chunks_fts MATCH ?
    ORDER BY rank_score ASC
    LIMIT ?
  `).all(ftsQuery, topK);
}

// FTS5's query syntax has reserved characters (* " : ( ) etc) that throw
// "fts5: syntax error" if passed raw. Strip them, split on whitespace, drop
// stopword-y short tokens, and OR the rest together. Returns '' if nothing
// useful remains -- caller treats as "no BM25 hits".
function ftsSafeQuery(q) {
  const tokens = String(q)
    .toLowerCase()
    .replace(/[^a-z0-9\s+#./-]/g, ' ')   // keep letters/digits + a few skill-y chars
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .filter((t) => !FTS_STOPWORDS.has(t))
    .slice(0, 12);                        // cap to keep query small
  if (tokens.length === 0) return '';
  // Quote each token so things like "node.js" don't trip the parser.
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

const FTS_STOPWORDS = new Set([
  'a','an','the','and','or','but','of','for','with','to','in','on','at','by',
  'is','are','was','were','be','been','being','i','me','my','we','our','you',
  'who','whom','that','this','these','those','it','its','as','from','do','does',
  'did','have','has','had','can','could','should','would','will','show','find',
  'give','list','need','want','one','someone','person','people','candidate',
  'candidates','resume','resumes','please','any','about','tell','what','which',
  'where','how','many','some','more','less','than','then','also','etc'
]);

// Returns the FULL enriched profile for a set of resumes. Used by chat to
// inject structured data into the LLM context alongside retrieved chunks.
export function getResumeProfiles(ids) {
  if (!ids || ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return getDb().prepare(`
    SELECT id, filename, candidate_name, score, category, role_title,
           email, phone, location, linkedin, github, portfolio,
           current_title, current_company, years_experience, highest_education,
           top_skills, languages, notice_period, expected_salary,
           work_locations, companies, domains,
           remote_worked, remote_years, remote_evidence,
           managed_people, team_size_managed, open_to_relocate,
           education_json, certifications, publications,
           review_json
    FROM resumes WHERE id IN (${placeholders})
  `).all(...ids).map(decodeProfile);
}

function decodeProfile(r) {
  if (!r) return r;
  return {
    ...r,
    top_skills:     safeJsonParse(r.top_skills) || [],
    languages:      safeJsonParse(r.languages) || [],
    work_locations: safeJsonParse(r.work_locations) || [],
    companies:      safeJsonParse(r.companies) || [],
    domains:        safeJsonParse(r.domains) || [],
    education:      safeJsonParse(r.education_json) || [],
    certifications: safeJsonParse(r.certifications) || [],
    remote_worked:    r.remote_worked === 1,
    managed_people:   r.managed_people === 1,
    open_to_relocate: r.open_to_relocate === 1,
    publications:     r.publications === 1,
    review:           safeJsonParse(r.review_json) || null
  };
}

// ---------------------------------------------------------------------------
// Chat threads + messages

export function createThread({ resumeId = null, title = null }) {
  const info = getDb().prepare(`
    INSERT INTO chat_threads (resume_id, title, created_at) VALUES (?, ?, ?)
  `).run(resumeId, title, Date.now());
  return Number(info.lastInsertRowid);
}

export function listThreads() {
  return getDb().prepare(`
    SELECT
      t.id, t.resume_id, t.title, t.created_at,
      r.candidate_name, r.filename,
      (SELECT content FROM chat_messages WHERE thread_id = t.id ORDER BY id DESC LIMIT 1) AS last_message
    FROM chat_threads t
    LEFT JOIN resumes r ON r.id = t.resume_id
    ORDER BY t.created_at DESC
  `).all();
}

export function getThread(id) {
  return getDb().prepare(`
    SELECT t.*, r.candidate_name, r.filename
    FROM chat_threads t
    LEFT JOIN resumes r ON r.id = t.resume_id
    WHERE t.id = ?
  `).get(id);
}

export function appendMessage({ threadId, role, content }) {
  const info = getDb().prepare(`
    INSERT INTO chat_messages (thread_id, role, content, created_at) VALUES (?, ?, ?, ?)
  `).run(threadId, role, content, Date.now());
  return Number(info.lastInsertRowid);
}

export function getMessages(threadId, { limit = 50 } = {}) {
  return getDb().prepare(`
    SELECT id, role, content, created_at FROM chat_messages
    WHERE thread_id = ?
    ORDER BY id ASC
    LIMIT ?
  `).all(threadId, limit);
}

export function setThreadTitle(threadId, title) {
  getDb().prepare('UPDATE chat_threads SET title = ? WHERE id = ?').run(title, threadId);
}
