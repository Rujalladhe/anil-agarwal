// ONE-TIME migration: copy everything out of the legacy SQLite file
// (backend/data.db) into MongoDB, then seed the id counters. Run this ONCE,
// while better-sqlite3 is still installed, BEFORE removing the SQLite deps.
//
//   node migrate-to-mongo.js                 # copy resumes/chunks/chat/automation + seed counters
//   node migrate-to-mongo.js --reindex-missing   # also re-embed resumes that have 0 chunks
//
// Idempotent: every upsert is keyed by _id and counters use $max, so re-running
// is safe and never moves a live counter backwards. The SQLite file is left on
// disk untouched (keep it as a backup).

import 'dotenv/config';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { getMongoDb, closeMongo } from './mongo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, 'data.db');

const safeJson = (s) => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };

// Numeric collections that get sequential ids from the `counters` collection.
const COUNTER_COLLECTIONS = [
  'resumes', 'chunks', 'chat_threads', 'chat_messages',
  'workflows', 'workflow_runs', 'workflow_actions', 'interviewers', 'oa_templates'
];

async function bulkUpsert(mdb, collection, docs) {
  if (!docs.length) return 0;
  const ops = docs.map((doc) => ({
    replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true }
  }));
  const result = await mdb.collection(collection).bulkWrite(ops, { ordered: false });
  return (result.upsertedCount || 0) + (result.modifiedCount || 0) + (result.matchedCount || 0);
}

// Seed a counter to the current max(_id) so the next nextId() yields max+1.
// $max never lowers an existing counter, so this is safe to re-run.
async function seedCounter(mdb, name) {
  const top = await mdb.collection(name).find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).next();
  const maxId = top && typeof top._id === 'number' ? top._id : 0;
  await mdb.collection('counters').updateOne({ _id: name }, { $max: { seq: maxId } }, { upsert: true });
  return maxId;
}

