// Resume Scorer -- local backend.
// Endpoints:
//   GET  /health                liveness check
//   POST /score                 { filename, contentType, contentBase64, emailId?, attachmentId? } -> scored JSON (+ resumeId)
//   POST /score-text            { text, filename? }
//   POST /classify              { filename, contentType, contentBase64 } -> { isResume, ... }
//   GET  /resumes               list scored resumes
//   GET  /resumes/:id           full resume + review
//   DELETE /resumes/:id         remove a resume + its chunks/threads
//   GET  /threads               list chat threads
//   GET  /threads/:id/messages  messages in a thread
//   POST /chat                  { threadId?, resumeId?, message } -> { threadId, answer }
//   POST /summarize             { resumeId } | { contentBase64, filename } | { text } -> { summary, cached }

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import ExcelJS from 'exceljs';

import { extractText } from './extract.js';
import { scoreResume } from './ai.js';
import { classifyAsResume } from './classify.js';
import { indexResume } from './rag.js';
import { chat, chatStream, summarizeText } from './chat.js';
import { matchJobDescription, matchJobDescriptionWithReasons } from './match.js';
import { searchResumes, parseRecruiterQuery, getStats } from './search.js';
import {
  getDb, insertResume, listResumes, listResumesByCategory, getResume,
  listResumesForExport, listThreads, getThread, getMessages
} from './db.js';
import {
  ensureAutomationSchema, seedDefaults,
  listWorkflows, getWorkflow, createWorkflow, updateWorkflow, deleteWorkflow,
  listRuns, getRun,
  listInterviewers, createInterviewer, deleteInterviewer,
  addAvailabilityWindow, removeAvailabilityWindow,
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate
} from './automationDb.js';
import { runWorkflow } from './automation.js';
import {
  googleConfigured, googleConnected, googleProfile,
  getAuthUrl, exchangeCode, disconnectGoogle
} from './google.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = join(__dirname, 'uploads');
const PUBLIC_DIR = join(__dirname, 'public');
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

const app = express();

// 10 MB is plenty for a resume attachment (base64 inflates by ~33%).
app.use(express.json({ limit: '15mb' }));
app.use(cors()); // MVP: allow any origin, including chrome-extension://...

// Serve the dashboard SPA from /. GET / -> public/index.html, all other
// public/* assets get served statically. Routes below take priority.
app.use('/', express.static(PUBLIC_DIR, { extensions: ['html'] }));

// Shared filter coercion for /resumes/search (GET + POST).
function readSearchFilters(src) {
  const num = (v) => {
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const list = (v) => {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === 'string' && v.trim()) {
      return v.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return undefined;
  };
  return {
    q:        src.q != null ? String(src.q) : undefined,
    category: src.category != null ? String(src.category) : undefined,
    minScore: num(src.minScore),
    maxScore: num(src.maxScore),
    minYears: num(src.minYears),
    maxYears: num(src.maxYears),
    skills:   list(src.skills),
    location: src.location != null ? String(src.location) : undefined,
    limit:    num(src.limit)
  };
}

// Touch the DB on startup so a misconfigured sqlite-vec binary fails loudly
// at boot rather than on the first chat request.
getDb();
ensureAutomationSchema();
try { seedDefaults(); } catch (err) { console.warn('[automation] seed failed:', err.message); }

// In-process pub/sub for dashboard live updates. Every connected /events
// client gets a frame whenever a resume is scored (from /score, /score-text,
// the extension auto-poller, anywhere). Keeps the dashboard in sync without
// the user having to hit Refresh.
const events = new EventEmitter();
events.setMaxListeners(50);

function broadcast(eventName, payload) {
  events.emit(eventName, payload);
}

// Server-Sent Events feed. Long-lived GET — the dashboard subscribes here at
// boot, then re-renders whenever a `resume:scored` frame arrives. Saves the
// user from clicking Refresh after every Outlook auto-poll.
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const write = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  write('hello', { ok: true, ts: Date.now() });

  const onScored = (payload) => write('resume:scored', payload);
  events.on('resume:scored', onScored);

  // Comment frames (": ping") count as keep-alive for proxies / EventSource.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    events.off('resume:scored', onScored);
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    provider: process.env.AI_PROVIDER || 'groq',
    model: process.env.MODEL || '(default)',
    embedProvider: process.env.EMBED_PROVIDER || 'google',
    time: new Date().toISOString()
  });
});

