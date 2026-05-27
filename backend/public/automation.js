// Automation builder front-end. Vanilla JS, no framework. Drives:
//   - workflow list (left rail)
//   - canvas (drag nodes around, drag ports to wire edges)
//   - inspector (right rail) — type-specific config form for the selected node
//   - candidate picker modal
//   - run history + run-detail modal
//   - Google connection card + interviewers + templates in Settings
//
// State lives in `state`. Persisted to backend via /automation/* endpoints.

const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const toast = (msg, kind) => {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast ${kind || ''}`;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3000);
};

// ---------- Catalog of node types -----------------------------------------

const NODE_CATALOG = {
  'trigger.manual': {
    kind: 'trigger', name: 'Manual run', ico: '▶',
    summary: () => 'Fires when you click Execute.',
    defaultConfig: () => ({ label: 'Manual trigger' })
  },
  'logic.filter': {
    kind: 'logic', name: 'Filter', ico: '◇',
    summary: (c) => {
      const parts = [];
      if (Number.isFinite(+c.minScore)) parts.push(`score ≥ ${c.minScore}`);
      if (Number.isFinite(+c.maxScore)) parts.push(`score ≤ ${c.maxScore}`);
      if (c.category) parts.push(`cat = ${c.category}`);
      if (Number.isFinite(+c.minYears)) parts.push(`yrs ≥ ${c.minYears}`);
      if (Array.isArray(c.skillsAny) && c.skillsAny.length) parts.push(`any: ${c.skillsAny.slice(0,3).join(', ')}`);
      if (c.requireEmail) parts.push('has email');
      return parts.length ? parts.join(' · ') : 'No rules — passes everything';
    },
    defaultConfig: () => ({ minScore: null, maxScore: null, category: '', minYears: null, skillsAny: [], skillsAll: [], requireEmail: true })
  },
  'logic.branch': {
    kind: 'logic', name: 'Branch', ico: '⌥',
    summary: (c) => `≥ ${c.threshold ?? 75} = top · rest = below`,
    defaultConfig: () => ({ threshold: 75 })
  },
  'logic.limit': {
    kind: 'logic', name: 'Take top N', ico: '↧',
    summary: (c) => `Keep top ${c.n ?? 10} by score`,
    defaultConfig: () => ({ n: 10 })
  },
  'action.sendOaEmail': {
    kind: 'action', name: 'Send OA link', ico: '✉',
    summary: (c) => c.templateId ? `Template #${c.templateId}` :
                   (c.oaLinkOverride ? 'Custom link override' : 'No template selected'),
    defaultConfig: () => ({ templateId: null, oaLinkOverride: '', subject: '', body: '' })
  },
  'action.scheduleInterview': {
    kind: 'action', name: 'Schedule interview', ico: '📅',
    summary: (c) => {
      const n = (c.interviewerIds || []).length;
      const dur = c.durationMinutes || 30;
      return `${n} interviewer${n === 1 ? '' : 's'} · ${dur}m · ${c.dayStart || '10:00'}–${c.dayEnd || '17:00'}`;
    },
    defaultConfig: () => ({
      interviewerIds: [], durationMinutes: 30,
      dayStart: '10:00', dayEnd: '17:00',
      daysAhead: 7, createMeet: true
    })
  },
  'action.sendRejection': {
    kind: 'action', name: 'Polite rejection', ico: '✕',
    summary: (c) => {
      const parts = [];
      if (Number.isFinite(+c.maxScore)) parts.push(`only score ≤ ${c.maxScore}`);
      if (Number.isFinite(+c.nearMissAbove)) parts.push(`near-miss band ≥ ${c.nearMissAbove}`);
      parts.push(`tone: ${c.tone || 'warm'}`);
      return parts.join(' · ');
    },
    defaultConfig: () => ({
      tone: 'warm', maxScore: null, nearMissAbove: null,
      subject: '', body: '', nearMissSubject: '', nearMissBody: ''
    })
  },
  'action.notify': {
    kind: 'action', name: 'Notify me', ico: '🔔',
    summary: (c) => c.title || 'Pin a note in history',
    defaultConfig: () => ({ title: 'Workflow finished', message: 'Processed {{count}} candidates.' })
  },
  'action.logRun': {
    kind: 'action', name: 'Log note', ico: '≡',
    summary: (c) => c.note ? `“${c.note}”` : 'Stamp this run',
    defaultConfig: () => ({ note: '' })
  }
};

const NODE_W = 168;
const NODE_H = 64;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.5;

// ---------- State ---------------------------------------------------------

const state = {
  initialized: false,
  workflows: [],
  currentId: null,
  graph: { nodes: [], edges: [] },
  selectedNodeId: null,
  selectedCandidates: [],   // [] = use everyone
  templates: [],
  interviewers: [],
  draggingNode: null,
  draggingEdge: null,
  zoom: 0.85,               // canvas zoom level
  dirty: false,
  candidatesCache: null
};

// ---------- Public entry points ------------------------------------------

window.initAutomationIfNeeded = async function initAutomationIfNeeded() {
  if (state.initialized) return;
  state.initialized = true;
  bindUI();
  await Promise.all([refreshWorkflows(), refreshTemplates(), refreshInterviewers(), refreshHistory()]);
  if (state.workflows.length > 0) {
    openWorkflow(state.workflows[0].id);
  } else {
    const id = await createBlankWorkflow();
    openWorkflow(id);
  }
};

window.refreshAutomationSettings = async function refreshAutomationSettings() {
  await Promise.all([loadGoogleStatus(), renderInterviewers(), renderTemplates()]);
  wireSettingsForms();
};

// ---------- Loaders -------------------------------------------------------

async function refreshWorkflows() {
  const { workflows } = await api('/automation/workflows');
  state.workflows = workflows || [];
  renderWorkflowList();
}

async function refreshTemplates() {
  const { templates } = await api('/automation/templates');
  state.templates = templates || [];
}

async function refreshInterviewers() {
  const { interviewers } = await api('/automation/interviewers');
  state.interviewers = interviewers || [];
}

async function refreshHistory() {
  try {
    const wfId = state.currentId;
    const path = wfId ? `/automation/runs?workflowId=${wfId}` : '/automation/runs';
    const { runs } = await api(path);
    renderHistory(runs);
  } catch { /* harmless on first load */ }
}

async function createBlankWorkflow() {
  const r = await api('/automation/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Untitled workflow',
      description: '',
      graph: { nodes: [{ id: nodeId('trigger'), type: 'trigger.manual', x: 60, y: 200, config: NODE_CATALOG['trigger.manual'].defaultConfig() }], edges: [] }
    })
  });
  await refreshWorkflows();
  return r.id;
}

