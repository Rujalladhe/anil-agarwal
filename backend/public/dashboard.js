// Dashboard SPA. Vanilla JS — no framework — talks to the backend over fetch.
// Sections: overview / candidates / chat / settings.
// Chart.js is loaded via CDN <script defer> in index.html.

const API = ''; // same-origin (server.js serves this file)
const $ = (id) => document.getElementById(id);

// =================== Util ===================
const fmtDate = (ts) => {
  if (!ts) return '';
  const d = new Date(typeof ts === 'number' ? ts : ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
const scoreBand = (s) => (s >= 75 ? 'good' : s >= 50 ? 'warn' : 'bad');

function toast(message, type = '') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${type}`;
  setTimeout(() => el.classList.add('hidden'), 3000);
  el.classList.remove('hidden');
}

async function api(path, opts = {}) {
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

// =================== View routing ===================
const VIEW_TITLES = {
  overview:   { title: 'Overview',   sub: 'At-a-glance metrics across every scored resume.' },
  candidates: { title: 'Candidates', sub: 'Search, filter, and inspect every scored resume.' },
  match:      { title: 'JD Match',   sub: 'Paste a job description, get your best-fit candidates ranked.' },
  chat:       { title: 'AI Chat',    sub: 'Ask anything — across all resumes or about one in particular.' },
  settings:   { title: 'Settings',   sub: 'Backend, extension, and token-saving notes.' }
};

function switchView(name) {
  document.querySelectorAll('.nav-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) =>
    v.classList.toggle('hidden', v.dataset.view !== name));
  const meta = VIEW_TITLES[name];
  if (meta) {
    $('viewTitle').textContent = meta.title;
    $('viewSubtitle').textContent = meta.sub;
  }
  // Lazy-load per-view data so the dashboard boot is snappy.
  if (name === 'candidates') loadCandidates();
  if (name === 'match')      initMatchIfNeeded();
  if (name === 'chat')       initChatIfNeeded();
  if (name === 'settings')   loadSettings();
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// =================== Health =================
async function checkHealth() {
  const box = $('healthBox');
  const dot = box.querySelector('.dot');
  const txt = box.querySelector('.health-text');
  try {
    const h = await api('/health');
    dot.className = 'dot ok';
    txt.textContent = `${h.provider} · ${h.model}`;
  } catch {
    dot.className = 'dot bad';
    txt.textContent = 'backend offline';
  }
}

// =================== Charts (Overview) ===================
const charts = {};

function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); charts[key] = null; }
}

// Sophisticated, harmonious palette — muted earth tones + sage, no neon.
// Designed to look intentional even when 8+ categories are visible.
const CAT_COLORS = [
  '#3c6e64', // sage-teal (primary)
  '#6a8e9b', // muted slate-blue
  '#b78a5a', // warm sand
  '#9c6b6b', // muted rose
  '#7a8b5c', // olive
  '#5e6b80', // dusty navy
  '#a47c8c', // mauve
  '#c89653', // amber
  '#90a58a', // soft sage
  '#6f5e72', // plum
  '#6b8f7c', // mint
  '#a67c70', // clay
  '#8d8467', // khaki
  '#5e7d8a', // teal-grey
  '#9d8aa0'  // dusty mauve
];

// Status palette mirrored from CSS tokens.
const COLOR = {
  good:     '#3f7e5e',
  goodSoft: '#e3efe6',
  warn:     '#a06b1f',
  warnSoft: '#f7ecd1',
  bad:      '#9f3a3a',
  badSoft:  '#f5e0e0',
  primary:  '#3c6e64',
  primaryFill: 'rgba(60, 110, 100, 0.12)',
  grid:     '#efece6',
  axis:     '#a8a29e',
  text:     '#44403c'
};

// Apply globally so every chart inherits the same axis/legend look.
if (window.Chart) {
  Chart.defaults.font.family = "'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  Chart.defaults.font.size = 11.5;
  Chart.defaults.color = COLOR.text;
  Chart.defaults.borderColor = COLOR.grid;
}

function loadOverview() {
  return api('/stats').then((s) => renderOverview(s)).catch((err) => {
    toast(`Could not load stats: ${err.message}`, 'error');
  });
}

function renderOverview(s) {
  // KPIs
  $('kpiTotal').textContent = s.total;
  $('kpiTotalSub').textContent = `${s.byCategory.length} categor${s.byCategory.length === 1 ? 'y' : 'ies'}`;
  $('kpiAvg').textContent = s.avgScore || '—';
  $('kpiAvgSub').textContent = `${s.bands.good || 0} strong · ${s.bands.warn || 0} mid · ${s.bands.bad || 0} low`;
  const top = (s.byCategory[0] && s.byCategory[0].label) || '—';
  $('kpiCat').textContent = top;
  $('kpiCatSub').textContent = s.byCategory[0] ? `${s.byCategory[0].count} candidates` : '';
  $('kpiGood').textContent = s.bands.good || 0;

  // Skills + recent
  renderTopSkills(s.topSkills);
  renderRecent(s.recent);

  // Charts
  renderCategoryChart(s.byCategory);
  renderScoreChart(s.scoreBuckets);
  renderBandsChart(s.bands);
  renderTimelineChart(s.timeline);
  renderBreakdownChart(s.breakdownAvg);
  renderYearsChart(s.yearBuckets);
}

function renderCategoryChart(data) {
  destroyChart('cat');
  const ctx = $('chartCategory'); if (!ctx) return;
  charts.cat = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map((d) => d.label),
      datasets: [{
        label: 'Resumes',
        data: data.map((d) => d.count),
        backgroundColor: data.map((_, i) => CAT_COLORS[i % CAT_COLORS.length]),
        borderRadius: 4,
        borderSkipped: false,
        maxBarThickness: 36
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: '#1c1917', padding: 10, cornerRadius: 6, displayColors: false }
      },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: COLOR.grid }, border: { display: false } },
        x: { grid: { display: false }, ticks: { font: { size: 11 } }, border: { color: COLOR.grid } }
      }
    }
  });
}

function renderScoreChart(buckets) {
  destroyChart('scores');
  const ctx = $('chartScores'); if (!ctx) return;
  charts.scores = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: buckets.map((b) => b.label),
      datasets: [{
        label: 'Candidates',
        data: buckets.map((b) => b.count),
        backgroundColor: buckets.map((b, i) => {
          if (i >= 8) return COLOR.good;
          if (i >= 5) return COLOR.warn;
          return COLOR.bad;
        }),
        borderRadius: 4,
        borderSkipped: false,
        maxBarThickness: 28
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: '#1c1917', padding: 10, cornerRadius: 6, displayColors: false }
      },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: COLOR.grid }, border: { display: false } },
        x: { grid: { display: false }, ticks: { font: { size: 10 } }, border: { color: COLOR.grid } }
      }
    }
  });
}

function renderBandsChart(bands) {
  destroyChart('bands');
  const ctx = $('chartBands'); if (!ctx) return;
  charts.bands = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Strong (75+)', 'Mid (50-74)', 'Low (<50)'],
      datasets: [{
        data: [bands.good || 0, bands.warn || 0, bands.bad || 0],
        backgroundColor: [COLOR.good, COLOR.warn, COLOR.bad],
        borderWidth: 3,
        borderColor: '#ffffff',
        hoverOffset: 6
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '64%',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 8, boxHeight: 8, padding: 12, font: { size: 11 } } },
        tooltip: { backgroundColor: '#1c1917', padding: 10, cornerRadius: 6, displayColors: false }
      }
    }
  });
}

function renderTimelineChart(timeline) {
  destroyChart('timeline');
  const ctx = $('chartTimeline'); if (!ctx) return;
  charts.timeline = new Chart(ctx, {
    type: 'line',
    data: {
      labels: timeline.map((t) => t.date.slice(5)),
      datasets: [{
        label: 'Resumes',
        data: timeline.map((t) => t.count),
        borderColor: COLOR.primary,
        backgroundColor: COLOR.primaryFill,
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: COLOR.primary,
        pointHoverBorderColor: '#ffffff',
        pointHoverBorderWidth: 2,
        borderWidth: 2
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: '#1c1917', padding: 10, cornerRadius: 6, displayColors: false }
      },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: COLOR.grid }, border: { display: false } },
        x: { grid: { display: false }, ticks: { font: { size: 10 } }, border: { color: COLOR.grid } }
      }
    }
  });
}

function renderBreakdownChart(avg) {
  destroyChart('breakdown');
  const ctx = $('chartBreakdown'); if (!ctx) return;
  const keys = ['experience','skills','education','clarity','impact'];
  charts.breakdown = new Chart(ctx, {
    type: 'radar',
    data: {
      labels: keys.map((k) => k.charAt(0).toUpperCase() + k.slice(1)),
      datasets: [{
        label: 'Avg',
        data: keys.map((k) => avg[k] || 0),
        backgroundColor: COLOR.primaryFill,
        borderColor: COLOR.primary,
        pointBackgroundColor: COLOR.primary,
        pointBorderColor: '#ffffff',
        pointBorderWidth: 2,
        pointRadius: 4,
        borderWidth: 2
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: '#1c1917', padding: 10, cornerRadius: 6, displayColors: false }
      },
      scales: {
        r: {
          beginAtZero: true, max: 100,
          ticks: { stepSize: 25, font: { size: 9 }, backdropColor: 'transparent', color: COLOR.axis },
          grid: { color: COLOR.grid },
          angleLines: { color: COLOR.grid },
          pointLabels: { font: { size: 11 }, color: COLOR.text }
        }
      }
    }
  });
}

function renderYearsChart(buckets) {
  destroyChart('years');
  const ctx = $('chartYears'); if (!ctx) return;
  charts.years = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: buckets.map((b) => b.label + 'y'),
      datasets: [{
        label: 'Candidates',
        data: buckets.map((b) => b.count),
        backgroundColor: '#6a8e9b',
        borderRadius: 4,
        borderSkipped: false,
        maxBarThickness: 22
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: '#1c1917', padding: 10, cornerRadius: 6, displayColors: false }
      },
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: COLOR.grid }, border: { display: false } },
        y: { grid: { display: false }, border: { color: COLOR.grid } }
      }
    }
  });
}

function renderTopSkills(skills) {
  const el = $('topSkills');
  el.innerHTML = '';
  if (!skills.length) {
    el.innerHTML = '<div class="muted small">No skills tracked yet.</div>';
    return;
  }
  for (const s of skills) {
    const chip = document.createElement('div');
    chip.className = 'skill-chip';
    chip.innerHTML = `${s.skill}<span class="count">${s.count}</span>`;
    el.appendChild(chip);
  }
}

function renderRecent(items) {
  const list = $('recentList');
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<li class="muted small">Score a resume to see it here.</li>';
    return;
  }
  for (const r of items) {
    const li = document.createElement('li');
    const band = scoreBand(r.score || 0);
    li.innerHTML = `
      <div>
        <div class="name"></div>
        <div class="meta"></div>
      </div>
      <span class="score-pill ${band}">${r.score ?? '—'}</span>
    `;
    li.querySelector('.name').textContent = r.candidate_name || r.filename;
    li.querySelector('.meta').textContent =
      [r.role_title, r.category, fmtDate(r.created_at)].filter(Boolean).join(' · ');
    li.addEventListener('click', () => openCandidate(r.id));
    list.appendChild(li);
  }
}

// =================== Candidates view ===================
const CATEGORIES_FOR_SELECT = [
  ['frontend','Frontend'],['backend','Backend'],['fullstack','Full-stack'],
  ['mobile','Mobile'],['data','Data'],['ml-ai','ML / AI'],
  ['devops','DevOps / SRE'],['security','Security'],['qa','QA / Test'],
  ['design','Design'],['product','Product'],['marketing','Marketing'],
  ['sales','Sales'],['hr','HR'],['other','Other']
];

function populateCategorySelect() {
  const sel = $('categoryFilter');
  if (sel.options.length > 1) return;
  for (const [v, label] of CATEGORIES_FOR_SELECT) {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = label;
    sel.appendChild(opt);
  }
}

function readCandidateFilters() {
  return {
    q:         $('searchInput').value.trim(),
    category:  $('categoryFilter').value || undefined,
    minScore:  $('minScoreFilter').value || undefined,
    minYears:  $('minYearsFilter').value || undefined
  };
}

async function loadCandidates() {
  populateCategorySelect();
  $('candidatesStatus').textContent = 'Loading…';
  const body = $('candidatesBody');
  body.innerHTML = '';
  try {
    const filters = readCandidateFilters();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v != null && v !== '') qs.set(k, v);
    }
    qs.set('limit', '200');
    const { results } = await api(`/resumes/search?${qs.toString()}`);
    renderCandidates(results);
    $('candidatesStatus').textContent = `${results.length} candidate${results.length === 1 ? '' : 's'}`;
  } catch (err) {
    $('candidatesStatus').textContent = '';
    body.innerHTML = `<tr><td colspan="8" class="muted">Could not load: ${err.message}</td></tr>`;
  }
}

function renderCandidates(rows) {
  const body = $('candidatesBody');
  body.innerHTML = '';
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="8" class="muted">No candidates match.</td></tr>';
    return;
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const band = scoreBand(r.score || 0);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>
        <div class="cand-name"></div>
        <div class="cand-meta"></div>
      </td>
      <td>
        <div></div>
        <div class="cand-meta"></div>
      </td>
      <td><span class="cat-badge"></span></td>
      <td>${r.years_experience != null ? Math.round(r.years_experience) : '—'}</td>
      <td class="cand-skills"></td>
      <td><span class="score-pill ${band}">${r.score ?? '—'}</span></td>
      <td>
        <div class="row-actions">
          <button class="btn ghost small" data-act="view">View</button>
          <button class="btn ghost small" data-act="chat">Chat</button>
        </div>
      </td>
    `;
    tr.querySelector('.cand-name').textContent = r.candidate_name || r.filename;
    tr.querySelector('.cand-meta').textContent =
      [r.email, r.location].filter(Boolean).join(' · ') || r.filename;
    const cells = tr.querySelectorAll('td');
    cells[2].querySelector('div:first-child').textContent = r.role_title || r.current_title || '—';
    cells[2].querySelector('.cand-meta').textContent = r.current_company || '';
    tr.querySelector('.cat-badge').textContent = r.category || '—';
    const sk = tr.querySelector('.cand-skills');
    (r.top_skills || []).slice(0, 5).forEach((s) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = s;
      sk.appendChild(chip);
    });
    tr.querySelector('[data-act="view"]').addEventListener('click', () => openCandidate(r.id));
    tr.querySelector('[data-act="chat"]').addEventListener('click', () => startChatForResume(r));
    body.appendChild(tr);
  }
}

