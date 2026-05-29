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
import helmet from 'helmet';
import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, extname, resolve as resolvePath, sep as pathSep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import ExcelJS from 'exceljs';

import { extractText } from './extract.js';
import { scoreResume } from './ai.js';
import { classifyAsResume } from './classify.js';
import { indexResume } from './rag.js';
import { chat, chatStream, summarizeText } from './chat.js';
import { segregateResumes } from './segregate.js';
import { searchResumes, parseRecruiterQuery, getStats } from './search.js';
import {
  insertResume, listResumes, listResumesByCategory, getResume,
  getResumeByEmailAttachment,
  listResumesForExport, listThreads, getThread, getMessages,
  deleteResume, deleteThread
} from './db.js';
import { mongoStatus, getMongoDb } from './mongo.js';
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
  getAuthUrl, exchangeCode, disconnectGoogle,
  validIanaTimeZone,
  listGmailResumeEmails, downloadGmailAttachment
} from './google.js';
import {
  imapStatus, imapConfigured, setImapConfig, disconnectImap,
  testImapConnection, fetchImapResumes,
  listImapResumeEmails, downloadImapAttachment
} from './imap.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = join(__dirname, 'uploads');
const PUBLIC_DIR = join(__dirname, 'public');
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

const app = express();

// Behind a reverse proxy (Render, Fly, nginx, Cloudflare) we need this so
// req.secure / req.ip reflect the real client, not the proxy. Required for
// the HTTPS redirect below and for express-rate-limit's per-IP keying.
app.set('trust proxy', 1);

// helmet sets a stack of safe-default security headers:
//   - Strict-Transport-Security (HSTS): tells browsers "only ever talk to me
//     over HTTPS for the next year", so a coffee-shop attacker can't downgrade
//     a future session to HTTP and sniff it.
//   - X-Content-Type-Options: nosniff, X-Frame-Options: deny, Referrer-Policy,
//     and a handful of other small wins.
// We disable CSP because it interferes with the inline scripts in the
// dashboard SPA. We also relax the cross-origin policies because:
//   - The Chrome extension (origin chrome-extension://...) needs to read
//     responses from this backend. helmet's default CORP "same-origin"
//     would block that.
//   - The dashboard fetches resume PDFs and embeds them inline.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
}));

// Force HTTPS in production. In dev (NODE_ENV !== 'production') we stay on
// plain HTTP so localhost works without a cert.
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  });
}

// 10 MB is plenty for a resume attachment (base64 inflates by ~33%).
// Lowered from 15 MB to shrink the surface area for memory-pressure DoS.
app.use(express.json({ limit: '10mb' }));
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

// DB startup runs in init() before app.listen (bottom of this file): connect
// to Mongo (required), ensure indexes, and seed automation defaults.

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
    mongo: mongoStatus(),
    time: new Date().toISOString()
  });
});

// Mongo status. (The one-time SQLite->Mongo import lives in the standalone
// migrate-to-mongo.js script; Mongo is the source of truth now.)
app.get('/mongo/status', (_req, res) => {
  res.json(mongoStatus());
});

