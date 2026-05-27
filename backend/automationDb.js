// Automation-builder persistence. Lives next to db.js so it can reuse the same
// better-sqlite3 connection. Tables:
//
//   workflows         — saved automation graphs (nodes + edges as JSON)
//   workflow_runs     — one row per execution
//   workflow_actions  — one row per (run, candidate, action node) execution result
//   automation_kv     — key/value for tokens (Google OAuth) + provider settings
//   interviewers      — saved interview panel members + their calendar id
//   oa_templates      — reusable OA email bodies (Mustache-ish placeholders)

import { getDb } from './db.js';

export function ensureAutomationSchema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      description  TEXT,
      graph_json   TEXT NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id  INTEGER REFERENCES workflows(id) ON DELETE CASCADE,
      mode         TEXT NOT NULL,        -- 'live' | 'dry-run'
      status       TEXT NOT NULL,        -- 'running' | 'ok' | 'partial' | 'error'
      summary      TEXT,                 -- JSON: counters, totals
      started_at   INTEGER NOT NULL,
      finished_at  INTEGER
    );

    CREATE TABLE IF NOT EXISTS workflow_actions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      resume_id    INTEGER,
      candidate    TEXT,
      node_id      TEXT NOT NULL,
      node_type    TEXT NOT NULL,
      status       TEXT NOT NULL,         -- 'ok' | 'skipped' | 'error' | 'preview'
      detail_json  TEXT,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wfa_run ON workflow_actions(run_id);

    CREATE TABLE IF NOT EXISTS automation_kv (
      k            TEXT PRIMARY KEY,
      v            TEXT NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS interviewers (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL,
      email             TEXT NOT NULL,
      calendar_id       TEXT,                  -- defaults to "primary"
      timezone          TEXT,                  -- IANA tz, e.g. "Asia/Kolkata"
      availability_json TEXT,                  -- JSON array of {id,start,end} windows
      created_at        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oa_templates (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      subject      TEXT NOT NULL,
      body         TEXT NOT NULL,
      oa_link      TEXT,                  -- shared default OA link
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
  `);

  // Migration: older DBs had `interviewers` without availability_json. Add it.
  const cols = db.prepare("PRAGMA table_info(interviewers)").all();
  if (!cols.some((c) => c.name === 'availability_json')) {
    db.exec(`ALTER TABLE interviewers ADD COLUMN availability_json TEXT`);
  }
}

// --- key/value -----------------------------------------------------------

export function kvGet(k) {
  const row = getDb().prepare('SELECT v FROM automation_kv WHERE k = ?').get(k);
  if (!row) return null;
  try { return JSON.parse(row.v); } catch { return row.v; }
}

export function kvSet(k, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  getDb().prepare(`
    INSERT INTO automation_kv (k, v, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at
  `).run(k, v, Date.now());
}

export function kvDel(k) {
  getDb().prepare('DELETE FROM automation_kv WHERE k = ?').run(k);
}

// --- workflows -----------------------------------------------------------

const DEFAULT_GRAPH = () => ({
  nodes: [
    { id: 'trigger-1', type: 'trigger.manual', x: 80,  y: 200, config: {} }
  ],
  edges: []
});

export function listWorkflows() {
  return getDb().prepare(`
    SELECT id, name, description, enabled, created_at, updated_at
    FROM workflows ORDER BY updated_at DESC
  `).all();
}

export function getWorkflow(id) {
  const row = getDb().prepare('SELECT * FROM workflows WHERE id = ?').get(id);
  if (!row) return null;
  let graph;
  try { graph = JSON.parse(row.graph_json); }
  catch { graph = DEFAULT_GRAPH(); }
  return { ...row, enabled: row.enabled === 1, graph };
}

export function createWorkflow({ name, description = '', graph = DEFAULT_GRAPH() }) {
  const now = Date.now();
  const info = getDb().prepare(`
    INSERT INTO workflows (name, description, graph_json, enabled, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `).run(name, description || '', JSON.stringify(graph), now, now);
  return Number(info.lastInsertRowid);
}

export function updateWorkflow(id, { name, description, graph, enabled }) {
  const db = getDb();
  const current = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id);
  if (!current) return false;
  const next = {
    name: name ?? current.name,
    description: description ?? current.description ?? '',
    graph_json: graph ? JSON.stringify(graph) : current.graph_json,
    enabled: enabled == null ? current.enabled : (enabled ? 1 : 0)
  };
  db.prepare(`
    UPDATE workflows
    SET name = ?, description = ?, graph_json = ?, enabled = ?, updated_at = ?
    WHERE id = ?
  `).run(next.name, next.description, next.graph_json, next.enabled, Date.now(), id);
  return true;
}

export function deleteWorkflow(id) {
  return getDb().prepare('DELETE FROM workflows WHERE id = ?').run(id).changes;
}

// --- runs ----------------------------------------------------------------

export function createRun({ workflowId, mode }) {
  const info = getDb().prepare(`
    INSERT INTO workflow_runs (workflow_id, mode, status, summary, started_at)
    VALUES (?, ?, 'running', NULL, ?)
  `).run(workflowId, mode, Date.now());
  return Number(info.lastInsertRowid);
}

export function finalizeRun(runId, { status, summary }) {
  getDb().prepare(`
    UPDATE workflow_runs
    SET status = ?, summary = ?, finished_at = ?
    WHERE id = ?
  `).run(status, JSON.stringify(summary || {}), Date.now(), runId);
}

export function recordAction({ runId, resumeId, candidate, nodeId, nodeType, status, detail }) {
  getDb().prepare(`
    INSERT INTO workflow_actions (run_id, resume_id, candidate, node_id, node_type, status, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    resumeId ?? null,
    candidate || null,
    nodeId,
    nodeType,
    status,
    JSON.stringify(detail || {}),
    Date.now()
  );
}

export function listRuns({ workflowId, limit = 30 } = {}) {
  const db = getDb();
  if (workflowId) {
    return db.prepare(`
      SELECT r.*, w.name AS workflow_name
      FROM workflow_runs r LEFT JOIN workflows w ON w.id = r.workflow_id
      WHERE r.workflow_id = ?
      ORDER BY r.started_at DESC LIMIT ?
    `).all(workflowId, limit).map(decodeRun);
  }
  return db.prepare(`
    SELECT r.*, w.name AS workflow_name
    FROM workflow_runs r LEFT JOIN workflows w ON w.id = r.workflow_id
    ORDER BY r.started_at DESC LIMIT ?
  `).all(limit).map(decodeRun);
}

export function getRun(id) {
  const db = getDb();
  const run = db.prepare(`
    SELECT r.*, w.name AS workflow_name
    FROM workflow_runs r LEFT JOIN workflows w ON w.id = r.workflow_id
    WHERE r.id = ?
  `).get(id);
  if (!run) return null;
  const actions = db.prepare(`
    SELECT * FROM workflow_actions WHERE run_id = ? ORDER BY id ASC
  `).all(id).map((a) => ({
    ...a,
    detail: safeJson(a.detail_json)
  }));
  return { ...decodeRun(run), actions };
}

function decodeRun(r) {
  return { ...r, summary: safeJson(r.summary) };
}
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// --- interviewers --------------------------------------------------------

export function listInterviewers() {
  return getDb().prepare('SELECT * FROM interviewers ORDER BY name ASC').all().map(decodeInterviewer);
}
export function getInterviewer(id) {
  const row = getDb().prepare('SELECT * FROM interviewers WHERE id = ?').get(id);
  return row ? decodeInterviewer(row) : null;
}
function decodeInterviewer(r) {
  let windows = [];
  try { windows = JSON.parse(r.availability_json || '[]') || []; } catch { windows = []; }
  return { ...r, availability: windows };
}
export function createInterviewer({ name, email, calendarId, timezone }) {
  const info = getDb().prepare(`
    INSERT INTO interviewers (name, email, calendar_id, timezone, availability_json, created_at)
    VALUES (?, ?, ?, ?, '[]', ?)
  `).run(name, email, calendarId || 'primary', timezone || null, Date.now());
  return Number(info.lastInsertRowid);
}
export function deleteInterviewer(id) {
  return getDb().prepare('DELETE FROM interviewers WHERE id = ?').run(id).changes;
}

// Availability window helpers. Each window: { id, start, end } (ISO strings).
// We rewrite the whole JSON blob on every change — list is small per person.
export function addAvailabilityWindow(interviewerId, { start, end }) {
  if (!start || !end) throw new Error('start and end are required.');
  const startTs = Date.parse(start), endTs = Date.parse(end);
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) throw new Error('Invalid date.');
  if (endTs <= startTs) throw new Error('End must be after start.');
  const iv = getInterviewer(interviewerId);
  if (!iv) throw new Error('Interviewer not found.');
  const winId = `w-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const next = [...(iv.availability || []), { id: winId, start, end }]
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  getDb().prepare('UPDATE interviewers SET availability_json = ? WHERE id = ?')
    .run(JSON.stringify(next), interviewerId);
  return { id: winId, windows: next };
}
export function removeAvailabilityWindow(interviewerId, windowId) {
  const iv = getInterviewer(interviewerId);
  if (!iv) return 0;
  const next = (iv.availability || []).filter((w) => w.id !== windowId);
  getDb().prepare('UPDATE interviewers SET availability_json = ? WHERE id = ?')
    .run(JSON.stringify(next), interviewerId);
  return 1;
}

// --- OA templates --------------------------------------------------------

export function listTemplates() {
  return getDb().prepare('SELECT * FROM oa_templates ORDER BY updated_at DESC').all();
}
export function getTemplate(id) {
  return getDb().prepare('SELECT * FROM oa_templates WHERE id = ?').get(id);
}
export function createTemplate({ name, subject, body, oaLink }) {
  const now = Date.now();
  const info = getDb().prepare(`
    INSERT INTO oa_templates (name, subject, body, oa_link, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, subject, body, oaLink || null, now, now);
  return Number(info.lastInsertRowid);
}
export function updateTemplate(id, { name, subject, body, oaLink }) {
  const cur = getTemplate(id);
  if (!cur) return false;
  getDb().prepare(`
    UPDATE oa_templates SET name = ?, subject = ?, body = ?, oa_link = ?, updated_at = ?
    WHERE id = ?
  `).run(
    name ?? cur.name,
    subject ?? cur.subject,
    body ?? cur.body,
    oaLink ?? cur.oa_link,
    Date.now(), id
  );
  return true;
}
export function deleteTemplate(id) {
  return getDb().prepare('DELETE FROM oa_templates WHERE id = ?').run(id).changes;
}

// --- seeding -------------------------------------------------------------

// Drop in a couple of useful presets the very first time the tables are
// created. Idempotent: skips if rows already exist.
export function seedDefaults() {
  const db = getDb();
  const wfCount = db.prepare('SELECT COUNT(*) AS n FROM workflows').get().n;
  if (wfCount === 0) {
    const oaPlaybook = {
      nodes: [
        { id: 'trigger',  type: 'trigger.manual', x: 40,  y: 180, config: { label: 'Run on selected' } },
        { id: 'filter',   type: 'logic.filter',   x: 240, y: 180, config: { minScore: 75, category: '', skillsAny: [] } },
        { id: 'oa',       type: 'action.sendOaEmail', x: 440, y: 100, config: { templateId: null, oaLinkOverride: '' } },
        { id: 'sched',    type: 'action.scheduleInterview', x: 440, y: 260, config: {
          interviewerIds: [], durationMinutes: 30, dayStart: '10:00', dayEnd: '17:00', daysAhead: 7, createMeet: true
        } },
        { id: 'log',      type: 'action.logRun', x: 660, y: 180, config: { note: 'OA + interview' } }
      ],
      edges: [
        { from: 'trigger', to: 'filter' },
        { from: 'filter',  to: 'oa' },
        { from: 'filter',  to: 'sched' },
        { from: 'oa',      to: 'log' },
        { from: 'sched',   to: 'log' }
      ]
    };
    createWorkflow({
      name: 'Top picks → OA + Interview',
      description: 'Send the OA link and book a Google Meet interview for candidates scoring 75+',
      graph: oaPlaybook
    });

    const rejectPlaybook = {
      nodes: [
        { id: 'trigger',  type: 'trigger.manual', x: 40,  y: 180, config: { label: 'Polite no' } },
        { id: 'filter',   type: 'logic.filter',   x: 240, y: 180, config: { maxScore: 45 } },
        { id: 'reject',   type: 'action.sendRejection', x: 440, y: 180, config: { tone: 'warm', maxScore: 60, nearMissAbove: 50 } }
      ],
      edges: [
        { from: 'trigger', to: 'filter' },
        { from: 'filter',  to: 'reject' }
      ]
    };
    createWorkflow({
      name: 'Polite rejection blast',
      description: 'Send a warm, brand-safe rejection to candidates under 45',
      graph: rejectPlaybook
    });
  }

  const tplCount = db.prepare('SELECT COUNT(*) AS n FROM oa_templates').get().n;
  if (tplCount === 0) {
    createTemplate({
      name: 'Default OA invite',
      subject: 'Online assessment for the {{role}} role — please complete by {{deadline}}',
      body:
`Hi {{first_name}},

Thanks for applying for the {{role}} role at our team. We were impressed with your background and would like to invite you to complete a short online assessment.

▶ Start here: {{oa_link}}

This should take ~60 minutes. Please complete it by {{deadline}}.

If you have any trouble loading the assessment, just reply to this email and we'll sort it out.

Best,
Recruiting Team`,
      oaLink: 'https://your-oa-platform.com/exam/REPLACE_ME'
    });
  }
}
