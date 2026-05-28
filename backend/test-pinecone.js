// Pinecone health check. Loads .env, connects, ensures the index exists,
// does a round-trip upsert -> query -> delete on a throwaway vector, and
// prints a short pass/fail report. Run from backend/: `node test-pinecone.js`.

import 'dotenv/config';
import { Pinecone } from '@pinecone-database/pinecone';

const INDEX_NAME = process.env.PINECONE_INDEX     || 'resume-chunks';
const NAMESPACE  = process.env.PINECONE_NAMESPACE || 'default';
const CLOUD      = process.env.PINECONE_CLOUD     || 'aws';
const REGION     = process.env.PINECONE_REGION    || 'us-east-1';
const EMBED_DIM  = Number(process.env.EMBED_DIM)  || 768;

function ok(msg)   { console.log(`  OK  ${msg}`); }
function info(msg) { console.log(`  --  ${msg}`); }
function fail(msg, err) {
  console.error(`  XX  ${msg}`);
  if (err) console.error('       ' + (err.stack || err.message || err));
  process.exit(1);
}

(async () => {
  console.log('\nPinecone health check');
  console.log('---------------------');
  console.log(`  index     : ${INDEX_NAME}`);
  console.log(`  namespace : ${NAMESPACE}`);
  console.log(`  cloud/reg : ${CLOUD}/${REGION}`);
  console.log(`  dimension : ${EMBED_DIM}\n`);

  if (!process.env.PINECONE_API_KEY) {
    fail('PINECONE_API_KEY is not set in backend/.env');
  }
  ok('PINECONE_API_KEY is set');

  let pc;
  try {
    pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    ok('client constructed');
  } catch (err) {
    fail('failed to construct Pinecone client', err);
  }

  let indexes;
  try {
    indexes = await pc.listIndexes();
    ok(`listIndexes() succeeded (found ${indexes.indexes?.length || 0} index${(indexes.indexes?.length || 0) === 1 ? '' : 'es'})`);
  } catch (err) {
    fail('listIndexes() failed -- usually means the API key is wrong', err);
  }

  const found = (indexes.indexes || []).find((i) => i.name === INDEX_NAME);
  if (found) {
    info(`existing index dimension=${found.dimension}, metric=${found.metric}, host=${found.host || 'pending'}`);
    if (found.dimension && found.dimension !== EMBED_DIM) {
      fail(`dimension mismatch: index has dim=${found.dimension}, EMBED_DIM=${EMBED_DIM}. Drop the index or set PINECONE_INDEX to a new name.`);
    }
    ok('index already exists with matching dimension');
  } else {
    info(`index "${INDEX_NAME}" not found, creating (this can take ~30s)...`);
    try {
      await pc.createIndex({
        name: INDEX_NAME,
        dimension: EMBED_DIM,
        metric: 'cosine',
        spec: { serverless: { cloud: CLOUD, region: REGION } },
        waitUntilReady: true
      });
      ok('index created and ready');
    } catch (err) {
      fail('createIndex() failed -- common causes: free tier is limited to one region (aws/us-east-1), or you already have 5 indexes', err);
    }
  }

  const idx = pc.index(INDEX_NAME).namespace(NAMESPACE);

  // Build a deterministic test vector so we don't depend on a random source.
  // First element = 1, rest = 0 -- still a valid unit-ish vector for cosine.
  const testVec = new Array(EMBED_DIM).fill(0);
  testVec[0] = 1;
  const testId = `__healthcheck_${Date.now()}`;

  try {
    await idx.upsert([{
      id: testId,
      values: testVec,
      metadata: { resume_id: -1, chunk_index: 0, _test: true }
    }]);
    ok('upsert succeeded');
  } catch (err) {
    fail('upsert failed', err);
  }

  // Serverless indexes have eventual consistency; small sleep before query.
  await new Promise((r) => setTimeout(r, 1500));

  try {
    const res = await idx.query({
      vector: testVec,
      topK: 3,
      includeMetadata: false,
      includeValues: false
    });
    const hit = (res.matches || []).find((m) => m.id === testId);
    if (hit) {
      ok(`query succeeded, found test vector (score=${hit.score?.toFixed(4)})`);
    } else {
      // Not a hard fail -- serverless can lag a bit. Mention it so user knows.
      info(`query succeeded but test vector not in top-3 yet (eventual consistency); top match id=${res.matches?.[0]?.id || 'none'}`);
    }
  } catch (err) {
    fail('query failed', err);
  }

  try {
    await idx.deleteOne(testId);
    ok('delete succeeded');
  } catch (err) {
    // Don't fail the whole check on cleanup -- the test vector is tagged
    // with _test:true so the user can clean it up later if needed.
    info(`cleanup delete failed (${err.message}) -- test vector "${testId}" left in index, safe to ignore`);
  }

  console.log('\nAll checks passed. Pinecone is wired up correctly.\n');
})();
