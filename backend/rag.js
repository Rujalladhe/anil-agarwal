// RAG: chunk a resume, embed each chunk, store vectors. Retrieve top-K
// chunks for a query, optionally scoped to a single resume.

import { chunkResumeText } from './chunker.js';
import { embedTexts, embedQuery } from './embeddings.js';
import { replaceChunksForResume, searchChunks } from './db.js';

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

export async function retrieve({ query, resumeId = null, topK = 8 }) {
  if (!query || !query.trim()) return [];
  const queryEmbedding = await embedQuery(query);
  return searchChunks({ queryEmbedding, topK, resumeId });
}
