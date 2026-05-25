// Structured search + recruiter-style natural-language query parsing.
//
// Two layers:
//   1) searchResumes(filters)     -- SQL filter on the resumes table.
//   2) parseRecruiterQuery(text)  -- regex-based parser that turns a plain
//                                    sentence like "backend devs with 2+ yrs
//                                    in node" into a filters object.
//
// We do this server-side instead of asking the AI to filter, so common
// recruiter questions ("show me React devs", "candidates with >5 years",
// "fresh grads") DO NOT burn Groq tokens. The /chat route still falls back
// to RAG + AI for fuzzier asks.

import { getDb } from './db.js';
import { CATEGORIES, CATEGORY_LABELS } from './ai.js';

// ---------------------------------------------------------------------------
// SQL filter builder.

export function searchResumes(filters = {}) {
  const db = getDb();
  const where = [];
  const params = [];

  if (filters.category) {
    where.push('category = ?');
    params.push(String(filters.category).toLowerCase());
  }

  if (Number.isFinite(filters.minScore)) {
    where.push('COALESCE(score, 0) >= ?');
    params.push(filters.minScore);
  }
  if (Number.isFinite(filters.maxScore)) {
    where.push('COALESCE(score, 0) <= ?');
    params.push(filters.maxScore);
  }

  if (Number.isFinite(filters.minYears)) {
    where.push('COALESCE(years_experience, 0) >= ?');
    params.push(filters.minYears);
  }
  if (Number.isFinite(filters.maxYears)) {
    where.push('COALESCE(years_experience, 0) <= ?');
    params.push(filters.maxYears);
  }

  // Free-text search across raw_text + name + skills + role title. Uses LIKE
  // (case-insensitive thanks to COLLATE NOCASE) — at MVP scale (<10k rows)
  // a full scan is fine and beats setting up FTS5.
  if (filters.q && filters.q.trim()) {
    const q = `%${filters.q.trim()}%`;
    where.push(`(
      COALESCE(candidate_name, '')    LIKE ? COLLATE NOCASE OR
      COALESCE(role_title, '')        LIKE ? COLLATE NOCASE OR
      COALESCE(top_skills, '')        LIKE ? COLLATE NOCASE OR
      COALESCE(current_title, '')     LIKE ? COLLATE NOCASE OR
      COALESCE(current_company, '')   LIKE ? COLLATE NOCASE OR
      COALESCE(location, '')          LIKE ? COLLATE NOCASE OR
      COALESCE(raw_text, '')          LIKE ? COLLATE NOCASE
    )`);
    for (let i = 0; i < 7; i++) params.push(q);
  }

  // Each requested skill must appear in the top_skills JSON. We store skills
  // as a JSON-encoded array string, so a LIKE match works for our purposes.
  if (Array.isArray(filters.skills) && filters.skills.length) {
    for (const skill of filters.skills) {
      const s = String(skill).trim();
      if (!s) continue;
      where.push(`(
        COALESCE(top_skills, '') LIKE ? COLLATE NOCASE OR
        COALESCE(raw_text, '')   LIKE ? COLLATE NOCASE
      )`);
      params.push(`%${s}%`, `%${s}%`);
    }
  }

  if (filters.location && filters.location.trim()) {
    where.push('COALESCE(location, \'\') LIKE ? COLLATE NOCASE');
    params.push(`%${filters.location.trim()}%`);
  }

  const sql = `
    SELECT id, filename, candidate_name, score, category, role_title, created_at,
           email, phone, location, linkedin, github, portfolio,
           current_title, current_company, years_experience, highest_education,
           top_skills, languages, notice_period, expected_salary,
           file_path, content_type, review_json
    FROM resumes
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(score, 0) DESC, created_at DESC
    LIMIT ?
  `;
  const limit = Number.isFinite(filters.limit) ? filters.limit : 200;
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  return rows.map((r) => {
    let review = null;
    try { review = JSON.parse(r.review_json); } catch { review = null; }
    return {
      ...r,
      top_skills: safeJson(r.top_skills) || [],
      languages: safeJson(r.languages) || [],
      summary: review?.summary || '',
      review_json: undefined
    };
  });
}

function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Natural-language query parser for recruiter-style questions.
//
// Recognises:
//   - category words ("backend", "react devs", "data engineer", ...)
//   - years experience ("2+ years", ">5 yrs", "between 2 and 5 years", "fresh grad")
//   - skill keywords (a small allowlist of common stacks; extend as needed)
//   - free-text fallback (the original query, used for SQL LIKE)
//
// Returns: { filters, intent } where intent is "filter" | "ask" so the
// caller can decide whether to skip the AI step and just return rows.