async function openWorkflow(id) {
  const wf = await api(`/automation/workflows/${id}`);
  state.currentId = wf.id;
  state.graph = wf.graph || { nodes: [], edges: [] };
  state.selectedNodeId = null;
  state.dirty = false;
  $('autoWfName').value = wf.name || '';
  renderWorkflowList();
  renderCanvas();
  renderInspector();
  refreshHistory();
  // Once the layout settles, fit content into view.
  requestAnimationFrame(fitToContent);
}

// ---------- Workflow list rendering --------------------------------------

function renderWorkflowList() {
  const ul = $('autoWfList');
  if (!ul) return;
  if (!state.workflows.length) {
    ul.innerHTML = '<li class="muted small" style="padding:8px 10px;cursor:default;">No workflows yet</li>';
    return;
  }
  ul.innerHTML = state.workflows.map((w) => `
    <li data-id="${w.id}" class="${w.id === state.currentId ? 'active' : ''}">
      <div>
        <div class="wf-title">${escapeHtml(w.name)}</div>
        <div class="wf-mini">${w.enabled ? 'enabled' : 'paused'} · updated ${fmtAgo(w.updated_at)}</div>
      </div>
      <span class="wf-del" title="Delete">×</span>
    </li>
  `).join('');
  ul.querySelectorAll('li[data-id]').forEach((li) => {
    const id = Number(li.dataset.id);
    li.addEventListener('click', (e) => {
      if (e.target.classList.contains('wf-del')) {
        e.stopPropagation();
        deleteWorkflowConfirm(id);
        return;
      }
      openWorkflow(id);
    });
  });
}

async function deleteWorkflowConfirm(id) {
  const wf = state.workflows.find((w) => w.id === id);
  if (!wf) return;
  if (!confirm(`Delete "${wf.name}"? This removes its run history too.`)) return;
  await api(`/automation/workflows/${id}`, { method: 'DELETE' });
  if (state.currentId === id) state.currentId = null;
  await refreshWorkflows();
  if (state.workflows.length) openWorkflow(state.workflows[0].id);
  else state.graph = { nodes: [], edges: [] }, renderCanvas(), renderInspector();
}

function fmtAgo(ts) {
  if (!ts) return '';
  const delta = Date.now() - ts;
  if (delta < 60_000) return 'just now';
  if (delta < 3600_000) return `${Math.round(delta/60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta/3_600_000)}h ago`;
  return `${Math.round(delta/86_400_000)}d ago`;
}

// ---------- Canvas rendering ---------------------------------------------

function renderCanvas() {
  const root = $('autoCanvas');
  const nodesEl = $('autoNodes');
  const edgesEl = $('autoEdges');
  if (!root) return;

  // Apply current zoom level to both layers (nodes + edges).
  applyZoom();

  // Empty-state hint vanishes once there's >1 node (the seeded trigger doesn't count as "built").
  root.classList.toggle('has-nodes', state.graph.nodes.length > 1);

  // Nodes
  nodesEl.innerHTML = state.graph.nodes.map((n) => {
    const meta = NODE_CATALOG[n.type] || { kind: 'action', name: n.type, ico: '?', summary: () => '' };
    const summary = meta.summary(n.config || {});
    return `
      <div class="canvas-node ${meta.kind} ${n.id === state.selectedNodeId ? 'selected' : ''}"
           data-id="${n.id}" style="left:${n.x}px;top:${n.y}px;">
        <div class="port in"  data-port="in"  data-id="${n.id}"></div>
        <div class="port out" data-port="out" data-id="${n.id}"></div>
        <div class="nh">
          <div class="nh-ico">${meta.ico}</div>
          <div class="nh-name">${escapeHtml(meta.name)}</div>
          <button class="nh-del" data-del="${n.id}" title="Delete">×</button>
        </div>
        <div class="nb">${escapeHtml(summary || '—')}</div>
      </div>
    `;
  }).join('');

  // Edges
  edgesEl.innerHTML = state.graph.edges.map((e, i) =>
    `<path data-edge="${i}" d="${bezierFor(e.from, e.to)}"></path>`
  ).join('') + arrowMarker();

  // Node events
  nodesEl.querySelectorAll('.canvas-node').forEach((el) => {
    const id = el.dataset.id;
    el.addEventListener('mousedown', (ev) => {
      if (ev.target.classList.contains('port')) return;
      if (ev.target.classList.contains('nh-del')) return;
      selectNode(id);
      startNodeDrag(ev, id);
    });
    el.querySelector('.nh-del').addEventListener('click', (ev) => {
      ev.stopPropagation();
      deleteNode(id);
    });
    el.querySelectorAll('.port').forEach((port) => {
      port.addEventListener('mousedown', (ev) => {
        ev.stopPropagation();
        startEdgeDrag(ev, id, port.dataset.port);
      });
    });
  });

  // Edge click = delete
  edgesEl.querySelectorAll('path[data-edge]').forEach((p) => {
    p.addEventListener('click', (ev) => {
      const i = Number(p.dataset.edge);
      state.graph.edges.splice(i, 1);
      state.dirty = true;
      renderCanvas();
    });
  });
}

function arrowMarker() {
  return `<defs>
    <marker id="autoArrow" viewBox="0 0 10 10" refX="9" refY="5"
            markerUnits="strokeWidth" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" class="arrow"></path>
    </marker>
  </defs>`;
}

function nodeById(id) { return state.graph.nodes.find((n) => n.id === id); }

function bezierFor(fromId, toId) {
  const a = nodeById(fromId), b = nodeById(toId);
  if (!a || !b) return '';
  const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
  const x2 = b.x,           y2 = b.y + NODE_H / 2;
  return bezierPath(x1, y1, x2, y2);
}

