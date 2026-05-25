// Provider-agnostic AI call. Selected by AI_PROVIDER env var.
//
// Supported providers:
//   groq      -> OpenAI-compatible Chat Completions on api.groq.com (default)
//   anthropic -> /v1/messages on api.anthropic.com
//   gemini    -> generateContent on generativelanguage.googleapis.com
//
// All providers receive the SAME prompt and are asked to return STRICT JSON
// matching the shape documented in CLAUDE.md. We parse defensively (strip
// ``` fences, find the first {...} block) so a chatty model doesn't break us.

const SYSTEM_PROMPT = `You are an expert technical recruiter and resume reviewer.
You evaluate resumes objectively on a 0-100 scale.
You ALWAYS respond with a single valid JSON object and nothing else.
Do NOT wrap the JSON in markdown code fences. Do NOT add commentary.`;

// Fixed enum -- the model MUST pick one. Keeps grouping/ranking sane.
// Order roughly mirrors how a recruiter dashboard typically slices.
export const CATEGORIES = [
  'frontend',
  'backend',
  'fullstack',
  'mobile',
  'data',          // data engineer / data analyst / BI
  'ml-ai',         // ML / AI / research / data science
  'devops',        // devops / SRE / platform / cloud
  'security',      // cybersecurity / appsec / infosec
  'qa',            // QA / SDET / test automation
  'design',        // UI / UX / product design
  'product',       // PM / product owner
  'marketing',     // marketing / growth / content
  'sales',
  'hr',            // HR / recruiter / TA
  'other'
];

// Human-friendly labels for the UI; key = enum value above.
export const CATEGORY_LABELS = {
  frontend: 'Frontend',
  backend: 'Backend',
  fullstack: 'Full-stack',
  mobile: 'Mobile',
  data: 'Data',
  'ml-ai': 'ML / AI',
  devops: 'DevOps / SRE',
  security: 'Security',
  qa: 'QA / Test',
  design: 'Design',
  product: 'Product',
  marketing: 'Marketing',
  sales: 'Sales',
  hr: 'HR',
  other: 'Other'
};

function buildUserPrompt(resumeText) {
  return `Score and categorize the following resume.

Return ONLY a JSON object with EXACTLY this shape:
{
  "score": <integer 0-100, overall>,
  "category": <one of: ${CATEGORIES.map((c) => `"${c}"`).join(', ')}>,
  "categoryConfidence": <number 0.0-1.0, your confidence in the category pick>,
  "roleTitle": "<short canonical role title, e.g. 'Senior Frontend Engineer', 'ML Researcher', 'Product Designer'>",
  "candidate": {
    "name":           "<full name, or empty string if not found>",
    "email":          "<primary email, or empty string>",
    "phone":          "<primary phone number, or empty string>",
    "location":       "<city/country, or empty string>",
    "linkedin":       "<full linkedin profile URL, or empty string>",
    "github":         "<full github profile URL, or empty string>",
    "portfolio":      "<personal website / portfolio URL, or empty string>",
    "currentTitle":   "<current or most recent job title, or empty string>",
    "currentCompany": "<current or most recent employer, or empty string>",
    "yearsExperience": <number, total professional years; 0 if unclear>,
    "highestEducation": "<highest degree + field, e.g. 'BSc Computer Science', or empty string>",
    "topSkills":       ["<skill>", "..."],
    "languages":       ["<spoken language>", "..."],
    "noticePeriod":   "<notice period if mentioned, or empty string>",
    "expectedSalary": "<expected salary / CTC if mentioned, or empty string>"
  },
  "breakdown": {
    "experience": <integer 0-100>,
    "skills":     <integer 0-100>,
    "education":  <integer 0-100>,
    "clarity":    <integer 0-100>,
    "impact":     <integer 0-100>
  },
  "summary": "<2-4 sentence summary of the candidate>",
  "strengths":       ["<short bullet>", "..."],
  "concerns":        ["<short bullet>", "..."],
  "recommendations": ["<actionable suggestion to improve the resume>", "..."]
}

Category guidance:
- Pick the SINGLE best-fit category from the enum above based on the candidate's recent / dominant experience, not their education.
- "frontend" = primarily React/Vue/Angular/Web UI work. "backend" = APIs / services. "fullstack" only if BOTH are significant.
- "mobile" = iOS/Android/React Native/Flutter focus.
- "data" = SQL, ETL, dashboards, analytics, data engineering, BI. NOT ML modeling.
- "ml-ai" = ML modeling, LLMs, NLP/CV, research, ML engineering, MLOps.
- "devops" = SRE, platform, cloud, Kubernetes, infra automation.
- "security" = pentest, appsec, infosec, SOC.
- "design" = UI/UX/product design, Figma, design systems.
- If none clearly fit, use "other".

Scoring guidance:
- "experience": seniority, relevance, progression.
- "skills": breadth + depth of technical/role-specific skills.
- "education": degrees, certifications, relevance.
- "clarity": structure, readability, grammar, formatting hints.
- "impact": quantified results, ownership, business outcomes.
- "score" should roughly reflect a weighted view of the breakdown — not a plain average.
- Each list should have 3-6 short bullets. Be specific, cite items from the resume when possible.

Resume text follows between the <RESUME> tags:
<RESUME>
${resumeText}
</RESUME>`;
}

