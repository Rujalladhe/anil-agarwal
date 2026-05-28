// MongoDB connection + dual-write layer.
//
// This module is the ONLY place that talks to MongoDB. Everything else in the
// backend keeps using SQLite as the read-side source of truth; we just mirror
// writes here so the user's data is reflected in their Mongo cluster too.
//
// Design notes:
// - If MONGODB_URI is empty the whole module degrades to no-ops, so the app
//   keeps working on SQLite alone. The user can paste their URI any time and
//   restart -- no code changes needed.
// - All write helpers return a Promise but are safe to "fire and await": they
//   never throw upward unless the caller passes { strict: true }. Failures are
//   logged with [mongo] prefix so they're easy to spot in the dev server log.
// - Collection names mirror the SQLite tables one-to-one. _id is the same
//   numeric primary key that SQLite assigns, so the two stores stay in sync
//   without us needing to translate ids on the read path later.
// - On first connect we ensure helpful indexes (email_id/attachment_id unique
//   for resumes, thread_id index for messages, etc.). These match the SQLite
//   indexes so query shapes carry over cleanly when we eventually flip reads.

import { MongoClient } from 'mongodb';

const URI = (process.env.MONGODB_URI || '').trim();
const DB_NAME = (process.env.MONGODB_DB || 'resume_scorer').trim();

let _client = null;
let _db = null;
let _initPromise = null;
// Disabled means: no URI configured, OR an earlier connect attempt failed
// hard. We flip to true so we don't log the same error on every write.
let _disabled = !URI;

export function mongoEnabled() {
  return !_disabled;
}

export function mongoStatus() {
  return {
    configured: !!URI,
    connected: !!_db,
    disabled: _disabled,
    db: DB_NAME
  };
}

// Lazy, idempotent connect. Safe to call from anywhere; the actual handshake
// happens once. Returns the Db handle, or null if disabled.
export async function getMongoDb() {
  if (_disabled) return null;
  if (_db) return _db;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const client = new MongoClient(URI, {
        // Keep the pool small -- this is a single-process dev server.
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
    } catch (err) {
      _disabled = true;
      console.warn(`[mongo] connect failed, disabling dual-write: ${err.message}`);
      return null;
    } finally {
      _initPromise = null;
    }
  })();

  return _initPromise;
}

async function ensureIndexes(db) {
  // resumes: (email_id, attachment_id) unique when both present. Mirrors the
  // partial unique index in SQLite so we can't insert the same Outlook/Gmail
  // attachment twice.
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

  await db.collection('chat_messages').createIndex({ thread_id: 1, id: 1 }, { name: 'thread_msgs' });
  await db.collection('chat_threads').createIndex({ created_at: -1 }, { name: 'threads_created' });

  await db.collection('workflow_runs').createIndex({ workflow_id: 1, started_at: -1 });
  await db.collection('workflow_actions').createIndex({ run_id: 1 });

  await db.collection('automation_kv').createIndex({ k: 1 }, { unique: true });
}

// ---------------------------------------------------------------------------
// Generic dual-write helpers. All of these are no-ops when Mongo is disabled.
// They log on failure and never throw -- the SQLite write is the source of
// truth, and we don't want a transient Mongo blip to break a user request.

// Upsert a document by _id (the SQLite primary key). Replaces the whole doc.
export async function mongoUpsertById(collection, id, doc) {
  if (_disabled) return;
  try {
    const db = await getMongoDb();
    if (!db) return;
    await db.collection(collection).replaceOne(
      { _id: id },
      { _id: id, ...doc },
      { upsert: true }
    );
  } catch (err) {
    console.warn(`[mongo] upsert ${collection}#${id} failed: ${err.message}`);
  }
}

// Insert a fresh document. Use when you know there's no existing row.
export async function mongoInsert(collection, doc) {
  if (_disabled) return;
  try {
    const db = await getMongoDb();
    if (!db) return;
    await db.collection(collection).insertOne(doc);
  } catch (err) {
    console.warn(`[mongo] insert ${collection} failed: ${err.message}`);
  }
}

// Patch fields on a doc by _id.
export async function mongoUpdateById(collection, id, patch) {
  if (_disabled) return;
  try {
    const db = await getMongoDb();
    if (!db) return;
    await db.collection(collection).updateOne(
      { _id: id },
      { $set: patch },
      { upsert: false }
    );
  } catch (err) {
    console.warn(`[mongo] update ${collection}#${id} failed: ${err.message}`);
  }
}

// Delete a doc by _id.
export async function mongoDeleteById(collection, id) {
  if (_disabled) return;
  try {
    const db = await getMongoDb();
    if (!db) return;
    await db.collection(collection).deleteOne({ _id: id });
  } catch (err) {
    console.warn(`[mongo] delete ${collection}#${id} failed: ${err.message}`);
  }
}

// Delete every doc matching a filter. Used for cascading deletes (e.g. drop
// all chat_messages for a thread).
export async function mongoDeleteMany(collection, filter) {
  if (_disabled) return;
  try {
    const db = await getMongoDb();
    if (!db) return;
    await db.collection(collection).deleteMany(filter);
  } catch (err) {
    console.warn(`[mongo] deleteMany ${collection} failed: ${err.message}`);
  }
}

// Upsert a key/value entry (used for the automation_kv table -- Google OAuth
// tokens, integration settings, etc.).
export async function mongoKvSet(key, value) {
  if (_disabled) return;
  try {
    const db = await getMongoDb();
    if (!db) return;
    await db.collection('automation_kv').replaceOne(
      { _id: key },
      { _id: key, k: key, v: value, updated_at: Date.now() },
      { upsert: true }
    );
  } catch (err) {
    console.warn(`[mongo] kv set ${key} failed: ${err.message}`);
  }
}

export async function mongoKvDel(key) {
  if (_disabled) return;
  try {
    const db = await getMongoDb();
    if (!db) return;
    await db.collection('automation_kv').deleteOne({ _id: key });
  } catch (err) {
    console.warn(`[mongo] kv del ${key} failed: ${err.message}`);
  }
}

// Clean shutdown -- called from a process exit hook if you want, but harmless
// to skip. The Node driver pools connections and the process dies anyway.
export async function closeMongo() {
  if (_client) {
    try { await _client.close(); } catch { /* ignore */ }
    _client = null;
    _db = null;
  }
}
