// Chat orchestration with RAG.
//
// Two modes, picked by whether the thread is bound to a resume_id:
//   per-resume   : pass the full review JSON + top-K chunks FROM THAT RESUME
//   cross-resume : retrieve top-K chunks across ALL resumes, group by resume,
//                  include each hit resume's compact review summary
//
// Chat history (last N turns) is included so follow-ups work.
// Chat completion uses the same provider switch as scoring (groq/anthropic/gemini)
// but in free-form text mode (no JSON coercion).

import { retrieve, retrieveHybrid } from './rag.js';
import {
  appendMessage, createThread, getMessages, getThread,
  getResume, getAllResumesForChat, getResumeSummaries, getResumeProfiles, setThreadTitle
} from './db.js';
import { parseRecruiterQueryLLM, searchResumes } from './search.js';

const TOP_K_PER_RESUME   = 6;
const TOP_K_CROSS_RESUME = 20;   // L4: bumped from 10 -> 20 for short queries
const MAX_HISTORY_TURNS  = 20;
const MAX_CANDIDATES_IN_CONTEXT = 30;

const SYSTEM_PROMPT = `You are a recruiting assistant helping the user review and compare scored resumes.
You have access to selected excerpts from those resumes (retrieved via semantic search) plus their AI-generated scores and reviews.

Rules:
- Ground every claim in the provided context. If the context does not support an answer, say so plainly -- do not invent details.
- When referring to a candidate, use their name if known, otherwise the filename.
- Be concise. Use short paragraphs or bullet lists. Skip preamble.
- When comparing or ranking candidates, briefly cite WHY (the score, a quoted phrase, or a specific excerpt).

Citations -- THIS IS REQUIRED:
- Each candidate in the context is prefixed with "Candidate #<id>:" (e.g. "Candidate #42: Jane Doe").
- Every time you reference a candidate in your answer, you MUST tag them with [[#<id>]] using their real id from the context, immediately after their name (or in place of their name).
  Example: "Jane Doe [[#42]] has strong AWS experience, while [[#17]] is a better fit for the junior role."
- NEVER write "Candidate #42" or "#42" by itself -- ALWAYS use the [[#42]] form so the UI can render a clickable chip.
- This applies inside bullet lists, comparisons, and ranked output too.`;

// ---------------------------------------------------------------------------
// Public entrypoint used by the /chat route.

