// JD -> ranked candidates.
//
// Pipeline:
//   1. Embed the job description as a single query vector.
//   2. Pull the top-N most similar chunks across ALL resumes.
//   3. Group hits by resume, aggregate (best chunk + top-K avg) into a
//      single 0-100 "match score" per candidate.
//   4. Optionally make ONE LLM call to write 1-line "why" reasons for the
//      top candidates.
//
// We deliberately do *one* LLM call for reasoning (with all top candidates
// in a single prompt) instead of one per candidate -- cheaper and faster.

import { embedQuery } from './embeddings.js';
import { searchChunks, getResumeSummaries } from './db.js';
import { callChatModel } from './chat.js';

// Convert a cosine distance (0 = identical, 1 = orthogonal, ~2 = opposite)
// into a friendly 0-100 match score. Real-world distances cluster between
// 0.2 (great) and 0.7 (poor); we stretch that range so the UI has signal.
function distanceToScore(d) {
  if (!Number.isFinite(d)) return 0;
  // Map distance 0.15 -> 100, distance 0.75 -> 0, linearly.
  const norm = Math.max(0, Math.min(1, (0.75 - d) / 0.60));
  return Math.round(norm * 100);
}

// Pure embedding-based ranking. No LLM call. Useful as a building block
// (and as a fast path when the caller only needs IDs).
export async function matchJobDescription(jobDescription, { topK = 5, poolSize = 60 } = {}) {
  const text = String(jobDescription || '').trim();
  if (!text) return [];

  const jdEmbedding = await embedQuery(text);
  const hits = searchChunks({ queryEmbedding: jdEmbedding, topK: poolSize, resumeId: null });
  if (!hits.length) return [];

  // Aggregate per resume: best distance + average of top-3.
  const byResume = new Map();
  for (const h of hits) {
    let bucket = byResume.get(h.resume_id);
    if (!bucket) {
      bucket = {
        resumeId: h.resume_id,
        candidateName: h.candidate_name,
        filename: h.filename,
        score: h.score,
        distances: [],
        bestHit: h
      };
      byResume.set(h.resume_id, bucket);
    }
    bucket.distances.push(h.distance);
    if (h.distance < bucket.bestHit.distance) bucket.bestHit = h;
  }

  const ranked = Array.from(byResume.values()).map((b) => {
    const top3 = b.distances.slice(0, 3);
    const avg  = top3.reduce((a, x) => a + x, 0) / top3.length;
    // Weight: 70% best chunk, 30% avg of top 3 -- rewards a great single
    // match a little more than a broadly-mediocre fit.
    const composite = b.bestHit.distance * 0.7 + avg * 0.3;
    return {
      resumeId:      b.resumeId,
      candidateName: b.candidateName,
      filename:      b.filename,
      score:         b.score,
      matchScore:    distanceToScore(composite),
      _distance:     composite,
      bestExcerpt:   String(b.bestHit.text || '').slice(0, 500)
    };
  });

  ranked.sort((a, b) => a._distance - b._distance);
  return ranked.slice(0, topK).map(({ _distance, ...rest }) => rest);
}

// Pulls reasons for the top candidates with ONE LLM call. Returns the same
// shape as matchJobDescription() plus a `reason` string per row.
export async function matchJobDescriptionWithReasons(jobDescription, { topK = 5, poolSize = 60 } = {}) {
  const candidates = await matchJobDescription(jobDescription, { topK, poolSize });
  if (candidates.length === 0) return [];

  // Bring in each candidate's stored AI summary so the model has context
  // beyond just the best-matching excerpt.
  const summaries = getResumeSummaries(candidates.map((c) => c.resumeId));
  const summaryById = new Map(summaries.map((s) => [s.id, s]));

  const candidateBlocks = candidates.map((c) => {
    const s = summaryById.get(c.resumeId);
    return `Candidate #${c.resumeId} -- ${c.candidateName || c.filename}
  Overall score: ${c.score ?? 'n/a'}/100
  Semantic match: ${c.matchScore}/100
  Stored summary: ${s?.review?.summary || '(none)'}
  Best matching excerpt: ${c.bestExcerpt}`;
  }).join('\n\n');

  const prompt = `JOB DESCRIPTION:
${String(jobDescription).slice(0, 3000)}

CANDIDATES (already pre-ranked by semantic similarity):
${candidateBlocks}

For each candidate, write ONE concise sentence (max 24 words) explaining the STRONGEST concrete reason they fit (or don't fit) this job. Reference a specific skill, project, or year-count when possible. If a candidate is a poor fit, say so plainly.

Respond with strict JSON only -- NO markdown, NO commentary. Shape:
{ "reasons": [ { "id": <resumeId>, "reason": "<one sentence>" } ] }`;

  let raw;
  try {
    raw = await callChatModel({
      system: 'You write concise recruiter-grade candidate fit summaries. Output strict JSON only.',
      messages: [{ role: 'user', content: prompt }]
    });
  } catch (err) {
    // Reasons are nice-to-have; if the LLM call fails, return rows without them.
    console.warn('[match] LLM reasons failed:', err.message);
    return candidates.map((c) => ({ ...c, reason: '' }));
  }

  const parsed = parseLooseJson(raw);
  const reasonById = new Map();
  if (parsed && Array.isArray(parsed.reasons)) {
    for (const r of parsed.reasons) {
      const id = Number(r.id);
      if (Number.isFinite(id) && typeof r.reason === 'string') {
        reasonById.set(id, r.reason.trim());
      }
    }
  }

  return candidates.map((c) => ({ ...c, reason: reasonById.get(c.resumeId) || '' }));
}

// Lifted from ai.js -- tolerant JSON extractor for chatty models that wrap
// their output in code fences or add commentary.
function parseLooseJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  }
  const first = s.indexOf('{');
  const last  = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) return null;
  try { return JSON.parse(s.slice(first, last + 1)); }
  catch { return null; }
}