function bezierPath(x1, y1, x2, y2) {
  const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function applyZoom() {
  const ns = $('autoNodes');
  const es = $('autoEdges');
  if (!ns || !es) return;
  const t = `scale(${state.zoom})`;
  ns.style.transformOrigin = '0 0';
  ns.style.transform = t;
  es.style.transformOrigin = '0 0';
  es.style.transform = t;
  const zEl = $('autoZoomLevel');
  if (zEl) zEl.textContent = Math.round(state.zoom * 100) + '%';
}

function setZoom(z) {
  state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  applyZoom();
}

// Click-and-drag panning of the canvas viewport. Listens at the document
// level once started so the cursor can drift outside the canvas without
// breaking the gesture. Scrolls the canvas viewport (cheaper than transforming
// the inner layers).
function startCanvasPan(downEvent) {
  const canvas = $('autoCanvas');
  if (!canvas) return;
  const startX = downEvent.clientX;
  const startY = downEvent.clientY;
  const origScrollX = canvas.scrollLeft;
  const origScrollY = canvas.scrollTop;
  let movedEnough = false;
  canvas.classList.add('panning');

  const onMove = (e) => {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!movedEnough && (Math.abs(dx) + Math.abs(dy)) > 3) movedEnough = true;
    canvas.scrollLeft = origScrollX - dx;
    canvas.scrollTop  = origScrollY - dy;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    canvas.classList.remove('panning');
    // If we actually moved, swallow the trailing click so it doesn't deselect.
    if (movedEnough) state._didPan = true;
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  downEvent.preventDefault();
}

// Compute the bounding box of all nodes and either pan the canvas to show
// them centered (if they fit) or auto-pick a zoom so they fit comfortably.
function fitToContent() {
  if (!state.graph.nodes.length) { setZoom(0.85); return; }
  const padding = 40;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of state.graph.nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NODE_W);
    maxY = Math.max(maxY, n.y + NODE_H);
  }
  const contentW = maxX - minX + padding * 2;
  const contentH = maxY - minY + padding * 2;
  const canvas = $('autoCanvas');
  if (!canvas) return;
  const viewW = canvas.clientWidth, viewH = canvas.clientHeight;
  const zoom = Math.min(1, viewW / contentW, viewH / contentH);
  setZoom(Math.max(MIN_ZOOM, Math.min(1, zoom)));
  // Scroll so the content is roughly centered.
  requestAnimationFrame(() => {
    const sx = Math.max(0, (minX - padding) * state.zoom);
    const sy = Math.max(0, (minY - padding) * state.zoom);
    canvas.scrollTo(sx, sy);
  });
}

// ---------- Node drag-around ---------------------------------------------

function startNodeDrag(ev, id) {
  const n = nodeById(id);
  if (!n) return;
  const startX = ev.clientX, startY = ev.clientY;
  const origX = n.x, origY = n.y;
  state.draggingNode = id;
  const onMove = (e) => {
    // Divide by zoom so dragging feels 1:1 with the cursor at any zoom level.
    const z = state.zoom || 1;
    n.x = Math.max(8, origX + (e.clientX - startX) / z);
    n.y = Math.max(8, origY + (e.clientY - startY) / z);
    state.dirty = true;
    // Cheap re-render: just shift the DOM element + redraw edges.
    const el = document.querySelector(`.canvas-node[data-id="${id}"]`);
    if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
    redrawEdges();
  };
  const onUp = () => {
    state.draggingNode = null;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  ev.preventDefault();
}

function redrawEdges() {
  const edgesEl = $('autoEdges');
  edgesEl.innerHTML = state.graph.edges.map((e, i) =>
    `<path data-edge="${i}" d="${bezierFor(e.from, e.to)}"></path>`
  ).join('') + (state.draggingEdge ? `<path class="drag" d="${state.draggingEdge.d}"></path>` : '') + arrowMarker();
  edgesEl.querySelectorAll('path[data-edge]').forEach((p) => {
    p.addEventListener('click', () => {
      const i = Number(p.dataset.edge);
      state.graph.edges.splice(i, 1);
      state.dirty = true;
      renderCanvas();
    });
  });
}

// ---------- Edge drawing (port -> port) ----------------------------------

function startEdgeDrag(ev, nodeId, portSide) {
  const n = nodeById(nodeId);
  if (!n) return;
  const canvas = $('autoCanvas');
  const startX = portSide === 'out' ? n.x + NODE_W : n.x;
  const startY = n.y + NODE_H / 2;
  state.draggingEdge = { fromId: nodeId, portSide, d: '' };
  const onMove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const z = state.zoom || 1;
    // Convert screen-space cursor into canvas-space (account for scroll + zoom).
    const x = (e.clientX - rect.left + canvas.scrollLeft) / z;
    const y = (e.clientY - rect.top  + canvas.scrollTop)  / z;
    state.draggingEdge.d = bezierPath(startX, startY, x, y);
    redrawEdges();
  };
  const onUp = (e) => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    const targetEl = document.elementFromPoint(e.clientX, e.clientY);
    const targetNode = targetEl?.closest?.('.canvas-node');
    if (targetNode && targetNode.dataset.id !== nodeId) {
      const otherId = targetNode.dataset.id;
      // out -> in means edge from THIS to OTHER; in -> out is the inverse.
      const from = portSide === 'out' ? nodeId : otherId;
      const to   = portSide === 'out' ? otherId : nodeId;
      if (!createsCycle(from, to)) {
        state.graph.edges.push({ from, to });
        state.dirty = true;
      } else {
        toast('That edge would create a cycle.', 'error');
      }
    }
    state.draggingEdge = null;
    renderCanvas();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  ev.preventDefault();
}

function createsCycle(from, to) {
  if (from === to) return true;
  // DFS from `to`, see if we hit `from`.
  const adj = new Map();
  for (const e of state.graph.edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  const stack = [to]; const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of (adj.get(cur) || [])) stack.push(next);
  }
  return false;
}

// ---------- Selection & inspector ----------------------------------------

function selectNode(id) {
  state.selectedNodeId = id;
  renderCanvas();
  renderInspector();
}

function renderInspector() {
  const ins = $('autoInspector');
  if (!ins) return;
  const n = nodeById(state.selectedNodeId);
  if (!n) { ins.classList.add('empty'); ins.innerHTML = ins._emptyHtml || ins.innerHTML; return; }
  if (!ins._emptyHtml) ins._emptyHtml = ins.innerHTML;
  ins.classList.remove('empty');
  const meta = NODE_CATALOG[n.type];
  if (!meta) {
    ins.innerHTML = `<div class="ins-head"><div class="ico">?</div><div><div class="name">Unknown</div><div class="kind">${escapeHtml(n.type)}</div></div></div>`;
    return;
  }
  const head = `
    <div class="ins-head">
      <div class="ico">${meta.ico}</div>
      <div>
        <div class="name">${escapeHtml(meta.name)}</div>
        <div class="kind">${meta.kind} · id ${escapeHtml(n.id)}</div>
      </div>
    </div>
  `;
  ins.innerHTML = head + `<div class="ins-body">${inspectorBody(n)}</div>`;
  wireInspector(n);
}

