// Bulk JD segregation. Given N job descriptions, decide which JD each
// resume in the pipeline fits best, and bucket them.
//
// Pipeline (per JD):
//   1. Embed the JD once.
//   2. Vector-search the candidate chunk pool.
//   3. Aggregate hits per resume into a single composite distance
//      (70% best chunk + 30% avg of top-3).
//
// Assignment:
//   For each resume seen by ANY JD, pick the JD with the smallest
//   composite distance. Convert that distance to a 0-100 match score.
//   If the best match score is below `threshold`, the candidate lands in
//   the "unmatched" bucket. Resumes never reached by any JD's chunk pool
//   also land in unmatched with matchScore=0.

import { embedQuery } from './embeddings.js';
import { listResumes } from './db.js';
import { searchChunksWithFallback } from './rag.js';

function distanceToScore(d) {
  if (!Number.isFinite(d)) return 0;
  const norm = Math.max(0, Math.min(1, (0.95 - d) / 0.75));
  return Math.round(norm * 100);
}

function aggregatePerResume(hits) {
  const byResume = new Map();
  for (const h of hits) {
    let b = byResume.get(h.resume_id);
    if (!b) {
      b = { resumeId: h.resume_id, distances: [], best: h };
      byResume.set(h.resume_id, b);
    }
    b.distances.push(h.distance);
    if (h.distance < b.best.distance) b.best = h;
  }
  const out = [];
  for (const b of byResume.values()) {
    const top3 = b.distances.slice(0, 3);
    const avg  = top3.reduce((a, x) => a + x, 0) / top3.length;
    out.push({
      resumeId:    b.resumeId,
      distance:    b.best.distance * 0.7 + avg * 0.3,
      bestExcerpt: String(b.best.text || '').slice(0, 400)
    });
  }
  return out;
}

export async function segregateResumes(jds, { threshold = 30, poolPerJd } = {}) {
  const prepared = (jds || []).map((jd, i) => ({
    _idx:  i,
    name:  (jd?.name && String(jd.name).trim()) || `Job #${i + 1}`,
    text:  typeof jd?.text === 'string' ? jd.text.trim() : ''
  }));

  const valid = prepared.filter((jd) => jd.text.length >= 20);
  if (!valid.length) {
    return { buckets: [], unmatched: [], jdCount: prepared.length, resumeCount: 0, validJdCount: 0 };
  }

  const resumes = await listResumes();
  const resumeMeta = new Map(resumes.map((r) => [r.id, r]));
  // Scale the per-JD pool with how many resumes are in the pipeline so a
  // tail-end candidate doesn't get dropped just because the default top-60
  // was too small. Capped to keep the SQL search bounded.
  const pool = poolPerJd || Math.min(1000, Math.max(80, resumes.length * 6));

  // resumeId -> Array<{ jdIdx, distance, bestExcerpt }>
  const byResume = new Map();

  // Embed + search sequentially. embedQuery is local-friendly but cloud
  // embedding providers rate-limit on bursts; serial keeps it boring.
  for (const jd of valid) {
    const embedding = await embedQuery(jd.text);
    const hits = await searchChunksWithFallback({ queryEmbedding: embedding, topK: pool, resumeId: null });
    const perResume = aggregatePerResume(hits);
    for (const r of perResume) {
      let arr = byResume.get(r.resumeId);
      if (!arr) { arr = []; byResume.set(r.resumeId, arr); }
      arr.push({ jdIdx: jd._idx, distance: r.distance, bestExcerpt: r.bestExcerpt });
    }
  }

  // Initialize one bucket per submitted JD so empties still render in the UI.
  const buckets = prepared.map((jd) => ({
    jdIndex: jd._idx,
    jdName:  jd.name,
    jdText:  jd.text,
    candidates: []
  }));
  const unmatched = [];

  // Argmin distance per resume -> assigned JD.
  for (const [resumeId, fits] of byResume.entries()) {
    fits.sort((a, b) => a.distance - b.distance);
    const best = fits[0];
    const matchScore = distanceToScore(best.distance);
    const meta = resumeMeta.get(resumeId) || {};
    const row = {
      resumeId,
      candidateName: meta.candidate_name || null,
      filename:      meta.filename || null,
      score:         meta.score,
      category:      meta.category,
      matchScore,
      bestExcerpt:   best.bestExcerpt,
      runnerUp: fits[1]
        ? { jdIndex: fits[1].jdIdx, matchScore: distanceToScore(fits[1].distance) }
        : null
    };
    if (matchScore < threshold) {
      unmatched.push(row);
    } else {
      buckets[best.jdIdx].candidates.push(row);
    }
  }

  // Resumes the chunk-pool never reached count as unmatched too -- otherwise
  // the UI total wouldn't reconcile with the pipeline count.
  for (const r of resumes) {
    if (!byResume.has(r.id)) {
      unmatched.push({
        resumeId:      r.id,
        candidateName: r.candidate_name || null,
        filename:      r.filename || null,
        score:         r.score,
        category:      r.category,
        matchScore:    0,
        bestExcerpt:   '',
        runnerUp:      null
      });
    }
  }

  // Dedupe identical candidate copies across the whole result. If the same
  // candidate (by name + filename + score + category) appears in multiple
  // places — e.g. one copy got matched to a JD while a second copy slipped
  // through the chunk-pool and landed in Unmatched at 0% — keep only the
  // single best-matched row. Otherwise the UI shows misleading duplicates.
  const dedupeKey = (c) =>
    [c.candidateName || '', c.filename || '', c.score ?? '', c.category || ''].join('|');
  const bestByKey = new Map();
  const indexAllRows = (rows) => {
    for (const r of rows) {
      const k = dedupeKey(r);
      const prev = bestByKey.get(k);
      if (!prev || r.matchScore > prev.matchScore) bestByKey.set(k, r);
    }
  };
  buckets.forEach((b) => indexAllRows(b.candidates));
  indexAllRows(unmatched);
  const keep = (rows) => rows.filter((r) => bestByKey.get(dedupeKey(r)) === r);
  buckets.forEach((b) => { b.candidates = keep(b.candidates); });
  const dedupedUnmatched = keep(unmatched);

  for (const b of buckets) {
    b.candidates.sort((a, b) =>
      (b.matchScore - a.matchScore) || ((b.score || 0) - (a.score || 0)));
  }
  dedupedUnmatched.sort((a, b) => b.matchScore - a.matchScore);

  return {
    buckets,
    unmatched: dedupedUnmatched,
    jdCount:      prepared.length,
    validJdCount: valid.length,
    resumeCount:  resumes.length
  };
}