export async function chat({ threadId, resumeId, message }) {
  if (!message || !message.trim()) {
    throw new Error('Empty message.');
  }

  // 1. Resolve or create the thread.
  let thread;
  if (threadId) {
    thread = getThread(threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found.`);
  } else {
    const newId = createThread({ resumeId: resumeId || null, title: null });
    thread = getThread(newId);
  }

  // 2. Persist the user message before doing any AI work, so it's saved
  //    even if the model call fails.
  appendMessage({ threadId: thread.id, role: 'user', content: message });

  // 3. Build the context block (full resume + retrieved chunks, OR cross-resume RAG).
  const contextBlock = thread.resume_id
    ? await buildPerResumeContext({ resumeId: thread.resume_id, query: message })
    : await buildCrossResumeContext({ query: message });

  // 4. Load the chat history (excluding the just-saved user message; we'll add it explicitly).
  const history = getMessages(thread.id, { limit: MAX_HISTORY_TURNS * 2 });
  const priorMessages = history
    .slice(0, -1)  // drop the user message we just appended
    .map((m) => ({ role: m.role, content: m.content }));

  // 5. Compose the final messages and call the chat model.
  const messages = [
    { role: 'user', content: `Context for this conversation:\n\n${contextBlock}\n\n---\n\nUse the context above to answer the user's questions.` },
    { role: 'assistant', content: 'Understood. I will ground my answers in the provided context.' },
    ...priorMessages,
    { role: 'user', content: message }
  ];

  const answer = await callChatModel({ system: SYSTEM_PROMPT, messages });

  // 6. Persist the assistant message.
  appendMessage({ threadId: thread.id, role: 'assistant', content: answer });

  // 7. Auto-title the thread off the first user message.
  if (!thread.title) {
    setThreadTitle(thread.id, message.slice(0, 80));
  }

  return { threadId: thread.id, answer };
}

// Streaming variant. Identical setup to chat() above, but pumps tokens
// through `onToken(token)` as they arrive from the model, then persists the
// full assistant reply at the end. The optional `onMeta({ threadId })`
// callback fires as soon as the thread is resolved -- the SSE endpoint uses
// this to announce the (possibly newly-created) thread id to the client
// before the model produces any tokens.
export async function chatStream({ threadId, resumeId, message }, callbacks = {}) {
  const onToken = typeof callbacks === 'function' ? callbacks : callbacks.onToken;
  const onMeta  = typeof callbacks === 'function' ? null      : callbacks.onMeta;

  if (!message || !message.trim()) throw new Error('Empty message.');

  let thread;
  if (threadId) {
    thread = getThread(threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found.`);
  } else {
    const newId = createThread({ resumeId: resumeId || null, title: null });
    thread = getThread(newId);
  }
  try { onMeta && onMeta({ threadId: thread.id }); } catch { /* */ }

  appendMessage({ threadId: thread.id, role: 'user', content: message });

  const contextBlock = thread.resume_id
    ? await buildPerResumeContext({ resumeId: thread.resume_id, query: message })
    : await buildCrossResumeContext({ query: message });

  const history = getMessages(thread.id, { limit: MAX_HISTORY_TURNS * 2 });
  const priorMessages = history
    .slice(0, -1)
    .map((m) => ({ role: m.role, content: m.content }));

  const messages = [
    { role: 'user', content: `Context for this conversation:\n\n${contextBlock}\n\n---\n\nUse the context above to answer the user's questions.` },
    { role: 'assistant', content: 'Understood. I will ground my answers in the provided context.' },
    ...priorMessages,
    { role: 'user', content: message }
  ];

  let answer = '';
  for await (const token of streamChatModel({ system: SYSTEM_PROMPT, messages })) {
    answer += token;
    try { onToken && onToken(token); } catch { /* ignore consumer-side throw */ }
  }

  appendMessage({ threadId: thread.id, role: 'assistant', content: answer });
  if (!thread.title) setThreadTitle(thread.id, message.slice(0, 80));

  return { threadId: thread.id, answer };
}

// ---------------------------------------------------------------------------
// Context builders

async function buildPerResumeContext({ resumeId, query }) {
  const resume = getResume(resumeId);
  if (!resume) throw new Error(`Resume ${resumeId} not found.`);

  // L4: hybrid retrieval (vectors + BM25 + RRF). For a single resume with a
  // small number of chunks this is mostly the same as vector-only, but it
  // protects keyword-y questions ("which Spring annotations did they use?")
  // from being missed by short-query embeddings.
  let chunks = [];
  try {
    chunks = await retrieveHybrid({ query, resumeId, topK: TOP_K_PER_RESUME });
  } catch (err) {
    console.warn('[chat] retrieveHybrid failed, falling back to raw text:', err.message);
  }

  const header = formatResumeHeader(resume);
  const review = JSON.stringify(resume.review, null, 2);

  let excerpts;
  if (chunks.length > 0) {
    excerpts = chunks.map((c, i) =>
      `[Excerpt ${i + 1} | chunk ${c.chunk_index}]\n${c.text}`
    ).join('\n\n');
  } else {
    excerpts = `[Full resume text]\n${truncate(resume.raw_text, 8000)}`;
  }

  return `${header}\n\nAI review (JSON):\n${review}\n\nRelevant resume excerpts:\n${excerpts}`;
}

async function buildCrossResumeContext({ query }) {
  const all = getAllResumesForChat();
  if (all.length === 0) {
    return '(No resumes have been scored yet. Tell the user to score some resumes first.)';
  }

  // Layer 1 (L3) -- LLM parses the question into a structured filter object.
  // Fast (Llama 8B), close-to-free, handles any phrasing. Falls back to the
  // regex parser inside parseRecruiterQueryLLM if the LLM call fails.
  const parsed = await parseRecruiterQueryLLM(query);
  const filters = parsed.filters || {};
  const usedFilters = Object.keys(filters).length > 0;

  // Layer 2 (L1+L2d) -- ALWAYS pass the raw query as `q` so the LIKE scan
  // over raw_text catches words the parser didn't surface as a typed filter
  // ("Boston", "remote", "fintech", names of schools, etc.).
  let candidateRows = [];
  try {
    candidateRows = searchResumes({ ...filters, q: query, limit: 30 });
  } catch (err) {
    console.warn('[chat] searchResumes failed:', err.message);
  }

  // Layer 3 (L4) -- hybrid retrieval over chunks: vector + BM25 fused with
  // Reciprocal Rank Fusion. Catches the long tail of phrasings the SQL
  // scan would miss (synonyms, paraphrases, semantic-only matches).
  let chunks = [];
  try {
    chunks = await retrieveHybrid({ query, resumeId: null, topK: TOP_K_CROSS_RESUME });
  } catch (err) {
    console.warn('[chat] retrieveHybrid failed:', err.message);
  }

  const hitsByResume = new Map();
  for (const c of chunks) {
    if (!hitsByResume.has(c.resume_id)) hitsByResume.set(c.resume_id, []);
    hitsByResume.get(c.resume_id).push(c);
  }

  // Merge: SQL filter rows first (they matched on structured + raw_text);
  // then RAG-only resumes (matched on chunks but not SQL); finally fall
  // back to ALL resumes if nothing matched at all.
  let resumeIds;
  if (candidateRows.length) {
    const filterIds = candidateRows.map((r) => r.id);
    const ragOnly = Array.from(hitsByResume.keys()).filter((id) => !filterIds.includes(id));
    resumeIds = [...filterIds, ...ragOnly].slice(0, MAX_CANDIDATES_IN_CONTEXT);
  } else if (hitsByResume.size > 0) {
    resumeIds = Array.from(hitsByResume.keys()).slice(0, MAX_CANDIDATES_IN_CONTEXT);
  } else {
    resumeIds = all.map((r) => r.id).slice(0, MAX_CANDIDATES_IN_CONTEXT);
  }

  // L2 -- inject FULL structured profiles, not just review summaries. This
  // means the model sees workLocations, remote flags, companies, domains,
  // managed-people flag, etc. for every candidate in the context, even when
  // those facts weren't in the retrieved chunks.
  const profiles = getResumeProfiles(resumeIds);

  const candidateBlocks = profiles.map((p) => {
    const header  = formatResumeHeader(p);
    const profile = compactProfile(p);
    const review  = compactReview(p.review);
    const excerpts = (hitsByResume.get(p.id) || [])
      .map((c, i) => `  [Excerpt ${i + 1}] ${truncate(c.text, 600)}`)
      .join('\n');
    const parts = [header, profile, review].filter(Boolean);
    if (excerpts) parts.push(`Excerpts:\n${excerpts}`);
    return parts.join('\n');
  }).join('\n\n---\n\n');

  const totalCount = all.length;
  const shownCount = profiles.length;
  const filterNote = usedFilters
    ? `\n(Parsed filters (${parsed.source}): ${JSON.stringify(filters)}.)`
    : '';
  const note = shownCount < totalCount
    ? `\n\n(Showing ${shownCount} of ${totalCount} candidates -- the most relevant for the query.${filterNote})`
    : `\n\n(${totalCount} total candidates available.${filterNote})`;

  return `You have ${totalCount} scored candidates. The following are the most relevant for the current question.\n\n${candidateBlocks}${note}`;
}

// ---------------------------------------------------------------------------
// Formatting helpers

function formatResumeHeader(resume) {
  const name = resume.candidate_name || '(name not detected)';
  const file = resume.filename || '';
  const score = resume.score != null ? `score ${resume.score}/100` : 'unscored';
  return `Candidate #${resume.id}: ${name} -- ${file} -- ${score}`;
}

// One-line-per-fact profile block. Only emits lines we actually have data
// for, so a sparse profile stays short. Crucial -- this is how the model
// SEES the structured fields (remote_worked, work_locations, etc.) without
// us needing to retrieve a chunk that happens to mention them.
function compactProfile(p) {
  if (!p) return '';
  const lines = [];
  if (p.current_title || p.current_company) {
    lines.push(`Current role: ${[p.current_title, p.current_company].filter(Boolean).join(' @ ')}`);
  }
  if (Number.isFinite(p.years_experience) && p.years_experience > 0) {
    lines.push(`Total experience: ${p.years_experience} yrs`);
  }
  if (p.location) lines.push(`Home/base location: ${p.location}`);
  if (Array.isArray(p.work_locations) && p.work_locations.length) {
    lines.push(`Work locations: ${p.work_locations.join('; ')}`);
  }
  if (p.remote_worked) {
    const years = Number(p.remote_years) > 0 ? ` (${p.remote_years} yrs)` : '';
    const ev = p.remote_evidence ? ` — "${p.remote_evidence}"` : '';
    lines.push(`Remote experience: yes${years}${ev}`);
  }
  if (Array.isArray(p.companies) && p.companies.length) {
    lines.push(`Companies: ${p.companies.join('; ')}`);
  }
  if (Array.isArray(p.domains) && p.domains.length) {
    lines.push(`Domains: ${p.domains.join(', ')}`);
  }
  if (p.managed_people) {
    const ts = Number(p.team_size_managed) > 0 ? ` (team of ${p.team_size_managed})` : '';
    lines.push(`Managed people: yes${ts}`);
  }
  if (p.open_to_relocate) lines.push(`Open to relocate: yes`);
  if (p.publications)     lines.push(`Has publications/patents: yes`);
  if (p.highest_education) lines.push(`Education: ${p.highest_education}`);
  if (Array.isArray(p.education) && p.education.length) {
    lines.push(`Schools: ${p.education.map((e) => [e.school, e.degree].filter(Boolean).join(' — ')).join('; ')}`);
  }
  if (Array.isArray(p.top_skills) && p.top_skills.length) {
    lines.push(`Top skills: ${p.top_skills.join(', ')}`);
  }
  if (Array.isArray(p.certifications) && p.certifications.length) {
    lines.push(`Certifications: ${p.certifications.join(', ')}`);
  }
  if (Array.isArray(p.languages) && p.languages.length) {
    lines.push(`Languages: ${p.languages.join(', ')}`);
  }
  return lines.length ? `Profile:\n  ${lines.join('\n  ')}` : '';
}

function compactReview(review) {
  if (!review || typeof review !== 'object') return '';
  const b = review.breakdown || {};
  const parts = [];
  if (review.summary) parts.push(`Summary: ${review.summary}`);
  const breakdown = ['experience', 'skills', 'education', 'clarity', 'impact']
    .map((k) => `${k} ${b[k] ?? '?'}`)
    .join(', ');
  parts.push(`Breakdown: ${breakdown}`);
  if (Array.isArray(review.strengths) && review.strengths.length) {
    parts.push(`Strengths: ${review.strengths.slice(0, 4).join('; ')}`);
  }
  if (Array.isArray(review.concerns) && review.concerns.length) {
    parts.push(`Concerns: ${review.concerns.slice(0, 4).join('; ')}`);
  }
  return parts.join('\n');
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '...' : s;
}

// ---------------------------------------------------------------------------
// Provider-agnostic chat call. Mirrors the switch in ai.js but in
// free-form text mode (no JSON response coercion, larger max tokens).

export async function callChatModel({ system, messages }) {
  const provider = (process.env.AI_PROVIDER || 'groq').toLowerCase();
  const model = process.env.CHAT_MODEL || process.env.MODEL || defaultChatModelFor(provider);

  switch (provider) {
    case 'groq':      return chatGroq({ model, system, messages });
    case 'anthropic': return chatAnthropic({ model, system, messages });
    case 'gemini':    return chatGemini({ model, system, messages });
    default:
      throw new Error(`Unknown AI_PROVIDER "${provider}". Use one of: groq, anthropic, gemini.`);
  }
}

// Streaming async generator. For providers that don't support stream-mode
// (anthropic/gemini in this file), falls back to a single non-streaming call
// and yields the whole reply at the end -- consumer code stays identical.
export async function* streamChatModel({ system, messages }) {
  const provider = (process.env.AI_PROVIDER || 'groq').toLowerCase();
  const model = process.env.CHAT_MODEL || process.env.MODEL || defaultChatModelFor(provider);

  if (provider === 'groq') {
    yield* chatGroqStream({ model, system, messages });
    return;
  }
  // Fallback: non-streaming providers. Yield the whole answer in one go.
  const full = await callChatModel({ system, messages });
  yield full;
}

// Groq OpenAI-compatible streaming. Yields content deltas. Skips role-only
// deltas and the [DONE] sentinel.
async function* chatGroqStream({ model, system, messages }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY is not set in backend/.env');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      stream: true,
      messages: [{ role: 'system', content: system }, ...messages]
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq chat stream ${res.status}: ${body}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by blank lines; within a frame, "data: ..." lines.
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // tolerate partial frames -- they'll arrive on the next read
      }
    }
  }
}