function inspectorBody(n) {
  const c = n.config || {};
  switch (n.type) {
    case 'trigger.manual':
      return field('Label', `<input data-cfg="label" value="${escapeHtml(c.label || '')}" />`,
        'Just a name to help you recognize this trigger.');

    case 'logic.filter':
      return [
        field('Minimum score',
          `<input type="number" min="0" max="100" data-cfg="minScore" value="${c.minScore ?? ''}" placeholder="e.g. 75" />`),
        field('Maximum score',
          `<input type="number" min="0" max="100" data-cfg="maxScore" value="${c.maxScore ?? ''}" placeholder="e.g. 45" />`),
        field('Category', categorySelect(c.category)),
        field('Minimum years',
          `<input type="number" min="0" step="0.5" data-cfg="minYears" value="${c.minYears ?? ''}" placeholder="any" />`),
        field('Has any of these skills', chipsInput('skillsAny', c.skillsAny || []),
          'Press Enter to add. Matches resumes that mention at least one.'),
        field('Must have all of these skills', chipsInput('skillsAll', c.skillsAll || [])),
        `<label class="ins-check"><input type="checkbox" data-cfg="requireEmail" ${c.requireEmail !== false ? 'checked' : ''}/> Skip candidates with no email on file</label>`
      ].join('');

    case 'logic.branch':
      return field('Threshold score',
        `<input type="number" min="0" max="100" data-cfg="threshold" value="${c.threshold ?? 75}" />`,
        'Items with score ≥ threshold go to the "top" branch; the rest go elsewhere.');

    case 'logic.limit':
      return field('Keep top',
        `<input type="number" min="1" max="500" data-cfg="n" value="${c.n ?? 10}" />`,
        'Sorts by score desc and keeps this many. Useful for "OA only to top 25".');

    case 'action.sendOaEmail':
      return [
        field('Template',
          `<select data-cfg="templateId">
            <option value="">— inline override below —</option>
            ${state.templates.map((t) =>
              `<option value="${t.id}" ${String(c.templateId) === String(t.id) ? 'selected' : ''}>${escapeHtml(t.name)}</option>`
            ).join('')}
          </select>`,
          'Manage templates from Settings → OA email templates.'),
        field('Override OA link',
          `<input data-cfg="oaLinkOverride" placeholder="https://oa.example.com/exam/abc" value="${escapeHtml(c.oaLinkOverride || '')}" />`,
          'Leave blank to use the link saved on the chosen template.'),
        '<div class="ins-section-title">Or write the email here (no template)</div>',
        field('Subject', `<input data-cfg="subject" value="${escapeHtml(c.subject || '')}" placeholder="Online assessment — {{role}}" />`),
        field('Body', `<textarea data-cfg="body" rows="6" placeholder="Hi {{first_name}}, ...">${escapeHtml(c.body || '')}</textarea>`,
          'Placeholders: {{first_name}}, {{name}}, {{role}}, {{score}}, {{oa_link}}, {{deadline}}.')
      ].join('');

    case 'action.scheduleInterview': {
      const picked = (c.interviewerIds || []).map(Number);
      const pickedIvs = state.interviewers.filter((iv) => picked.includes(iv.id));
      const withWindows    = pickedIvs.filter((iv) => (iv.availability || []).length);
      const withoutWindows = pickedIvs.filter((iv) => !(iv.availability || []).length);
      const summaryHtml = pickedIvs.length ? `
        <div class="ins-avail-summary">
          ${withWindows.length ? `
            <div class="ins-avail-row good">
              <span class="ins-avail-dot"></span>
              <span><strong>${withWindows.length}</strong> using stated availability:
              ${withWindows.map((iv) => `${escapeHtml(iv.name)} (${(iv.availability || []).length})`).join(', ')}</span>
            </div>` : ''}
          ${withoutWindows.length ? `
            <div class="ins-avail-row warn">
              <span class="ins-avail-dot"></span>
              <span><strong>${withoutWindows.length}</strong> with no windows yet — falls back to the workday range below:
              ${withoutWindows.map((iv) => escapeHtml(iv.name)).join(', ')}</span>
            </div>` : ''}
        </div>
      ` : '';
      return [
        field('Interviewers', interviewerPicker(c.interviewerIds || []),
          'Add interviewers + their availability slots in Settings → Interview panel. The scheduler intersects every selected interviewer\'s windows.'),
        summaryHtml,
        `<div class="ins-row">
          ${field('Duration (min)', `<input type="number" min="15" step="15" data-cfg="durationMinutes" value="${c.durationMinutes ?? 30}" />`)}
          ${field('Days to look ahead', `<input type="number" min="1" max="30" data-cfg="daysAhead" value="${c.daysAhead ?? 7}" />`)}
        </div>`,
        `<div class="ins-section-title">Fallback workday (only used for interviewers with no stated availability)</div>`,
        `<div class="ins-row">
          ${field('Workday start', `<input type="time" data-cfg="dayStart" value="${c.dayStart || '10:00'}" />`)}
          ${field('Workday end',   `<input type="time" data-cfg="dayEnd"   value="${c.dayEnd   || '17:00'}" />`)}
        </div>`,
        `<label class="ins-check"><input type="checkbox" data-cfg="createMeet" ${c.createMeet !== false ? 'checked' : ''}/> Attach a Google Meet link to every invite</label>`
      ].join('');
    }

    case 'action.sendRejection':
      return [
        '<div class="ins-section-title">Score-driven gating</div>',
        field('Only send if score ≤',
          `<input type="number" min="0" max="100" data-cfg="maxScore" value="${c.maxScore ?? ''}" placeholder="e.g. 60 — leave blank to send to everyone reaching this node" />`,
          'Acts as a safety net so a strong candidate accidentally routed here never gets a rejection.'),
        field('Near-miss threshold (score ≥)',
          `<input type="number" min="0" max="100" data-cfg="nearMissAbove" value="${c.nearMissAbove ?? ''}" placeholder="e.g. 50 — leave blank to send the same body to everyone" />`,
          'Candidates with score ≥ this get the warmer "near-miss" body below. Below it, they get the standard body.'),

        '<div class="ins-section-title">Standard rejection (clear "no")</div>',
        field('Tone (used for default body if you leave the override blank)',
          `<select data-cfg="tone">
            <option value="warm"        ${c.tone === 'warm' || !c.tone ? 'selected' : ''}>Warm</option>
            <option value="direct"      ${c.tone === 'direct' ? 'selected' : ''}>Direct</option>
            <option value="encouraging" ${c.tone === 'encouraging' ? 'selected' : ''}>Encouraging</option>
          </select>`),
        field('Subject', `<input data-cfg="subject" value="${escapeHtml(c.subject || '')}" placeholder="Update on your application" />`),
        field('Body', `<textarea data-cfg="body" rows="5" placeholder="Leave blank to use the tone's default">${escapeHtml(c.body || '')}</textarea>`,
          'Placeholders: {{first_name}}, {{name}}, {{role}}, {{score}}'),

        '<div class="ins-section-title">Near-miss rejection (kinder note)</div>',
        field('Subject', `<input data-cfg="nearMissSubject" value="${escapeHtml(c.nearMissSubject || '')}" placeholder="(uses the standard subject if blank)" />`),
        field('Body',    `<textarea data-cfg="nearMissBody" rows="5" placeholder="Leave blank to use the built-in near-miss template">${escapeHtml(c.nearMissBody || '')}</textarea>`,
          'Sent when score ≥ near-miss threshold. The built-in default acknowledges that they were close.')
      ].join('');

    case 'action.notify':
      return [
        field('Title',   `<input data-cfg="title"   value="${escapeHtml(c.title || '')}" placeholder="Workflow finished" />`),
        field('Message', `<textarea data-cfg="message" rows="3">${escapeHtml(c.message || '')}</textarea>`,
          'Use {{count}} for the number of candidates that reached this node.')
      ].join('');

    case 'action.logRun':
      return field('Note', `<input data-cfg="note" value="${escapeHtml(c.note || '')}" placeholder="e.g. campaign-A round 1" />`,
        'Stamps this run in the history so you can filter later.');

    default:
      return `<div class="muted">No editor for ${escapeHtml(n.type)}.</div>`;
  }
}