const CATEGORY_KEYWORDS = {
  frontend:  ['frontend', 'front-end', 'front end', 'react dev', 'vue dev', 'angular dev', 'ui dev', 'web dev'],
  backend:   ['backend', 'back-end', 'back end', 'api dev', 'server side', 'serverside', 'node dev', 'java dev', 'go dev', 'python backend'],
  fullstack: ['fullstack', 'full-stack', 'full stack'],
  mobile:    ['mobile', 'android', 'ios', 'react native', 'flutter'],
  data:      ['data engineer', 'data analyst', 'analytics', 'bi engineer', 'sql dev'],
  'ml-ai':   ['machine learning', 'ml engineer', 'ai engineer', 'data scientist', 'data science', 'llm', 'nlp', 'computer vision', 'researcher'],
  devops:    ['devops', 'sre', 'site reliability', 'platform engineer', 'kubernetes', 'k8s', 'cloud engineer'],
  security:  ['security', 'pentest', 'pentester', 'appsec', 'infosec', 'soc analyst'],
  qa:        ['qa engineer', 'sdet', 'test engineer', 'tester', 'automation tester'],
  design:    ['designer', 'ui/ux', 'ux designer', 'ui designer', 'product designer'],
  product:   ['product manager', 'pm ', 'product owner'],
  marketing: ['marketer', 'growth', 'seo', 'content marketer'],
  sales:     ['sales rep', 'account exec', 'business development', 'bdr'],
  hr:        ['recruiter', 'talent acquisition', 'hr manager']
};

const KNOWN_SKILLS = [
  // languages
  'javascript','typescript','python','java','go','rust','c++','c#','ruby','php','kotlin','swift','scala','r ','sql',
  // frontend
  'react','vue','angular','svelte','next.js','nextjs','redux','tailwind','sass','webpack','vite',
  // backend
  'node','node.js','nodejs','express','nestjs','django','flask','fastapi','spring','spring boot','rails','laravel','graphql','rest api','grpc',
  // mobile
  'android','ios','react native','flutter','swift','kotlin',
  // data / ml
  'pandas','numpy','pytorch','tensorflow','scikit-learn','keras','spark','hadoop','airflow','dbt','snowflake','bigquery','redshift','tableau','power bi','looker',
  // devops / infra
  'aws','gcp','azure','docker','kubernetes','terraform','ansible','jenkins','github actions','gitlab ci','prometheus','grafana','helm',
  // db
  'mysql','postgres','postgresql','mongodb','redis','elasticsearch','dynamodb','cassandra','sqlite',
  // ml/ai specific
  'llm','rag','langchain','llamaindex','transformers','huggingface','openai','anthropic','gemini'
];