$('applyFiltersBtn').addEventListener('click', loadCandidates);
$('clearFiltersBtn').addEventListener('click', () => {
  $('searchInput').value = '';
  $('categoryFilter').value = '';
  $('minScoreFilter').value = '';
  $('minYearsFilter').value = '';
  loadCandidates();
});
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); loadCandidates(); }
});

// =================== Candidate detail modal ===================
async function openCandidate(id) {
  try {
    const r = await api(`/resumes/${id}`);
    const review = r.review || {};
    const band = scoreBand(r.score || 0);
    const contact = [
      ['Email', r.email],
      ['Phone', r.phone],
      ['Location', r.location],
      ['Current title', r.current_title],
      ['Current company', r.current_company],
      ['Years exp', r.years_experience],
      ['Education', r.highest_education],
      ['Notice', r.notice_period],
      ['Salary', r.expected_salary]
    ].filter(([_, v]) => v != null && v !== '');
    const links = [
      ['LinkedIn', r.linkedin],
      ['GitHub', r.github],
      ['Portfolio', r.portfolio]
    ].filter(([_, v]) => !!v);

    const body = $('modalBody');
    body.innerHTML = `
      <div class="modal-head">
        <div class="modal-score ${band}">${r.score ?? '—'}</div>
        <div>
          <div class="modal-title"></div>
          <div class="modal-sub"></div>
        </div>
      </div>

      <div class="modal-section">
        <h4>Summary</h4>
        <p id="modalSummary"></p>
      </div>

      <div class="modal-section">
        <h4>Breakdown</h4>
        <div class="modal-bars"></div>
      </div>

      <div class="modal-section">
        <h4>Contact</h4>
        <div class="contact-grid"></div>
      </div>

      <div class="modal-section">
        <h4>Strengths</h4>
        <ul id="modalStrengths"></ul>
      </div>
      <div class="modal-section">
        <h4>Concerns</h4>
        <ul id="modalConcerns"></ul>
      </div>
      <div class="modal-section">
        <h4>Recommendations</h4>
        <ul id="modalRecs"></ul>
      </div>

      <div class="modal-section" style="display:flex;gap:8px;flex-wrap:wrap;">
        ${r.file_path ? `<a class="btn ghost" href="/resumes/${r.id}/file" target="_blank">Download file</a>` : ''}
        <button class="btn primary" id="modalChatBtn">Chat about this candidate</button>
        <button class="btn danger" id="modalDeleteBtn">Delete</button>
      </div>
    `;
    body.querySelector('.modal-title').textContent = r.candidate_name || r.filename;
    body.querySelector('.modal-sub').textContent =
      [r.role_title, r.category, r.email].filter(Boolean).join(' · ');
    $('modalSummary').textContent = review.summary || '(no summary available)';

    const bars = body.querySelector('.modal-bars');
    for (const [k, v] of Object.entries(review.breakdown || {})) {
      const row = document.createElement('div');
      row.className = 'modal-bar';
      row.innerHTML = `<span class="label">${k}</span><div class="bar"><span></span></div><span class="val">${v}</span>`;
      row.querySelector('.bar > span').style.width = `${Math.max(0, Math.min(100, v))}%`;
      bars.appendChild(row);
    }
    const cg = body.querySelector('.contact-grid');
    for (const [k, v] of contact) {
      const dt = document.createElement('div'); dt.textContent = k; dt.className = 'muted';
      const dd = document.createElement('div'); dd.textContent = v;
      cg.appendChild(dt); cg.appendChild(dd);
    }
    for (const [k, v] of links) {
      const dt = document.createElement('div'); dt.textContent = k; dt.className = 'muted';
      const dd = document.createElement('div');
      const a = document.createElement('a');
      a.href = v; a.target = '_blank'; a.rel = 'noopener'; a.textContent = v;
      dd.appendChild(a);
      cg.appendChild(dt); cg.appendChild(dd);
    }
    fillUL('modalStrengths', review.strengths);
    fillUL('modalConcerns', review.concerns);
    fillUL('modalRecs', review.recommendations);

    body.querySelector('#modalChatBtn').addEventListener('click', () => {
      closeModal();
      startChatForResume(r);
    });
    body.querySelector('#modalDeleteBtn').addEventListener('click', async () => {
      if (!confirm(`Delete ${r.candidate_name || r.filename}?`)) return;
      try {
        await api(`/resumes/${r.id}`, { method: 'DELETE' });
        toast('Deleted', 'success');
        closeModal();
        loadCandidates();
        loadOverview();
      } catch (err) {
        toast(`Delete failed: ${err.message}`, 'error');
      }
    });

    $('modal').classList.remove('hidden');
  } catch (err) {
    toast(`Could not load resume: ${err.message}`, 'error');
  }
}

