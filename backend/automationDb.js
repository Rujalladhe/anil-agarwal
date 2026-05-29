// Automation-builder persistence (MongoDB). Collections:
//
//   workflows         — saved automation graphs (nodes + edges as a nested object)
//   workflow_runs     — one doc per execution
//   workflow_actions  — one doc per (run, candidate, action node) execution result
//   automation_kv     — key/value for tokens (Google OAuth) + provider settings
//                       (_id = the string key)
//   interviewers      — saved interview panel members + their calendar id
//   oa_templates      — reusable OA email bodies (Mustache-ish placeholders)
//
// All exported functions are async. Numeric ids come from nextId().

import { getMongoDb, nextId } from './mongo.js';

// Indexes are created on connect (mongo.js ensureIndexes). This just touches the
// connection so a misconfigured Mongo fails loud at startup.
export async function ensureAutomationSchema() {
  await getMongoDb();
}

// --- key/value -----------------------------------------------------------

export async function kvGet(k) {
  const db = await getMongoDb();
  const row = await db.collection('automation_kv').findOne({ _id: k });
  return row ? (row.v ?? null) : null;
}

export async function kvSet(k, value) {
  const db = await getMongoDb();
  await db.collection('automation_kv').replaceOne(
    { _id: k },
    { _id: k, k, v: value, updated_at: Date.now() },
    { upsert: true }
  );
}

export async function kvDel(k) {
  const db = await getMongoDb();
  await db.collection('automation_kv').deleteOne({ _id: k });
}

// --- workflows -----------------------------------------------------------

const DEFAULT_GRAPH = () => ({
  nodes: [
    { id: 'trigger-1', type: 'trigger.manual', x: 80, y: 200, config: {} }
  ],
  edges: []
});

export async function listWorkflows() {
  const db = await getMongoDb();
  return db.collection('workflows')
    .find({}, { projection: { _id: 0, id: 1, name: 1, description: 1, enabled: 1, created_at: 1, updated_at: 1 } })
    .sort({ updated_at: -1 })
    .toArray();
}

export async function getWorkflow(id) {
  const db = await getMongoDb();
  const row = await db.collection('workflows').findOne({ _id: Number(id) });
  if (!row) return null;
  return { ...row, enabled: row.enabled !== false, graph: row.graph || DEFAULT_GRAPH() };
}

export async function createWorkflow({ name, description = '', graph = DEFAULT_GRAPH() }) {
  const db = await getMongoDb();
  const id = await nextId('workflows');
  const now = Date.now();
  await db.collection('workflows').insertOne({
    _id: id, id, name, description: description || '', graph, enabled: true,
    created_at: now, updated_at: now
  });
  return id;
}

export async function updateWorkflow(id, { name, description, graph, enabled }) {
  const db = await getMongoDb();
  const current = await db.collection('workflows').findOne({ _id: Number(id) });
  if (!current) return false;
  const $set = { updated_at: Date.now() };
  if (name != null) $set.name = name;
  if (description != null) $set.description = description;
  if (graph != null) $set.graph = graph;
  if (enabled != null) $set.enabled = Boolean(enabled);
  await db.collection('workflows').updateOne({ _id: Number(id) }, { $set });
  return true;
}

export async function deleteWorkflow(id) {
  const db = await getMongoDb();
  const res = await db.collection('workflows').deleteOne({ _id: Number(id) });
  // Cascade child runs + actions (no FKs in Mongo).
  await db.collection('workflow_runs').deleteMany({ workflow_id: Number(id) });
  await db.collection('workflow_actions').deleteMany({ workflow_id: Number(id) });
  return res.deletedCount;
}

// --- runs ----------------------------------------------------------------

export async function createRun({ workflowId, mode }) {
  const db = await getMongoDb();
  const id = await nextId('workflow_runs');
  const started_at = Date.now();
  await db.collection('workflow_runs').insertOne({
    _id: id, id, workflow_id: workflowId == null ? null : Number(workflowId),
    mode, status: 'running', summary: null, started_at, finished_at: null
  });
  return id;
}

export async function finalizeRun(runId, { status, summary }) {
  const db = await getMongoDb();
  await db.collection('workflow_runs').updateOne(
    { _id: Number(runId) },
    { $set: { status, summary: summary || {}, finished_at: Date.now() } }
  );
}

export async function recordAction({ runId, resumeId, candidate, nodeId, nodeType, status, detail }) {
  const db = await getMongoDb();
  const id = await nextId('workflow_actions');
  await db.collection('workflow_actions').insertOne({
    _id: id, id, run_id: Number(runId), resume_id: resumeId ?? null,
    candidate: candidate || null, node_id: nodeId, node_type: nodeType,
    status, detail: detail || {}, created_at: Date.now()
  });
}

export async function listRuns({ workflowId, limit = 30 } = {}) {
  const db = await getMongoDb();
  const match = workflowId ? { workflow_id: Number(workflowId) } : {};
  return db.collection('workflow_runs').aggregate([
    { $match: match },
    { $sort: { started_at: -1 } },
    { $limit: limit },
    { $lookup: { from: 'workflows', localField: 'workflow_id', foreignField: '_id', as: '_w' } },
    { $addFields: { workflow_name: { $arrayElemAt: ['$_w.name', 0] } } },
    { $project: { _id: 0, _w: 0 } }
  ]).toArray();
}

