// MongoDB data layer (source of truth). Pinecone is the only vector store.
//
// Collections:
// - resumes        : one doc per scored resume (raw text + decoded review object)
// - chunks         : resume text split into retrieval-sized pieces (_id = chunk id,
//                    which is also the Pinecone vector id). Embeddings live ONLY
//                    in Pinecone; this collection holds the text for hydration +
//                    the $text (BM25) index.
// - chat_threads   : conversations (resume_id null = "all resumes" thread)
// - chat_messages  : messages inside a thread
//
// Every exported function is async (the Mongo driver is async-only). Numeric ids
// come from nextId() so they stay sequential integers.

import { getMongoDb, nextId } from './mongo.js';
import { deleteResumeVectors as pineconeDeleteResume } from './pinecone.js';

// ---------------------------------------------------------------------------
// Resume CRUD

// Field sets used to give INSERTs the same default shape the old SQLite->Mongo
// mirror produced (missing arrays -> [], missing booleans -> false, else null).
const RESUME_ARRAY_FIELDS = new Set([
  'top_skills', 'languages', 'work_locations', 'companies', 'domains', 'education', 'certifications'
]);
const RESUME_BOOL_FIELDS = new Set([
  'remote_worked', 'managed_people', 'open_to_relocate', 'publications'
]);

// Build the decoded candidate/review field map from insertResume args. A value
// of `undefined` means "not provided" -> skipped on update (COALESCE semantics).
function resumeFieldsFromArgs(args) {
  const c = args.candidate || {};
  const rem = c.remoteExperience || {};
  const arr  = (x) => (Array.isArray(x) ? x : undefined);
  const num  = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : undefined);
  const str  = (x) => (x ? x : undefined);
  const bool = (x) => (x === true ? true : x === false ? false : undefined);

  return {
    candidate_name:    str(args.candidateName || c.name),
    category:          str(args.category),
    role_title:        str(args.roleTitle),
    score:             num(args.score),
    email:             str(c.email),
    phone:             str(c.phone),
    location:          str(c.location),
    linkedin:          str(c.linkedin),
    github:            str(c.github),
    portfolio:         str(c.portfolio),
    current_title:     str(c.currentTitle),
    current_company:   str(c.currentCompany),
    years_experience:  num(c.yearsExperience),
    highest_education: str(c.highestEducation),
    top_skills:        arr(c.topSkills),
    languages:         arr(c.languages),
    notice_period:     str(c.noticePeriod),
    expected_salary:   str(c.expectedSalary),
    file_path:         str(args.filePath),
    content_type:      str(args.contentType),
    work_locations:    arr(c.workLocations),
    companies:         arr(c.companies),
    domains:           arr(c.domains),
    remote_worked:     bool(rem.worked),
    remote_years:      num(rem.years),
    remote_evidence:   rem.evidence ? String(rem.evidence) : undefined,
    managed_people:    bool(c.managedPeople),
    team_size_managed: num(c.teamSizeManaged),
    open_to_relocate:  bool(c.openToRelocate),
    education:         arr(c.education),
    certifications:    arr(c.certifications),
    publications:      bool(c.publications)
  };
}

function buildInsertDoc(id, args, fields, review) {
  const doc = {
    _id: id,
    id,
    email_id:      args.emailId || null,
    attachment_id: args.attachmentId || null,
    filename:      args.filename,
    raw_text:      args.rawText,
    created_at:    Date.now(),
    review:        review ?? null
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) doc[k] = v;
    else if (RESUME_ARRAY_FIELDS.has(k)) doc[k] = [];
    else if (RESUME_BOOL_FIELDS.has(k)) doc[k] = false;
    else doc[k] = null;
  }
  return doc;
}

function buildUpdateSet(fields, review) {
  // review is ALWAYS overwritten (matches the old `review_json = ?`); every
  // other field follows COALESCE — only overwrite when a value was provided.
  const $set = { review: review ?? null };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) $set[k] = v;
  }
  return $set;
}