// ---------------------------------------------------------------------------
// Defensive JSON extraction. Some models still wrap output in ```json fences
// or add a sentence before/after. Strip fences, then grab the outermost {...}.
function parseModelJson(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('AI response was empty.');
  }
  let s = raw.trim();

  // Strip ```json ... ``` or ``` ... ``` fences if present.
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  }

  // Grab the outermost JSON object.
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) {
    throw new Error(`AI response did not contain JSON. Raw: ${raw.slice(0, 300)}`);
  }
  const jsonSlice = s.slice(first, last + 1);
  try {
    return JSON.parse(jsonSlice);
  } catch (err) {
    throw new Error(`Failed to parse AI JSON: ${err.message}. Raw: ${raw.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// Groq (OpenAI-compatible) -- default provider.
async function callGroq({ model, prompt }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY is not set in backend/.env');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ]
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq API ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

// ---------------------------------------------------------------------------
// Anthropic Messages API.
async function callAnthropic({ model, prompt }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set in backend/.env');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      temperature: 0.2,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body}`);
  }
  const data = await res.json();
  // content is an array of blocks; concatenate any text blocks.
  const text = (data?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return text;
}

// ---------------------------------------------------------------------------
// Google Gemini generateContent.
async function callGemini({ model, prompt }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set in backend/.env');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json'
      }
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini API ${res.status}: ${body}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('\n');
}

// ---------------------------------------------------------------------------
export async function scoreResume(resumeText) {
  const provider = (process.env.AI_PROVIDER || 'groq').toLowerCase();
  const model = process.env.MODEL || defaultModelFor(provider);

  if (!resumeText || resumeText.trim().length < 30) {
    throw new Error('Extracted resume text is too short to score.');
  }
  // Cap the prompt to keep token usage and latency sane.
  const trimmed = resumeText.slice(0, 20000);
  const prompt = buildUserPrompt(trimmed);

  let raw;
  switch (provider) {
    case 'groq':      raw = await callGroq({ model, prompt }); break;
    case 'anthropic': raw = await callAnthropic({ model, prompt }); break;
    case 'gemini':    raw = await callGemini({ model, prompt }); break;
    default:
      throw new Error(`Unknown AI_PROVIDER "${provider}". Use one of: groq, anthropic, gemini.`);
  }

  const parsed = parseModelJson(raw);
  const shaped = normalizeShape(parsed);
  // Regex fallback: if the model missed any contact field, recover it from
  // the raw text. Resumes don't always put contact info at the top, so this
  // helps the Excel export stay populated.
  shaped.candidate = backfillCandidateFromText(shaped.candidate, resumeText);
  return shaped;
}

// ---------------------------------------------------------------------------
// Regex-based fallbacks for contact info the model didn't surface.

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;
const LINKEDIN_RE = /(https?:\/\/)?(www\.)?linkedin\.com\/(in|pub)\/[A-Za-z0-9-_%]+\/?/i;
const GITHUB_RE = /(https?:\/\/)?(www\.)?github\.com\/[A-Za-z0-9-_.]+\/?/i;
const URL_RE = /https?:\/\/[^\s)]+/i;