// Core scoring pipeline, shared by /score (extension uploads / Outlook / Gmail)
// and /imap/sync (server-side custom-domain pull). Given raw bytes + optional
// (emailId, attachmentId) cache keys it: returns the cached review on a hit, or
// extracts text -> scores -> persists -> indexes -> broadcasts on a miss.
// Throws an Error with code 'NO_TEXT' when the attachment yields too little
// text to score. Callers map the result to their own response shape.
async function processResume({ buffer, filename, contentType, emailId, attachmentId }) {
  // Cache hit: this exact (email_id, attachment_id) was already scored.
  // Skip extractText + scoreResume entirely (the expensive LLM call) and
  // return the previously stored review. Saves the full ~2-4k LLM tokens per
  // duplicate -- which is what makes re-syncing an IMAP mailbox cheap.
  if (emailId && attachmentId) {
    const cached = await getResumeByEmailAttachment(emailId, attachmentId);
    if (cached) {
      const cachedScored = cached.review || {};
      broadcast('resume:scored', {
        resumeId: cached.id,
        candidateName: cached.candidate_name,
        isNew: false,
        score: cachedScored.score,
        category: cachedScored.category,
        categoryLabel: cachedScored.categoryLabel,
        roleTitle: cachedScored.roleTitle,
        filename: cached.filename,
        ts: Date.now()
      });
      return {
        cached: true, isNew: false, chunks: 0,
        resumeId: cached.id, candidateName: cached.candidate_name,
        scored: cachedScored
      };
    }
  }

  const text = await extractText({ filename, contentType, buffer });
  if (!text || text.trim().length < 30) {
    const err = new Error('Could not extract enough text from the attachment. Is it a real resume PDF/DOCX (not a scan)?');
    err.code = 'NO_TEXT';
    throw err;
  }

  const scored = await scoreResume(text);

  // Persist + index. Indexing requires an embedding key; if that fails we
  // still keep the row + score (chunks will just be missing).
  const candidateName = scored.candidate?.name || guessCandidateName(text);
  const filePath = await saveAttachment(buffer, filename, contentType);
  const { id: resumeId, isNew } = await insertResume({
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
      console.warn(`[processResume] indexing failed for resume ${resumeId}:`, err.message);
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

  return { cached: false, isNew, chunks: indexed.chunks, resumeId, candidateName, scored };
}

app.post('/score', async (req, res) => {
  const { filename, contentType, contentBase64, emailId, attachmentId } = req.body || {};
  if (!contentBase64 || typeof contentBase64 !== 'string') {
    return res.status(400).json({ error: 'Missing contentBase64 in request body.' });
  }

  try {
    const buffer = Buffer.from(contentBase64, 'base64');
    const r = await processResume({ buffer, filename, contentType, emailId, attachmentId });
    res.json({ ...r.scored, resumeId: r.resumeId, candidateName: r.candidateName, chunks: r.chunks });
  } catch (err) {
    if (err.code === 'NO_TEXT') return res.status(422).json({ error: err.message });
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
    const { id: resumeId, isNew } = await insertResume({
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

app.get('/resumes', async (_req, res) => {
  try {
    res.json({ resumes: await listResumes() });
  } catch (err) {
    console.error('[/resumes] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Ranked-by-category view. Each group is sorted by score desc.
app.get('/resumes/by-category', async (_req, res) => {
  try {
    res.json({ groups: await listResumesByCategory() });
  } catch (err) {
    console.error('[/resumes/by-category] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Structured search. Must be defined BEFORE /resumes/:id or that route
// captures "search" as the id and returns 400.
app.get('/resumes/search', async (req, res) => {
  try {
    const filters = readSearchFilters(req.query || {});
    res.json({ filters, results: await searchResumes(filters) });
  } catch (err) {
    console.error('[/resumes/search] error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/resumes/search', async (req, res) => {
  try {
    const filters = readSearchFilters(req.body || {});
    res.json({ filters, results: await searchResumes(filters) });
  } catch (err) {
    console.error('[/resumes/search POST] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve the original PDF/DOCX bytes for a stored resume. This is what the
// "Resume link" column in the Excel export points to. Defined BEFORE
// /resumes/:id so the more-specific route wins.
app.get('/resumes/:id/file', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const resume = await getResume(id);
  if (!resume) return res.status(404).json({ error: 'Resume not found.' });
  if (!resume.file_path) return res.status(404).json({ error: 'No file stored for this resume.' });

  // Path-traversal guard. resume.file_path comes from the DB -- which today we
  // populate ourselves, but if anything in the future lets a user influence
  // it (an import script, a re-ingestion tool) a value like
  // "../../../etc/passwd" would otherwise read arbitrary files off disk.
  // Resolve both sides to absolute, normalized paths, then require the file's
  // path to live INSIDE the uploads directory.
  const abs = resolvePath(join(__dirname, resume.file_path));
  const safeRoot = resolvePath(UPLOADS_DIR);
  if (abs !== safeRoot && !abs.startsWith(safeRoot + pathSep)) {
    console.warn(`[/resumes/${id}/file] path-traversal attempt blocked: ${resume.file_path}`);
    return res.status(400).json({ error: 'Invalid file path.' });
  }
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
    const rows = await listResumesForExport();
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
      // (no extra Groq call). review + raw_text are projected by
      // listResumesForExport(), so no per-row fetch is needed.
      let summary = r.review?.summary || '';
      if (!summary && r.raw_text) {
        summary = r.raw_text.slice(0, 240).replace(/\s+/g, ' ').trim();
      }
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

app.get('/resumes/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const resume = await getResume(id);
    if (!resume) return res.status(404).json({ error: 'Resume not found.' });
    res.json(resume);
  } catch (err) {
    console.error('[/resumes/:id] error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/resumes/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    // db.deleteResume removes the resume doc, its chunks, and cascades its
    // chat threads/messages in Mongo, plus deletes the Pinecone vectors.
    const deleted = await deleteResume(id);
    res.json({ deleted });
  } catch (err) {
    console.error('[DELETE /resumes/:id] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Dashboard stats + structured search.

app.get('/stats', async (_req, res) => {
  try {
    res.json(await getStats());
  } catch (err) {
    console.error('[/stats] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Extract plain text from an uploaded JD file (PDF/DOCX). Used by the
// Segregate view so users can review/edit the JD before running.
app.post('/segregate/extract', async (req, res) => {
  const { filename, contentType, contentBase64 } = req.body || {};
  if (!contentBase64 || typeof contentBase64 !== 'string') {
    return res.status(400).json({ error: 'Missing contentBase64.' });
  }
  try {
    const buffer = Buffer.from(contentBase64, 'base64');
    const text = await extractText({ filename, contentType, buffer });
    res.json({ text: (text || '').trim() });
  } catch (err) {
    console.warn('[/segregate/extract]', err.message);
    res.status(422).json({ error: err.message || 'Could not extract text.' });
  }
});

// Bulk JD segregation. Body:
//   { jds: [{ name?, text?, filename?, contentType?, contentBase64? }, ...],
//     threshold? }   // 0-100, default 30
// Returns: { buckets: [...], unmatched: [...], jdCount, validJdCount, resumeCount }
//
// `text` is preferred. If absent and contentBase64 is given (PDF/DOCX), the
// server extracts the JD text on the fly so the user can upload JD files
// directly without parsing them in the browser.
app.post('/segregate', async (req, res) => {
  const { jds, threshold } = req.body || {};
  if (!Array.isArray(jds) || jds.length === 0) {
    return res.status(400).json({ error: 'Send "jds" as a non-empty array.' });
  }
  if (jds.length > 100) {
    return res.status(400).json({ error: 'Max 100 JDs per request.' });
  }

  try {
    const prepared = [];
    for (let i = 0; i < jds.length; i++) {
      const jd = jds[i] || {};
      let text = typeof jd.text === 'string' ? jd.text.trim() : '';
      if (!text && jd.contentBase64) {
        try {
          const buffer = Buffer.from(jd.contentBase64, 'base64');
          text = await extractText({
            filename: jd.filename || `jd-${i + 1}`,
            contentType: jd.contentType,
            buffer
          });
        } catch (err) {
          console.warn(`[/segregate] failed to extract JD #${i + 1}:`, err.message);
          text = '';
        }
      }
      const name = (jd.name && String(jd.name).trim())
        || (jd.filename && String(jd.filename).replace(/\.[^.]+$/, ''))
        || `Job #${i + 1}`;
      prepared.push({ name, text });
    }

    const t = Number.isFinite(Number(threshold))
      ? Math.max(0, Math.min(100, Number(threshold)))
      : 30;

    const out = await segregateResumes(prepared, { threshold: t });
    res.json({ ...out, threshold: t });
  } catch (err) {
    console.error('[/segregate] error:', err);
    res.status(500).json({ error: err.message || 'Internal error segregating.' });
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

app.get('/threads', async (_req, res) => {
  try {
    res.json({ threads: await listThreads() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/threads/:id/messages', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const thread = await getThread(id);
    if (!thread) return res.status(404).json({ error: 'Thread not found.' });
    res.json({ thread, messages: await getMessages(id) });
  } catch (err) {
    console.error('[/threads/:id/messages] error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/threads/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const deleted = await deleteThread(id);
    res.json({ deleted });
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
      const resume = await getResume(id);
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

// (The one-time SQLite -> Mongo importer now lives in migrate-to-mongo.js.)

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

app.get('/automation/workflows', async (_req, res) => {
  try { res.json({ workflows: await listWorkflows() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/automation/workflows/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const wf = await getWorkflow(id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found.' });
    res.json(wf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/automation/workflows', async (req, res) => {
  const { name, description, graph } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Missing workflow name.' });
  try {
    const id = await createWorkflow({ name, description, graph });
    res.json({ id, workflow: await getWorkflow(id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/automation/workflows/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const ok = await updateWorkflow(id, req.body || {});
    if (!ok) return res.status(404).json({ error: 'Workflow not found.' });
    res.json({ ok: true, workflow: await getWorkflow(id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/automation/workflows/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    res.json({ deleted: await deleteWorkflow(id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

app.get('/automation/runs', async (req, res) => {
  try {
    const workflowId = req.query.workflowId ? Number(req.query.workflowId) : undefined;
    res.json({ runs: await listRuns({ workflowId, limit: 50 }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/automation/runs/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const run = await getRun(id);
    if (!run) return res.status(404).json({ error: 'Run not found.' });
    res.json(run);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Google integration ---

app.get('/automation/google/status', async (_req, res) => {
  try {
    res.json({
      configured: googleConfigured(),
      connected:  await googleConnected(),
      profile:    await googleProfile(),
      redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8787/automation/google/callback'
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

app.post('/automation/google/disconnect', async (_req, res) => {
  try {
    await disconnectGoogle();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Gmail (extension-facing: list + download attachments) ---
//
// The extension calls these after the user has connected Google via the same
// /automation/google/* flow used by the automation engine. We deliberately
// reuse those routes so a user who's already wired up Google for interview
// scheduling doesn't have to reconnect for Gmail.

app.get('/gmail/status', async (_req, res) => {
  try {
    res.json({
      configured: googleConfigured(),
      connected:  await googleConnected(),
      profile:    await googleProfile()
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Same auth URL as /automation/google/auth -- aliased here so the extension
// has a stable Gmail-namespaced URL to point users at.
app.get('/gmail/auth', (_req, res) => {
  try { res.json({ url: getAuthUrl('gmail') }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/gmail/disconnect', async (_req, res) => {
  try {
    await disconnectGoogle();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List resume-shaped attachments in the user's Gmail inbox. Returns the same
// item shape as the extension's Outlook listing, plus a `source: 'gmail'` tag.
app.get('/gmail/messages', async (req, res) => {
  const top = Number(req.query.top);
  try {
    const items = await listGmailResumeEmails({
      topMessages: Number.isFinite(top) && top > 0 ? top : 75
    });
    res.json({ items });
  } catch (err) {
    const status = err.status === 401 || /not connected|refresh token/i.test(err.message) ? 401 : 500;
    console.warn('[/gmail/messages] error:', err.message);
    res.status(status).json({ error: err.message });
  }
});

// Download one Gmail attachment by (messageId, attachmentId). Returns the
// bytes already base64-encoded so the popup can POST straight to /score.
app.get('/gmail/attachments/:messageId/:attachmentId', async (req, res) => {
  try {
    const { messageId, attachmentId } = req.params;
    const att = await downloadGmailAttachment(messageId, attachmentId);
    res.json(att);
  } catch (err) {
    const status = err.status === 401 || /not connected|refresh token/i.test(err.message) ? 401 : 500;
    console.warn('[/gmail/attachments] error:', err.message);
    res.status(status).json({ error: err.message });
  }
});

// --- IMAP (custom-domain mailbox) ---------------------------------------
//
// Provider-neutral path: read resume attachments out of any mailbox that
// speaks IMAP (Zoho, Google Workspace, M365, cPanel hosts, ...). Credentials
// live in the backend (.env or saved config), never the extension.

// Current config minus the password (safe for the dashboard to render).
app.get('/imap/status', async (_req, res) => {
  try {
    res.json(await imapStatus());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Save host/port/secure/user/pass/mailbox. Blank password keeps the stored one.
app.post('/imap/config', async (req, res) => {
  try {
    const { host, port, secure, user, pass, mailbox } = req.body || {};
    const status = await setImapConfig({ host, port, secure, user, pass, mailbox });
    res.json(status);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/imap/disconnect', async (_req, res) => {
  try {
    await disconnectImap();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Verify credentials connect + open the mailbox. Returns { ok, mailbox, messages }.
app.post('/imap/test', async (_req, res) => {
  try {
    const result = await testImapConnection();
    res.json(result);
  } catch (err) {
    console.warn('[/imap/test] error:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Pull the newest messages, extract PDF/DOCX attachments, and run each through
// the same scoring pipeline as /score. Already-scored attachments hit the cache
// (keyed by messageId + part index) so re-syncing is cheap and idempotent.
//   body: { limit?: number=25, sinceDays?: number=0 }
app.post('/imap/sync', async (req, res) => {
  if (!(await imapConfigured())) {
    return res.status(400).json({ error: 'IMAP not configured. Save host/user/password first via /imap/config or .env.' });
  }
  const limitRaw = Number(req.body?.limit);
  const sinceRaw = Number(req.body?.sinceDays);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 25;
  const sinceDays = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;

  try {
    const found = await fetchImapResumes({ limit, sinceDays });

    const items = [];
    let scored = 0, duplicates = 0, skipped = 0;
    for (const it of found) {
      try {
        const buffer = Buffer.from(it.contentBase64 || '', 'base64');
        const r = await processResume({
          buffer,
          filename: it.filename,
          contentType: it.contentType,
          emailId: it.messageId,
          attachmentId: it.partId
        });
        if (r.cached) duplicates++; else scored++;
        items.push({
          filename: it.filename,
          from: it.from,
          subject: it.subject,
          receivedDateTime: it.receivedDateTime,
          resumeId: r.resumeId,
          candidateName: r.candidateName,
          score: r.scored?.score,
          cached: r.cached
        });
      } catch (err) {
        skipped++;
        items.push({ filename: it.filename, from: it.from, subject: it.subject, error: err.message });
      }
    }

    res.json({ scanned: found.length, scored, duplicates, skipped, items });
  } catch (err) {
    console.warn('[/imap/sync] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// List resume-shaped attachments in the mailbox (metadata only). Same item
// shape as /gmail/messages so the popup can merge IMAP into the inbox list.
app.get('/imap/messages', async (req, res) => {
  if (!(await imapConfigured())) {
    return res.status(401).json({ error: 'IMAP not configured.' });
  }
  const top = Number(req.query.top);
  try {
    const items = await listImapResumeEmails({
      limit: Number.isFinite(top) && top > 0 ? Math.min(top, 200) : 25
    });
    res.json({ items });
  } catch (err) {
    const status = /not configured|auth/i.test(err.message) ? 401 : 500;
    console.warn('[/imap/messages] error:', err.message);
    res.status(status).json({ error: err.message });
  }
});

// Download one IMAP attachment by (messageId, partId). Returns the bytes
// base64-encoded so the popup can POST straight to /score, just like Gmail.
app.get('/imap/attachments/:messageId/:partId', async (req, res) => {
  try {
    const { messageId, partId } = req.params;
    const att = await downloadImapAttachment(messageId, partId);
    res.json(att);
  } catch (err) {
    const status = /not configured|auth/i.test(err.message) ? 401 : 500;
    console.warn('[/imap/attachments] error:', err.message);
    res.status(status).json({ error: err.message });
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// --- Interviewers ---

app.get('/automation/interviewers', async (_req, res) => {
  try {
    res.json({ interviewers: await listInterviewers() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/automation/interviewers', async (req, res) => {
  const { name, email, calendarId, timezone } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email are required.' });
  // Reject obviously-wrong timezones at write time (e.g. "asia") so Google
  // Calendar never has to throw "Invalid time zone definition". Blank is OK.
  if (timezone && !validIanaTimeZone(timezone)) {
    return res.status(400).json({
      error: `"${timezone}" is not a valid IANA timezone. Examples: "Asia/Kolkata", "America/New_York", "Europe/London".`
    });
  }
  try {
    const id = await createInterviewer({ name, email, calendarId, timezone });
    res.json({ id, interviewers: await listInterviewers() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/automation/interviewers/:id', async (req, res) => {
  try {
    res.json({ deleted: await deleteInterviewer(Number(req.params.id)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add an availability window. Body: { start: ISO, end: ISO }
app.post('/automation/interviewers/:id/availability', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await addAvailabilityWindow(id, req.body || {});
    res.json({ ok: true, ...r, interviewers: await listInterviewers() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/automation/interviewers/:id/availability/:windowId', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const removed = await removeAvailabilityWindow(id, String(req.params.windowId));
    res.json({ deleted: removed, interviewers: await listInterviewers() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- OA email templates ---

app.get('/automation/templates', async (_req, res) => {
  try { res.json({ templates: await listTemplates() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/automation/templates/:id', async (req, res) => {
  try {
    const t = await getTemplate(Number(req.params.id));
    if (!t) return res.status(404).json({ error: 'Template not found.' });
    res.json(t);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/automation/templates', async (req, res) => {
  const { name, subject, body, oaLink } = req.body || {};
  if (!name || !subject || !body) return res.status(400).json({ error: 'name, subject, body required.' });
  try {
    const id = await createTemplate({ name, subject, body, oaLink });
    res.json({ id, templates: await listTemplates() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/automation/templates/:id', async (req, res) => {
  try {
    const ok = await updateTemplate(Number(req.params.id), req.body || {});
    if (!ok) return res.status(404).json({ error: 'Template not found.' });
    res.json({ ok: true, templates: await listTemplates() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/automation/templates/:id', async (req, res) => {
  try { res.json({ deleted: await deleteTemplate(Number(req.params.id)) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 8787;

// Mongo is the source of truth, so connect (and ensure indexes) BEFORE we start
// serving. ensureAutomationSchema touches the connection; seedDefaults inserts
// the starter workflows/template on a fresh DB. A failed connect aborts boot —
// there's no SQLite fallback anymore.
async function init() {
  await getMongoDb();
  await ensureAutomationSchema();
  try { await seedDefaults(); } catch (err) { console.warn('[automation] seed failed:', err.message); }
}

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Resume Scorer backend listening on http://localhost:${PORT}`);
      console.log(`  ai provider:    ${process.env.AI_PROVIDER || 'groq'}`);
      console.log(`  ai model:       ${process.env.MODEL || '(default)'}`);
      console.log(`  embed provider: ${process.env.EMBED_PROVIDER || 'google'}`);
      console.log(`  mongo:          connected (db="${mongoStatus().db}")`);
    });
  })
  .catch((err) => {
    console.error('[boot] fatal — could not start (is MONGODB_URI set and reachable?):', err.message);
    process.exit(1);
  });