export async function insertResume(args) {
  const db = await getMongoDb();
  const fields = resumeFieldsFromArgs(args);
  const review = args.reviewJson;
  const hasKey = Boolean(args.emailId && args.attachmentId);

  // Upsert on (email_id, attachment_id): same message+attachment = same bytes,
  // so we update the existing row rather than create a duplicate.
  if (hasKey) {
    const existing = await db.collection('resumes').findOne(
      { email_id: args.emailId, attachment_id: args.attachmentId },
      { projection: { _id: 1 } }
    );
    if (existing) {
      await db.collection('resumes').updateOne({ _id: existing._id }, { $set: buildUpdateSet(fields, review) });
      return { id: existing._id, isNew: false };
    }
  }

  const id = await nextId('resumes');
  const doc = buildInsertDoc(id, args, fields, review);
  try {
    await db.collection('resumes').insertOne(doc);
    return { id, isNew: true };
  } catch (err) {
    // Race: a concurrent insert of the same attachment hit the unique index
    // between our findOne and insertOne. Fall back to update.
    if (err && err.code === 11000 && hasKey) {
      const ex = await db.collection('resumes').findOne(
        { email_id: args.emailId, attachment_id: args.attachmentId },
        { projection: { _id: 1 } }
      );
      if (ex) {
        await db.collection('resumes').updateOne({ _id: ex._id }, { $set: buildUpdateSet(fields, review) });
        return { id: ex._id, isNew: false };
      }
    }
    throw err;
  }
}

export async function deleteResume(id) {
  const db = await getMongoDb();
  const rid = Number(id);
  const res = await db.collection('resumes').deleteOne({ _id: rid });
  // Drop this resume's chunks (text lives in Mongo now).
  await db.collection('chunks').deleteMany({ resume_id: rid });
  // Cascade chat: messages are keyed by thread_id (not resume_id), so resolve
  // the resume's threads first, then delete their messages and the threads.
  const threads = await db.collection('chat_threads').find({ resume_id: rid }, { projection: { _id: 1 } }).toArray();
  const threadIds = threads.map((t) => t._id);
  if (threadIds.length) {
    await db.collection('chat_messages').deleteMany({ thread_id: { $in: threadIds } });
    await db.collection('chat_threads').deleteMany({ _id: { $in: threadIds } });
  }
  // Pinecone vectors: best-effort. A stale vector is harmless — hydration joins
  // back to `chunks` by id and drops any id with no chunk doc.
  pineconeDeleteResume(rid).catch(() => {});
  return res.deletedCount;
}

const RESUME_LIST_PROJECTION = {
  _id: 0, id: 1, filename: 1, candidate_name: 1, score: 1, category: 1, role_title: 1, created_at: 1
};

export async function listResumes() {
  const db = await getMongoDb();
  return db.collection('resumes')
    .find({}, { projection: RESUME_LIST_PROJECTION })
    .sort({ created_at: -1 })
    .toArray();
}

// Returns resumes grouped by category, each group sorted by score DESC.
const CATEGORY_ORDER = [
  'frontend', 'backend', 'fullstack', 'mobile', 'data', 'ml-ai',
  'devops', 'security', 'qa', 'design', 'product',
  'marketing', 'sales', 'hr', 'other', null
];
const CATEGORY_LABELS = {
  frontend: 'Frontend', backend: 'Backend', fullstack: 'Full-stack',
  mobile: 'Mobile', data: 'Data', 'ml-ai': 'ML / AI',
  devops: 'DevOps / SRE', security: 'Security', qa: 'QA / Test',
  design: 'Design', product: 'Product', marketing: 'Marketing',
  sales: 'Sales', hr: 'HR', other: 'Other', null: 'Uncategorized'
};

export async function listResumesByCategory() {
  const db = await getMongoDb();
  const rows = await db.collection('resumes')
    .find({}, { projection: RESUME_LIST_PROJECTION })
    .toArray();
  // Sort by score desc (treating missing as 0), then created_at desc.
  rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.created_at ?? 0) - (a.created_at ?? 0));

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

export async function getResume(id) {
  const db = await getMongoDb();
  const row = await db.collection('resumes').findOne({ _id: Number(id) });
  if (!row) return null;
  return { ...row, review: row.review || null };
}

// Cache-lookup for /score: same (email_id, attachment_id) means same bytes, so
// the prior AI review is still valid (skips the expensive LLM call).
export async function getResumeByEmailAttachment(emailId, attachmentId) {
  if (!emailId || !attachmentId) return null;
  const db = await getMongoDb();
  const row = await db.collection('resumes').findOne({ email_id: emailId, attachment_id: attachmentId });
  if (!row) return null;
  return { ...row, review: row.review || null };
}

