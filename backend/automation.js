// Automation engine. Walks the saved workflow graph from each trigger,
// pushes every candidate through Filter/Branch nodes, then fires Actions.
//
// Mental model:
//   nodes are connected by edges { from, to }
//   data flow = an array of "items" (each item is one candidate)
//   Trigger emits the initial item list
//   Logic nodes (filter, branch, delay) transform / split the list
//   Action nodes consume the list and side-effect (email / calendar / log)
//
// We resolve graph traversal with a tiny topological walk: each node only
// fires once, with the union of items handed to it by upstream edges.
// Cycles are forbidden by the UI; if one sneaks in we detect it and bail.

import {
  getWorkflow, createRun, finalizeRun, recordAction,
  listInterviewers, getTemplate
} from './automationDb.js';
import { listResumes, getResume, getResumeProfiles } from './db.js';
import {
  googleConnected, findNextFreeSlot, createMeetEvent, sendGmail
} from './google.js';

// -------------------------------------------------------------------------
// Entry point. mode = 'live' | 'dry-run'.
export async function runWorkflow(workflowId, {
  mode = 'live',
  candidateIds = null,        // pre-selected; if null we pull everything
  manualOverrides = {}        // node-id -> partial config override (for ad-hoc edits)
} = {}) {
  const wf = getWorkflow(workflowId);
  if (!wf) throw new Error('Workflow not found.');
  if (!wf.enabled && mode === 'live') throw new Error('Workflow is disabled.');

  const runId = createRun({ workflowId, mode });

  const summary = {
    workflowId,
    mode,
    totals: { triggers: 0, filtered: 0, actions: 0, errors: 0 },
    nodes: {}
  };

  try {
    const graph = normalizeGraph(wf.graph);
    const initialItems = await loadCandidates(candidateIds);
    summary.totals.triggers = initialItems.length;

    const ctx = { runId, mode, graph, manualOverrides, summary };
    const nodeItems = new Map();          // nodeId -> array of items at entry
    const nodeStatus = new Map();         // nodeId -> 'pending' | 'done'

    // Triggers seed the initial items.
    for (const n of graph.nodes) {
      if (n.type.startsWith('trigger.')) {
        nodeItems.set(n.id, initialItems);
      }
    }

    // Process nodes in topological-ish order: repeatedly find a node whose
    // predecessors are all done. The UI prevents cycles; if we get stuck
    // we abort with a clear error.
    let safety = graph.nodes.length * 2 + 1;
    while (safety-- > 0) {
      const ready = graph.nodes.find((n) =>
        !nodeStatus.get(n.id) &&
        graph.predecessors(n.id).every((pid) => nodeStatus.get(pid) === 'done') &&
        (nodeItems.has(n.id) || graph.predecessors(n.id).length === 0)
      );
      if (!ready) break;

      const items = nodeItems.get(ready.id) || [];
      const outputs = await runNode(ctx, ready, items);
      nodeStatus.set(ready.id, 'done');

      // Hand off to downstream nodes. Logic nodes may emit multiple labelled
      // streams (e.g. filter.pass, filter.fail). We carry the label on edges
      // via edge.from === nodeId + ':' + label OR plain nodeId.
      for (const edge of graph.outgoing(ready.id)) {
        const stream = outputs[edge.label || 'out'] || outputs.out || [];
        const merged = nodeItems.get(edge.to) || [];
        nodeItems.set(edge.to, mergeUnique(merged, stream));
      }
    }

    if (safety <= 0) throw new Error('Workflow graph appears cyclic.');
    // If any node was reachable from a trigger but never executed, we hit a
    // cycle (the readiness loop just no-ops out instead of looping forever).
    const unreached = graph.nodes.filter((n) =>
      !nodeStatus.get(n.id) && (nodeItems.has(n.id) || n.type.startsWith('trigger.'))
    );
    if (unreached.length) {
      throw new Error(`Workflow graph appears cyclic — couldn't reach: ${unreached.map((n) => n.id).join(', ')}`);
    }

    const status = summary.totals.errors === 0
      ? 'ok'
      : (summary.totals.errors < summary.totals.actions ? 'partial' : 'error');
    finalizeRun(runId, { status, summary });
    return { runId, status, summary };
  } catch (err) {
    finalizeRun(runId, { status: 'error', summary: { ...summary, error: err.message } });
    throw err;
  }
}

