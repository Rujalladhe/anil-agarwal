// Pinecone vector store — runs as PRIMARY for vector search when configured,
// with sqlite-vec kept as a hot backup (dual-write + read-fallback). Designed
// so the rest of the app works unchanged whether Pinecone is on or off:
//
//   - PINECONE_API_KEY unset  -> isPineconeEnabled() === false, every helper
//     in this file becomes a no-op. Existing sqlite-vec path is untouched.
//   - PINECONE_API_KEY set    -> writes go to both stores, reads prefer
//     Pinecone but transparently fall back to sqlite-vec on any error.
//
// Index is auto-created on first use (free-tier serverless: aws/us-east-1,
// cosine, dim from EMBED_DIM). Lazy init keeps server boot fast and avoids
// hitting the network unless RAG is actually exercised.

import { Pinecone } from '@pinecone-database/pinecone';

const INDEX_NAME    = process.env.PINECONE_INDEX     || 'resume-chunks';
const NAMESPACE     = process.env.PINECONE_NAMESPACE || 'default';
const CLOUD         = process.env.PINECONE_CLOUD     || 'aws';
const REGION        = process.env.PINECONE_REGION    || 'us-east-1';
const EMBED_DIM     = Number(process.env.EMBED_DIM) || 768;
// Pinecone upsert batch limit (free tier accepts up to 100 vectors / request
// for typical dims; smaller batches are safer for large payloads).
const UPSERT_BATCH  = 96;

let _clientPromise;   // memoized Pinecone client + index handle
let _disabledReason;  // sticky error so we don't spam logs every call

export function isPineconeEnabled() {
  return Boolean(process.env.PINECONE_API_KEY) && !_disabledReason;
}

// Lazy-init. First call creates the client, ensures the index exists with
// the right dimension, and returns a per-namespace index handle. Subsequent
// calls hit the memoized promise. If init fails (bad key, network down, dim
// mismatch) we set _disabledReason so isPineconeEnabled() flips off and the
// rest of the app cleanly falls back to sqlite-vec.
async function getIndex() {
  if (_clientPromise) return _clientPromise;
  _clientPromise = (async () => {
    const apiKey = process.env.PINECONE_API_KEY;
    if (!apiKey) throw new Error('PINECONE_API_KEY not set');

    const pc = new Pinecone({ apiKey });

    // listIndexes is cheap; use it to decide whether we need to create.
    const existing = await pc.listIndexes();
    const found = (existing.indexes || []).find((i) => i.name === INDEX_NAME);

    if (!found) {
      console.log(`[pinecone] creating index "${INDEX_NAME}" dim=${EMBED_DIM} (${CLOUD}/${REGION})...`);
      await pc.createIndex({
        name: INDEX_NAME,
        dimension: EMBED_DIM,
        metric: 'cosine',
        spec: { serverless: { cloud: CLOUD, region: REGION } },
        waitUntilReady: true
      });
      console.log(`[pinecone] index ready.`);
    } else if (found.dimension && found.dimension !== EMBED_DIM) {
      // Wrong-dim index would silently corrupt search results. Fail loud so
      // the operator either fixes EMBED_DIM or renames PINECONE_INDEX.
      throw new Error(
        `Pinecone index "${INDEX_NAME}" has dimension ${found.dimension} but EMBED_DIM=${EMBED_DIM}. ` +
        `Drop the index or set PINECONE_INDEX to a new name.`
      );
    }

    return pc.index(INDEX_NAME).namespace(NAMESPACE);
  })().catch((err) => {
    _disabledReason = err.message;
    console.warn(`[pinecone] disabled: ${err.message}`);
    throw err;
  });
  return _clientPromise;
}

// Upsert one resume's chunk vectors. `items` is the same array
// replaceChunksForResume already builds; `chunkIds` is the parallel list of
// SQLite chunk row IDs (used as Pinecone vector IDs so the two stores share
// a primary key).
//
// Caller should await this AFTER the sqlite-vec write has succeeded so a
// Pinecone failure here can't roll back the local source of truth.
export async function upsertResumeChunks(resumeId, chunkIds, items) {
  if (!isPineconeEnabled()) return;
  if (!chunkIds.length) return;
  const idx = await getIndex();

  const vectors = chunkIds.map((cid, i) => ({
    id: String(cid),
    values: items[i].embedding,
    metadata: {
      resume_id: Number(resumeId),
      chunk_index: i
    }
  }));

  // Pinecone caps payload size per request; batch defensively.
  for (let i = 0; i < vectors.length; i += UPSERT_BATCH) {
    await idx.upsert(vectors.slice(i, i + UPSERT_BATCH));
  }
}

// Delete every vector tied to a resume. Called from db.deleteResume so the
// two stores stay in sync. Metadata filter delete is supported on serverless
// indexes (which is what the free tier creates).
export async function deleteResumeVectors(resumeId) {
  if (!isPineconeEnabled()) return;
  try {
    const idx = await getIndex();
    await idx.deleteMany({ resume_id: { $eq: Number(resumeId) } });
  } catch (err) {
    // Don't throw -- the SQLite cascade has already happened, so the user's
    // delete-resume request succeeded. A stale vector in Pinecone is
    // harmless: subsequent searches join back to `chunks` via chunk_id and
    // any orphan IDs are filtered out (no chunk row = dropped from results).
    console.warn(`[pinecone] deleteResumeVectors(${resumeId}) failed: ${err.message}`);
  }
}

// Query Pinecone for the top-K nearest chunks. Returns an array of
// { chunk_id, score } in best-first order; the caller hydrates text +
// resume metadata from SQLite by chunk_id (single IN-list query).
//
// Returns null on any failure so the caller can transparently fall back
// to sqlite-vec without a try/catch on every code path.
export async function queryNearestChunkIds({ queryEmbedding, topK = 10, resumeId = null }) {
  if (!isPineconeEnabled()) return null;
  try {
    const idx = await getIndex();
    const req = {
      vector: queryEmbedding,
      topK,
      includeMetadata: false,
      includeValues: false
    };
    if (resumeId != null) {
      req.filter = { resume_id: { $eq: Number(resumeId) } };
    }
    const res = await idx.query(req);
    return (res.matches || []).map((m) => ({
      chunk_id: Number(m.id),
      score: m.score
    }));
  } catch (err) {
    console.warn(`[pinecone] query failed, falling back to sqlite-vec: ${err.message}`);
    return null;
  }
}