// Full rows for spreadsheet export, score-desc. Projects review + raw_text too
// so the export route doesn't need a per-row getResume() (avoids an N+1).
export async function listResumesForExport() {
  const db = await getMongoDb();
  const rows = await db.collection('resumes').find({}, {
    projection: {
      _id: 0, id: 1, filename: 1, candidate_name: 1, score: 1, category: 1, role_title: 1, created_at: 1,
      email: 1, phone: 1, location: 1, linkedin: 1, github: 1, portfolio: 1,
      current_title: 1, current_company: 1, years_experience: 1, highest_education: 1,
      top_skills: 1, languages: 1, notice_period: 1, expected_salary: 1,
      file_path: 1, content_type: 1, email_id: 1, raw_text: 1, review: 1
    }
  }).toArray();
  rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.created_at ?? 0) - (a.created_at ?? 0));
  return rows.map((r) => ({
    ...r,
    top_skills: Array.isArray(r.top_skills) ? r.top_skills : [],
    languages: Array.isArray(r.languages) ? r.languages : []
  }));
}

export async function getResumeSummaries(ids) {
  if (!ids || ids.length === 0) return [];
  const db = await getMongoDb();
  const rows = await db.collection('resumes')
    .find({ _id: { $in: ids.map(Number) } },
      { projection: { _id: 0, id: 1, filename: 1, candidate_name: 1, score: 1, review: 1 } })
    .toArray();
  return rows.map((r) => ({
    id: r.id, filename: r.filename, candidate_name: r.candidate_name, score: r.score,
    review: r.review || null
  }));
}

export async function getAllResumesForChat() {
  const db = await getMongoDb();
  const rows = await db.collection('resumes')
    .find({}, { projection: { _id: 0, id: 1, filename: 1, candidate_name: 1, score: 1, review: 1 } })
    .toArray();
  return rows.map((r) => ({
    id: r.id, filename: r.filename, candidate_name: r.candidate_name, score: r.score,
    review: r.review || null
  }));
}

// Full enriched profiles for a set of resumes (chat context). Docs are already
// in the decoded shape (arrays/booleans/review object).
export async function getResumeProfiles(ids) {
  if (!ids || ids.length === 0) return [];
  const db = await getMongoDb();
  const rows = await db.collection('resumes').find({ _id: { $in: ids.map(Number) } }).toArray();
  return rows.map((r) => ({ ...r, review: r.review || null }));
}

// ---------------------------------------------------------------------------
// Chunk insertion. Embeddings go to Pinecone (handled in rag.js); this stores
// the text + ids. Returns the chunk ids so the caller can mirror them into
// Pinecone as vector ids.

export async function replaceChunksForResume(resumeId, items) {
  const db = await getMongoDb();
  const rid = Number(resumeId);
  await db.collection('chunks').deleteMany({ resume_id: rid });
  const chunkIds = [];
  const docs = [];
  for (let i = 0; i < items.length; i++) {
    const id = await nextId('chunks');
    chunkIds.push(id);
    docs.push({ _id: id, id, resume_id: rid, chunk_index: i, text: items[i].text });
  }
  if (docs.length) await db.collection('chunks').insertMany(docs);
  return chunkIds;
}