function field(label, control, help = '') {
  return `
    <div class="ins-field">
      <span class="ins-label">${escapeHtml(label)}</span>
      ${control}
      ${help ? `<div class="ins-help">${escapeHtml(help)}</div>` : ''}
    </div>
  `;
}

function categorySelect(current) {
  const cats = ['frontend','backend','fullstack','mobile','data','ml-ai','devops','security','qa','design','product','marketing','sales','hr','other'];
  return `<select data-cfg="category">
    <option value="">Any category</option>
    ${cats.map((c) => `<option value="${c}" ${c === current ? 'selected' : ''}>${c}</option>`).join('')}
  </select>`;
}

function chipsInput(name, values) {
  return `
    <div class="ins-chips" data-chips="${escapeHtml(name)}">
      ${values.map((v) => chipHtml(v)).join('')}
      <input placeholder="add skill + Enter" />
    </div>
  `;
}

function chipHtml(v) {
  return `<span class="ins-chip">${escapeHtml(v)}<span class="ins-chip-del" data-rm="${escapeHtml(v)}">×</span></span>`;
}

function interviewerPicker(selectedIds) {
  if (state.interviewers.length === 0) {
    return `<div class="muted small" style="padding:8px 10px;border:1px solid var(--border-soft);border-radius:8px;background:white;">
      None yet. Add interviewers in Settings → Interview panel.
    </div>`;
  }
  const ids = new Set((selectedIds || []).map(Number));
  return `<div class="ins-interviewers">
    ${state.interviewers.map((iv) => `
      <label>
        <input type="checkbox" data-iv="${iv.id}" ${ids.has(iv.id) ? 'checked' : ''} />
        <span>${escapeHtml(iv.name)}</span>
        <span class="muted small" style="margin-left:auto;">${escapeHtml(iv.email)}</span>
      </label>
    `).join('')}
  </div>`;
}

function wireInspector(n) {
  const ins = $('autoInspector');
  ins.querySelectorAll('[data-cfg]').forEach((el) => {
    const key = el.dataset.cfg;
    const apply = () => {
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'number') v = v === '' ? null : Number(v);
      n.config = { ...(n.config || {}), [key]: v };
      state.dirty = true;
      // Cheap re-render of just this node's summary text.
      const node = document.querySelector(`.canvas-node[data-id="${n.id}"] .nb`);
      if (node) node.textContent = NODE_CATALOG[n.type].summary(n.config);
    };
    el.addEventListener('input', apply);
    el.addEventListener('change', apply);
  });
  // chips
  ins.querySelectorAll('[data-chips]').forEach((wrap) => {
    const key = wrap.dataset.chips;
    const input = wrap.querySelector('input');
    const add = (value) => {
      const v = value.trim();
      if (!v) return;
      const list = n.config[key] = [...(n.config[key] || [])];
      if (!list.includes(v)) list.push(v);
      state.dirty = true;
      renderInspector();   // re-render to repaint chips
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        add(input.value);
        input.value = '';
      }
    });
    wrap.querySelectorAll('[data-rm]').forEach((x) => {
      x.addEventListener('click', () => {
        n.config[key] = (n.config[key] || []).filter((v) => v !== x.dataset.rm);
        state.dirty = true;
        renderInspector();
      });
    });
  });
  // interviewer multi-check
  ins.querySelectorAll('[data-iv]').forEach((el) => {
    el.addEventListener('change', () => {
      const ids = [...ins.querySelectorAll('[data-iv]')].filter((x) => x.checked).map((x) => Number(x.dataset.iv));
      n.config.interviewerIds = ids;
      state.dirty = true;
      const node = document.querySelector(`.canvas-node[data-id="${n.id}"] .nb`);
      if (node) node.textContent = NODE_CATALOG[n.type].summary(n.config);
    });
  });
}

// ---------- Canvas helpers -----------------------------------------------

function nodeId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function deleteNode(id) {
  state.graph.nodes = state.graph.nodes.filter((n) => n.id !== id);
  state.graph.edges = state.graph.edges.filter((e) => e.from !== id && e.to !== id);
  if (state.selectedNodeId === id) state.selectedNodeId = null;
  state.dirty = true;
  renderCanvas();
  renderInspector();
}

function addNode(type, x, y) {
  const meta = NODE_CATALOG[type];
  if (!meta) return;
  const id = nodeId(type.split('.')[1] || 'node');
  state.graph.nodes.push({ id, type, x: x ?? 220, y: y ?? 240, config: meta.defaultConfig() });
  state.dirty = true;
  selectNode(id);
  renderCanvas();
}

// ---------- Save / Run ---------------------------------------------------