function defaultChatModelFor(provider) {
  if (provider === 'groq')      return 'llama-3.3-70b-versatile';
  if (provider === 'anthropic') return 'claude-sonnet-4-5';
  if (provider === 'gemini')    return 'gemini-2.0-flash';
  return '';
}

async function chatGroq({ model, system, messages }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY is not set in backend/.env');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [{ role: 'system', content: system }, ...messages]
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq chat ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

async function chatAnthropic({ model, system, messages }) {
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
      temperature: 0.3,
      system,
      messages
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic chat ${res.status}: ${body}`);
  }
  const data = await res.json();
  return (data?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// One-shot summarization. Reuses the same chat-model provider switch as
// the conversational endpoint, but with a tight system prompt and no
// retrieval. Returns plain text (3-4 sentences).
//
// Used by /summarize for resumes the user hasn't fully scored yet, or
// when re-summarizing on demand. Cheap: one short prompt, no JSON, no DB
// writes, no embedding.

const SUMMARY_SYSTEM_PROMPT = `You write tight, factual resume summaries.
- Output 3-4 sentences of plain prose (no bullets, no markdown).
- Cover: seniority + role, main technical strengths, notable achievements.
- No commentary, no greeting, no "this resume". Start directly with the candidate.`;

export async function summarizeText(resumeText) {
  if (!resumeText || resumeText.trim().length < 30) {
    throw new Error('Resume text is too short to summarize.');
  }
  // Cap input the same way scoreResume does, to keep latency + cost sane.
  const trimmed = resumeText.slice(0, 20000);
  const messages = [
    { role: 'user', content: `Summarize this resume:\n\n<RESUME>\n${trimmed}\n</RESUME>` }
  ];
  const text = await callChatModel({ system: SUMMARY_SYSTEM_PROMPT, messages });
  return text.trim();
}

async function chatGemini({ model, system, messages }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set in backend/.env');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  // Gemini wants 'model' role, not 'assistant'.
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature: 0.3 }
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini chat ${res.status}: ${body}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('\n');
}