export function parseRecruiterQuery(text) {
  const raw = String(text || '').trim();
  if (!raw) return { filters: {}, intent: 'ask' };
  const lower = raw.toLowerCase();

  const filters = {};

  // --- Category ----------------------------------------------------------
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    if (words.some((w) => lower.includes(w))) { filters.category = cat; break; }
  }
  // Bare category names ("show me backend")
  if (!filters.category) {
    for (const cat of CATEGORIES) {
      const word = cat === 'ml-ai' ? 'ml' : cat;
      const re = new RegExp(`\\b${word}\\b`, 'i');
      if (re.test(lower)) { filters.category = cat; break; }
    }
  }

  // --- Years of experience ----------------------------------------------
  // "fresh grad" / "fresh grads" / "intern" -> 0-1 years.
  // Note: matching "grads?" (with optional s) without \b at the end so
  // "grads" is captured alongside "grad".
  if (/\b(fresh\s*(grad|graduate)s?|fresher|intern(ship)?|entry[\s-]?level)\b/i.test(lower)) {
    filters.maxYears = 1;
  }
  // "between X and Y years"
  const between = lower.match(/between\s+(\d+)\s*(?:and|to|-)\s*(\d+)\s*(?:yrs?|years?)/);
  if (between) {
    filters.minYears = Number(between[1]);
    filters.maxYears = Number(between[2]);
  }
  // "X+ years", "X plus years", "more than X years"
  const plus = lower.match(/(\d+)\s*\+\s*(?:yrs?|years?|yoe)/) ||
               lower.match(/(?:more\s+than|over|at\s+least|>=?)\s*(\d+)\s*(?:yrs?|years?|yoe)/) ||
               lower.match(/(\d+)\s*plus\s*(?:yrs?|years?|yoe)/);
  if (plus && filters.minYears == null) {
    filters.minYears = Number(plus[1]);
  }
  // "less than X years", "<X yrs", "up to X years"
  const lt = lower.match(/(?:less\s+than|under|<=?|up\s+to)\s*(\d+)\s*(?:yrs?|years?|yoe)/);
  if (lt && filters.maxYears == null) {
    filters.maxYears = Number(lt[1]);
  }
  // "X years experience" (exact-ish, treat as min)
  const eq = lower.match(/(\d+)\s*(?:yrs?|years?|yoe)\s*(?:of\s+)?experience/);
  if (eq && filters.minYears == null && filters.maxYears == null) {
    filters.minYears = Number(eq[1]);
  }

  // --- Score band -------------------------------------------------------
  // "top candidates", "best matches", "top N", "top backend candidates" etc.
  // We accept any quantifier word followed (possibly after intervening words
  // like "backend") by a candidate-y noun, OR a "top N" at the start.
  if (/\b(top|best|highest|strongest|strong)\s+(\d+\s+)?[a-z][a-z\s-]{0,40}(candidates?|matches?|resumes?|profiles?|devs?|developers?|engineers?|hires?|fits?)\b/i.test(lower)
      || /^\s*(top|best)\s+\d+\b/i.test(lower)) {
    filters.minScore = 75;
  }
  const scoreMatch = lower.match(/score\s*(?:>=?|above|over|at\s+least)\s*(\d+)/);
  if (scoreMatch) filters.minScore = Number(scoreMatch[1]);

  // --- Skills -----------------------------------------------------------
  const hitSkills = new Set();
  for (const skill of KNOWN_SKILLS) {
    const sk = skill.trim();
    // word-boundary-ish match, allow . / + in skill (e.g. "node.js", "c++")
    const safe = sk.replace(/[.+/]/g, (c) => `\\${c}`);
    const re = new RegExp(`(?:^|[^a-z0-9])${safe}(?:[^a-z0-9]|$)`, 'i');
    if (re.test(lower)) hitSkills.add(sk);
  }
  if (hitSkills.size) filters.skills = Array.from(hitSkills);

  // --- Location --------------------------------------------------------
  // Prefer unambiguous prepositional forms. Plain "in <X>" / "from <X>" also
  // matches "in node", "in react" etc., so we look at the ORIGINAL casing --
  // a real city name almost always starts with an uppercase letter when the
  // user types it -- and we additionally reject any token that matches a
  // known skill in KNOWN_SKILLS.
  const inLoc =
    raw.match(/\b(?:based\s+in|located\s+in|lives\s+in|living\s+in|residing\s+in)\s+([A-Za-z][A-Za-z\s,.-]{2,40})/) ||
    raw.match(/\b(?:in|from)\s+([A-Z][A-Za-z][A-Za-z\s,.-]{2,40})/);
  if (inLoc) {
    let loc = inLoc[1].trim().replace(/[.,;]+$/, '');
    loc = loc.replace(/\b(with|who|that|having|and|or|but|for|experience|years?|yrs?)\b.*$/i, '').trim();
    const firstWord = loc.split(/\s+/)[0].toLowerCase();
    const isKnownSkill = KNOWN_SKILLS.some((s) => s.trim().toLowerCase() === firstWord);
    if (loc.length >= 2 && loc.length <= 40 && !isKnownSkill) {
      filters.location = loc;
    }
  }

  // --- Intent ----------------------------------------------------------
  // Filter-y question = something we can answer with rows alone.
  // Ask-y question  = open-ended, model should still chime in.
  const isFiltery =
    Object.keys(filters).length > 0 &&
    /(show|list|find|give|get|filter|segregate|segregat|fetch|who|which|how many|count)/i.test(lower);

  return {
    filters,
    intent: isFiltery ? 'filter' : 'ask',
    raw
  };
}

// ---------------------------------------------------------------------------
// Stats for the dashboard.