async function saveCurrent({ silent } = {}) {
  if (!state.currentId) return;
  const payload = {
    name: $('autoWfName').value.trim() || 'Untitled workflow',
    graph: state.graph
  };
  await api(`/automation/workflows/${state.currentId}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
  state.dirty = false;
  await refreshWorkflows();
  if (!silent) toast('Saved', 'success');
}

async function runCurrent(mode) {
  if (!state.currentId) return;
  if (state.dirty) {
    try { await saveCurrent({ silent: true }); }
    catch (err) { toast('Save failed: ' + err.message, 'error'); return; }
  }
  const candidateIds = state.selectedCandidates.length ? state.selectedCandidates : null;
  try {
    toast(mode === 'dry-run' ? 'Running dry-run…' : 'Executing…');
    const r = await api(`/automation/workflows/${state.currentId}/run`, {
      method: 'POST',
      body: JSON.stringify({ mode, candidateIds })
    });
    toast(`${mode === 'dry-run' ? 'Dry-run' : 'Run'} ${r.status}`,
      r.status === 'ok' ? 'success' : (r.status === 'error' ? 'error' : ''));
    await refreshHistory();
    if (r.runId) openRunDetail(r.runId);
  } catch (err) {
    toast('Run failed: ' + err.message, 'error');
  }
}

// ---------- History ------------------------------------------------------

function renderHistory(runs) {
  const el = $('autoHistory');
  if (!el) return;
  if (!runs?.length) {
    el.innerHTML = '<div class="muted small" style="padding:6px 4px;">No runs yet — hit Execute or Dry run.</div>';
    return;
  }
  el.innerHTML = runs.map((r) => {
    const sum = r.summary || {};
    const totals = sum.totals || {};
    const ts = new Date(r.started_at).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    return `
      <div class="auto-history-row" data-run="${r.id}">
        <span class="auto-history-status ${r.status}"></span>
        <span class="auto-history-name">${escapeHtml(r.workflow_name || ('run #' + r.id))}</span>
        <span class="auto-history-meta">${ts} · ${totals.triggers ?? '?'} in · ${totals.actions ?? 0} act · ${totals.errors ?? 0} err</span>
        <span class="auto-history-mode ${r.mode}">${r.mode}</span>
      </div>
    `;
  }).join('');
  el.querySelectorAll('[data-run]').forEach((row) => {
    row.addEventListener('click', () => openRunDetail(Number(row.dataset.run)));
  });
}

async function openRunDetail(runId) {
  try {
    const run = await api(`/automation/runs/${runId}`);
    const sum = run.summary?.totals || {};
    const actions = run.actions || [];
    const body = `
      <h2 style="margin:0 0 6px;font-size:18px;font-weight:600;letter-spacing:-0.02em;">
        ${escapeHtml(run.workflow_name || 'Run')} · ${escapeHtml(run.status)}
      </h2>
      <div class="muted small" style="margin-bottom:14px;">
        ${run.mode} · started ${new Date(run.started_at).toLocaleString()}
        ${run.finished_at ? ` · took ${Math.max(1, Math.round((run.finished_at - run.started_at)/100)/10)}s` : ''}
      </div>
      <div class="run-summary">
        <div class="run-stat"><div class="v">${sum.triggers ?? '0'}</div><div class="k">triggered</div></div>
        <div class="run-stat"><div class="v">${sum.filtered ?? '0'}</div><div class="k">passed filters</div></div>
        <div class="run-stat"><div class="v">${sum.actions ?? '0'}</div><div class="k">actions</div></div>
        <div class="run-stat"><div class="v" style="color:${sum.errors ? 'var(--bad)' : 'var(--text)'}">${sum.errors ?? '0'}</div><div class="k">errors</div></div>
      </div>
      <table class="run-actions-table">
        <thead><tr>
          <th>Node</th><th>Candidate</th><th>Status</th><th>Detail</th>
        </tr></thead>
        <tbody>
          ${actions.map((a) => `
            <tr>
              <td><div style="font-weight:500;">${escapeHtml(a.node_type)}</div><div class="muted small">${escapeHtml(a.node_id)}</div></td>
              <td>${escapeHtml(a.candidate || '—')}</td>
              <td><span class="run-action-status ${a.status}">${a.status}</span></td>
              <td><pre class="run-detail-pre">${escapeHtml(JSON.stringify(a.detail, null, 2))}</pre></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    $('autoRunBody').innerHTML = body;
    $('autoRunModal').classList.remove('hidden');
  } catch (err) {
    toast('Failed to load run: ' + err.message, 'error');
  }
}

// ---------- Candidate picker --------------------------------------------

let pickerStaging = new Set();

async function openPicker() {
  if (!state.candidatesCache) {
    state.candidatesCache = (await api('/resumes')).resumes || [];
    const cats = [...new Set(state.candidatesCache.map((r) => r.category).filter(Boolean))].sort();
    const sel = $('autoPickCategory');
    sel.innerHTML = '<option value="">All categories</option>' +
      cats.map((c) => `<option value="${c}">${c}</option>`).join('');
  }
  pickerStaging = new Set(state.selectedCandidates);
  renderPicker();
  $('autoPickModal').classList.remove('hidden');
}

function renderPicker() {
  const q   = ($('autoPickSearch').value || '').toLowerCase();
  const cat = $('autoPickCategory').value;
  const min = Number($('autoPickMinScore').value) || 0;
  const list = state.candidatesCache.filter((r) =>
    (!cat || r.category === cat) &&
    (Number.isFinite(r.score) ? r.score >= min : min === 0) &&
    (!q ||
      (r.candidate_name || '').toLowerCase().includes(q) ||
      (r.role_title || '').toLowerCase().includes(q) ||
      (r.filename || '').toLowerCase().includes(q))
  ).slice(0, 400);
  $('autoPickList').innerHTML = list.map((r) => {
    const band = (r.score ?? 0) >= 75 ? 'good' : (r.score ?? 0) >= 50 ? 'warn' : 'bad';
    const checked = pickerStaging.has(r.id) ? 'checked' : '';
    return `
      <label class="auto-pick-row">
        <input type="checkbox" data-cand="${r.id}" ${checked}/>
        <div>
          <div class="auto-pick-name">${escapeHtml(r.candidate_name || '—')}</div>
          <div class="auto-pick-sub">${escapeHtml(r.role_title || r.filename)}</div>
        </div>
        <span class="auto-pick-cat">${escapeHtml(r.category || 'other')}</span>
        <span class="score-pill ${band}">${Number.isFinite(r.score) ? r.score : '—'}</span>
      </label>
    `;
  }).join('') || '<div class="muted" style="padding:18px;text-align:center;">No matches</div>';
  $('autoPickList').querySelectorAll('[data-cand]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = Number(cb.dataset.cand);
      if (cb.checked) pickerStaging.add(id); else pickerStaging.delete(id);
      updatePickerCount();
    });
  });
  updatePickerCount();
}

function updatePickerCount() {
  $('autoPickFootCount').textContent = `${pickerStaging.size} selected`;
}

function closePicker(commit) {
  if (commit) {
    state.selectedCandidates = [...pickerStaging];
    updateSelectionUI();
  }
  $('autoPickModal').classList.add('hidden');
}

function updateSelectionUI() {
  const n = state.selectedCandidates.length;
  const countEl = $('autoSelectedCount');
  const textEl = document.querySelector('.auto-sel-text');
  if (countEl) {
    countEl.textContent = n ? String(n) : 'all';
    countEl.classList.toggle('has', n > 0);
  }
  if (textEl) textEl.textContent = n === 1 ? 'candidate' : 'candidates';
}

// ---------- Settings: Google + Interviewers + Templates ------------------

async function loadGoogleStatus() {
  const statusEl = $('googleStatus');
  const actEl    = $('googleActions');
  const helpEl   = $('googleHelp');
  if (!statusEl) return;
  let s;
  try { s = await api('/automation/google/status'); }
  catch (err) { statusEl.className = 'google-status bad'; statusEl.textContent = err.message; return; }

  if (!s.configured) {
    statusEl.className = 'google-status bad';
    statusEl.textContent = 'Google OAuth client is not configured on the backend.';
    actEl.innerHTML = '';
    helpEl.innerHTML = `
      Set these in <code>backend/.env</code> and restart:<br>
      <code>GOOGLE_CLIENT_ID=...</code><br>
      <code>GOOGLE_CLIENT_SECRET=...</code><br>
      <code>GOOGLE_REDIRECT_URI=${escapeHtml(s.redirectUri)}</code><br>
      In Google Cloud Console → APIs &amp; Services → Credentials, create an OAuth 2.0 Web client and add the redirect URI above.
      Enable <em>Google Calendar API</em> and <em>Gmail API</em> for the project.
    `;
    return;
  }
  if (s.connected) {
    statusEl.className = 'google-status connected';
    statusEl.textContent = `Connected as ${s.profile?.email || 'unknown'}`;
    actEl.innerHTML = `<button class="btn ghost" id="gDisconnect">Disconnect</button>`;
    helpEl.innerHTML = '';
    actEl.querySelector('#gDisconnect').addEventListener('click', async () => {
      await api('/automation/google/disconnect', { method: 'POST' });
      loadGoogleStatus();
    });
  } else {
    statusEl.className = 'google-status';
    statusEl.textContent = 'Not connected. Calendar + Gmail actions will fail until you authorize.';
    actEl.innerHTML = `<button class="btn primary" id="gConnect">Connect Google</button>`;
    helpEl.innerHTML = '';
    actEl.querySelector('#gConnect').addEventListener('click', async () => {
      try {
        const { url } = await api('/automation/google/auth');
        const w = window.open(url, '_blank', 'width=520,height=620');
        // Poll status until connected or window closes.
        const t = setInterval(async () => {
          const cur = await api('/automation/google/status');
          if (cur.connected || w.closed) {
            clearInterval(t);
            loadGoogleStatus();
          }
        }, 1500);
      } catch (err) { toast(err.message, 'error'); }
    });
  }
}

async function renderInterviewers() {
  await refreshInterviewers();
  const el = $('interviewerList');
  if (!el) return;
  if (!state.interviewers.length) {
    el.innerHTML = '<div class="muted small">No interviewers yet — add the first one below.</div>';
    return;
  }
  el.innerHTML = state.interviewers.map((iv) => {
    const wins = (iv.availability || []).slice().sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    return `
      <div class="iv-card">
        <div class="iv-card-head">
          <div>
            <div class="iv-name">${escapeHtml(iv.name)}</div>
            <div class="iv-meta">${escapeHtml(iv.email)}${iv.timezone ? ' · ' + escapeHtml(iv.timezone) : ''} · cal: ${escapeHtml(iv.calendar_id || 'primary')}</div>
          </div>
          <div class="iv-card-actions">
            <button class="btn ghost small" data-toggle="${iv.id}">${wins.length} availability ${wins.length === 1 ? 'slot' : 'slots'}</button>
            <button class="btn ghost small" data-rmiv="${iv.id}" style="color:var(--bad);">remove</button>
          </div>
        </div>
        <div class="iv-availability hidden" data-avail="${iv.id}">
          ${wins.length ? `
            <ul class="iv-windows">
              ${wins.map((w) => `
                <li>
                  <span class="iv-win-text">${escapeHtml(formatWindow(w.start, w.end))}</span>
                  <button class="iv-win-rm" data-rmwin="${iv.id}::${w.id}" title="Remove">×</button>
                </li>
              `).join('')}
            </ul>
          ` : '<div class="muted small" style="margin-bottom:8px;">No windows yet — scheduler will fall back to the node\'s workday range.</div>'}
          <form class="iv-add-window" data-add-win="${iv.id}">
            <input type="date" name="date" required />
            <input type="time" name="start" value="10:00" required />
            <span class="muted small">to</span>
            <input type="time" name="end"   value="11:00" required />
            <button class="btn primary small" type="submit">+ Add slot</button>
          </form>
        </div>
      </div>
    `;
  }).join('');

  el.querySelectorAll('[data-rmiv]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Remove this interviewer? Their availability windows will be deleted too.')) return;
      await api(`/automation/interviewers/${b.dataset.rmiv}`, { method: 'DELETE' });
      renderInterviewers();
    });
  });
  el.querySelectorAll('[data-toggle]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.toggle;
      const panel = el.querySelector(`[data-avail="${id}"]`);
      if (panel) panel.classList.toggle('hidden');
    });
  });
  el.querySelectorAll('[data-rmwin]').forEach((b) => {
    b.addEventListener('click', async () => {
      const [ivId, winId] = b.dataset.rmwin.split('::');
      await api(`/automation/interviewers/${ivId}/availability/${winId}`, { method: 'DELETE' });
      renderInterviewers();
    });
  });
  el.querySelectorAll('[data-add-win]').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ivId = form.dataset.addWin;
      const date  = form.elements.date.value;
      const start = form.elements.start.value;
      const end   = form.elements.end.value;
      if (!date || !start || !end) return;
      const startIso = new Date(`${date}T${start}:00`).toISOString();
      const endIso   = new Date(`${date}T${end}:00`).toISOString();
      try {
        await api(`/automation/interviewers/${ivId}/availability`, {
          method: 'POST',
          body: JSON.stringify({ start: startIso, end: endIso })
        });
        renderInterviewers();
        toast('Availability added', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

function formatWindow(startIso, endIso) {
  const s = new Date(startIso), e = new Date(endIso);
  const day  = s.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const t = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const same = s.toDateString() === e.toDateString();
  return same ? `${day} · ${t(s)}–${t(e)}` : `${day} ${t(s)} → ${e.toLocaleDateString(undefined,{month:'short',day:'numeric'})} ${t(e)}`;
}

async function renderTemplates() {
  await refreshTemplates();
  const el = $('tplList');
  if (!el) return;
  if (!state.templates.length) {
    el.innerHTML = '<div class="muted small">No templates yet.</div>';
    return;
  }
  el.innerHTML = state.templates.map((t) => `
    <div class="tpl-row">
      <div>
        <div>${escapeHtml(t.name)}</div>
        <div class="tpl-subject">${escapeHtml(t.subject)}</div>
      </div>
      <button class="btn ghost small" data-edit-tpl="${t.id}">Edit</button>
      <button class="btn ghost small" data-rm-tpl="${t.id}">Delete</button>
    </div>
  `).join('');
  el.querySelectorAll('[data-rm-tpl]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Delete this template?')) return;
      await api(`/automation/templates/${b.dataset.rmTpl}`, { method: 'DELETE' });
      renderTemplates();
    });
  });
  el.querySelectorAll('[data-edit-tpl]').forEach((b) => {
    b.addEventListener('click', () => editTemplate(Number(b.dataset.editTpl)));
  });
}

function wireSettingsForms() {
  const form = $('ivAddForm');
  if (form && !form._wired) {
    form._wired = true;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/automation/interviewers', {
          method: 'POST',
          body: JSON.stringify({
            name:       $('ivName').value.trim(),
            email:      $('ivEmail').value.trim(),
            calendarId: $('ivCalendar').value.trim() || 'primary',
            timezone:   $('ivTz').value.trim() || null
          })
        });
        form.reset();
        renderInterviewers();
        toast('Interviewer added', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  const newTpl = $('tplNewBtn');
  if (newTpl && !newTpl._wired) {
    newTpl._wired = true;
    newTpl.addEventListener('click', () => editTemplate(null));
  }
}

function editTemplate(id) {
  const t = id ? state.templates.find((x) => x.id === id) : null;
  const modal = $('autoTplModal');
  $('autoTplTitle').textContent = t ? 'Edit template' : 'New template';
  $('tplName').value    = t?.name    || '';
  $('tplSubject').value = t?.subject || 'Online assessment for the {{role}} role';
  $('tplLink').value    = t?.oa_link || '';
  $('tplBody').value    = t?.body    || 'Hi {{first_name}},\n\nPlease complete the OA: {{oa_link}}\n\nBest,\nRecruiting Team';
  modal.classList.remove('hidden');
  setTimeout(() => $('tplName').focus(), 50);

  const form = $('autoTplForm');
  const handler = async (e) => {
    e.preventDefault();
    const payload = {
      name:    $('tplName').value.trim(),
      subject: $('tplSubject').value.trim(),
      oaLink:  $('tplLink').value.trim(),
      body:    $('tplBody').value
    };
    if (!payload.name || !payload.subject || !payload.body) return;
    try {
      const path = id ? `/automation/templates/${id}` : '/automation/templates';
      await api(path, { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      modal.classList.add('hidden');
      renderTemplates();
      toast('Template saved', 'success');
    } catch (err) { toast(err.message, 'error'); }
    form.removeEventListener('submit', handler);
  };
  form.addEventListener('submit', handler);
}

// ---------- Wire-up ------------------------------------------------------

function bindUI() {
  // Palette
  document.querySelectorAll('.palette-node[data-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // Drop near the right-most existing node, vertically centered.
      const rightmost = state.graph.nodes.reduce((acc, n) => n.x > acc ? n.x : acc, 0);
      const meanY = state.graph.nodes.length
        ? Math.round(state.graph.nodes.reduce((a, n) => a + n.y, 0) / state.graph.nodes.length)
        : 220;
      addNode(btn.dataset.add, rightmost + NODE_W + 60, meanY);
    });
  });
  $('autoNewWfBtn').addEventListener('click', async () => {
    const id = await createBlankWorkflow();
    openWorkflow(id);
  });
  $('autoWfName').addEventListener('input', () => { state.dirty = true; });

  $('autoZoomIn').addEventListener('click', () => setZoom(state.zoom + 0.1));
  $('autoZoomOut').addEventListener('click', () => setZoom(state.zoom - 0.1));
  $('autoZoomLevel').addEventListener('click', fitToContent);

  // Ctrl + wheel = zoom; plain wheel still scrolls.
  $('autoCanvas').addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(state.zoom + (e.deltaY > 0 ? -0.05 : 0.05));
  }, { passive: false });

  $('autoSaveBtn').addEventListener('click', () => saveCurrent());
  $('autoDryRunBtn').addEventListener('click', () => runCurrent('dry-run'));
  $('autoRunBtn').addEventListener('click', () => {
    if (!state.selectedCandidates.length) {
      if (!confirm('No candidate filter — this will run against every scored resume. Continue?')) return;
    }
    runCurrent('live');
  });

  $('autoPickCandidatesBtn').addEventListener('click', openPicker);
  document.querySelectorAll('[data-close="pick"]').forEach((el) =>
    el.addEventListener('click', () => closePicker(false))
  );
  $('autoPickConfirmBtn').addEventListener('click', () => closePicker(true));
  $('autoPickAllBtn').addEventListener('click', () => {
    state.candidatesCache.forEach((r) => pickerStaging.add(r.id));
    renderPicker();
  });
  ['autoPickSearch','autoPickCategory','autoPickMinScore'].forEach((id) =>
    $(id).addEventListener('input', renderPicker)
  );

  document.querySelectorAll('[data-close="run"]').forEach((el) =>
    el.addEventListener('click', () => $('autoRunModal').classList.add('hidden'))
  );
  document.querySelectorAll('[data-close="tpl"]').forEach((el) =>
    el.addEventListener('click', () => $('autoTplModal').classList.add('hidden'))
  );

  // Click-outside on canvas deselects.
  $('autoCanvas').addEventListener('click', (e) => {
    if (state._didPan) { state._didPan = false; return; }   // suppress click after a drag-pan
    if (e.target.id === 'autoCanvas' || e.target.classList.contains('auto-canvas-grid')) {
      state.selectedNodeId = null;
      renderCanvas();
      renderInspector();
    }
  });

  // Click-and-drag on empty canvas to pan. Skipped if mousedown was on a node,
  // port, edge, button, or the SVG content of the edges layer.
  $('autoCanvas').addEventListener('mousedown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;   // left or middle
    const isOnNode = e.target.closest('.canvas-node');
    const isOnEdge = e.target.tagName === 'path';
    if (isOnNode || isOnEdge) return;
    startCanvasPan(e);
  });

  // Ctrl/Cmd-S save shortcut while on the automation view.
  document.addEventListener('keydown', (e) => {
    const onAuto = !document.querySelector('.view[data-view="automation"]').classList.contains('hidden');
    if (onAuto && (e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveCurrent();
    }
  });
}
