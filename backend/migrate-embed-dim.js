// OBSOLETE. This script handled sqlite-vec's fixed-dimension virtual table.
// There is no SQLite anymore — Pinecone is the only vector store and its index
// dimension is fixed at index-creation time.
//
// To change embedding dimensions now:
//   1. Set a NEW PINECONE_INDEX name (and the new EMBED_DIM / EMBED_PROVIDER)
//      in backend/.env. pinecone.js auto-creates the index at the new dim on
//      first use. (Re-using the old index name with a different dim throws.)
//   2. node reindex.js      — re-chunks + re-embeds every resume into Mongo +
//                             the new Pinecone index.
//   3. npm run dev          — restart the server.

console.log('migrate-embed-dim.js is obsolete (no SQLite / sqlite-vec).');
console.log('To change embedding dims: set a new PINECONE_INDEX + EMBED_DIM in .env, then run `node reindex.js`.');
process.exit(0);
