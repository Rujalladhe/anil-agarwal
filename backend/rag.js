// RAG: chunk a resume, embed each chunk, store vectors. Retrieve top-K
// chunks for a query via TWO signals merged with Reciprocal Rank Fusion:
//   1. semantic vector search (sqlite-vec, cosine distance)
//   2. lexical BM25 search   (sqlite FTS5)
// RRF is the standard hybrid-retrieval fusion: each chunk gets
//   score = sum over signals of 1 / (k + rank_in_signal)
// where k=60 is the classic constant. Chunks that rank high in EITHER
// signal surface; chunks that rank high in BOTH surface even more.

import { chunkResumeText } from './chunker.js';
import { embedTexts, embedQuery } from './embeddings.js';
import { replaceChunksForResume, searchChunks, searchChunksBM25 } from './db.js';

export async function indexResume(resumeId, rawText) {
  const chunkTexts = chunkResumeText(rawText);
  if (chunkTexts.length === 0) {
    return { chunks: 0 };
  }
  const embeddings = await embedTexts(chunkTexts);
  if (embeddings.length !== chunkTexts.length) {
    throw new Error(
      `Embedding count mismatch: got ${embeddings.length} for ${chunkTexts.length} chunks.`
    );
  }
  const items = chunkTexts.map((text, i) => ({ text, embedding: embeddings[i] }));
  replaceChunksForResume(resumeId, items);
  return { chunks: items.length };
}

// Vector-only retrieval (kept for callers that need it).
export async function retrieve({ query, resumeId = null, topK = 8 }) {
  if (!query || !query.trim()) return [];
  const queryEmbedding = await embedQuery(query);
  return searchChunks({ queryEmbedding, topK, resumeId });
}

// Hybrid retrieval = vectors + BM25 merged with RRF. This is the function
// chat.js should call. We over-fetch each signal (2x topK) so the fusion has
// enough overlap to work, then cut to topK at the end.
export async function retrieveHybrid({ query, resumeId = null, topK = 10 }) {
  if (!query || !query.trim()) return [];

  const overFetch = Math.max(topK * 2, 20);

  // Run both signals in parallel. BM25 is sync but cheap, vector is async.
  let vecHits = [];
  let bm25Hits = [];
  try {
    const queryEmbedding = await embedQuery(query);
    vecHits = searchChunks({ queryEmbedding, topK: overFetch, resumeId });
  } catch (err) {
    console.warn('[retrieveHybrid] vector search failed:', err.message);
  }
  try {
    bm25Hits = searchChunksBM25({ query, topK: overFetch, resumeId });
  } catch (err) {
    console.warn('[retrieveHybrid] bm25 search failed:', err.message);
  }

  return rrfMerge([vecHits, bm25Hits], topK);
}

// Reciprocal Rank Fusion. Each input is a ranked list (best first). Items are
// matched across lists by chunk_id. Returns one merged list, best first,
// trimmed to topK. Carries the union of metadata fields from both signals.
function rrfMerge(rankedLists, topK, k = 60) {
  const byId = new Map();
  for (const list of rankedLists) {
    list.forEach((item, idx) => {
      const id = item.chunk_id;
      const contribution = 1 / (k + idx + 1);
      const existing = byId.get(id);
      if (existing) {
        existing._rrf += contribution;
      } else {
        byId.set(id, { ...item, _rrf: contribution });
      }
    });
  }
  return Array.from(byId.values())
    .sort((a, b) => b._rrf - a._rrf)
    .slice(0, topK);
}
