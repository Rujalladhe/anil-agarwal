// RAG: chunk a resume, embed each chunk, store vectors. Retrieve top-K
// chunks for a query via TWO signals merged with Reciprocal Rank Fusion:
//   1. semantic vector search (Pinecone)
//   2. lexical BM25 search   (Mongo $text index on chunks.text)
// RRF is the standard hybrid-retrieval fusion: each chunk gets
//   score = sum over signals of 1 / (k + rank_in_signal)
// where k=60 is the classic constant. Chunks that rank high in EITHER
// signal surface; chunks that rank high in BOTH surface even more.
//
// Vector store strategy:
//   - Chunk TEXT lives in Mongo (chunks collection); embeddings live ONLY in
//     Pinecone. Vector search returns chunk ids which we hydrate from Mongo.
//   - Pinecone is the only vector store. On a Pinecone error the vector signal
//     returns [] and BM25 still contributes to the fused result.

import { chunkResumeText } from './chunker.js';
import { embedTexts, embedQuery } from './embeddings.js';
import {
  replaceChunksForResume, searchChunksBM25, hydrateChunksByIds
} from './db.js';
import {
  isPineconeEnabled, upsertResumeChunks, queryNearestChunkIds, deleteResumeVectors
} from './pinecone.js';

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
  // Mongo write first (source of truth for chunk text). Returns the inserted
  // chunk ids so we can reuse them as Pinecone vector ids.
  const chunkIds = await replaceChunksForResume(resumeId, items);
  // Upsert vectors to Pinecone. Re-indexing allocates NEW chunk ids, so clear
  // this resume's stale vectors first (the old delete-then-insert the SQLite
  // path did in one transaction). Wrapped so a Pinecone hiccup can't fail the
  // whole indexing call -- the text is already safely in Mongo.
  if (isPineconeEnabled()) {
    try {
      await deleteResumeVectors(resumeId);
      await upsertResumeChunks(resumeId, chunkIds, items);
    } catch (err) {
      console.warn(`[indexResume] Pinecone upsert failed for resume ${resumeId}: ${err.message}`);
    }
  }
  return { chunks: items.length };
}

// Run a vector search via Pinecone, hydrating text from Mongo by chunk id.
// Returns [] if Pinecone is disabled, errors, or has no hits (BM25 still
// contributes in the hybrid path).
export async function searchChunksWithFallback({ queryEmbedding, topK, resumeId }) {
  if (!isPineconeEnabled()) return [];
  const matches = await queryNearestChunkIds({ queryEmbedding, topK, resumeId });
  if (!matches || !matches.length) return [];
  const orderedIds = matches.map((m) => m.chunk_id);
  const hydrated = await hydrateChunksByIds(orderedIds);
  // Pinecone returns cosine similarity (higher = better). Convert to a
  // distance-like field for consistent logging; RRF only uses rank order.
  const scoreById = new Map(matches.map((m) => [m.chunk_id, m.score]));
  return hydrated.map((h) => ({ ...h, distance: 1 - (scoreById.get(h.chunk_id) ?? 0) }));
}

// Vector-only retrieval (kept for callers that need it).
export async function retrieve({ query, resumeId = null, topK = 8 }) {
  if (!query || !query.trim()) return [];
  const queryEmbedding = await embedQuery(query);
  return searchChunksWithFallback({ queryEmbedding, topK, resumeId });
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
    vecHits = await searchChunksWithFallback({ queryEmbedding, topK: overFetch, resumeId });
  } catch (err) {
    console.warn('[retrieveHybrid] vector search failed:', err.message);
  }
  try {
    bm25Hits = await searchChunksBM25({ query, topK: overFetch, resumeId });
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
