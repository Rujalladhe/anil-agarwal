// MongoDB connection + low-level helpers.
//
// MongoDB is now the SOURCE OF TRUTH for all document/relational data (resumes,
// resume text-chunks, chat threads/messages, and the automation suite). Pinecone
// is the sole vector store. There is no SQLite anymore.
//
// Design notes:
// - The connection is REQUIRED. If MONGODB_URI is empty we throw at startup;
//   if the handshake fails getMongoDb() rejects. Callers no longer null-check.
// - Numeric primary keys are assigned by nextId() against a `counters`
//   collection so ids stay sequential integers (the applicant-id format
//   #CAN00001 and the Pinecone vector-id = chunk_id linkage both depend on it).
// - Collection names match the old SQLite tables one-to-one; _id is the numeric
//   primary key (so _id === id), except automation_kv whose _id is the string key.

import { MongoClient } from 'mongodb';

const URI = (process.env.MONGODB_URI || '').trim();
const DB_NAME = (process.env.MONGODB_DB || 'resume_scorer').trim();

let _client = null;
let _db = null;
let _initPromise = null;

export function mongoStatus() {
  return {
    configured: !!URI,
    connected: !!_db,
    db: DB_NAME
  };
}

// Lazy, idempotent connect. Required: throws if MONGODB_URI is unset and
// rejects if the handshake fails (Mongo is the source of truth — there is no
// graceful degradation). Safe to call from anywhere; the handshake happens once.
export async function getMongoDb() {
  if (_db) return _db;
  if (_initPromise) return _initPromise;
  if (!URI) {
    throw new Error('MONGODB_URI is not set in backend/.env — MongoDB is required.');
  }

  _initPromise = (async () => {
    const client = new MongoClient(URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 8000
    });
    await client.connect();
    const db = client.db(DB_NAME);
    await ensureIndexes(db);
    _client = client;
    _db = db;
    console.log(`[mongo] connected to "${DB_NAME}"`);
    return db;
  })();

  try {
    return await _initPromise;
  } catch (err) {
    _initPromise = null; // allow a later retry
    console.error(`[mongo] connect failed: ${err.message}`);
    throw err;
  }
}

async function ensureIndexes(db) {
  // resumes: (email_id, attachment_id) unique when both present. Stops the same
  // Outlook/Gmail attachment being scored twice.
  await db.collection('resumes').createIndex(
    { email_id: 1, attachment_id: 1 },
    {
      name: 'uniq_attachment',
      unique: true,
      partialFilterExpression: { email_id: { $type: 'string' }, attachment_id: { $type: 'string' } }
    }
  );
  await db.collection('resumes').createIndex({ category: 1, score: -1 }, { name: 'category_score' });
  await db.collection('resumes').createIndex({ created_at: -1 }, { name: 'created_at_desc' });

  // chunks: text index for BM25/keyword retrieval, plus resume_id for cascade
  // deletes and per-resume scoping.
  await db.collection('chunks').createIndex(
    { text: 'text' },
    { name: 'chunks_text', default_language: 'english' }
  );
  await db.collection('chunks').createIndex({ resume_id: 1 }, { name: 'chunks_resume' });

  // chat
  await db.collection('chat_messages').createIndex({ thread_id: 1, id: 1 }, { name: 'thread_msgs' });
  await db.collection('chat_threads').createIndex({ created_at: -1 }, { name: 'threads_created' });
  await db.collection('chat_threads').createIndex({ resume_id: 1 }, { name: 'threads_resume' });

  // automation
  await db.collection('workflow_runs').createIndex({ workflow_id: 1, started_at: -1 });
  await db.collection('workflow_actions').createIndex({ run_id: 1 });
  await db.collection('automation_kv').createIndex({ k: 1 }, { unique: true });
}

// ---------------------------------------------------------------------------
// Sequential numeric id allocator. One doc per sequence in `counters`:
//   { _id: "<collectionName>", seq: <number> }
// findOneAndUpdate + $inc is a single atomic document op, so concurrent callers
// each get a distinct, monotonically increasing id (safe across the pool and
// across processes). Driver v6 returns the document directly (no `.value`).
export async function nextId(name) {
  const db = await getMongoDb();
  const doc = await db.collection('counters').findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return doc.seq;
}

// Clean shutdown. Harmless to skip — the driver pools connections and the
// process dies anyway.
export async function closeMongo() {
  if (_client) {
    try { await _client.close(); } catch { /* ignore */ }
    _client = null;
    _db = null;
  }
}