function closeModal() { $('modal').classList.add('hidden'); }
function fillUL(id, items) {
  const ul = $(id); ul.innerHTML = '';
  (items || []).forEach((t) => {
    const li = document.createElement('li'); li.textContent = t; ul.appendChild(li);
  });
}
$('modalClose').addEventListener('click', closeModal);
$('modal').querySelector('.modal-backdrop').addEventListener('click', closeModal);

// =================== Chat ===================
let chatState = {
  mode: 'all',          // 'all' or 'one'
  resumeId: null,       // active resume id when mode === 'one'
  threadId: null,       // active thread id
  resumes: [],          // cached for picker
  sending: false
};

function initChatIfNeeded() {
  if (chatState._inited) return;
  chatState._inited = true;
  // Mode toggle
  document.querySelectorAll('input[name="chatMode"]').forEach((r) => {
    r.addEventListener('change', () => {
      chatState.mode = r.value;
      $('resumePicker').classList.toggle('hidden', r.value !== 'one');
      if (r.value === 'one' && !chatState.resumes.length) populateResumePicker();
      chatState.threadId = null;
      renderChatMessages([]);
      updateChatHeader();
    });
  });
  $('resumePicker').addEventListener('change', (e) => {
    chatState.resumeId = Number(e.target.value) || null;
    chatState.threadId = null;
    renderChatMessages([]);
    updateChatHeader();
  });
  $('newThreadBtn').addEventListener('click', () => {
    chatState.threadId = null;
    renderChatMessages([]);
    $('chatInput').focus();
    document.querySelectorAll('#threadList li').forEach((li) => li.classList.remove('active'));
  });
  // Auto-grow textarea + submit on Enter (Shift+Enter = newline).
  $('chatInput').addEventListener('input', () => autoGrow($('chatInput')));
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chatForm').requestSubmit(); }
  });
  $('chatForm').addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });

  // Prompt chips → click to seed
  document.querySelectorAll('.prompt-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('chatInput').value = chip.textContent;
      autoGrow($('chatInput'));
      $('chatInput').focus();
    });
  });

  loadThreads();
  populateResumePicker();
  updateChatHeader();
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(200, el.scrollHeight) + 'px';
}

