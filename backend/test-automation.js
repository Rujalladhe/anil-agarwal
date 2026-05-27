// Smoke tests for the automation builder. Hits a temp SQLite DB and the
// real engine. Skips anything that needs Google (Calendar / Gmail). Run with:
//
//   node test-automation.js
//
// Exits non-zero on first failure.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DB = join(__dirname, `.test-automation-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
// We don't want chat.js or rag.js to need real API keys for these tests.
process.env.AI_PROVIDER = 'groq';

const out = [];
let passed = 0, failed = 0;

function ok(name, cond, detail = '') {
  if (cond) { passed++; out.push(`  ✓ ${name}`); }
  else      { failed++; out.push(`  ✗ ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
function section(title) { out.push(`\n${title}`); }

async function main() {
  // Late imports so DB_PATH takes effect first.
  const db = await import('./db.js');
  const adb = await import('./automationDb.js');
  const eng = await import('./automation.js');

  section('schema + seeding');
  adb.ensureAutomationSchema();
  adb.seedDefaults();
  ok('default workflows seeded', adb.listWorkflows().length >= 2);
  ok('default OA template seeded', adb.listTemplates().length >= 1);

  section('CRUD: workflow');
  const wfId = adb.createWorkflow({
    name: 'Test wf',
    description: 'unit test workflow',
    graph: {
      nodes: [
        { id: 't', type: 'trigger.manual', x: 0, y: 0, config: {} },
        { id: 'f', type: 'logic.filter',   x: 200, y: 0, config: { minScore: 70, requireEmail: true } },
        { id: 'l', type: 'action.logRun',  x: 400, y: 0, config: { note: 'smoke' } }
      ],
      edges: [
        { from: 't', to: 'f' },
        { from: 'f', to: 'l' }
      ]
    }
  });
  ok('createWorkflow returns id', Number.isFinite(wfId));
  const fetched = adb.getWorkflow(wfId);
  ok('getWorkflow round-trips graph', fetched.graph.nodes.length === 3);
  ok('getWorkflow round-trips edges', fetched.graph.edges.length === 2);

  adb.updateWorkflow(wfId, { name: 'Renamed' });
  ok('updateWorkflow renames', adb.getWorkflow(wfId).name === 'Renamed');

  section('CRUD: interviewers + templates');
  const ivId = adb.createInterviewer({ name: 'Anita Roy', email: 'anita@example.com', calendarId: 'primary', timezone: 'Asia/Kolkata' });
  ok('createInterviewer returns id', Number.isFinite(ivId));
  ok('listInterviewers includes new', adb.listInterviewers().some((iv) => iv.id === ivId));

  const tplId = adb.createTemplate({
    name: 'unit-tpl',
    subject: 'Hi {{first_name}}',
    body:    'OA: {{oa_link}}',
    oaLink:  'https://example.com/oa'
  });
  ok('createTemplate returns id', Number.isFinite(tplId));

  section('engine: filter helpers (pure)');
  const { matchesFilter, renderTemplate, profileToItem, normalizeGraph } = eng.__testing;

  const itemHigh = { score: 85, category: 'backend', years: 4, skills: ['python','aws'], email: 'a@b.com' };
  const itemLow  = { score: 30, category: 'backend', years: 1, skills: ['python'],       email: 'b@b.com' };
  const itemNoEm = { score: 90, category: 'backend', years: 6, skills: ['python'],       email: '' };

  ok('filter passes high score',         matchesFilter(itemHigh, { minScore: 70 }));
  ok('filter blocks low score',         !matchesFilter(itemLow,  { minScore: 70 }));
  ok('filter requireEmail blocks',      !matchesFilter(itemNoEm, { minScore: 70, requireEmail: true }));
  ok('filter skillsAny matches',         matchesFilter(itemHigh, { skillsAny: ['AWS', 'go'] }));
  ok('filter skillsAll missing fails',  !matchesFilter(itemHigh, { skillsAll: ['python','go'] }));
  ok('filter maxScore bounds',           matchesFilter(itemLow,  { maxScore: 50 }));
  ok('filter category mismatch fails',  !matchesFilter(itemHigh, { category: 'frontend' }));
  ok('filter minYears blocks',          !matchesFilter(itemLow,  { minYears: 3 }));

  ok('renderTemplate substitutes',
    renderTemplate('Hi {{first_name}} — {{role}}', { first_name: 'Alex', role: 'Backend' }) === 'Hi Alex — Backend');
  ok('renderTemplate handles missing',
    renderTemplate('x {{missing}} y', {}) === 'x  y');

  section('engine: graph traversal w/ stub candidate (dry-run)');
  // Insert one synthetic resume so the engine has someone to process.
  const { insertResume } = db;
  const r = insertResume({
    filename: 'alex.pdf',
    candidateName: 'Alex Test',
    rawText: 'experienced backend dev',
    score: 88,
    category: 'backend',
    roleTitle: 'Senior backend',
    reviewJson: { score: 88, summary: 'great' },
    candidate: { name: 'Alex Test', email: 'alex@example.com', topSkills: ['python','aws'], yearsExperience: 5 }
  });
  ok('insert synthetic resume', Number.isFinite(r.id));

  const result = await eng.runWorkflow(wfId, { mode: 'dry-run' });
  ok('dry-run returns ok', result.status === 'ok',  `status=${result.status}`);
  ok('dry-run sees triggers', result.summary.totals.triggers >= 1);

  // Run a workflow that uses sendOaEmail in dry-run — should NOT need Google,
  // since dry-run never calls the API. Build one inline.
  const wfOA = adb.createWorkflow({
    name: 'OA dry-run',
    graph: {
      nodes: [
        { id: 't', type: 'trigger.manual', x: 0, y: 0, config: {} },
        { id: 'f', type: 'logic.filter',   x: 200, y: 0, config: { minScore: 50, requireEmail: true } },
        { id: 'oa', type: 'action.sendOaEmail', x: 400, y: 0, config: { templateId: tplId } }
      ],
      edges: [
        { from: 't', to: 'f' },
        { from: 'f', to: 'oa' }
      ]
    }
  });
  const dr = await eng.runWorkflow(wfOA, { mode: 'dry-run' });
  ok('OA dry-run is ok', dr.status === 'ok', `status=${dr.status}`);
  const run = adb.getRun(dr.runId);
  ok('OA dry-run produced preview rows', run.actions.some((a) => a.status === 'preview'));
  const previewRow = run.actions.find((a) => a.status === 'preview');
  ok('preview includes templated subject', previewRow?.detail?.subject?.includes('Hi Alex'));
  ok('preview body includes oa link', previewRow?.detail?.body?.includes('https://example.com/oa'));

  section('availability windows');
  const ivWin = adb.addAvailabilityWindow(ivId, {
    start: new Date(Date.now() + 86_400_000).toISOString().slice(0, 16) + ':00.000Z',
    end:   new Date(Date.now() + 86_400_000 + 2 * 3600_000).toISOString().slice(0, 16) + ':00.000Z'
  });
  ok('addAvailabilityWindow returns id', typeof ivWin.id === 'string');
  ok('window persisted on interviewer', adb.getInterviewer(ivId).availability.length === 1);
  let badThrew = false;
  try { adb.addAvailabilityWindow(ivId, { start: 'x', end: 'y' }); }
  catch { badThrew = true; }
  ok('addAvailabilityWindow rejects bad dates', badThrew);
  let invertedThrew = false;
  try { adb.addAvailabilityWindow(ivId, { start: '2030-01-01T10:00:00Z', end: '2030-01-01T09:00:00Z' }); }
  catch { invertedThrew = true; }
  ok('addAvailabilityWindow rejects inverted range', invertedThrew);
  adb.removeAvailabilityWindow(ivId, ivWin.id);
  ok('removeAvailabilityWindow drops the window', adb.getInterviewer(ivId).availability.length === 0);

  section('scheduling math: interval merge + intersect');
  const { mergeIntervals, intersectIntervals } = (await import('./google.js')).__schedTesting;
  const t = (h) => new Date(2030, 0, 1, h, 0, 0, 0);
  const merged = mergeIntervals([
    { start: t(9),  end: t(11) },
    { start: t(10), end: t(12) },
    { start: t(13), end: t(14) }
  ]);
  ok('merge collapses overlapping', merged.length === 2);
  ok('merge keeps disjoint',        merged[0].end.getHours() === 12 && merged[1].start.getHours() === 13);

  const inter = intersectIntervals(
    [{ start: t(9),  end: t(12) }, { start: t(13), end: t(17) }],
    [{ start: t(11), end: t(14) }, { start: t(15), end: t(16) }]
  );
  ok('intersect overlaps correctly', inter.length === 3);
  ok('intersect 11-12',  inter[0].start.getHours() === 11 && inter[0].end.getHours() === 12);
  ok('intersect 13-14',  inter[1].start.getHours() === 13 && inter[1].end.getHours() === 14);
  ok('intersect 15-16',  inter[2].start.getHours() === 15 && inter[2].end.getHours() === 16);

  const disjoint = intersectIntervals(
    [{ start: t(9), end: t(10) }],
    [{ start: t(14), end: t(15) }]
  );
  ok('intersect returns empty when disjoint', disjoint.length === 0);

  section('engine: rejection score gating + band split');
  // Add a couple more synthetic resumes so we have a score spread.
  db.insertResume({
    filename: 'mid.pdf', candidateName: 'Mid Scorer',
    rawText: 'mid', score: 55, category: 'backend', roleTitle: 'Engineer',
    reviewJson: { score: 55 }, candidate: { name: 'Mid Scorer', email: 'mid@example.com' }
  });
  db.insertResume({
    filename: 'low.pdf', candidateName: 'Low Scorer',
    rawText: 'low', score: 20, category: 'backend', roleTitle: 'Engineer',
    reviewJson: { score: 20 }, candidate: { name: 'Low Scorer', email: 'low@example.com' }
  });

  const wfReject = adb.createWorkflow({
    name: 'reject test',
    graph: {
      nodes: [
        { id: 't', type: 'trigger.manual', x:0, y:0, config:{} },
        { id: 'r', type: 'action.sendRejection', x:200, y:0, config: {
          maxScore: 60,         // anyone > 60 is skipped
          nearMissAbove: 50,    // 50-60 gets near-miss body; <50 gets standard
          subject: 'No this time', body: 'standard {{first_name}}',
          nearMissSubject: 'So close', nearMissBody: 'near {{first_name}}'
        } }
      ],
      edges: [{ from: 't', to: 'r' }]
    }
  });
  const rj = await eng.runWorkflow(wfReject, { mode: 'dry-run' });
  const rjRun = adb.getRun(rj.runId);
  const high = rjRun.actions.find((a) => a.candidate === 'Alex Test');
  const mid  = rjRun.actions.find((a) => a.candidate === 'Mid Scorer');
  const low  = rjRun.actions.find((a) => a.candidate === 'Low Scorer');
  ok('high (88) skipped by maxScore',     high?.status === 'skipped' && /above rejection cap/.test(high?.detail?.reason));
  ok('mid (55) gets near-miss body',      mid?.status === 'preview' && mid.detail.tier === 'near-miss' && mid.detail.body.startsWith('near'));
  ok('low (20) gets standard body',       low?.status === 'preview' && low.detail.tier === 'standard' && low.detail.body.startsWith('standard'));

  // With no maxScore set, the high-scorer should also be sent (acts as a normal action).
  adb.updateWorkflow(wfReject, { graph: {
    nodes: [
      { id: 't', type: 'trigger.manual', x:0, y:0, config:{} },
      { id: 'r', type: 'action.sendRejection', x:200, y:0, config: {} }
    ],
    edges: [{ from: 't', to: 'r' }]
  }});
  const rj2 = await eng.runWorkflow(wfReject, { mode: 'dry-run' });
  const rjRun2 = adb.getRun(rj2.runId);
  const high2 = rjRun2.actions.find((a) => a.candidate === 'Alex Test');
  ok('with no maxScore, every score is allowed through', high2?.status === 'preview');

  section('engine: rejects cycles');
  const wfBad = adb.createWorkflow({
    name: 'cycle',
    graph: {
      nodes: [
        { id: 't', type: 'trigger.manual', x:0, y:0, config:{} },
        { id: 'a', type: 'logic.filter',   x:1, y:0, config:{} },
        { id: 'b', type: 'logic.filter',   x:2, y:0, config:{} }
      ],
      edges: [
        { from: 't', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' }      // ← cycle
      ]
    }
  });
  let threw = false;
  try { await eng.runWorkflow(wfBad, { mode: 'dry-run' }); }
  catch (e) { threw = /cyclic/i.test(e.message); }
  ok('cycle detection trips engine', threw);

  section('routes: smoke via supertest-like fetch');
  // Boot the express app inline (not as a separate server) by importing it.
  // This relies on server.js exporting nothing; we use a quick HTTP listen
  // on an ephemeral port.
  const { default: http } = await import('node:http');
  const express = (await import('express')).default;
  const cors = (await import('cors')).default;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(cors());

  // Mount the same handlers by re-importing server module would also boot
  // the listener. Cheaper: mount our small subset of automation routes.
  app.get('/automation/workflows', (_q, s) => s.json({ workflows: adb.listWorkflows() }));
  app.post('/automation/workflows/:id/run', async (q, s) => {
    try {
      const out = await eng.runWorkflow(Number(q.params.id), { mode: q.body?.mode || 'dry-run' });
      s.json(out);
    } catch (err) { s.status(500).json({ error: err.message }); }
  });
  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const lst = await fetch(`${base}/automation/workflows`).then((r) => r.json());
  ok('GET /automation/workflows returns array', Array.isArray(lst.workflows));
  const runResp = await fetch(`${base}/automation/workflows/${wfOA}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'dry-run' })
  }).then((r) => r.json());
  ok('POST run returns runId', Number.isFinite(runResp.runId), `body=${JSON.stringify(runResp)}`);
  server.close();

  // ----- summary -----
  console.log(out.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((err) => { console.error('UNCAUGHT', err); process.exitCode = 2; })
  .finally(() => {
    // Cleanup temp DB. (WAL/SHM files cleaned too.)
    for (const ext of ['', '-wal', '-shm']) {
      const p = TMP_DB + ext;
      if (existsSync(p)) try { unlinkSync(p); } catch {}
    }
  });