async function main() {
  const reindexMissing = process.argv.includes('--reindex-missing');

  if (!existsSync(DB_PATH)) {
    console.error(`[migrate] SQLite file not found at ${DB_PATH} — nothing to migrate.`);
    process.exit(1);
  }

  const sdb = new Database(DB_PATH, { readonly: true });
  const mdb = await getMongoDb();
  console.log(`[migrate] SQLite: ${DB_PATH}`);
  console.log('[migrate] connected to Mongo, copying...');

  const tableExists = (name) =>
    !!sdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

  const report = {};

  // --- resumes (decoded shape, matches db.insertResume / search reads) ------
  const resumeRows = sdb.prepare('SELECT * FROM resumes').all();
  report.resumes = await bulkUpsert(mdb, 'resumes', resumeRows.map((row) => {
    const doc = {
      _id: row.id,
      ...row,
      top_skills:     safeJson(row.top_skills) || [],
      languages:      safeJson(row.languages) || [],
      work_locations: safeJson(row.work_locations) || [],
      companies:      safeJson(row.companies) || [],
      domains:        safeJson(row.domains) || [],
      education:      safeJson(row.education_json) || [],
      certifications: safeJson(row.certifications) || [],
      remote_worked:    row.remote_worked === 1,
      managed_people:   row.managed_people === 1,
      open_to_relocate: row.open_to_relocate === 1,
      publications:     row.publications === 1,
      review:           safeJson(row.review_json) || null
    };
    delete doc.review_json;
    delete doc.education_json;
    return doc;
  }));

  // --- chunks (NEW — text was never mirrored before) ------------------------
  // _id = chunk id, which is also the Pinecone vector id, so existing vectors
  // keep hydrating correctly.
  if (tableExists('chunks')) {
    const chunkDocs = sdb.prepare('SELECT id, resume_id, chunk_index, text FROM chunks').all()
      .map((r) => ({ _id: r.id, id: r.id, resume_id: r.resume_id, chunk_index: r.chunk_index, text: r.text }));
    report.chunks = await bulkUpsert(mdb, 'chunks', chunkDocs);
  }

  // --- chat -----------------------------------------------------------------
  if (tableExists('chat_threads')) {
    report.chat_threads = await bulkUpsert(mdb, 'chat_threads',
      sdb.prepare('SELECT * FROM chat_threads').all().map((r) => ({ _id: r.id, ...r })));
  }
  if (tableExists('chat_messages')) {
    report.chat_messages = await bulkUpsert(mdb, 'chat_messages',
      sdb.prepare('SELECT * FROM chat_messages').all().map((r) => ({ _id: r.id, ...r })));
  }

  // --- automation -----------------------------------------------------------
  if (tableExists('workflows')) {
    report.workflows = await bulkUpsert(mdb, 'workflows',
      sdb.prepare('SELECT * FROM workflows').all().map((r) => {
        const d = { _id: r.id, ...r, enabled: r.enabled === 1, graph: safeJson(r.graph_json) || {} };
        delete d.graph_json; return d;
      }));
  }
  if (tableExists('workflow_runs')) {
    report.workflow_runs = await bulkUpsert(mdb, 'workflow_runs',
      sdb.prepare('SELECT * FROM workflow_runs').all().map((r) => ({
        _id: r.id, ...r, summary: safeJson(r.summary) || {}
      })));
  }
  if (tableExists('workflow_actions')) {
    report.workflow_actions = await bulkUpsert(mdb, 'workflow_actions',
      sdb.prepare('SELECT * FROM workflow_actions').all().map((r) => {
        const d = { _id: r.id, ...r, detail: safeJson(r.detail_json) || {} };
        delete d.detail_json; return d;
      }));
  }
  if (tableExists('interviewers')) {
    report.interviewers = await bulkUpsert(mdb, 'interviewers',
      sdb.prepare('SELECT * FROM interviewers').all().map((r) => {
        const d = { _id: r.id, ...r, availability: safeJson(r.availability_json) || [] };
        delete d.availability_json; return d;
      }));
  }
  if (tableExists('oa_templates')) {
    report.oa_templates = await bulkUpsert(mdb, 'oa_templates',
      sdb.prepare('SELECT * FROM oa_templates').all().map((r) => ({ _id: r.id, ...r })));
  }
  if (tableExists('automation_kv')) {
    // KV: _id = the string key (matches db.kvSet / the unique index).
    report.automation_kv = await bulkUpsert(mdb, 'automation_kv',
      sdb.prepare('SELECT * FROM automation_kv').all().map((r) => ({
        _id: r.k, k: r.k, v: safeJson(r.v) ?? r.v, updated_at: r.updated_at
      })));
  }

  console.log('[migrate] copied:', report);

  // --- seed counters from current max(_id) ----------------------------------
  console.log('[migrate] seeding id counters...');
  for (const name of COUNTER_COLLECTIONS) {
    const max = await seedCounter(mdb, name);
    console.log(`  ${name.padEnd(18)} next id starts after ${max}`);
  }

  // --- verify: per-collection counts vs SQLite ------------------------------
  console.log('[migrate] verifying counts (mongo vs sqlite)...');
  const checks = [
    ['resumes', 'resumes'], ['chunks', 'chunks'],
    ['chat_threads', 'chat_threads'], ['chat_messages', 'chat_messages'],
    ['workflows', 'workflows'], ['workflow_runs', 'workflow_runs'],
    ['workflow_actions', 'workflow_actions'], ['interviewers', 'interviewers'],
    ['oa_templates', 'oa_templates']
  ];
  let mismatches = 0;
  for (const [coll, table] of checks) {
    if (!tableExists(table)) continue;
    const sCount = sdb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    const mCount = await mdb.collection(coll).countDocuments();
    const ok = mCount >= sCount; // >= because re-runs / new writes can add rows
    if (!ok) mismatches++;
    console.log(`  ${coll.padEnd(18)} sqlite=${sCount} mongo=${mCount} ${ok ? 'OK' : 'MISMATCH'}`);
  }

  // Resumes with zero chunks (their vector/keyword search won't work).
  const resumeIds = resumeRows.map((r) => r.id);
  let zeroChunk = [];
  for (const id of resumeIds) {
    const cnt = await mdb.collection('chunks').countDocuments({ resume_id: id });
    if (cnt === 0) zeroChunk.push(id);
  }
  if (zeroChunk.length) {
    console.warn(`[migrate] ${zeroChunk.length} resume(s) have 0 chunks: ${zeroChunk.slice(0, 20).join(', ')}${zeroChunk.length > 20 ? '…' : ''}`);
    console.warn('          Re-run with --reindex-missing to re-embed them (uses your embedding provider).');
  } else {
    console.log('[migrate] every resume has chunks ✓');
  }

  // --- optional: re-index resumes with 0 chunks -----------------------------
  if (reindexMissing && zeroChunk.length) {
    const { indexResume } = await import('./rag.js');
    const byId = new Map(resumeRows.map((r) => [r.id, r]));
    console.log(`[migrate] re-indexing ${zeroChunk.length} resume(s)...`);
    let done = 0;
    for (const id of zeroChunk) {
      const r = byId.get(id);
      if (!r || !r.raw_text) continue;
      try {
        const { chunks } = await indexResume(id, r.raw_text);
        done++;
        console.log(`  reindexed resume ${id} -> ${chunks} chunks`);
      } catch (err) {
        console.warn(`  reindex resume ${id} failed: ${err.message}`);
      }
    }
    console.log(`[migrate] reindexed ${done}/${zeroChunk.length}.`);
  }

  sdb.close();
  await closeMongo();
  console.log(`[migrate] done.${mismatches ? ` (${mismatches} count mismatch(es) — review above)` : ''}`);
  process.exit(mismatches ? 2 : 0);
}

main().catch((err) => {
  console.error('[migrate] fatal:', err);
  process.exit(1);
});