// Hydrate chunk rows by id, preserving the input order (Pinecone rank). Any id
// with no chunk doc is dropped (orphan filter).
export async function hydrateChunksByIds(orderedIds) {
  if (!orderedIds || orderedIds.length === 0) return [];
  const db = await getMongoDb();
  const ids = orderedIds.map(Number);
  const rows = await db.collection('chunks').aggregate([
    { $match: { _id: { $in: ids } } },
    { $lookup: { from: 'resumes', localField: 'resume_id', foreignField: '_id', as: '_r' } },
    { $addFields: { _r: { $arrayElemAt: ['$_r', 0] } } },
    { $project: {
        _id: 0, chunk_id: '$_id', resume_id: 1, chunk_index: 1, text: 1,
        candidate_name: '$_r.candidate_name', filename: '$_r.filename', score: '$_r.score'
      } }
  ]).toArray();
  const byId = new Map(rows.map((r) => [r.chunk_id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// BM25 / keyword search over chunks via Mongo's $text index. Returns the same
// shape as hydrateChunksByIds() so the RRF merger treats both signals uniformly.

export async function searchChunksBM25({ query, topK = 10, resumeId = null }) {
  if (!query || !query.trim()) return [];
  const terms = mongoTextQuery(query);
  if (!terms) return [];
  const db = await getMongoDb();
  const match = { $text: { $search: terms } };
  if (resumeId != null) match.resume_id = Number(resumeId);
  return db.collection('chunks').aggregate([
    { $match: match },
    { $addFields: { _score: { $meta: 'textScore' } } },
    { $sort: { _score: -1 } },
    { $limit: topK },
    { $lookup: { from: 'resumes', localField: 'resume_id', foreignField: '_id', as: '_r' } },
    { $addFields: { _r: { $arrayElemAt: ['$_r', 0] } } },
    { $project: {
        _id: 0, chunk_id: '$_id', resume_id: 1, chunk_index: 1, text: 1,
        candidate_name: '$_r.candidate_name', filename: '$_r.filename', score: '$_r.score'
      } }
  ]).toArray();
}

// Tokenize a free-text query into bare terms for Mongo $text (which ORs
// space-separated terms). Strips reserved chars, drops short/stopword tokens.
// Returns '' if nothing useful remains.
function mongoTextQuery(q) {
  const tokens = String(q)
    .toLowerCase()
    .replace(/[^a-z0-9\s+#./-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .filter((t) => !FTS_STOPWORDS.has(t))
    .slice(0, 12);
  return tokens.join(' ');
}

const FTS_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'for', 'with', 'to', 'in', 'on', 'at', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'i', 'me', 'my', 'we', 'our', 'you',
  'who', 'whom', 'that', 'this', 'these', 'those', 'it', 'its', 'as', 'from', 'do', 'does',
  'did', 'have', 'has', 'had', 'can', 'could', 'should', 'would', 'will', 'show', 'find',
  'give', 'list', 'need', 'want', 'one', 'someone', 'person', 'people', 'candidate',
  'candidates', 'resume', 'resumes', 'please', 'any', 'about', 'tell', 'what', 'which',
  'where', 'how', 'many', 'some', 'more', 'less', 'than', 'then', 'also', 'etc'
]);

// ---------------------------------------------------------------------------
// Chat threads + messages

export async function createThread({ resumeId = null, title = null }) {
  const db = await getMongoDb();
  const id = await nextId('chat_threads');
  const created_at = Date.now();
  await db.collection('chat_threads').insertOne({
    _id: id, id, resume_id: resumeId == null ? null : Number(resumeId), title, created_at
  });
  return id;
}

export async function deleteThread(id) {
  const db = await getMongoDb();
  const tid = Number(id);
  const res = await db.collection('chat_threads').deleteOne({ _id: tid });
  await db.collection('chat_messages').deleteMany({ thread_id: tid });
  return res.deletedCount;
}

export async function listThreads() {
  const db = await getMongoDb();
  return db.collection('chat_threads').aggregate([
    { $sort: { created_at: -1 } },
    { $lookup: { from: 'resumes', localField: 'resume_id', foreignField: '_id', as: '_r' } },
    { $addFields: { _r: { $arrayElemAt: ['$_r', 0] } } },
    { $lookup: {
        from: 'chat_messages',
        let: { tid: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$thread_id', '$$tid'] } } },
          { $sort: { id: -1 } },
          { $limit: 1 },
          { $project: { _id: 0, content: 1 } }
        ],
        as: '_last'
      } },
    { $project: {
        _id: 0, id: '$_id', resume_id: 1, title: 1, created_at: 1,
        candidate_name: '$_r.candidate_name', filename: '$_r.filename',
        last_message: { $ifNull: [{ $arrayElemAt: ['$_last.content', 0] }, null] }
      } }
  ]).toArray();
}

export async function getThread(id) {
  const db = await getMongoDb();
  const rows = await db.collection('chat_threads').aggregate([
    { $match: { _id: Number(id) } },
    { $lookup: { from: 'resumes', localField: 'resume_id', foreignField: '_id', as: '_r' } },
    { $addFields: { _r: { $arrayElemAt: ['$_r', 0] } } },
    { $project: {
        _id: 0, id: '$_id', resume_id: 1, title: 1, created_at: 1,
        candidate_name: '$_r.candidate_name', filename: '$_r.filename'
      } }
  ]).toArray();
  return rows[0] || null;
}

export async function appendMessage({ threadId, role, content }) {
  const db = await getMongoDb();
  const id = await nextId('chat_messages');
  const created_at = Date.now();
  await db.collection('chat_messages').insertOne({
    _id: id, id, thread_id: Number(threadId), role, content, created_at
  });
  return id;
}

export async function getMessages(threadId, { limit = 50 } = {}) {
  const db = await getMongoDb();
  return db.collection('chat_messages')
    .find({ thread_id: Number(threadId) },
      { projection: { _id: 0, id: 1, role: 1, content: 1, created_at: 1 } })
    .sort({ id: 1 })
    .limit(limit)
    .toArray();
}

export async function setThreadTitle(threadId, title) {
  const db = await getMongoDb();
  await db.collection('chat_threads').updateOne({ _id: Number(threadId) }, { $set: { title } });
}