export function getStats() {
  const db = getDb();

  const total = db.prepare('SELECT COUNT(*) AS n FROM resumes').get().n;
  const avgScoreRow = db.prepare('SELECT AVG(score) AS avg FROM resumes WHERE score IS NOT NULL').get();
  const avgScore = avgScoreRow.avg != null ? Math.round(avgScoreRow.avg) : 0;

  // Counts by category, ordered by count desc, with human labels.
  const byCategoryRows = db.prepare(`
    SELECT COALESCE(category, 'unknown') AS category, COUNT(*) AS count, ROUND(AVG(score)) AS avg_score
    FROM resumes
    GROUP BY COALESCE(category, 'unknown')
    ORDER BY count DESC
  `).all();
  const byCategory = byCategoryRows.map((r) => ({
    category: r.category,
    label: CATEGORY_LABELS[r.category] || (r.category === 'unknown' ? 'Uncategorized' : r.category),
    count: r.count,
    avgScore: r.avg_score || 0
  }));

  // Score distribution in 10-point buckets (0-9, 10-19, ..., 90-100).
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    label: i === 9 ? '90-100' : `${i * 10}-${i * 10 + 9}`,
    count: 0
  }));
  for (const r of db.prepare('SELECT score FROM resumes WHERE score IS NOT NULL').all()) {
    const idx = Math.min(9, Math.max(0, Math.floor(r.score / 10)));
    buckets[idx].count++;
  }

  // Score bands (good / warn / bad) for a doughnut chart.
  const bands = { good: 0, warn: 0, bad: 0 };
  for (const r of db.prepare('SELECT score FROM resumes WHERE score IS NOT NULL').all()) {
    if (r.score >= 75) bands.good++;
    else if (r.score >= 50) bands.warn++;
    else bands.bad++;
  }

  // Resumes added per day for the last 14 days. Uses local time bucketing
  // (UTC midnight) which is fine for an MVP — recruiters won't care about
  // timezone edges and this stays index-free.
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const timeline = [];
  for (let i = 13; i >= 0; i--) {
    const start = new Date(now - i * day);
    start.setUTCHours(0, 0, 0, 0);
    const end = start.getTime() + day;
    const count = db.prepare(`
      SELECT COUNT(*) AS n FROM resumes WHERE created_at >= ? AND created_at < ?
    `).get(start.getTime(), end).n;
    timeline.push({
      date: start.toISOString().slice(0, 10),
      count
    });
  }

  // Average breakdown across the 5 axes (experience/skills/education/clarity/impact).
  const breakdownAvg = { experience: 0, skills: 0, education: 0, clarity: 0, impact: 0 };
  const breakdownRows = db.prepare('SELECT review_json FROM resumes').all();
  if (breakdownRows.length) {
    const sums = { ...breakdownAvg };
    const counts = { experience: 0, skills: 0, education: 0, clarity: 0, impact: 0 };
    for (const r of breakdownRows) {
      try {
        const review = JSON.parse(r.review_json);
        const b = review.breakdown || {};
        for (const k of Object.keys(sums)) {
          const v = Number(b[k]);
          if (Number.isFinite(v)) { sums[k] += v; counts[k]++; }
        }
      } catch { /* ignore */ }
    }
    for (const k of Object.keys(sums)) {
      breakdownAvg[k] = counts[k] ? Math.round(sums[k] / counts[k]) : 0;
    }
  }

  // Top skills (frequency across all resumes).
  const skillCounts = new Map();
  for (const r of db.prepare('SELECT top_skills FROM resumes WHERE top_skills IS NOT NULL').all()) {
    let arr = [];
    try { arr = JSON.parse(r.top_skills) || []; } catch { /* ignore */ }
    for (const s of arr) {
      const key = String(s).trim().toLowerCase();
      if (!key) continue;
      skillCounts.set(key, (skillCounts.get(key) || 0) + 1);
    }
  }
  const topSkills = Array.from(skillCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([skill, count]) => ({ skill, count }));

  // Years-experience distribution (0, 1-2, 3-5, 6-10, 10+).
  const yearBuckets = [
    { label: '0-1',  min: 0,   max: 1.99 },
    { label: '2-3',  min: 2,   max: 3.99 },
    { label: '4-6',  min: 4,   max: 6.99 },
    { label: '7-10', min: 7,   max: 10.99 },
    { label: '10+',  min: 11,  max: 1000 }
  ].map((b) => ({ ...b, count: 0 }));
  for (const r of db.prepare('SELECT years_experience FROM resumes WHERE years_experience IS NOT NULL').all()) {
    const y = Number(r.years_experience);
    if (!Number.isFinite(y)) continue;
    for (const b of yearBuckets) {
      if (y >= b.min && y <= b.max) { b.count++; break; }
    }
  }

  const recent = db.prepare(`
    SELECT id, candidate_name, filename, score, category, role_title, created_at
    FROM resumes
    ORDER BY created_at DESC
    LIMIT 8
  `).all();

  return {
    total,
    avgScore,
    bands,
    byCategory,
    scoreBuckets: buckets,
    timeline,
    breakdownAvg,
    topSkills,
    yearBuckets: yearBuckets.map(({ label, count }) => ({ label, count })),
    recent,
    generatedAt: new Date().toISOString()
  };
}