app.post('/score', async (req, res) => {
  const { filename, contentType, contentBase64, emailId, attachmentId } = req.body || {};
  if (!contentBase64 || typeof contentBase64 !== 'string') {
    return res.status(400).json({ error: 'Missing contentBase64 in request body.' });
  }

  try {
    const buffer = Buffer.from(contentBase64, 'base64');
    const text = await extractText({ filename, contentType, buffer });

    if (!text || text.trim().length < 30) {
      return res.status(422).json({
        error: 'Could not extract enough text from the attachment. Is it a real resume PDF/DOCX (not a scan)?'
      });
    }

    const scored = await scoreResume(text);

    // Persist + index. Indexing requires an embedding key; if that fails we
    // still keep the row + score (chunks will just be missing).
    const candidateName = scored.candidate?.name || guessCandidateName(text);
    const filePath = await saveAttachment(buffer, filename, contentType);
    const { id: resumeId, isNew } = insertResume({
      emailId, attachmentId,
      filename: filename || 'resume',
      candidateName,
      rawText: text,
      score: scored.score,
      category: scored.category,
      roleTitle: scored.roleTitle,
      reviewJson: scored,
      candidate: scored.candidate,
      filePath,
      contentType
    });

    let indexed = { chunks: 0 };
    if (isNew) {
      try {
        indexed = await indexResume(resumeId, text);
      } catch (err) {
        console.warn(`[/score] indexing failed for resume ${resumeId}:`, err.message);
      }
    }

    broadcast('resume:scored', {
      resumeId, candidateName, isNew,
      score: scored.score,
      category: scored.category,
      categoryLabel: scored.categoryLabel,
      roleTitle: scored.roleTitle,
      filename: filename || 'resume',
      ts: Date.now()
    });

    res.json({ ...scored, resumeId, candidateName, chunks: indexed.chunks });
  } catch (err) {
    console.error('[/score] error:', err);
    res.status(500).json({ error: err.message || 'Internal error scoring resume.' });
  }
});

// Cheap classifier: does this attachment look like a resume?
app.post('/classify', async (req, res) => {
  const { filename, contentType, contentBase64 } = req.body || {};
  if (!contentBase64 || typeof contentBase64 !== 'string') {
    return res.status(400).json({ error: 'Missing contentBase64 in request body.' });
  }
  try {
    const buffer = Buffer.from(contentBase64, 'base64');
    const text = await extractText({ filename, contentType, buffer });
    const result = classifyAsResume(text);
    res.json(result);
  } catch (err) {
    console.error('[/classify] error:', err);
    res.json({ isResume: false, confidence: 0, signals: [], reason: `extract failed: ${err.message}` });
  }
});

// Useful for layer-1 smoke testing without a real attachment.
app.post('/score-text', async (req, res) => {
  const { text, filename } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing "text" in request body.' });
  }
  try {
    const scored = await scoreResume(text);

    const candidateName = scored.candidate?.name || guessCandidateName(text);
    const { id: resumeId, isNew } = insertResume({
      filename: filename || 'pasted-text.txt',
      candidateName,
      rawText: text,
      score: scored.score,
      category: scored.category,
      roleTitle: scored.roleTitle,
      reviewJson: scored,
      candidate: scored.candidate
    });

    let indexed = { chunks: 0 };
    if (isNew) {
      try {
        indexed = await indexResume(resumeId, text);
      } catch (err) {
        console.warn(`[/score-text] indexing failed:`, err.message);
      }
    }

    broadcast('resume:scored', {
      resumeId, candidateName, isNew,
      score: scored.score,
      category: scored.category,
      categoryLabel: scored.categoryLabel,
      roleTitle: scored.roleTitle,
      filename: filename || 'pasted-text.txt',
      ts: Date.now()
    });

    res.json({ ...scored, resumeId, candidateName, chunks: indexed.chunks });
  } catch (err) {
    console.error('[/score-text] error:', err);
    res.status(500).json({ error: err.message || 'Internal error scoring resume.' });
  }
});