function updateChatHeader() {
  const scope = chatState.mode === 'one'
    ? (chatState.resumeId
        ? `Resume #${chatState.resumeId}`
        : 'Per-resume mode — pick one above')
    : 'Cross-resume mode';
  $('chatScope').textContent = scope;
  $('chatTitle').textContent = chatState.threadId
    ? `Conversation #${chatState.threadId}`
    : 'New conversation';
}

async function populateResumePicker() {
  try {
    const { resumes } = await api('/resumes');
    chatState.resumes = resumes;
    syncResumeNameCache(resumes);
    const sel = $('resumePicker');
    sel.innerHTML = '<option value="">— pick a resume —</option>';
    for (const r of resumes) {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = `${r.candidate_name || r.filename} — score ${r.score ?? '—'}`;
      sel.appendChild(opt);
    }
  } catch (err) {
    console.warn('[chat] resume picker:', err.message);
  }
}

async function loadThreads() {
  try {
    const { threads } = await api('/threads');
    const list = $('threadList');
    list.innerHTML = '';
    if (!threads.length) {
      list.innerHTML = '<li class="muted small" style="cursor:default;">No conversations yet.</li>';
      return;
    }
    for (const t of threads) {
      const li = document.createElement('li');
      const isOne = !!t.resume_id;
      li.innerHTML = `
        <span class="thread-title"></span>
        <span class="thread-sub"></span>
      `;
      li.querySelector('.thread-title').textContent = t.title || '(untitled)';
      li.querySelector('.thread-sub').textContent =
        isOne ? `On ${t.candidate_name || t.filename || `resume #${t.resume_id}`}` : 'All resumes';
      li.addEventListener('click', () => openThread(t));
      list.appendChild(li);
    }
  } catch (err) {
    console.warn('[chat] threads:', err.message);
  }
}

