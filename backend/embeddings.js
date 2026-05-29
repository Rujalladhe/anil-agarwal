// Embedding provider. Default: Google text-embedding-004 (768 dims, free tier).
// Selected via EMBED_PROVIDER env var. Supported: google, voyage, local.
//
// `local` runs Transformers.js in-process -- no API key, no rate limits.
// First call downloads ~25 MB of model weights to ./node_modules/@huggingface
// (or your HF cache dir). After that it's offline.
//
// IMPORTANT: the dimension MUST match the Pinecone index's dimension (fixed at
// index-creation time). If you switch providers and the dimension changes, set
// a new PINECONE_INDEX name in .env and run `node reindex.js` to re-embed every
// resume into the new index.

// Google retired `text-embedding-004` -- the current stable embedder is
// `gemini-embedding-001`. Its native output is 3072 dims (Matryoshka), and
// we pass outputDimensionality below to truncate to 768 for compatibility
// with the Pinecone index dimension.
const PROVIDER_DEFAULTS = {
  google: { model: 'gemini-embedding-001',       dim: 768 },
  voyage: { model: 'voyage-3-lite',              dim: 512 },
  local:  { model: 'Xenova/all-MiniLM-L6-v2',    dim: 384 }
};

export function getEmbedConfig() {
  const provider = (process.env.EMBED_PROVIDER || 'google').toLowerCase();
  const defaults = PROVIDER_DEFAULTS[provider];
  if (!defaults) {
    throw new Error(`Unknown EMBED_PROVIDER "${provider}". Use one of: ${Object.keys(PROVIDER_DEFAULTS).join(', ')}.`);
  }
  return {
    provider,
    model: process.env.EMBED_MODEL || defaults.model,
    dim:   Number(process.env.EMBED_DIM) || defaults.dim
  };
}

// Batches an array of strings -> array of Float32 embeddings.
export async function embedTexts(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const { provider } = getEmbedConfig();

  switch (provider) {
    case 'google': return embedGoogleBatch(texts);
    case 'voyage': return embedVoyageBatch(texts);
    case 'local':  return embedLocalBatch(texts);
    default:       throw new Error(`Unsupported EMBED_PROVIDER: ${provider}`);
  }
}

export async function embedQuery(text) {
  const [vec] = await embedTexts([text]);
  return vec;
}

// ---------------------------------------------------------------------------
// Google Generative Language API: text-embedding-004
// Docs: https://ai.google.dev/api/embeddings
// Batch endpoint accepts up to 100 requests at a time.

async function embedGoogleBatch(texts) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error('GEMINI_API_KEY is not set in backend/.env (required for EMBED_PROVIDER=google).');
  }
  const { model, dim } = getEmbedConfig();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents?key=${encodeURIComponent(key)}`;

  const out = [];
  // Chunk the input array into groups of 100 (Google's batch limit).
  for (let i = 0; i < texts.length; i += 100) {
    const slice = texts.slice(i, i + 100);
    const body = {
      requests: slice.map((t) => ({
        model: `models/${model}`,
        content: { parts: [{ text: t }] },
        // gemini-embedding-001 natively outputs 3072 dims; outputDimensionality
        // applies Matryoshka truncation to the configured dim. Required for
        // the response to match EMBED_DIM (and therefore the sqlite-vec /
        // Pinecone schemas).
        outputDimensionality: dim
      }))
    };
    // Retry on 429 (rate limit) with exponential backoff. Free-tier
    // gemini-embedding-001 is tight (5 RPM), so a single batched
    // re-index burst will hit this and need to back off. After 5 tries
    // (~31s of waits) we surface the error so the caller doesn't hang.
    let res;
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.status !== 429) break;
      const waitMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s, 8s, 16s
      console.warn(`[embeddings] Google rate-limited (429), retrying in ${waitMs}ms (attempt ${attempt + 1}/5)...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Google embeddings ${res.status}: ${errBody}`);
    }
    const data = await res.json();
    for (const r of data.embeddings || []) {
      out.push(r.values);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Voyage AI: voyage-3-lite (or whatever EMBED_MODEL is set to)
// Docs: https://docs.voyageai.com/reference/embeddings-api

async function embedVoyageBatch(texts) {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) {
    throw new Error('VOYAGE_API_KEY is not set in backend/.env (required for EMBED_PROVIDER=voyage).');
  }
  const { model } = getEmbedConfig();

  const out = [];
  // Voyage accepts up to 128 inputs per request.
  for (let i = 0; i < texts.length; i += 128) {
    const slice = texts.slice(i, i + 128);
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ input: slice, model })
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Voyage embeddings ${res.status}: ${errBody}`);
    }
    const data = await res.json();
    for (const r of data.data || []) {
      out.push(r.embedding);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Local (Transformers.js / ONNX) -- no API key, runs in-process.
//
// Default model: Xenova/all-MiniLM-L6-v2 (384 dims, ~23 MB on disk, fast on CPU).
// Other reasonable swaps (set via EMBED_MODEL):
//   Xenova/bge-small-en-v1.5      (384, slightly better English quality)
//   Xenova/multilingual-e5-small  (384, multilingual)
//
// The pipeline is loaded lazily on first call and cached for the process
// lifetime. The first call also downloads the model weights, so it's slow;
// subsequent calls are fast.

let _localPipelinePromise;

async function getLocalPipeline() {
  if (_localPipelinePromise) return _localPipelinePromise;
  const { model } = getEmbedConfig();
  _localPipelinePromise = (async () => {
    // Dynamic import so users on cloud-embedding providers don't pay the
    // onnxruntime-node load cost.
    const transformers = await import('@huggingface/transformers');
    return transformers.pipeline('feature-extraction', model);
  })();
  return _localPipelinePromise;
}

async function embedLocalBatch(texts) {
  const extractor = await getLocalPipeline();
  // pooling: 'mean' averages token embeddings into a single sentence vector.
  // normalize: 'true' L2-normalizes -- required for cosine distance to behave
  // identically to dot product (Pinecone's index uses cosine).
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  const [n, dim] = output.dims;
  const data = output.data; // Float32Array of length n * dim
  const vectors = [];
  for (let i = 0; i < n; i++) {
    vectors.push(Array.from(data.subarray(i * dim, (i + 1) * dim)));
  }
  return vectors;
}