function backfillCandidateFromText(candidate, text) {
  const src = String(text || '');
  const out = { ...candidate };
  if (!out.email) {
    const m = src.match(EMAIL_RE);
    if (m) out.email = m[0];
  }
  if (!out.phone) {
    const m = src.match(PHONE_RE);
    if (m) out.phone = m[1].trim();
  }
  if (!out.linkedin) {
    const m = src.match(LINKEDIN_RE);
    if (m) out.linkedin = m[0].startsWith('http') ? m[0] : `https://${m[0]}`;
  }
  if (!out.github) {
    const m = src.match(GITHUB_RE);
    if (m) out.github = m[0].startsWith('http') ? m[0] : `https://${m[0]}`;
  }
  if (!out.portfolio) {
    // Grab the first URL that isn't already captured as linkedin/github.
    const urls = src.match(new RegExp(URL_RE.source, 'gi')) || [];
    for (const u of urls) {
      const low = u.toLowerCase();
      if (low.includes('linkedin.com') || low.includes('github.com')) continue;
      out.portfolio = u.replace(/[.,;]+$/, '');
      break;
    }
  }
  return out;
}

function defaultModelFor(provider) {
  if (provider === 'groq') return 'llama-3.3-70b-versatile';
  if (provider === 'anthropic') return 'claude-sonnet-4-5';
  if (provider === 'gemini') return 'gemini-2.0-flash';
  return '';
}

// Make sure the response always matches the documented shape, even if the
// model omits or mistypes a field. Clamps numeric scores to 0-100.
function normalizeShape(obj) {
  const clamp = (n) => {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(100, v));
  };
  const arr = (a) => (Array.isArray(a) ? a.map(String) : []);
  const b = obj.breakdown || {};

  // Category: must be one of the known enum values. Anything else -> "other".
  let category = String(obj.category || '').toLowerCase().trim();
  if (!CATEGORIES.includes(category)) {
    // Heuristic salvage before giving up: model sometimes returns "Frontend
    // Engineer" or "frontend-developer" etc.
    if (category.includes('front'))      category = 'frontend';
    else if (category.includes('back'))  category = 'backend';
    else if (category.includes('full'))  category = 'fullstack';
    else if (category.includes('mobile') || category.includes('ios') || category.includes('android')) category = 'mobile';
    else if (category.includes('devops') || category.includes('sre') || category.includes('platform')) category = 'devops';
    else if (category.includes('security') || category.includes('pentest')) category = 'security';
    else if (category.includes('qa') || category.includes('test')) category = 'qa';
    else if (category.includes('design') || category.includes('ux') || category.includes('ui')) category = 'design';
    else if (category.includes('product')) category = 'product';
    else if (category.includes('market'))  category = 'marketing';
    else if (category.includes('sales'))   category = 'sales';
    else if (category.includes('hr') || category.includes('recruit')) category = 'hr';
    else if (category.includes('ml') || category.includes('ai') || category.includes('data scien') || category.includes('research')) category = 'ml-ai';
    else if (category.includes('data')) category = 'data';
    else category = 'other';
  }

  const cc = Number(obj.categoryConfidence);
  const categoryConfidence = Number.isFinite(cc) ? Math.max(0, Math.min(1, cc)) : 0.5;

  const c = obj.candidate || {};
  const yrs = Number(c.yearsExperience);
  const candidate = {
    name:             String(c.name || '').slice(0, 120),
    email:            String(c.email || '').slice(0, 200),
    phone:            String(c.phone || '').slice(0, 60),
    location:         String(c.location || '').slice(0, 120),
    linkedin:         String(c.linkedin || '').slice(0, 300),
    github:           String(c.github || '').slice(0, 300),
    portfolio:        String(c.portfolio || '').slice(0, 300),
    currentTitle:     String(c.currentTitle || '').slice(0, 120),
    currentCompany:   String(c.currentCompany || '').slice(0, 120),
    yearsExperience:  Number.isFinite(yrs) ? Math.max(0, Math.min(60, yrs)) : 0,
    highestEducation: String(c.highestEducation || '').slice(0, 200),
    topSkills:        arr(c.topSkills).slice(0, 20),
    languages:        arr(c.languages).slice(0, 10),
    noticePeriod:     String(c.noticePeriod || '').slice(0, 60),
    expectedSalary:   String(c.expectedSalary || '').slice(0, 60)
  };

  return {
    score: clamp(obj.score),
    category,
    categoryConfidence,
    categoryLabel: CATEGORY_LABELS[category],
    roleTitle: String(obj.roleTitle || '').slice(0, 120),
    candidate,
    breakdown: {
      experience: clamp(b.experience),
      skills:     clamp(b.skills),
      education:  clamp(b.education),
      clarity:    clamp(b.clarity),
      impact:     clamp(b.impact)
    },
    summary: String(obj.summary || ''),
    strengths:       arr(obj.strengths),
    concerns:        arr(obj.concerns),
    recommendations: arr(obj.recommendations)
  };
}