// Merge two item lists, deduping by resumeId.
function mergeUnique(a, b) {
  const seen = new Set(a.map((x) => x.resumeId));
  for (const it of b) if (!seen.has(it.resumeId)) { a.push(it); seen.add(it.resumeId); }
  return a;
}

// -------------------------------------------------------------------------
// Graph wrapper. Provides predecessors / outgoing helpers + light validation.
function normalizeGraph(g) {
  const nodes = (g.nodes || []).map((n) => ({ ...n }));
  const edges = (g.edges || []).map((e) => ({ from: e.from, to: e.to, label: e.label || null }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return {
    nodes,
    edges,
    get: (id) => byId.get(id),
    predecessors: (id) => edges.filter((e) => e.to === id).map((e) => e.from),
    outgoing:     (id) => edges.filter((e) => e.from === id)
  };
}

// -------------------------------------------------------------------------
// Items + candidate loading. Each item is a snapshot of a candidate the rest
// of the engine can read without hitting the DB again.

async function loadCandidates(candidateIds) {
  let ids;
  if (Array.isArray(candidateIds) && candidateIds.length) {
    ids = candidateIds.map(Number).filter(Number.isFinite);
  } else {
    ids = listResumes().map((r) => r.id);
  }
  if (ids.length === 0) return [];
  const profiles = getResumeProfiles(ids);
  return profiles.map(profileToItem);
}

function profileToItem(p) {
  return {
    resumeId: p.id,
    name: p.candidate_name || 'Unknown',
    firstName: firstName(p.candidate_name),
    email: p.email || '',
    score: Number.isFinite(p.score) ? p.score : 0,
    category: p.category || '',
    roleTitle: p.role_title || '',
    skills: p.top_skills || [],
    years: Number.isFinite(p.years_experience) ? p.years_experience : null,
    education: p.highest_education || '',
    location: p.location || '',
    linkedin: p.linkedin || '',
    raw: p
  };
}

function firstName(full) {
  if (!full) return 'there';
  const w = String(full).trim().split(/\s+/)[0];
  return w || 'there';
}

// -------------------------------------------------------------------------
// Node dispatch.

async function runNode(ctx, node, items) {
  const cfg = { ...(node.config || {}), ...(ctx.manualOverrides[node.id] || {}) };
  const tag = node.type;
  try {
    if (tag.startsWith('trigger.'))  return { out: items };
    if (tag === 'logic.filter')      return runFilter(ctx, node, items, cfg);
    if (tag === 'logic.branch')      return runBranch(ctx, node, items, cfg);
    if (tag === 'logic.limit')       return runLimit(ctx, node, items, cfg);
    // The action handlers are async — must `await` here so a thrown error
    // lands in the catch below instead of escaping as an unhandled rejection.
    if (tag === 'action.sendOaEmail')         return await runSendOaEmail(ctx, node, items, cfg);
    if (tag === 'action.scheduleInterview')   return await runScheduleInterview(ctx, node, items, cfg);
    if (tag === 'action.sendRejection')       return await runSendRejection(ctx, node, items, cfg);
    if (tag === 'action.logRun')              return runLogNote(ctx, node, items, cfg);
    if (tag === 'action.notify')              return runNotifyOwner(ctx, node, items, cfg);
    throw new Error(`Unknown node type: ${tag}`);
  } catch (err) {
    ctx.summary.totals.errors++;
    recordAction({
      runId: ctx.runId, nodeId: node.id, nodeType: node.type,
      status: 'error', detail: { error: err.message }
    });
    return { out: [] };
  }
}

// --- Logic nodes ---------------------------------------------------------

function runFilter(ctx, node, items, cfg) {
  const pass = [], fail = [];
  for (const it of items) {
    if (matchesFilter(it, cfg)) pass.push(it); else fail.push(it);
  }
  ctx.summary.totals.filtered += pass.length;
  recordAction({
    runId: ctx.runId, nodeId: node.id, nodeType: node.type,
    status: 'ok', detail: { in: items.length, pass: pass.length, fail: fail.length, cfg }
  });
  return { out: pass, pass, fail };
}

function matchesFilter(it, cfg) {
  if (Number.isFinite(cfg.minScore) && it.score < cfg.minScore) return false;
  if (Number.isFinite(cfg.maxScore) && it.score > cfg.maxScore) return false;
  if (cfg.category && it.category && it.category !== cfg.category) return false;
  if (Number.isFinite(cfg.minYears) && (it.years ?? -1) < cfg.minYears) return false;
  if (Number.isFinite(cfg.maxYears) && it.years != null && it.years > cfg.maxYears) return false;
  if (Array.isArray(cfg.skillsAny) && cfg.skillsAny.length) {
    const have = new Set(it.skills.map((s) => s.toLowerCase()));
    const ok = cfg.skillsAny.some((s) => have.has(String(s).toLowerCase()));
    if (!ok) return false;
  }
  if (Array.isArray(cfg.skillsAll) && cfg.skillsAll.length) {
    const have = new Set(it.skills.map((s) => s.toLowerCase()));
    const ok = cfg.skillsAll.every((s) => have.has(String(s).toLowerCase()));
    if (!ok) return false;
  }
  if (cfg.requireEmail && !it.email) return false;
  return true;
}

function runBranch(ctx, node, items, cfg) {
  const a = [], b = [];
  const threshold = Number(cfg.threshold ?? 75);
  for (const it of items) (it.score >= threshold ? a : b).push(it);
  recordAction({
    runId: ctx.runId, nodeId: node.id, nodeType: node.type,
    status: 'ok', detail: { threshold, top: a.length, rest: b.length }
  });
  return { out: a, top: a, rest: b };
}

function runLimit(ctx, node, items, cfg) {
  const n = Math.max(1, Math.min(500, Number(cfg.n) || 10));
  const sorted = [...items].sort((x, y) => (y.score - x.score));
  const out = sorted.slice(0, n);
  recordAction({
    runId: ctx.runId, nodeId: node.id, nodeType: node.type,
    status: 'ok', detail: { in: items.length, out: out.length, n }
  });
  return { out };
}

// --- Action nodes --------------------------------------------------------

async function runSendOaEmail(ctx, node, items, cfg) {
  ctx.summary.totals.actions++;
  let template;
  if (cfg.templateId) template = getTemplate(Number(cfg.templateId));
  if (!template) {
    template = {
      subject: cfg.subject || 'Online assessment for your application',
      body:    cfg.body    || 'Hi {{first_name}},\n\nPlease complete the OA here: {{oa_link}}\n\nThanks!',
      oa_link: cfg.oaLinkOverride || ''
    };
  }
  const oaLink = cfg.oaLinkOverride || template.oa_link || '';

  const sent = [];
  for (const it of items) {
    const ctxVars = {
      first_name: it.firstName,
      name: it.name,
      role: it.roleTitle || it.category || 'the role',
      score: it.score,
      oa_link: oaLink,
      deadline: humanDate(Date.now() + 5 * 86400_000)
    };
    const subject = renderTemplate(template.subject, ctxVars);
    const body    = renderTemplate(template.body, ctxVars);

    if (!it.email) {
      recordAction({
        runId: ctx.runId, resumeId: it.resumeId, candidate: it.name,
        nodeId: node.id, nodeType: node.type,
        status: 'skipped', detail: { reason: 'no email on resume', subject }
      });
      continue;
    }

    if (ctx.mode === 'dry-run') {
      recordAction({
        runId: ctx.runId, resumeId: it.resumeId, candidate: it.name,
        nodeId: node.id, nodeType: node.type,
        status: 'preview', detail: { to: it.email, subject, body }
      });
      sent.push(it);
      continue;
    }

    if (!googleConnected()) throw new Error('Gmail send requires Google to be connected.');

    try {
      const messageId = await sendGmail({ to: it.email, subject, body });
      recordAction({
        runId: ctx.runId, resumeId: it.resumeId, candidate: it.name,
        nodeId: node.id, nodeType: node.type,
        status: 'ok', detail: { to: it.email, subject, messageId }
      });
      sent.push(it);
    } catch (err) {
      ctx.summary.totals.errors++;
      recordAction({
        runId: ctx.runId, resumeId: it.resumeId, candidate: it.name,
        nodeId: node.id, nodeType: node.type,
        status: 'error', detail: { to: it.email, subject, error: err.message }
      });
    }
    // tiny pause so we don't trip Gmail's per-second quota at scale
    await sleep(120);
  }
  return { out: sent };
}

async function runScheduleInterview(ctx, node, items, cfg) {
  ctx.summary.totals.actions++;

  const interviewerIds = (cfg.interviewerIds || []).map(Number).filter(Number.isFinite);
  const interviewers   = listInterviewers().filter((iv) => interviewerIds.includes(iv.id));
  const calendarIds    = interviewers.map((iv) => iv.calendar_id || 'primary');
  const interviewersEm = interviewers.map((iv) => ({ email: iv.email, displayName: iv.name }));
  // Each interviewer's stated availability windows. Calendars with an empty
  // list fall back to dayStart/dayEnd inside findNextFreeSlot.
  const availabilityWindows = interviewers.map((iv) => ({
    calendarId: iv.calendar_id || 'primary',
    windows: iv.availability || []
  }));

  if (interviewers.length === 0) {
    throw new Error('No interviewers selected for the schedule node.');
  }

  const out = [];
  for (const it of items) {
    if (!it.email) {
      recordAction({
        runId: ctx.runId, resumeId: it.resumeId, candidate: it.name,
        nodeId: node.id, nodeType: node.type,
        status: 'skipped', detail: { reason: 'no candidate email' }
      });
      continue;
    }

    if (ctx.mode === 'dry-run') {
      const stated = availabilityWindows.flatMap((a) => a.windows);
      recordAction({
        runId: ctx.runId, resumeId: it.resumeId, candidate: it.name,
        nodeId: node.id, nodeType: node.type,
        status: 'preview',
        detail: {
          summary: `Interview · ${it.name}`,
          attendees: [it.email, ...interviewersEm.map((iv) => iv.email)],
          window: stated.length
            ? `${stated.length} interviewer window(s) honored`
            : `${cfg.dayStart || '10:00'}–${cfg.dayEnd || '17:00'}, next ${cfg.daysAhead || 7}d (no explicit availability)`,
          duration: cfg.durationMinutes || 30,
          stated
        }
      });
      out.push(it);
      continue;
    }

    if (!googleConnected()) throw new Error('Calendar scheduling requires Google to be connected.');

    try {
      const slot = await findNextFreeSlot({
        calendarIds,
        durationMinutes: Number(cfg.durationMinutes) || 30,
        dayStart: cfg.dayStart || '10:00',
        dayEnd:   cfg.dayEnd   || '17:00',
        daysAhead: Number(cfg.daysAhead) || 7,
        timeZone:  interviewers[0].timezone || undefined,
        availabilityWindows
      });
      if (!slot) {
        const anyStated = availabilityWindows.some((a) => a.windows.length);
        throw new Error(anyStated
          ? 'No interviewer-availability slot overlaps for the chosen panel.'
          : `No free interview slot in the next ${cfg.daysAhead || 7} days.`);
      }

      const event = await createMeetEvent({
        calendarId: interviewers[0].calendar_id || 'primary',
        summary: `Interview · ${it.name}${it.roleTitle ? ' · ' + it.roleTitle : ''}`,
        description:
`Resume score: ${it.score}/100
Category: ${it.category || '—'}
Resume on file in Resume Scorer (id #${it.resumeId})`,
        startIso: slot.start, endIso: slot.end,
        attendees: [{ email: it.email, displayName: it.name }, ...interviewersEm],
        timeZone: interviewers[0].timezone || undefined
      });
      const meetUrl = event.hangoutLink ||
        event.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ||
        '';
      recordAction({
        runId: ctx.runId, resumeId: it.resumeId, candidate: it.name,
        nodeId: node.id, nodeType: node.type,
        status: 'ok',
        detail: {
          eventId: event.id, htmlLink: event.htmlLink, meetUrl,
          start: slot.start, end: slot.end,
          interviewers: interviewers.map((iv) => iv.email)
        }
      });
      out.push(it);
    } catch (err) {
      ctx.summary.totals.errors++;
      recordAction({
        runId: ctx.runId, resumeId: it.resumeId, candidate: it.name,
        nodeId: node.id, nodeType: node.type,
        status: 'error', detail: { error: err.message }
      });
    }
    await sleep(150);
  }
  return { out };
}

async function runSendRejection(ctx, node, items, cfg) {
  ctx.summary.totals.actions++;
  const tone     = cfg.tone || 'warm';
  const maxScore = Number.isFinite(+cfg.maxScore) ? +cfg.maxScore : null;
  const nearMiss = Number.isFinite(+cfg.nearMissAbove) ? +cfg.nearMissAbove : null;

  // Tier-routed templates. nearMissBody/subject are used when score ≥ nearMissAbove
  // (a near-miss candidate deserves a kinder note); below that we fall back to
  // the default body. Either can be left blank; defaults are used in that case.
  const subjectDefault  = cfg.subject     || 'Update on your application';
  const bodyDefault     = cfg.body        || defaultRejectionBody(tone);
  const subjectNearMiss = cfg.nearMissSubject || subjectDefault;
  const bodyNearMiss    = cfg.nearMissBody    || defaultNearMissBody();

  const sent = [];
  for (const it of items) {
    if (maxScore != null && Number.isFinite(it.score) && it.score > maxScore) {
      recordAction({
        runId: ctx.runId, resumeId: it.resumeId, candidate: it.name,
        nodeId: node.id, nodeType: node.type,
        status: 'skipped',
        detail: { reason: `score ${it.score} above rejection cap ${maxScore}` }
      });
      continue;
    }
    if (!it.email) {
      recordAction({
        runId: ctx.runId, resumeId: it.resumeId, candidate: it.name,
        nodeId: node.id, nodeType: node.type,
        status: 'skipped', detail: { reason: 'no email' }
      });
      continue;
    }
    const tier = (nearMiss != null && Number.isFinite(it.score) && it.score >= nearMiss) ? 'near-miss' : 'standard';
    const vars = { first_name: it.firstName, name: it.name, role: it.roleTitle || 'the role', score: it.score };
    const subj    = renderTemplate(tier === 'near-miss' ? subjectNearMiss : subjectDefault, vars);
    const bodyOut = renderTemplate(tier === 'near-miss' ? bodyNearMiss    : bodyDefault,    vars);

    if (ctx.mode === 'dry-run') {
      recordAction({
        runId: ctx.runId, resumeId: it.resumeId, candidate: it.name,
        nodeId: node.id, nodeType: node.type,
        status: 'preview', detail: { to: it.email, subject: subj, body: bodyOut, tier, score: it.score }
      });
      sent.push(it);
      continue;
    }
    if (!googleConnected()) throw new Error('Rejection send requires Google to be connected.');
    try {
      const id = await sendGmail({ to: it.email, subject: subj, body: bodyOut });
      recordAction({
        runId: ctx.runId, resumeId: it.resumeId, candidate: it.name,
        nodeId: node.id, nodeType: node.type,
        status: 'ok', detail: { to: it.email, subject: subj, messageId: id, tier, score: it.score }
      });
      sent.push(it);
    } catch (err) {
      ctx.summary.totals.errors++;
      recordAction({
        runId: ctx.runId, resumeId: it.resumeId, candidate: it.name,
        nodeId: node.id, nodeType: node.type,
        status: 'error', detail: { error: err.message, tier }
      });
    }
    await sleep(120);
  }
  return { out: sent };
}

function defaultNearMissBody() {
  return `Hi {{first_name}},

Thanks for putting time into your application for {{role}}. You were genuinely close — strong fundamentals and clear progression — but we ended up moving forward with a candidate whose recent experience lined up a bit more directly with what this specific role needs.

I'd love to keep your details on file and reach out when something better-aligned opens up. If you're interested in staying loosely in touch, just reply to this email and I'll add you to our shortlist for future roles.

Wishing you the best.

Warm regards,
Recruiting Team`;
}

function defaultRejectionBody() {
  return `Hi {{first_name}},

Thank you for taking the time to apply for {{role}}. After reviewing your background against the role's needs, we've decided to move forward with other candidates this time.

We'll keep your details on file and reach out if a better-aligned role opens up. Wishing you the best in your search.

Warm regards,
Recruiting Team`;
}

function runLogNote(ctx, node, items, cfg) {
  recordAction({
    runId: ctx.runId, nodeId: node.id, nodeType: node.type,
    status: 'ok',
    detail: { note: cfg.note || '', count: items.length, candidates: items.slice(0, 50).map((i) => i.name) }
  });
  return { out: items };
}

function runNotifyOwner(ctx, node, items, cfg) {
  // Lightweight: just a recorded notification line; the dashboard surfaces it
  // in the run-history panel. Hooking up Slack/webhooks is a follow-up.
  recordAction({
    runId: ctx.runId, nodeId: node.id, nodeType: node.type,
    status: 'ok',
    detail: {
      title: cfg.title || 'Workflow finished',
      message: (cfg.message || `Processed ${items.length} candidates.`).replace('{{count}}', items.length)
    }
  });
  return { out: items };
}

// -------------------------------------------------------------------------
// Helpers

function renderTemplate(s, vars) {
  if (!s) return '';
  return String(s).replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (_, k) =>
    (vars[k] == null ? '' : String(vars[k]))
  );
}
function humanDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Exposed for tests.
export const __testing = { renderTemplate, matchesFilter, profileToItem, normalizeGraph };