async function openThread(t) {
  chatState.threadId = t.id;
  chatState.mode = t.resume_id ? 'one' : 'all';
  chatState.resumeId = t.resume_id || null;
  document.querySelector(`input[name="chatMode"][value="${chatState.mode}"]`).checked = true;
  $('resumePicker').classList.toggle('hidden', chatState.mode !== 'one');
  if (chatState.mode === 'one' && chatState.resumeId) {
    $('resumePicker').value = String(chatState.resumeId);
  }
  document.querySelectorAll('#threadList li').forEach((li) => li.classList.remove('active'));
  // best-effort: mark active by matching title text
  document.querySelectorAll('#threadList li').forEach((li) => {
    if (li.querySelector('.thread-title')?.textContent === t.title) li.classList.add('active');
  });
  try {
    const { messages } = await api(`/threads/${t.id}/messages`);
    renderChatMessages(messages);
    updateChatHeader();
  } catch (err) {
    toast(`Could not open thread: ${err.message}`, 'error');
  }
}

function renderChatMessages(messages) {
  const el = $('chatMessages');
  el.innerHTML = '';
  if (!messages.length) {
    // re-attach the empty state
    el.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'empty-chat';
    wrap.innerHTML = `
      <h2>Ask anything about your candidates</h2>
      <p>Try a prompt:</p>
      <div class="prompt-chips">
        <button class="prompt-chip">Backend devs with 2+ years</button>
        <button class="prompt-chip">Top 5 React engineers, ranked</button>
        <button class="prompt-chip">Anyone available immediately?</button>
        <button class="prompt-chip">ML candidates with cloud experience</button>
      </div>
    `;
    wrap.querySelectorAll('.prompt-chip').forEach((c) =>
      c.addEventListener('click', () => { $('chatInput').value = c.textContent; autoGrow($('chatInput')); }));
    el.appendChild(wrap);
    return;
  }
  for (const m of messages) {
    appendMsg(m.role, m.content);
  }
  el.scrollTop = el.scrollHeight;
}

