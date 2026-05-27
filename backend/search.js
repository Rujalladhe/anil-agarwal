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

  // Location can match home location OR any work location OR raw text -- so
  // "Boston" finds someone whose current address says Mumbai but worked in
  // Boston. This is the single biggest fix for the Boston/remote miss.
  if (filters.location && filters.location.trim()) {
    const loc = `%${filters.location.trim()}%`;
    where.push(`(
      COALESCE(location, '')          LIKE ? COLLATE NOCASE OR
      COALESCE(work_locations, '')    LIKE ? COLLATE NOCASE OR
      COALESCE(raw_text, '')          LIKE ? COLLATE NOCASE
    )`);
    params.push(loc, loc, loc);
  }

  // L2 new filters --------------------------------------------------------
  if (filters.remote === true) {
    where.push(`(
      remote_worked = 1 OR
      COALESCE(work_locations, '') LIKE '%remote%' COLLATE NOCASE OR
      COALESCE(raw_text, '')       LIKE '%remote%' COLLATE NOCASE
    )`);
  }
  if (Number.isFinite(filters.minRemoteYears)) {
    where.push('COALESCE(remote_years, 0) >= ?');
    params.push(filters.minRemoteYears);
  }
  if (filters.managedPeople === true) {
    where.push('managed_people = 1');
  }
  if (Number.isFinite(filters.minTeamSize)) {
    where.push('COALESCE(team_size_managed, 0) >= ?');
    params.push(filters.minTeamSize);
  }
  if (filters.openToRelocate === true) {
    where.push('open_to_relocate = 1');
  }
  if (filters.publications === true) {
    where.push('publications = 1');
  }
  if (filters.company && filters.company.trim()) {
    const co = `%${filters.company.trim()}%`;
    where.push(`(
      COALESCE(companies, '')       LIKE ? COLLATE NOCASE OR
      COALESCE(current_company, '') LIKE ? COLLATE NOCASE OR
      COALESCE(raw_text, '')        LIKE ? COLLATE NOCASE
    )`);
    params.push(co, co, co);
  }
  if (Array.isArray(filters.domains) && filters.domains.length) {
    for (const d of filters.domains) {
      const dom = String(d).trim();
      if (!dom) continue;
      where.push(`(
        COALESCE(domains, '')  LIKE ? COLLATE NOCASE OR
        COALESCE(raw_text, '') LIKE ? COLLATE NOCASE
      )`);
      params.push(`%${dom}%`, `%${dom}%`);
    }
  }
  if (filters.school && filters.school.trim()) {
    const sc = `%${filters.school.trim()}%`;
    where.push(`(
      COALESCE(education_json, '')    LIKE ? COLLATE NOCASE OR
      COALESCE(highest_education, '') LIKE ? COLLATE NOCASE OR
      COALESCE(raw_text, '')          LIKE ? COLLATE NOCASE
    )`);
    params.push(sc, sc, sc);
  }
  if (filters.workLocation && filters.workLocation.trim()) {
    const wl = `%${filters.workLocation.trim()}%`;
    where.push(`(
      COALESCE(work_locations, '') LIKE ? COLLATE NOCASE OR
      COALESCE(raw_text, '')       LIKE ? COLLATE NOCASE
    )`);
    params.push(wl, wl);
  }

  const sql = `
    SELECT id, filename, candidate_name, score, category, role_title, created_at,
           email, phone, location, linkedin, github, portfolio,
           current_title, current_company, years_experience, highest_education,
           top_skills, languages, notice_period, expected_salary,
           file_path, content_type,
           work_locations, companies, domains,
           remote_worked, remote_years, remote_evidence,
           managed_people, team_size_managed, open_to_relocate,
           education_json, certifications, publications,
           review_json
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
      top_skills:     safeJson(r.top_skills)     || [],
      languages:      safeJson(r.languages)      || [],
      work_locations: safeJson(r.work_locations) || [],
      companies:      safeJson(r.companies)      || [],
      domains:        safeJson(r.domains)        || [],
      education:      safeJson(r.education_json) || [],
      certifications: safeJson(r.certifications) || [],
      remote_worked:    r.remote_worked === 1,
      managed_people:   r.managed_people === 1,
      open_to_relocate: r.open_to_relocate === 1,
      publications:     r.publications === 1,
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
// LLM-based query parser (L3).
//
// The regex parser above (parseRecruiterQuery) is fast and free but only
// understands a fixed grammar. parseRecruiterQueryLLM uses a tiny + cheap
// LLM call (~50 input tokens, ~80 output tokens) to translate ANY phrasing
// into the same filters object. If the LLM call fails or times out, we
// fall back to the regex parser -- chat still works, just less smart.
//
// Allowed filter keys (must match searchResumes(filters) above):
//   q, category, minScore, maxScore, minYears, maxYears, skills[], location,
//   remote (bool), minRemoteYears, managedPeople (bool), minTeamSize,
//   openToRelocate (bool), publications (bool), company, domains[], school,
//   workLocation

const LLM_PARSER_SYSTEM = `You translate recruiter-style natural-language questions about candidate resumes into a STRICT JSON filter object.

Output a single JSON object and nothing else. No markdown fences, no commentary.