export async function getRun(id) {
  const db = await getMongoDb();
  const runs = await db.collection('workflow_runs').aggregate([
    { $match: { _id: Number(id) } },
    { $lookup: { from: 'workflows', localField: 'workflow_id', foreignField: '_id', as: '_w' } },
    { $addFields: { workflow_name: { $arrayElemAt: ['$_w.name', 0] } } },
    { $project: { _id: 0, _w: 0 } }
  ]).toArray();
  const run = runs[0];
  if (!run) return null;
  const actions = await db.collection('workflow_actions')
    .find({ run_id: Number(id) }, { projection: { _id: 0 } })
    .sort({ id: 1 })
    .toArray();
  return { ...run, actions };
}

// --- interviewers --------------------------------------------------------

export async function listInterviewers() {
  const db = await getMongoDb();
  return db.collection('interviewers').find({}, { projection: { _id: 0 } }).sort({ name: 1 }).toArray();
}

export async function getInterviewer(id) {
  const db = await getMongoDb();
  const row = await db.collection('interviewers').findOne({ _id: Number(id) }, { projection: { _id: 0 } });
  if (!row) return null;
  return { ...row, availability: Array.isArray(row.availability) ? row.availability : [] };
}

export async function createInterviewer({ name, email, calendarId, timezone }) {
  const db = await getMongoDb();
  const id = await nextId('interviewers');
  await db.collection('interviewers').insertOne({
    _id: id, id, name, email,
    calendar_id: calendarId || 'primary',
    timezone: timezone || null,
    availability: [],
    created_at: Date.now()
  });
  return id;
}

export async function deleteInterviewer(id) {
  const db = await getMongoDb();
  const res = await db.collection('interviewers').deleteOne({ _id: Number(id) });
  return res.deletedCount;
}

// Availability window helpers. Each window: { id, start, end } (ISO strings).
export async function addAvailabilityWindow(interviewerId, { start, end }) {
  if (!start || !end) throw new Error('start and end are required.');
  const startTs = Date.parse(start), endTs = Date.parse(end);
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) throw new Error('Invalid date.');
  if (endTs <= startTs) throw new Error('End must be after start.');
  const iv = await getInterviewer(interviewerId);
  if (!iv) throw new Error('Interviewer not found.');
  const winId = `w-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const next = [...(iv.availability || []), { id: winId, start, end }]
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const db = await getMongoDb();
  await db.collection('interviewers').updateOne({ _id: Number(interviewerId) }, { $set: { availability: next } });
  return { id: winId, windows: next };
}

export async function removeAvailabilityWindow(interviewerId, windowId) {
  const iv = await getInterviewer(interviewerId);
  if (!iv) return 0;
  const next = (iv.availability || []).filter((w) => w.id !== windowId);
  const db = await getMongoDb();
  await db.collection('interviewers').updateOne({ _id: Number(interviewerId) }, { $set: { availability: next } });
  return 1;
}

// --- OA templates --------------------------------------------------------

export async function listTemplates() {
  const db = await getMongoDb();
  return db.collection('oa_templates').find({}, { projection: { _id: 0 } }).sort({ updated_at: -1 }).toArray();
}

export async function getTemplate(id) {
  const db = await getMongoDb();
  return db.collection('oa_templates').findOne({ _id: Number(id) }, { projection: { _id: 0 } });
}

export async function createTemplate({ name, subject, body, oaLink }) {
  const db = await getMongoDb();
  const id = await nextId('oa_templates');
  const now = Date.now();
  await db.collection('oa_templates').insertOne({
    _id: id, id, name, subject, body, oa_link: oaLink || null, created_at: now, updated_at: now
  });
  return id;
}

export async function updateTemplate(id, { name, subject, body, oaLink }) {
  const db = await getMongoDb();
  const cur = await db.collection('oa_templates').findOne({ _id: Number(id) });
  if (!cur) return false;
  const $set = { updated_at: Date.now() };
  if (name != null) $set.name = name;
  if (subject != null) $set.subject = subject;
  if (body != null) $set.body = body;
  if (oaLink != null) $set.oa_link = oaLink;
  await db.collection('oa_templates').updateOne({ _id: Number(id) }, { $set });
  return true;
}

export async function deleteTemplate(id) {
  const db = await getMongoDb();
  const res = await db.collection('oa_templates').deleteOne({ _id: Number(id) });
  return res.deletedCount;
}

// --- seeding -------------------------------------------------------------

// Drop in a couple of useful presets the very first time. Idempotent: skips if
// rows already exist.
export async function seedDefaults() {
  const db = await getMongoDb();
  const wfCount = await db.collection('workflows').countDocuments();
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
    await createWorkflow({
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
    await createWorkflow({
      name: 'Polite rejection blast',
      description: 'Send a warm, brand-safe rejection to candidates under 45',
      graph: rejectPlaybook
    });
  }

  const tplCount = await db.collection('oa_templates').countDocuments();
  if (tplCount === 0) {
    await createTemplate({
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