// --- Citation helpers ----------------------------------------------------
// Cache resume names so [[#42]] markers can render as "Jane Doe" chips
// without a per-message round-trip. Refreshed on chat init + after a stream.
const RESUME_NAME_BY_ID = new Map();
function syncResumeNameCache(list) {
  if (!Array.isArray(list)) return;
  for (const r of list) {
    if (r && r.id) RESUME_NAME_BY_ID.set(Number(r.id), r.candidate_name || r.filename || `#${r.id}`);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Replace [[#42]] markers in escaped text with a clickable name chip.
// The chip shows the candidate's name with a small ↗ glyph (CSS-applied)
// so the user can see it's clickable. When the model already wrote the
// name immediately before the marker (the common case), we swallow that
// preceding name so the result isn't "Rujal Ladhe Rujal Ladhe↗".
//
// Two fallback passes handle "Candidate #42" and bare "#42" -- but only
// when 42 is a known id in the resume cache, to avoid false positives.
function renderAssistantHtml(rawText) {
  let escaped = escapeHtml(rawText);

  const chipFor = (id, label) => {
    const safeLabel = escapeHtml(label);
    return `<button class="cite-chip" data-cite-id="${id}" title="Open ${safeLabel}">${safeLabel}</button>`;
  };

  // Pass 1: canonical [[#N]] marker, possibly preceded by the candidate's
  // name. The leading capture grabs up to 4 capitalized words (a typical
  // human name) so we can detect and remove the duplicate.
  escaped = escaped.replace(
    /([A-Z][A-Za-z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z][A-Za-z'.-]*){0,3})?(\s*)\[\[#(\d+)\]\]/g,
    (match, before, ws, idStr) => {
      const id = Number(idStr);
      const fullName = RESUME_NAME_BY_ID.get(id) || `#${id}`;
      if (before) {
        const beforeLower = before.toLowerCase();
        const nameLower = fullName.toLowerCase();
        // Full-name match: swallow it.
        if (beforeLower.endsWith(nameLower)) {
          return before.slice(0, before.length - fullName.length) + chipFor(id, fullName);
        }
        // First-name match: e.g. model wrote "Jane" then [[#42]] for Jane Doe.
        const firstName = fullName.split(/\s+/)[0];
        if (firstName && beforeLower.endsWith(firstName.toLowerCase())) {
          return before.slice(0, before.length - firstName.length) + chipFor(id, fullName);
        }
      }
      // No name to absorb -- emit the chip in-place.
      return (before || '') + (ws || '') + chipFor(id, fullName);
    }
  );

  // Pass 2: "Candidate #42" / "candidate #42" -- replace the whole phrase.
  escaped = escaped.replace(/\b[Cc]andidate\s+#(\d+)\b/g, (m, idStr) => {
    const id = Number(idStr);
    return RESUME_NAME_BY_ID.has(id)
      ? chipFor(id, RESUME_NAME_BY_ID.get(id))
      : m;
  });

  // Pass 3: bare "#42" preceded by whitespace/punctuation, only for known ids.
  escaped = escaped.replace(/(^|[\s(,;:])#(\d+)\b/g, (m, lead, idStr) => {
    const id = Number(idStr);
    return RESUME_NAME_BY_ID.has(id)
      ? `${lead}${chipFor(id, RESUME_NAME_BY_ID.get(id))}`
      : m;
  });

  return escaped;
}

function wireCitations(bubbleEl) {
  bubbleEl.querySelectorAll('.cite-chip').forEach((b) => {
    if (b.dataset.wired) return;
    b.dataset.wired = '1';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(b.dataset.citeId);
      if (Number.isFinite(id)) openCandidate(id);
    });
  });
}

function setAssistantContent(bubbleEl, text) {
  bubbleEl.innerHTML = renderAssistantHtml(text);
  wireCitations(bubbleEl);
}

function appendMsg(role, text, opts = {}) {
  const el = $('chatMessages');
  const empty = el.querySelector('.empty-chat');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = `msg ${role}${opts.pending ? ' pending' : ''}${opts.error ? ' error' : ''}`;
  if (role === 'assistant' && !opts.pending && !opts.error) {
    setAssistantContent(div, text);
  } else {
    div.textContent = text;
  }
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  return div;
}

// Streaming chat over Server-Sent Events.
// - Opens a POST to /chat/stream, reads response.body chunk-by-chunk.
// - Renders tokens incrementally (raw text -- looks like typewriter).
// - On 'done', re-renders the bubble through the citation parser so
//   [[#N]] markers become clickable chips.
async function sendChat() {
  if (chatState.sending) return;
  const input = $('chatInput');
  const msg = input.value.trim();
  if (!msg) return;
  if (chatState.mode === 'one' && !chatState.resumeId) {
    toast('Pick a resume first.', 'error');
    return;
  }
  chatState.sending = true;
  $('chatSendBtn').disabled = true;
  appendMsg('user', msg);
  input.value = '';
  autoGrow(input);

  const messagesEl = $('chatMessages');
  const empty = messagesEl.querySelector('.empty-chat');
  if (empty) empty.remove();

  const bubble = document.createElement('div');
  bubble.className = 'msg assistant streaming';
  bubble.textContent = '';
  messagesEl.appendChild(bubble);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  let full = '';
  let scheduledScroll = false;
  const scheduleScroll = () => {
    if (scheduledScroll) return;
    scheduledScroll = true;
    requestAnimationFrame(() => {
      scheduledScroll = false;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  };

  try {
    const body = { message: msg };
    if (chatState.threadId) body.threadId = chatState.threadId;
    if (chatState.mode === 'one') body.resumeId = chatState.resumeId;

    const res = await fetch(API + '/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok || !res.body) {
      let errMsg = `backend ${res.status}`;
      try { errMsg = (await res.json()).error || errMsg; } catch { /* */ }
      throw new Error(errMsg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // SSE frames: blocks separated by \n\n; each block has "event:" and "data:" lines.
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (!frame.trim() || frame.startsWith(':')) continue; // skip heartbeats

        let event = 'message';
        const dataLines = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        let payload = null;
        try { payload = JSON.parse(dataLines.join('\n')); } catch { continue; }

        if (event === 'thread' && payload && payload.threadId) {
          chatState.threadId = payload.threadId;
          updateChatHeader();
        } else if (event === 'error') {
          throw new Error(payload?.error || 'stream error');
        } else if (event === 'done') {
          // Final render with citation chips.
          bubble.classList.remove('streaming');
          setAssistantContent(bubble, full);
          scheduleScroll();
        } else if (payload && typeof payload.token === 'string') {
          full += payload.token;
          // While streaming, write plain text -- chip rendering happens on 'done'.
          bubble.textContent = full;
          scheduleScroll();
        }
      }
    }
    // Defensive: if 'done' never arrived, still finalize.
    if (bubble.classList.contains('streaming')) {
      bubble.classList.remove('streaming');
      setAssistantContent(bubble, full || '(no response)');
    }
    loadThreads();
  } catch (err) {
    bubble.classList.remove('streaming');
    bubble.classList.add('error');
    bubble.textContent = `Could not get an answer: ${err.message}`;
  } finally {
    chatState.sending = false;
    $('chatSendBtn').disabled = false;
  }
}

// Open the chat view scoped to a specific resume.
function startChatForResume(r) {
  switchView('chat');
  initChatIfNeeded();
  chatState.mode = 'one';
  chatState.resumeId = r.id;
  chatState.threadId = null;
  document.querySelector('input[name="chatMode"][value="one"]').checked = true;
  $('resumePicker').classList.remove('hidden');
  if (!chatState.resumes.length) populateResumePicker();
  $('resumePicker').value = String(r.id);
  renderChatMessages([]);
  updateChatHeader();
  $('chatInput').focus();
}

// =================== Settings ===================
async function loadSettings() {
  const info = $('backendInfo');
  try {
    const h = await api('/health');
    info.innerHTML = `
      <div class="k">Status</div><div class="v" style="color:var(--good)">online</div>
      <div class="k">AI provider</div><div class="v">${h.provider}</div>
      <div class="k">Model</div><div class="v">${h.model || '(default)'}</div>
      <div class="k">Embedding provider</div><div class="v">${h.embedProvider}</div>
      <div class="k">Server time</div><div class="v">${h.time}</div>
    `;
  } catch (err) {
    info.innerHTML = `<div class="k">Status</div><div class="v" style="color:var(--bad)">${err.message}</div>`;
  }
}

// =================== Top-bar actions ===================
$('refreshBtn').addEventListener('click', () => {
  const active = document.querySelector('.nav-btn.active')?.dataset.view || 'overview';
  if (active === 'overview')   loadOverview();
  if (active === 'candidates') loadCandidates();
  if (active === 'chat')       { loadThreads(); populateResumePicker(); }
  if (active === 'settings')   loadSettings();
  checkHealth();
});
$('exportBtn').addEventListener('click', async () => {
  try {
    const res = await fetch(API + '/resumes/export.xlsx');
    if (!res.ok) throw new Error(`backend ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `resumes-${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Excel downloaded.', 'success');
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'error');
  }
});

// =================== JD Match ===================
let matchState = { inited: false, running: false };

function initMatchIfNeeded() {
  // Always refresh the name cache so newly-scored candidates show up in
  // citations + match results without a full page reload.
  populateResumePicker().catch(() => {});

  if (matchState.inited) return;
  matchState.inited = true;

  $('jdRunBtn').addEventListener('click', runJdMatch);
  $('jdClearBtn').addEventListener('click', () => {
    $('jdInput').value = '';
    $('jdResults').innerHTML = '';
    $('jdStatus').textContent = '';
    $('jdInput').focus();
  });
  $('jdInput').addEventListener('keydown', (e) => {
    // Cmd/Ctrl + Enter to submit -- recruiters paste big blobs, so keep
    // plain Enter for new lines.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      runJdMatch();
    }
  });
}

async function runJdMatch() {
  if (matchState.running) return;
  const text = $('jdInput').value.trim();
  if (text.length < 20) {
    toast('Paste a longer job description first.', 'error');
    return;
  }
  const topK = Number($('jdTopK').value) || 5;
  const reasons = $('jdReasons').checked;

  matchState.running = true;
  $('jdRunBtn').disabled = true;
  $('jdResults').innerHTML = '';
  $('jdStatus').textContent = reasons
    ? `Embedding JD and ranking candidates… AI reasons take ~3–6 seconds.`
    : `Embedding JD and ranking candidates…`;

  try {
    const t0 = performance.now();
    const out = await api('/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobDescription: text, topK, reasons })
    });
    const ms = Math.round(performance.now() - t0);
    renderJdResults(out.results || []);
    const n = out.results?.length || 0;
    $('jdStatus').textContent = n
      ? `${n} candidate${n === 1 ? '' : 's'} ranked in ${ms} ms.`
      : `No matches — score some resumes first.`;
  } catch (err) {
    $('jdStatus').textContent = `Could not match: ${err.message}`;
  } finally {
    matchState.running = false;
    $('jdRunBtn').disabled = false;
  }
}

function renderJdResults(rows) {
  const wrap = $('jdResults');
  wrap.innerHTML = '';
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'jd-empty';
    empty.textContent = 'No candidates in your pipeline yet. Score some resumes from Outlook first.';
    wrap.appendChild(empty);
    return;
  }
  rows.forEach((r, i) => {
    const card = document.createElement('div');
    card.className = 'jd-card';
    const band = scoreBand(r.score || 0);
    card.innerHTML = `
      <div class="jd-rank">#${i + 1}</div>
      <div class="jd-head">
        <div>
          <div class="jd-name"></div>
          <div class="jd-meta"></div>
        </div>
        <div class="jd-scores">
          <span class="score-pill ${band}">${r.score ?? '—'}</span>
          <span class="jd-fit"><span class="fit-dot"></span>${r.matchScore}% fit</span>
        </div>
      </div>
      <div class="jd-reason"></div>
      <div class="jd-excerpt"></div>
      <div class="jd-actions">
        <button class="btn ghost small" data-act="view">View</button>
        <button class="btn ghost small" data-act="more">Excerpt</button>
        <button class="btn ghost small" data-act="chat">Chat</button>
      </div>
    `;
    card.querySelector('.jd-name').textContent = r.candidateName || r.filename || `Resume #${r.resumeId}`;
    card.querySelector('.jd-meta').textContent = r.filename && r.filename !== r.candidateName ? r.filename : '';
    card.querySelector('.jd-reason').textContent = r.reason || (r.bestExcerpt ? '(no AI reason — see excerpt)' : '');
    card.querySelector('.jd-excerpt').textContent = r.bestExcerpt || '';
    card.querySelector('[data-act="view"]').addEventListener('click', () => openCandidate(r.resumeId));
    card.querySelector('[data-act="more"]').addEventListener('click', () => card.classList.toggle('expanded'));
    card.querySelector('[data-act="chat"]').addEventListener('click', () =>
      startChatForResume({ id: r.resumeId, candidate_name: r.candidateName, filename: r.filename }));
    wrap.appendChild(card);
  });
}

// =================== Live updates (SSE) ===================
// Subscribe to the backend event feed. Whenever a new resume is scored
// (either from the Outlook extension auto-poller or someone clicking in the
// popup), the active view refreshes itself + a toast slides in.
//
// EventSource auto-reconnects with exponential backoff if the socket drops,
// so we don't have to babysit it.
let liveES = null;
function subscribeLive() {
  if (liveES) { try { liveES.close(); } catch { /* */ } }
  const es = new EventSource('/events');
  liveES = es;

  es.addEventListener('resume:scored', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data); } catch { /* */ }
    const name = data.candidateName || data.filename || `#${data.resumeId}`;
    const verb = data.isNew ? 'New candidate scored' : 'Updated';
    toast(`${verb}: ${name}${data.score != null ? ` (${data.score}/100)` : ''}`, 'success');

    // Always keep overview KPIs + the name cache fresh. Refreshing the
    // candidates view too if it's the visible one keeps the table live.
    loadOverview();
    populateResumePicker().catch(() => {});
    const active = document.querySelector('.nav-btn.active')?.dataset.view;
    if (active === 'candidates') loadCandidates();
  });

  // We don't auto-reload here -- EventSource will reconnect on its own. We
  // only update the health dot through the existing checkHealth poll.
  es.onerror = () => { /* silent; auto-reconnects */ };
}

// =================== Boot ===================
checkHealth();
loadOverview();
// Eagerly pre-load resume names so citation chips can render labels even
// before the chat tab has been opened.
populateResumePicker().catch(() => {});
subscribeLive();
setInterval(checkHealth, 30000);
