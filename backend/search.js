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

import { getMongoDb } from './mongo.js';
import { CATEGORIES, CATEGORY_LABELS } from './ai.js';

// ---------------------------------------------------------------------------
// SQL filter builder.

export async function searchResumes(filters = {}) {
  const db = await getMongoDb();
  const and = [];

  // Case-insensitive substring match. MUST escape regex metachars so skills
  // like "c++", "c#", "node.js" are treated literally (a behavior the old
  // SQL LIKE got for free). A regex against an array field (e.g. top_skills)
  // matches if ANY element matches — reproduces the old JSON-string LIKE.
  const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = (s) => new RegExp(escapeRegex(String(s).trim()), 'i');

  if (filters.category) {
    and.push({ category: String(filters.category).toLowerCase() });
  }

  if (Number.isFinite(filters.minScore)) {
    and.push({ score: { $gte: filters.minScore } });
  }
  if (Number.isFinite(filters.maxScore)) {
    // COALESCE(score,0) <= max also matches null/unscored (treated as 0).
    and.push({ $or: [{ score: { $lte: filters.maxScore } }, { score: null }, { score: { $exists: false } }] });
  }

  if (Number.isFinite(filters.minYears)) {
    and.push({ years_experience: { $gte: filters.minYears } });
  }
  if (Number.isFinite(filters.maxYears)) {
    and.push({ $or: [{ years_experience: { $lte: filters.maxYears } }, { years_experience: null }, { years_experience: { $exists: false } }] });
  }

  // Free-text across name/role/title/company/location/raw_text/top_skills.
  // Also matches a #CAN id like "#CAN00042" / "can42" / "42".
  if (filters.q && filters.q.trim()) {
    const r = rx(filters.q.trim());
    const or = [
      { candidate_name: r }, { role_title: r }, { current_title: r },
      { current_company: r }, { location: r }, { raw_text: r }, { top_skills: r }
    ];
    const idMatch = String(filters.q).trim().match(/#?can?0*(\d+)/i);
    if (idMatch) or.push({ id: Number(idMatch[1]) });
    and.push({ $or: or });
  }

  // Each requested skill must appear (AND across skills; OR within fields).
  if (Array.isArray(filters.skills) && filters.skills.length) {
    for (const skill of filters.skills) {
      const s = String(skill).trim();
      if (!s) continue;
      const r = rx(s);
      and.push({ $or: [{ top_skills: r }, { raw_text: r }] });
    }
  }

  // Location matches home OR any work location OR raw text.
  if (filters.location && filters.location.trim()) {
    const r = rx(filters.location.trim());
    and.push({ $or: [{ location: r }, { work_locations: r }, { raw_text: r }] });
  }

  if (filters.remote === true) {
    and.push({ $or: [{ remote_worked: true }, { work_locations: /remote/i }, { raw_text: /remote/i }] });
  }
  if (Number.isFinite(filters.minRemoteYears)) {
    and.push({ remote_years: { $gte: filters.minRemoteYears } });
  }
  if (filters.managedPeople === true) {
    and.push({ managed_people: true });
  }
  if (Number.isFinite(filters.minTeamSize)) {
    and.push({ team_size_managed: { $gte: filters.minTeamSize } });
  }
  if (filters.openToRelocate === true) {
    and.push({ open_to_relocate: true });
  }
  if (filters.publications === true) {
    and.push({ publications: true });
  }
  if (filters.company && filters.company.trim()) {
    const r = rx(filters.company.trim());
    and.push({ $or: [{ companies: r }, { current_company: r }, { raw_text: r }] });
  }
  if (Array.isArray(filters.domains) && filters.domains.length) {
    for (const d of filters.domains) {
      const dom = String(d).trim();
      if (!dom) continue;
      const r = rx(dom);
      and.push({ $or: [{ domains: r }, { raw_text: r }] });
    }
  }
  if (filters.school && filters.school.trim()) {
    const r = rx(filters.school.trim());
    and.push({ $or: [
      { education: { $elemMatch: { $or: [{ school: r }, { degree: r }] } } },
      { highest_education: r },
      { raw_text: r }
    ] });
  }
  if (filters.workLocation && filters.workLocation.trim()) {
    const r = rx(filters.workLocation.trim());
    and.push({ $or: [{ work_locations: r }, { raw_text: r }] });
  }

  const match = and.length ? { $and: and } : {};
  const limit = Number.isFinite(filters.limit) ? filters.limit : 200;

  // ORDER BY COALESCE(score,0) DESC, created_at DESC. $addFields normalizes a
  // null score to 0 so unscored rows sort low (matching the old COALESCE).
  const rows = await db.collection('resumes').aggregate([
    { $match: match },
    { $addFields: { _ss: { $ifNull: ['$score', 0] }, summary: { $ifNull: ['$review.summary', ''] } } },
    { $sort: { _ss: -1, created_at: -1 } },
    { $limit: limit },
    { $project: { _id: 0, _ss: 0, raw_text: 0, review: 0 } }
  ]).toArray();

  // Docs are already decoded (arrays/booleans); just defend against missing.
  return rows.map((r) => ({
    ...r,
    top_skills:     Array.isArray(r.top_skills) ? r.top_skills : [],
    languages:      Array.isArray(r.languages) ? r.languages : [],
    work_locations: Array.isArray(r.work_locations) ? r.work_locations : [],
    companies:      Array.isArray(r.companies) ? r.companies : [],
    domains:        Array.isArray(r.domains) ? r.domains : [],
    education:      Array.isArray(r.education) ? r.education : [],
    certifications: Array.isArray(r.certifications) ? r.certifications : [],
    remote_worked:    r.remote_worked === true,
    managed_people:   r.managed_people === true,
    open_to_relocate: r.open_to_relocate === true,
    publications:     r.publications === true
  }));
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

// In-memory LRU around the LLM parse call. Same recruiter query asked twice
// in a session returns the cached parse without burning a second LLM round
// trip (saves ~150-300 tokens per repeat). Key = lowercased + trimmed query
// so "React Devs" and "react devs" share an entry. Cap is tiny because the
// parse output is small and the working set per session is small.
const PARSER_CACHE = new Map();
const PARSER_CACHE_MAX = 200;

function parserCacheGet(key) {
  if (!PARSER_CACHE.has(key)) return undefined;
  // LRU touch: re-insert moves the key to the end of the iteration order.
  const val = PARSER_CACHE.get(key);
  PARSER_CACHE.delete(key);
  PARSER_CACHE.set(key, val);
  return val;
}

function parserCacheSet(key, val) {
  if (PARSER_CACHE.has(key)) PARSER_CACHE.delete(key);
  PARSER_CACHE.set(key, val);
  if (PARSER_CACHE.size > PARSER_CACHE_MAX) {
    // Evict the oldest entry (first key in iteration order).
    const oldest = PARSER_CACHE.keys().next().value;
    PARSER_CACHE.delete(oldest);
  }
}

export async function parseRecruiterQueryLLM(query) {
  const raw = String(query || '').trim();
  if (!raw) return { filters: {}, intent: 'ask', raw, source: 'empty' };

  const cacheKey = raw.toLowerCase();
  const cached = parserCacheGet(cacheKey);
  if (cached) return cached;

  const provider = (process.env.AI_PROVIDER || 'groq').toLowerCase();
  // Allow a smaller / cheaper model just for parsing. Falls back to MODEL.
  const model = process.env.PARSER_MODEL || process.env.MODEL || defaultParserModel(provider);

  try {
    const json = await callParserLLM({ provider, model, query: raw });
    const filters = sanitizeFilters(json);
    const intent = json.intent === 'filter' ? 'filter' : 'ask';
    const result = { filters, intent, raw, source: 'llm' };
    parserCacheSet(cacheKey, result);
    return result;
  } catch (err) {
    console.warn('[parseRecruiterQueryLLM] LLM parse failed, falling back to regex:', err.message);
    const fallback = parseRecruiterQuery(raw);
    const result = { ...fallback, source: 'regex-fallback' };
    // Cache the fallback too -- if the LLM call failed once (rate limit,
    // network), it's likely to fail again. No point hammering it.
    parserCacheSet(cacheKey, result);
    return result;
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

export async function getStats() {
  const db = await getMongoDb();
  // Single scan; the docs are small with this projection and we compute the
  // rest in JS (same shape as before, fewer round-trips than the old per-day
  // timeline queries).
  const docs = await db.collection('resumes').find({}, {
    projection: {
      _id: 0, id: 1, score: 1, category: 1, created_at: 1, candidate_name: 1, filename: 1,
      role_title: 1, top_skills: 1, companies: 1, years_experience: 1,
      highest_education: 1, education: 1, review: 1
    }
  }).toArray();

  const total = docs.length;
  const scored = docs.filter((d) => d.score != null);
  const avgScore = scored.length ? Math.round(scored.reduce((s, d) => s + d.score, 0) / scored.length) : 0;

  // Counts by category, ordered by count desc, with human labels.
  const catMap = new Map();
  for (const d of docs) {
    const key = d.category || 'unknown';
    if (!catMap.has(key)) catMap.set(key, { count: 0, sum: 0, scored: 0 });
    const c = catMap.get(key);
    c.count++;
    if (d.score != null) { c.sum += d.score; c.scored++; }
  }
  const byCategory = Array.from(catMap.entries())
    .map(([category, c]) => ({
      category,
      label: CATEGORY_LABELS[category] || (category === 'unknown' ? 'Uncategorized' : category),
      count: c.count,
      avgScore: c.scored ? Math.round(c.sum / c.scored) : 0
    }))
    .sort((a, b) => b.count - a.count);

  // Score distribution in 10-point buckets (0-9, ..., 90-100) + good/warn/bad.
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    label: i === 9 ? '90-100' : `${i * 10}-${i * 10 + 9}`,
    count: 0
  }));
  const bands = { good: 0, warn: 0, bad: 0 };
  for (const d of scored) {
    const idx = Math.min(9, Math.max(0, Math.floor(d.score / 10)));
    buckets[idx].count++;
    if (d.score >= 75) bands.good++;
    else if (d.score >= 50) bands.warn++;
    else bands.bad++;
  }

  // Resumes added per day for the last 14 days (UTC-midnight buckets).
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const timeline = [];
  for (let i = 13; i >= 0; i--) {
    const start = new Date(now - i * day);
    start.setUTCHours(0, 0, 0, 0);
    const startMs = start.getTime();
    const end = startMs + day;
    const count = docs.filter((d) => d.created_at >= startMs && d.created_at < end).length;
    timeline.push({ date: start.toISOString().slice(0, 10), count });
  }

  // Average breakdown across the 5 axes (experience/skills/education/clarity/impact).
  const breakdownAvg = { experience: 0, skills: 0, education: 0, clarity: 0, impact: 0 };
  {
    const sums = { ...breakdownAvg };
    const counts = { experience: 0, skills: 0, education: 0, clarity: 0, impact: 0 };
    for (const d of docs) {
      const b = (d.review && d.review.breakdown) || {};
      for (const k of Object.keys(sums)) {
        const v = Number(b[k]);
        if (Number.isFinite(v)) { sums[k] += v; counts[k]++; }
      }
    }
    for (const k of Object.keys(sums)) {
      breakdownAvg[k] = counts[k] ? Math.round(sums[k] / counts[k]) : 0;
    }
  }

  // Top skills (frequency across all resumes).
  const skillCounts = new Map();
  for (const d of docs) {
    for (const s of (Array.isArray(d.top_skills) ? d.top_skills : [])) {
      const key = String(s).trim().toLowerCase();
      if (!key) continue;
      skillCounts.set(key, (skillCounts.get(key) || 0) + 1);
    }
  }
  const topSkills = Array.from(skillCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([skill, count]) => ({ skill, count }));

  // Top companies — most-common past employers (lower-cased dedupe, keep label).
  const companyCounts = new Map();
  const companyLabel  = new Map();
  for (const d of docs) {
    for (const c of (Array.isArray(d.companies) ? d.companies : [])) {
      const raw = String(c).trim();
      if (!raw) continue;
      const key = raw.toLowerCase();
      companyCounts.set(key, (companyCounts.get(key) || 0) + 1);
      if (!companyLabel.has(key)) companyLabel.set(key, raw);
    }
  }
  const topCompanies = Array.from(companyCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key, count]) => ({ company: companyLabel.get(key), count }));

  // Years-experience distribution.
  const yearBuckets = [
    { label: '0-1',  min: 0,   max: 1.99 },
    { label: '2-3',  min: 2,   max: 3.99 },
    { label: '4-6',  min: 4,   max: 6.99 },
    { label: '7-10', min: 7,   max: 10.99 },
    { label: '10+',  min: 11,  max: 1000 }
  ].map((b) => ({ ...b, count: 0 }));
  for (const d of docs) {
    const y = Number(d.years_experience);
    if (!Number.isFinite(y)) continue;
    for (const b of yearBuckets) {
      if (y >= b.min && y <= b.max) { b.count++; break; }
    }
  }

  const recent = [...docs]
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
    .slice(0, 8)
    .map((d) => ({
      id: d.id, candidate_name: d.candidate_name, filename: d.filename,
      score: d.score, category: d.category, role_title: d.role_title, created_at: d.created_at
    }));

  // Education breakdown — keyword-bucket highest_education (fallback: first
  // education[].degree) into PhD / Master's / Bachelor's / Diploma / Other.
  const EDU_RULES = [
    { key: 'phd',       label: "PhD / Doctorate", tests: [/\bph\.?\s?d\b/i, /doctorate/i, /\bdoctor\b/i] },
    { key: 'masters',   label: "Master's",        tests: [/\bmaster/i, /\bm\.?tech\b/i, /\bm\.?sc\b/i, /\bm\.?s\.?\b/i, /\bm\.?a\.?\b/i, /\bmba\b/i, /post[- ]?graduat/i] },
    { key: 'bachelors', label: "Bachelor's",      tests: [/\bbachelor/i, /\bb\.?tech\b/i, /\bb\.?sc\b/i, /\bb\.?s\.?\b/i, /\bb\.?a\.?\b/i, /\bb\.?e\.?\b/i, /under[- ]?graduat/i] },
    { key: 'diploma',   label: 'Diploma',         tests: [/\bdiploma\b/i, /\bassociate\b/i, /\bpolytechnic\b/i] }
  ];
  const eduCounts = { phd: 0, masters: 0, bachelors: 0, diploma: 0, other: 0 };
  for (const d of docs) {
    let text = (d.highest_education || '').trim();
    if (!text) {
      const arr = Array.isArray(d.education) ? d.education : [];
      text = (arr[0]?.degree || '').trim();
    }
    if (!text) { eduCounts.other++; continue; }
    const hit = EDU_RULES.find((rule) => rule.tests.some((re) => re.test(text)));
    eduCounts[hit ? hit.key : 'other']++;
  }
  const educationBreakdown = [
    ...EDU_RULES.map((r) => ({ key: r.key, label: r.label, count: eduCounts[r.key] })),
    { key: 'other', label: 'Other / Unknown', count: eduCounts.other }
  ].filter((b) => b.count > 0);

  return {
    total,
    avgScore,
    bands,
    byCategory,
    scoreBuckets: buckets,
    timeline,
    breakdownAvg,
    topSkills,
    topCompanies,
    yearBuckets: yearBuckets.map(({ label, count }) => ({ label, count })),
    educationBreakdown,
    recent,
    generatedAt: new Date().toISOString()
  };
}
