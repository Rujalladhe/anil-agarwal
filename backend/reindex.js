// One-shot maintenance script: re-chunk + re-embed every resume, writing chunk
// text to Mongo and vectors to Pinecone.
//
// Run this:
//   - after switching EMBED_PROVIDER / EMBED_DIM (vectors must match the new dim)
//   - whenever resumes show up in /resumes with 0 chunks (embeddings were
//     misconfigured when they were scored)
//
// Usage:  node reindex.js
//
// indexResume() deletes the resume's existing Mongo chunks and Pinecone vectors
// before writing fresh ones, so this is safe to re-run.

import 'dotenv/config';
import { getMongoDb, closeMongo } from './mongo.js';
import { indexResume } from './rag.js';
import { getEmbedConfig } from './embeddings.js';

async function main() {
  const cfg = getEmbedConfig();
  console.log(`[reindex] embed provider=${cfg.provider} model=${cfg.model} dim=${cfg.dim}`);

  const db = await getMongoDb();
  const resumes = await db.collection('resumes')
    .find({}, { projection: { _id: 0, id: 1, candidate_name: 1, filename: 1, raw_text: 1 } })
    .sort({ id: 1 })
    .toArray();
  console.log(`[reindex] re-indexing ${resumes.length} resumes...`);

  for (const r of resumes) {
    const t0 = Date.now();
    try {
      const result = await indexResume(r.id, r.raw_text);
      const label = r.candidate_name || r.filename;
      console.log(`  #${r.id} ${label}: ${result.chunks} chunks (${Date.now() - t0}ms)`);
    } catch (err) {
      console.error(`  #${r.id} FAILED: ${err.message}`);
    }
  }

  await closeMongo();
  console.log('[reindex] done.');
}

main().catch((err) => {
  console.error('[reindex] fatal:', err);
  process.exit(1);
});
