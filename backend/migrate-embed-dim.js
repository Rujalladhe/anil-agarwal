// One-shot migration for switching embedding dimensions (e.g. 384 -> 768).
//
// sqlite-vec's vec0 virtual table is created with a fixed dimension. To
// change EMBED_DIM you must drop the table; CREATE VIRTUAL TABLE IF NOT
// EXISTS in db.js will recreate it at the new dim on next server boot.
//
// What this preserves:
//   - `resumes`        (all resume rows, AI reviews, candidate metadata)
//   - `chat_threads`   (chat history)
//   - `chat_messages`  (chat history)
//
// What this wipes (rebuilt by `node reindex.js`):
//   - `chunks`         (text chunks)
//   - `chunk_vectors`  (vector blobs; dim-locked at old EMBED_DIM)
//   - `chunks_fts`     (BM25 index; cleared by ON DELETE trigger on chunks)
//
// Run from backend/ AFTER stopping the server, AFTER updating EMBED_DIM in
// .env, and BEFORE running reindex.js:
//
//   node migrate-embed-dim.js

import 'dotenv/config';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, 'data.db');

console.log(`\nMigrating SQLite at ${DB_PATH}`);
console.log(`Target EMBED_DIM = ${process.env.EMBED_DIM || '(unset, server will use default)'}\n`);

let db;
try {
  db = new Database(DB_PATH, { fileMustExist: true });
} catch (err) {
  console.error(`Cannot open ${DB_PATH}: ${err.message}`);
  console.error('Is the server still running? Stop it (Ctrl+C) and try again.');
  process.exit(1);
}

db.pragma('foreign_keys = ON');
// vec0 virtual tables can't even be DROPped unless the extension is loaded
// -- "no such module: vec0". Load it before touching chunk_vectors.
sqliteVec.load(db);

// Pre-flight: how much are we throwing away?
const resumeCount = db.prepare('SELECT COUNT(*) AS n FROM resumes').get().n;
let chunkCount = 0;
try { chunkCount = db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n; } catch {}
console.log(`  resumes preserved   : ${resumeCount}`);
console.log(`  chunks to rebuild   : ${chunkCount}`);
console.log(`  vectors to rebuild  : ${chunkCount} (1:1 with chunks)\n`);

// Step each DROP independently. Don't wrap in a transaction: FTS5 virtual
// tables sometimes leave orphan shadow tables (_data, _idx, _docsize,
// _config) from prior failed init, and a tx rollback on one stale shadow
// would undo the whole migration. Tolerate "no such table" errors -- the
// goal is "these things are gone," not "everything dropped cleanly."
function tryExec(sql, label) {
  try {
    db.exec(sql);
    console.log(`  OK  ${label}`);
  } catch (err) {
    if (/no such table|no such module/.test(err.message)) {
      console.log(`  --  ${label} (already gone: ${err.message})`);
    } else {
      throw err;
    }
  }
}

try {
  // First: drop the triggers that mirror chunks -> chunks_fts. Without
  // this, the DELETE FROM chunks below would fire AFTER DELETE triggers
  // that try to write into a chunks_fts we're about to drop -> errors.
  tryExec('DROP TRIGGER IF EXISTS chunks_ai;', 'dropped trigger chunks_ai');
  tryExec('DROP TRIGGER IF EXISTS chunks_ad;', 'dropped trigger chunks_ad');
  tryExec('DROP TRIGGER IF EXISTS chunks_au;', 'dropped trigger chunks_au');
  // Drop the FTS5 main table. SQLite handles shadow tables (_data, _idx,
  // _docsize, _config) automatically when the FTS5 module is loaded.
  tryExec('DROP TABLE IF EXISTS chunks_fts;', 'dropped chunks_fts');
  // If shadow tables somehow survived (e.g. a prior crash mid-DROP),
  // remove them by hand so db.js can CREATE VIRTUAL TABLE fresh.
  for (const t of ['chunks_fts_data', 'chunks_fts_idx', 'chunks_fts_docsize', 'chunks_fts_config']) {
    tryExec(`DROP TABLE IF EXISTS ${t};`, `dropped orphan ${t}`);
  }
  tryExec('DROP TABLE IF EXISTS chunk_vectors;', 'dropped chunk_vectors');
  db.exec('DELETE FROM chunks;');
  console.log('  OK  cleared chunks table');
  // Reset autoincrement so new chunk IDs start at 1 -- keeps Pinecone IDs
  // small and predictable.
  db.exec(`DELETE FROM sqlite_sequence WHERE name = 'chunks';`);
  console.log('  OK  reset chunks autoincrement');
  console.log('  OK  resumes / chat tables untouched\n');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exit(1);
}

db.close();
console.log('Migration complete.\n');
console.log('Next steps:');
console.log('  1. Make sure GEMINI_API_KEY is set in .env');
console.log('  2. node test-pinecone.js          (verifies new 768-dim index)');
console.log('  3. node reindex.js                (rebuilds chunks for every resume)');
console.log('  4. npm run dev                    (restart the server)\n');