Allowed top-level keys (omit any key that's not clearly implied by the question):
  "category":        one of frontend|backend|fullstack|mobile|data|ml-ai|devops|security|qa|design|product|marketing|sales|hr|other
  "minScore":        number 0-100
  "minYears":        number   (e.g. "5+ years experience" -> 5)
  "maxYears":        number   (e.g. "under 2 years" -> 2; "fresh grad" -> 1)
  "skills":          array of skill strings (e.g. ["react","node.js"])
  "location":        string — home/current city the candidate lives in
  "workLocation":    string — a place they have WORKED at (not lived); ALWAYS set this when the user says "worked in <X>", "based in <X>", or names a city WITHOUT context about residence
  "remote":          true if the user is asking for remote-work experience
  "minRemoteYears":  number — minimum years of remote work
  "managedPeople":   true if the user is asking for managers / team leads / people who led others
  "minTeamSize":     number — minimum reports / team size managed
  "openToRelocate":  true if the user wants candidates open to relocation
  "publications":    true if the user wants candidates with papers / patents / books
  "company":         string — a specific employer name the user mentions (e.g. "Google", "Acme")
  "domains":         array of industry words (e.g. ["fintech","healthcare"])
  "school":          string — university / college name
  "intent":          "filter" if the user is asking to FIND/LIST/SHOW candidates, "ask" if it's an open-ended question about candidates

Rules:
- Be CONSERVATIVE. If you're not sure a key is implied, leave it out.
- City names go to "workLocation" by default unless the user explicitly says "lives in" / "based in" / "from <X>" / "located in" — then "location".
- "remote" / "WFH" / "work from home" / "distributed team" / "remote-first" all -> remote: true.
- Don't invent skills or companies that the user didn't say.
- Years: "2 yoe" / "2 yrs" / "2 years experience" -> minYears: 2 (interpret as "at least").
- "fresh grad" / "intern" / "entry level" -> maxYears: 1.`;

export async function parseRecruiterQueryLLM(query) {
  const raw = String(query || '').trim();
  if (!raw) return { filters: {}, intent: 'ask', raw, source: 'empty' };

  const provider = (process.env.AI_PROVIDER || 'groq').toLowerCase();
  // Allow a smaller / cheaper model just for parsing. Falls back to MODEL.
  const model = process.env.PARSER_MODEL || process.env.MODEL || defaultParserModel(provider);

  try {
    const json = await callParserLLM({ provider, model, query: raw });
    const filters = sanitizeFilters(json);
    const intent = json.intent === 'filter' ? 'filter' : 'ask';
    return { filters, intent, raw, source: 'llm' };
  } catch (err) {
    console.warn('[parseRecruiterQueryLLM] LLM parse failed, falling back to regex:', err.message);
    const fallback = parseRecruiterQuery(raw);
    return { ...fallback, source: 'regex-fallback' };
  }
}

function defaultParserModel(provider) {
  if (provider === 'groq')      return 'llama-3.1-8b-instant';
  if (provider === 'anthropic') return 'claude-haiku-4-5-20251001';
  if (provider === 'gemini')    return 'gemini-2.0-flash';
  return '';
}

async function callParserLLM({ provider, model, query }) {
  if (provider === 'groq') {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error('GROQ_API_KEY missing');
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: LLM_PARSER_SYSTEM },
          { role: 'user',   content: `Recruiter question: """${query}"""\n\nReturn the JSON filter object now.` }
        ]
      })
    });
    if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return parseStrictJson(data?.choices?.[0]?.message?.content ?? '');
  }
  if (provider === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY missing');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 400, temperature: 0,
        system: LLM_PARSER_SYSTEM,
        messages: [{ role: 'user', content: `Recruiter question: """${query}"""\n\nReturn the JSON filter object now.` }]
      })
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return parseStrictJson(text);
  }
  if (provider === 'gemini') {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY missing');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: LLM_PARSER_SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: `Recruiter question: """${query}"""\n\nReturn the JSON filter object now.` }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' }
      })
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    return parseStrictJson(parts.map((p) => p.text || '').join('\n'));
  }
  throw new Error(`Unsupported provider ${provider}`);
}

function parseStrictJson(s) {
  if (!s) throw new Error('empty parser response');
  let t = String(s).trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const first = t.indexOf('{'), last = t.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error(`no JSON object: ${t.slice(0, 200)}`);
  return JSON.parse(t.slice(first, last + 1));
}

const ALLOWED_FILTER_KEYS = new Set([
  'q','category','minScore','maxScore','minYears','maxYears','skills',
  'location','workLocation','remote','minRemoteYears','managedPeople',
  'minTeamSize','openToRelocate','publications','company','domains','school'
]);

// Coerce types + drop anything not in the allowlist. Defensive against
// hallucinated keys / wrong types from the parser model.
function sanitizeFilters(json) {
  const out = {};
  if (!json || typeof json !== 'object') return out;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const str = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : undefined;
  const bool = (v) => v === true;
  const arr = (v) => Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : undefined;

  for (const [k, raw] of Object.entries(json)) {
    if (!ALLOWED_FILTER_KEYS.has(k)) continue;
    let v;
    if (['minScore','maxScore','minYears','maxYears','minRemoteYears','minTeamSize'].includes(k)) v = num(raw);
    else if (['remote','managedPeople','openToRelocate','publications'].includes(k))               v = bool(raw);
    else if (['skills','domains'].includes(k))                                                      v = arr(raw);
    else                                                                                            v = str(raw);
    if (v !== undefined) out[k] = v;
  }
  // Clamp obvious score / year sanity bounds.
  if (out.minScore != null) out.minScore = Math.max(0, Math.min(100, Math.round(out.minScore)));
  if (out.maxScore != null) out.maxScore = Math.max(0, Math.min(100, Math.round(out.maxScore)));
  if (out.category) out.category = String(out.category).toLowerCase();
  return out;
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