// ---------------------------------------------------------------------------
// Resumes

app.get('/resumes', (_req, res) => {
  try {
    res.json({ resumes: listResumes() });
  } catch (err) {
    console.error('[/resumes] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Ranked-by-category view. Each group is sorted by score desc.
app.get('/resumes/by-category', (_req, res) => {
  try {
    res.json({ groups: listResumesByCategory() });
  } catch (err) {
    console.error('[/resumes/by-category] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Structured search. Must be defined BEFORE /resumes/:id or that route
// captures "search" as the id and returns 400.
app.get('/resumes/search', (req, res) => {
  try {
    const filters = readSearchFilters(req.query || {});
    res.json({ filters, results: searchResumes(filters) });
  } catch (err) {
    console.error('[/resumes/search] error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/resumes/search', (req, res) => {
  try {
    const filters = readSearchFilters(req.body || {});
    res.json({ filters, results: searchResumes(filters) });
  } catch (err) {
    console.error('[/resumes/search POST] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve the original PDF/DOCX bytes for a stored resume. This is what the
// "Resume link" column in the Excel export points to. Defined BEFORE
// /resumes/:id so the more-specific route wins.
app.get('/resumes/:id/file', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const resume = getResume(id);
  if (!resume) return res.status(404).json({ error: 'Resume not found.' });
  if (!resume.file_path) return res.status(404).json({ error: 'No file stored for this resume.' });

  const abs = join(__dirname, resume.file_path);
  if (!existsSync(abs)) return res.status(404).json({ error: 'File missing on disk.' });

  res.setHeader('Content-Type', resume.content_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(resume.filename || 'resume')}"`);
  res.sendFile(abs);
});

// Excel export of every scored resume. One row per candidate, ranked by score
// desc. The "Resume File" column is a clickable link back to this server.
// MUST be defined before /resumes/:id, otherwise that route swallows it.
app.get('/resumes/export.xlsx', async (req, res) => {
  try {
    const rows = listResumesForExport();
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Resume Scorer';
    wb.created = new Date();
    const ws = wb.addWorksheet('Candidates', {
      views: [{ state: 'frozen', ySplit: 1 }]
    });

    ws.columns = [
      { header: 'Rank',            key: 'rank',         width: 6  },
      { header: 'Candidate Name',  key: 'name',         width: 24 },
      { header: 'Score',           key: 'score',        width: 8  },
      { header: 'Category',        key: 'category',     width: 14 },
      { header: 'Role Title (AI)', key: 'roleTitle',    width: 24 },
      { header: 'Summary',         key: 'summary',      width: 60 },
      { header: 'Email',           key: 'email',        width: 28 },
      { header: 'Phone',           key: 'phone',        width: 18 },
      { header: 'Location',        key: 'location',     width: 22 },
      { header: 'Current Title',   key: 'currentTitle', width: 24 },
      { header: 'Current Company', key: 'currentCompany', width: 22 },
      { header: 'Years Experience', key: 'years',       width: 10 },
      { header: 'Highest Education', key: 'education',  width: 26 },
      { header: 'Top Skills',      key: 'skills',       width: 40 },
      { header: 'Languages',       key: 'languages',    width: 18 },
      { header: 'Notice Period',   key: 'notice',       width: 14 },
      { header: 'Expected Salary', key: 'salary',       width: 16 },
      { header: 'LinkedIn',        key: 'linkedin',     width: 30 },
      { header: 'GitHub',          key: 'github',       width: 30 },
      { header: 'Portfolio',       key: 'portfolio',    width: 30 },
      { header: 'Resume File',     key: 'fileLink',     width: 18 },
      { header: 'Source Filename', key: 'filename',     width: 26 },
      { header: 'Added',           key: 'created',      width: 20 }
    ];

    // Style the header row.
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A66C2' } };
    header.alignment = { vertical: 'middle', horizontal: 'left' };
    header.height = 22;

    rows.forEach((r, i) => {
      const fileUrl = r.file_path ? `${baseUrl}/resumes/${r.id}/file` : '';
      const created = r.created_at ? new Date(r.created_at).toISOString() : '';
      // Short summary -- pulled from the cached AI review so this is FREE
      // (no extra Groq call). Falls back to a tight slice of raw_text if
      // the review didn't include one.
      let summary = '';
      try {
        const fullRow = getResume(r.id);
        summary = fullRow?.review?.summary || '';
        if (!summary && fullRow?.raw_text) {
          summary = fullRow.raw_text.slice(0, 240).replace(/\s+/g, ' ').trim();
        }
      } catch { /* ignore */ }
      const row = ws.addRow({
        rank: i + 1,
        name: r.candidate_name || '',
        score: Number.isFinite(r.score) ? r.score : '',
        category: r.category || '',
        roleTitle: r.role_title || '',
        summary,
        email: r.email || '',
        phone: r.phone || '',
        location: r.location || '',
        currentTitle: r.current_title || '',
        currentCompany: r.current_company || '',
        years: Number.isFinite(r.years_experience) ? r.years_experience : '',
        education: r.highest_education || '',
        skills: (r.top_skills || []).join(', '),
        languages: (r.languages || []).join(', '),
        notice: r.notice_period || '',
        salary: r.expected_salary || '',
        linkedin: r.linkedin || '',
        github: r.github || '',
        portfolio: r.portfolio || '',
        fileLink: fileUrl ? { text: 'Download', hyperlink: fileUrl } : '',
        filename: r.filename || '',
        created
      });
      // Wrap the long summary cell so spreadsheets render it nicely.
      const sumCell = row.getCell('summary');
      sumCell.alignment = { wrapText: true, vertical: 'top' };
      // Color-band the score cell to mirror the dashboard.
      const scoreCell = row.getCell('score');
      const s = Number(r.score);
      if (Number.isFinite(s)) {
        const argb = s >= 75 ? 'FFDAFBE1' : s >= 50 ? 'FFFFF8C5' : 'FFFFEBE9';
        scoreCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
        scoreCell.font = { bold: true };
      }
      // Make link/URL cells render as hyperlinks.
      for (const k of ['linkedin', 'github', 'portfolio']) {
        const v = row.getCell(k).value;
        if (v && typeof v === 'string' && /^https?:\/\//i.test(v)) {
          row.getCell(k).value = { text: v, hyperlink: v };
        }
      }
      const fl = row.getCell('fileLink');
      if (fl.value && typeof fl.value === 'object') {
        fl.font = { color: { argb: 'FF0A66C2' }, underline: true };
      }
    });

    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="resumes-${stamp}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[/resumes/export.xlsx] error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/resumes/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const resume = getResume(id);
  if (!resume) return res.status(404).json({ error: 'Resume not found.' });
  res.json(resume);
});

app.delete('/resumes/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    // ON DELETE CASCADE handles chunks + threads + messages.
    // chunk_vectors aren't cascaded by FKs (vec0 isn't a regular table),
    // so we clean them up explicitly.
    const db = getDb();
    db.prepare(`DELETE FROM chunk_vectors WHERE rowid IN (SELECT id FROM chunks WHERE resume_id = ?)`).run(id);
    const info = db.prepare(`DELETE FROM resumes WHERE id = ?`).run(id);
    res.json({ deleted: info.changes });
  } catch (err) {
    console.error('[DELETE /resumes/:id] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Dashboard stats + structured search.

app.get('/stats', (_req, res) => {
  try {
    res.json(getStats());
  } catch (err) {
    console.error('[/stats] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Job description -> ranked candidates. Embeds the JD locally, runs vector
// search across every resume chunk, aggregates per candidate, and (unless
// reasons=false) makes ONE LLM call to write a 1-line fit reason for each.
//
// Body: { jobDescription, topK?, reasons? }
// Returns: { results: [{ resumeId, candidateName, score, matchScore, reason, bestExcerpt }] }
app.post('/match', async (req, res) => {
  const { jobDescription, topK, reasons } = req.body || {};
  if (!jobDescription || typeof jobDescription !== 'string' || jobDescription.trim().length < 20) {
    return res.status(400).json({ error: 'jobDescription must be at least 20 characters.' });
  }
  try {
    const k = Number.isFinite(Number(topK)) ? Math.max(1, Math.min(20, Number(topK))) : 5;
    const fn = reasons === false ? matchJobDescription : matchJobDescriptionWithReasons;
    const results = await fn(jobDescription, { topK: k });
    res.json({ count: results.length, results });
  } catch (err) {
    console.error('[/match] error:', err);
    res.status(500).json({ error: err.message || 'Internal error matching JD.' });
  }
});

// Recruiter-style natural-language parser endpoint. Useful for showing the
// user "we read your question as ...". Doesn't call the AI -- pure regex.
app.post('/parse-query', (req, res) => {
  const { query } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing "query" in request body.' });
  }
  res.json(parseRecruiterQuery(query));
});

// ---------------------------------------------------------------------------
// Chat

app.get('/threads', (_req, res) => {
  try {
    res.json({ threads: listThreads() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/threads/:id/messages', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const thread = getThread(id);
  if (!thread) return res.status(404).json({ error: 'Thread not found.' });
  res.json({ thread, messages: getMessages(id) });
});

app.delete('/threads/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const db = getDb();
    const info = db.prepare('DELETE FROM chat_threads WHERE id = ?').run(id);
    res.json({ deleted: info.changes });
  } catch (err) {
    console.error('[DELETE /threads/:id] error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/chat', async (req, res) => {
  const { threadId, resumeId, message } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Missing "message" in request body.' });
  }
  try {
    const result = await chat({
      threadId: threadId ? Number(threadId) : null,
      resumeId: resumeId ? Number(resumeId) : null,
      message
    });
    res.json(result);
  } catch (err) {
    console.error('[/chat] error:', err);
    res.status(500).json({ error: err.message || 'Internal error during chat.' });
  }
});

// SSE streaming chat. Events:
//   event: thread   data: { threadId }
//   data: { token: "..." }       (one frame per model delta)
//   event: done     data: {}
//   event: error    data: { error }
app.post('/chat/stream', async (req, res) => {
  const { threadId, resumeId, message } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Missing "message" in request body.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');     // disable proxy buffering
  res.flushHeaders?.();

  const write = (event, data) => {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Heartbeat every 15s so intermediate proxies don't kill the socket while
  // the model is "thinking" before the first token.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => clearInterval(heartbeat));

  try {
    const result = await chatStream(
      {
        threadId: threadId ? Number(threadId) : null,
        resumeId: resumeId ? Number(resumeId) : null,
        message
      },
      {
        onMeta:  (meta)  => write('thread', meta),
        onToken: (token) => write(null, { token })
      }
    );
    write('done', { threadId: result.threadId });
  } catch (err) {
    console.error('[/chat/stream] error:', err);
    write('error', { error: err.message || 'stream failed' });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// ---------------------------------------------------------------------------
// Summarize a resume.
//
// Three input modes, in order of preference:
//   1) { resumeId }                            -> returns stored review.summary, no AI call
//   2) { contentBase64, filename, contentType }-> extracts + cheap AI summary
//   3) { text }                                -> cheap AI summary
//
// Response: { summary, cached, resumeId? }
app.post('/summarize', async (req, res) => {
  const { resumeId, contentBase64, filename, contentType, text } = req.body || {};

  try {
    // Mode 1: stored summary lookup (free, instant).
    if (resumeId) {
      const id = Number(resumeId);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid resumeId.' });
      const resume = getResume(id);
      if (!resume) return res.status(404).json({ error: 'Resume not found.' });
      const cached = resume.review?.summary;
      if (cached && cached.trim()) {
        return res.json({ summary: cached, cached: true, resumeId: id });
      }
      // Fall through: resume exists but has no stored summary -- generate one.
      const summary = await summarizeText(resume.raw_text);
      return res.json({ summary, cached: false, resumeId: id });
    }

    // Mode 2: raw attachment (PDF/DOCX base64).
    if (contentBase64 && typeof contentBase64 === 'string') {
      const buffer = Buffer.from(contentBase64, 'base64');
      const extracted = await extractText({ filename, contentType, buffer });
      if (!extracted || extracted.trim().length < 30) {
        return res.status(422).json({
          error: 'Could not extract enough text from the attachment.'
        });
      }
      const summary = await summarizeText(extracted);
      return res.json({ summary, cached: false });
    }

    // Mode 3: plain text.
    if (text && typeof text === 'string') {
      const summary = await summarizeText(text);
      return res.json({ summary, cached: false });
    }

    return res.status(400).json({
      error: 'Send one of: { resumeId } | { contentBase64, filename, contentType } | { text }.'
    });
  } catch (err) {
    console.error('[/summarize] error:', err);
    res.status(500).json({ error: err.message || 'Internal error summarizing.' });
  }
});

// ---------------------------------------------------------------------------

// Persist an uploaded attachment to backend/uploads/ so we can later serve it
// as the "Resume File" link in the Excel export. Returns a path relative to
// the backend directory (DB-stable across machines).
async function saveAttachment(buffer, filename, contentType) {
  const safeName = String(filename || 'resume').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  let ext = extname(safeName);
  if (!ext) {
    if ((contentType || '').includes('pdf')) ext = '.pdf';
    else if ((contentType || '').includes('word') || (contentType || '').includes('officedocument')) ext = '.docx';
    else ext = '.bin';
  }
  const base = safeName.replace(/\.[^.]+$/, '') || 'resume';
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}${ext}`;
  const abs = join(UPLOADS_DIR, unique);
  await fs.writeFile(abs, buffer);
  return join('uploads', unique).replace(/\\/g, '/');
}

// First non-empty line, capped. Resumes typically start with the candidate's
// name. Falls back to null if the line looks too long or noisy.
function guessCandidateName(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 5)) {
    // Skip anything that looks like a header/contact line.
    if (/[@:/]|www\.|http|\+\d|\d{3}/.test(line)) continue;
    if (line.length > 60) continue;
    if (line.split(/\s+/).length > 6) continue;
    return line;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Automation builder — workflows, runs, integrations, interviewers, templates

app.get('/automation/workflows', (_req, res) => {
  try { res.json({ workflows: listWorkflows() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/automation/workflows/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const wf = getWorkflow(id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found.' });
  res.json(wf);
});

app.post('/automation/workflows', (req, res) => {
  const { name, description, graph } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Missing workflow name.' });
  try {
    const id = createWorkflow({ name, description, graph });
    res.json({ id, workflow: getWorkflow(id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/automation/workflows/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const ok = updateWorkflow(id, req.body || {});
    if (!ok) return res.status(404).json({ error: 'Workflow not found.' });
    res.json({ ok: true, workflow: getWorkflow(id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/automation/workflows/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  res.json({ deleted: deleteWorkflow(id) });
});

// Run / dry-run a workflow. Body: { mode, candidateIds?, overrides? }
app.post('/automation/workflows/:id/run', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const { mode = 'live', candidateIds = null, overrides = {} } = req.body || {};
  try {
    const result = await runWorkflow(id, { mode, candidateIds, manualOverrides: overrides });
    res.json(result);
  } catch (err) {
    console.error('[/automation/run] error:', err);
    res.status(500).json({ error: err.message || 'Workflow run failed.' });
  }
});

app.get('/automation/runs', (req, res) => {
  const workflowId = req.query.workflowId ? Number(req.query.workflowId) : undefined;
  res.json({ runs: listRuns({ workflowId, limit: 50 }) });
});

app.get('/automation/runs/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const run = getRun(id);
  if (!run) return res.status(404).json({ error: 'Run not found.' });
  res.json(run);
});

// --- Google integration ---

app.get('/automation/google/status', (_req, res) => {
  res.json({
    configured: googleConfigured(),
    connected:  googleConnected(),
    profile:    googleProfile(),
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8787/automation/google/callback'
  });
});

app.get('/automation/google/auth', (_req, res) => {
  try { res.json({ url: getAuthUrl() }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/automation/google/callback', async (req, res) => {
  const { code, error } = req.query || {};
  if (error) {
    return res.status(400).send(`<h2>Google auth failed</h2><p>${escapeHtml(String(error))}</p>`);
  }
  if (!code) return res.status(400).send('Missing code.');
  try {
    await exchangeCode(String(code));
    res.send(`
      <!doctype html><html><body style="font-family:Inter,sans-serif;padding:40px;background:#f8f7f4;">
        <h2 style="color:#244841;">Google connected ✓</h2>
        <p>You can close this tab and return to the dashboard.</p>
        <script>setTimeout(() => { window.close(); }, 1500);</script>
      </body></html>
    `);
  } catch (err) {
    console.error('[google callback]', err);
    res.status(500).send(`<h2>Google auth error</h2><pre>${escapeHtml(err.message)}</pre>`);
  }
});

app.post('/automation/google/disconnect', (_req, res) => {
  disconnectGoogle();
  res.json({ ok: true });
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// --- Interviewers ---

app.get('/automation/interviewers', (_req, res) => {
  res.json({ interviewers: listInterviewers() });
});
app.post('/automation/interviewers', (req, res) => {
  const { name, email, calendarId, timezone } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email are required.' });
  const id = createInterviewer({ name, email, calendarId, timezone });
  res.json({ id, interviewers: listInterviewers() });
});
app.delete('/automation/interviewers/:id', (req, res) => {
  res.json({ deleted: deleteInterviewer(Number(req.params.id)) });
});

// Add an availability window. Body: { start: ISO, end: ISO }
app.post('/automation/interviewers/:id/availability', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = addAvailabilityWindow(id, req.body || {});
    res.json({ ok: true, ...r, interviewers: listInterviewers() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/automation/interviewers/:id/availability/:windowId', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const removed = removeAvailabilityWindow(id, String(req.params.windowId));
  res.json({ deleted: removed, interviewers: listInterviewers() });
});

// --- OA email templates ---

app.get('/automation/templates', (_req, res) => {
  res.json({ templates: listTemplates() });
});
app.get('/automation/templates/:id', (req, res) => {
  const t = getTemplate(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Template not found.' });
  res.json(t);
});
app.post('/automation/templates', (req, res) => {
  const { name, subject, body, oaLink } = req.body || {};
  if (!name || !subject || !body) return res.status(400).json({ error: 'name, subject, body required.' });
  const id = createTemplate({ name, subject, body, oaLink });
  res.json({ id, templates: listTemplates() });
});
app.put('/automation/templates/:id', (req, res) => {
  const ok = updateTemplate(Number(req.params.id), req.body || {});
  if (!ok) return res.status(404).json({ error: 'Template not found.' });
  res.json({ ok: true, templates: listTemplates() });
});
app.delete('/automation/templates/:id', (req, res) => {
  res.json({ deleted: deleteTemplate(Number(req.params.id)) });
});

// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 8787;
app.listen(PORT, () => {
  console.log(`Resume Scorer backend listening on http://localhost:${PORT}`);
  console.log(`  ai provider:    ${process.env.AI_PROVIDER || 'groq'}`);
  console.log(`  ai model:       ${process.env.MODEL || '(default)'}`);
  console.log(`  embed provider: ${process.env.EMBED_PROVIDER || 'google'}`);
});
