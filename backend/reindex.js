// One-shot maintenance script: rebuild the chunk_vectors table at the
// CURRENT EMBED_DIM and re-embed every resume's chunks.
//
// Run this:
//   - the first time, after switching EMBED_PROVIDER (e.g. google -> local)
//     because sqlite-vec virtual tables fix dimension at CREATE time
//   - any time you wipe / corrupt the chunks table
//   - whenever resumes were inserted while embeddings were misconfigured
//     (you'll see those resumes in /resumes but with 0 chunks)
//
// Usage:  node reindex.js
//
// Safe to run while the dev server is up: it's just SQL + embedding calls.
// If you have a running server, you may want to restart it afterwards so
// it picks up the fresh vec0 table cleanly.

import 'dotenv/config';
import { getDb } from './db.js';
import { indexResume } from './rag.js';
import { getEmbedConfig } from './embeddings.js';

async function main() {
  const cfg = getEmbedConfig();
  console.log(`[reindex] embed provider=${cfg.provider} model=${cfg.model} dim=${cfg.dim}`);

  const db = getDb();

  // Drop + recreate the vec0 virtual table at the current dim. This wipes
  // any vectors that were stored at a different dim.
  db.exec('DROP TABLE IF EXISTS chunk_vectors;');
  db.exec(`CREATE VIRTUAL TABLE chunk_vectors USING vec0(embedding FLOAT[${cfg.dim}]);`);
  db.exec('DELETE FROM chunks;');

  const resumes = db.prepare('SELECT id, candidate_name, filename, raw_text FROM resumes ORDER BY id').all();
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

  console.log('[reindex] done.');
}

main().catch((err) => {
  console.error('[reindex] fatal:', err);
  process.exit(1);
});
