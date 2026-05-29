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

// SVG circular progress ring for resume scores — matches the IncRuiter
// "Resume Score" column look (navy arc on a light track, % in the center).
// Animation comes from the CSS transition on .score-ring-arc which sets
// stroke-dashoffset; we render at full offset then flip it on the next
// frame so the arc draws in. r=22 → circumference = 2π·22 ≈ 138.23.
const RING_CIRC = 138.23;
function scoreRingHTML(score) {
  if (score == null) {
    return `<div class="score-ring empty">—</div>`;
  }
  const pct = Math.max(0, Math.min(100, Number(score)));
  const band = scoreBand(pct);
  // data-pct lets the post-render hook compute the dashoffset once cells exist.
  return `
    <div class="score-ring ${band}" data-pct="${pct}">
      <svg viewBox="0 0 52 52" aria-hidden="true">
        <circle class="score-ring-track" cx="26" cy="26" r="22"></circle>
        <circle class="score-ring-arc"   cx="26" cy="26" r="22"
          stroke-dasharray="${RING_CIRC}" stroke-dashoffset="${RING_CIRC}"></circle>
      </svg>
      <span class="score-ring-val">${pct}%</span>
    </div>`;
}
// After the rows are in the DOM, kick each ring's arc to its target
// offset on the next frame so the CSS transition runs.
function animateScoreRings(root) {
  requestAnimationFrame(() => {
    root.querySelectorAll('.score-ring[data-pct]').forEach((el) => {
      const pct = Number(el.dataset.pct) || 0;
      const arc = el.querySelector('.score-ring-arc');
      if (arc) arc.style.strokeDashoffset = String(RING_CIRC * (1 - pct / 100));
    });
  });
}

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
  overview:   { title: 'Dashboard',  sub: "Welcome back! Here's your recruitment overview" },
  candidates: { title: 'Candidates', sub: 'Search, filter, and inspect every scored resume.' },
  match:      { title: 'JD Match',   sub: 'Paste a job description, get your best-fit candidates ranked.' },
  segregate:  { title: 'Segregate',  sub: 'Upload many JDs — each resume drops into the bucket it fits best.' },
  chat:       { title: 'AI Chat',    sub: 'Ask anything — across all resumes or about one in particular.' },
  automation: { title: 'Automation', sub: 'Build a node graph that sends OA links, books interviews, and more.' },
  settings:   { title: 'Settings',   sub: 'Backend, extension, integrations, and token-saving notes.' }
};

function switchView(name) {
  // Only the appbar nav drives view switching — the icon sidebar is
  // purely decorative (product-module branding, no navigation).
  document.querySelectorAll('.appnav-btn').forEach((b) =>
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
  if (name === 'match' && typeof initMatchIfNeeded === 'function') initMatchIfNeeded();
  if (name === 'segregate')  initSegregateIfNeeded();
  if (name === 'chat')       initChatIfNeeded();
  if (name === 'automation' && window.initAutomationIfNeeded) window.initAutomationIfNeeded();
  if (name === 'settings')   loadSettings();
}

document.querySelectorAll('.appnav-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// IncConnect gate: the appbar and main workspace stay hidden behind a
// body.not-connected class until the user clicks IncConnect (sidebar)
// or the "Open Workspace" splash button. Persists across reloads so a
// returning user lands straight in the workspace.
function openWorkspace() {
  document.body.classList.remove('not-connected');
  try { localStorage.setItem('inc_connected', '1'); } catch { /* ignore */ }
}
function closeWorkspace() {
  document.body.classList.add('not-connected');
  try { localStorage.removeItem('inc_connected'); } catch { /* ignore */ }
}
try {
  if (localStorage.getItem('inc_connected') === '1') {
    document.body.classList.remove('not-connected');
  }
} catch { /* ignore */ }
$('incConnectBtn')?.addEventListener('click', () => {
  // Toggle so clicking again can hide the workspace if the user wants to.
  if (document.body.classList.contains('not-connected')) openWorkspace();
  else closeWorkspace();
});
$('connectSplashBtn')?.addEventListener('click', openWorkspace);

// Deep-link support: ?view=candidates jumps straight to that view on load.
// Only honors known view names so a bogus value can't break boot.
{
  const v = new URLSearchParams(location.search).get('view');
  if (v && VIEW_TITLES[v]) {
    document.addEventListener('DOMContentLoaded', () => switchView(v), { once: true });
  }
}

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

// InCruiter palette — deep navy + warm orange + soft blues.
// Alternates between primary navy / accent orange so doughnut & bar charts
// match the dashboard screenshots' look.
const CAT_COLORS = [
  '#0f2851', // navy (primary)
  '#f5a14a', // orange (accent)
  '#3b6fb4', // mid blue
  '#f7c074', // soft amber
  '#5d83bf', // slate blue
  '#b75c2a', // burnt orange
  '#8aa6d4', // pale blue
  '#d68c2a', // amber
  '#1f3f72', // deep navy
  '#f1b06a', // peach
  '#274d8a', // royal navy
  '#c46a3a', // rust
  '#7e9bc8', // dusty blue
  '#e0954a', // mid orange
  '#456e9c'  // steel
];

// Status palette mirrored from CSS tokens (Figma reskin).
const COLOR = {
  good:     '#18ac00',
  goodSoft: '#e8f7e6',
  warn:     '#e8aa4e',
  warnSoft: '#fdf7ed',
  bad:      '#f2464b',
  badSoft:  '#feeded',
  primary:  '#133f7d',
  primaryFill: 'rgba(19, 63, 125, 0.12)',
  primaryLine: '#1e40af',
  accent:   '#12b6bc',
  accentFill: 'rgba(18, 182, 188, 0.18)',
  grid:     '#e2e8f0',
  axis:     '#a3a3a3',
  text:     '#4b5563'
};

// Apply globally so every chart inherits the same axis/legend look.
if (window.Chart) {
  Chart.defaults.font.family = "'Manrope', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
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
  renderCompaniesChart(s.topCompanies || []);
  renderEducationChart(s.educationBreakdown || []);
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
        backgroundColor: COLOR.primary,
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
        backgroundColor: [COLOR.primary, COLOR.accent, '#c4d0e2'],
        borderWidth: 3,
        borderColor: '#ffffff',
        hoverOffset: 6
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '64%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            usePointStyle: true,
            pointStyle: 'circle',
            boxWidth: 8,
            boxHeight: 8,
            padding: 12,
            font: { size: 12, family: 'Manrope', weight: '400' },
            color: '#020817'
          }
        },
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
        backgroundColor: (c) => {
          const { ctx: cc, chartArea } = c.chart;
          if (!chartArea) return '#133f7d';
          const g = cc.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          g.addColorStop(0.05, '#133f7d');
          g.addColorStop(0.95, 'rgba(18, 182, 188, 0.1)');
          return g;
        },
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: '#ffffff',
        pointHoverBorderColor: COLOR.primary,
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
        y: { beginAtZero: true, ticks: { display: false }, grid: { display: false }, border: { display: false } },
        x: {
          grid: { color: 'rgba(255,255,255,0.9)', drawTicks: false, lineWidth: 1.2, borderDash: [5, 5] },
          ticks: { font: { size: 10 }, color: COLOR.text },
          border: { display: false }
        }
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
        backgroundColor: COLOR.primary,
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

function renderCompaniesChart(rows) {
  destroyChart('companies');
  const ctx = $('chartCompanies'); if (!ctx) return;
  if (!rows.length) {
    // Wipe the canvas so an "empty" state reads as such instead of a stale chart.
    const c = ctx.getContext('2d');
    c.clearRect(0, 0, ctx.width, ctx.height);
    return;
  }
  // Trim labels so very long company names don't break the y-axis.
  const trim = (s, n = 22) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);
  charts.companies = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map((r) => trim(r.company)),
      datasets: [{
        label: 'Candidates',
        data: rows.map((r) => r.count),
        backgroundColor: COLOR.primary,
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
        tooltip: {
          backgroundColor: '#1c1917', padding: 10, cornerRadius: 6, displayColors: false,
          // Show the full (untrimmed) company name in the tooltip.
          callbacks: { title: (items) => rows[items[0].dataIndex]?.company || '' }
        }
      },
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: COLOR.grid }, border: { display: false } },
        y: { grid: { display: false }, border: { color: COLOR.grid } }
      }
    }
  });
}

const EDU_COLORS = ['#0f2851', '#3b6fb4', '#12b6bc', '#f5a14a', '#94a3b8'];

function renderEducationChart(rows) {
  destroyChart('education');
  const ctx = $('chartEducation'); if (!ctx) return;
  const legend = $('eduLegend');
  const insights = $('eduInsights');
  if (legend) legend.innerHTML = '';
  if (insights) insights.innerHTML = '';

  if (!rows.length) {
    const c = ctx.getContext('2d');
    c.clearRect(0, 0, ctx.width, ctx.height);
    if (legend) legend.innerHTML = '<li class="muted small">No education data on file yet.</li>';
    return;
  }
  const total = rows.reduce((sum, r) => sum + r.count, 0) || 1;
  const colors = rows.map((_, i) => EDU_COLORS[i % EDU_COLORS.length]);
  const sorted = rows.map((r, i) => ({ ...r, color: colors[i] }))
    .sort((a, b) => b.count - a.count);
  const top = sorted[0];
  const advanced = rows
    .filter((r) => /master|phd|doctor/i.test(r.label))
    .reduce((s, r) => s + r.count, 0);
  const known = total - (rows.find((r) => /other|unknown/i.test(r.label))?.count || 0);

  if (insights) {
    const advancedPct = Math.round((advanced / total) * 100);
    const knownPct = Math.round((known / total) * 100);
    insights.innerHTML = `
      <div class="edu-insight">
        <div class="edu-insight-label">Most common</div>
        <div class="edu-insight-value"></div>
        <div class="edu-insight-sub">${top.count} candidates · ${Math.round((top.count / total) * 100)}% of pipeline</div>
      </div>
      <div class="edu-insight">
        <div class="edu-insight-label">Advanced degrees</div>
        <div class="edu-insight-value">${advanced} <span style="font-size:13px;font-weight:500;color:#64748b;">(${advancedPct}%)</span></div>
        <div class="edu-insight-sub">Master's, PhD or doctoral candidates</div>
      </div>
      <div class="edu-insight">
        <div class="edu-insight-label">Pipeline coverage</div>
        <div class="edu-insight-value">${known} / ${total}</div>
        <div class="edu-insight-sub">${knownPct}% have identifiable education on file</div>
      </div>
    `;
    insights.querySelector('.edu-insight-value').textContent = top.label;
  }

  charts.education = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: rows.map((r) => r.label),
      datasets: [{
        data: rows.map((r) => r.count),
        backgroundColor: colors,
        borderWidth: 3,
        borderColor: '#ffffff',
        hoverOffset: 6
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1c1917', padding: 10, cornerRadius: 6, displayColors: false,
          callbacks: {
            label: (item) => {
              const pct = Math.round((item.parsed / total) * 100);
              return `${item.label}: ${item.parsed} (${pct}%)`;
            }
          }
        }
      }
    }
  });

  if (!legend) return;
  rows.forEach((r, i) => {
    const pct = Math.round((r.count / total) * 100);
    const li = document.createElement('li');
    li.className = 'edu-legend-item';
    li.innerHTML = `
      <span class="edu-dot" style="background:${colors[i]};"></span>
      <span class="edu-label"></span>
      <span class="edu-count">${r.count}</span>
      <span class="edu-pct muted small">${pct}%</span>
      <span class="edu-bar"><span style="width:${pct}%;background:${colors[i]};"></span></span>
    `;
    li.querySelector('.edu-label').textContent = r.label;
    legend.appendChild(li);
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
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'skill-chip';
    chip.title = `Show candidates with "${s.skill}"`;
    chip.innerHTML = `<span class="skill-label"></span><span class="count">${s.count}</span>`;
    chip.querySelector('.skill-label').textContent = s.skill;
    chip.addEventListener('click', () => filterCandidatesBySkill(s.skill));
    el.appendChild(chip);
  }
}

// Jump from any "skill chip" on the overview to the Candidates view with the
// search box pre-filled. searchResumes() already LIKE-matches the `q` param
// against top_skills + raw_text, so a plain skill name is enough to drive the
// filter end-to-end.
function filterCandidatesBySkill(skill) {
  switchView('candidates');
  // switchView triggers loadCandidates() asynchronously; set the inputs
  // first so the very next load reads them.
  const input = $('searchInput');
  const cat   = $('categoryFilter');
  const score = $('minScoreFilter');
  const years = $('minYearsFilter');
  if (input) input.value = skill;
  if (cat)   cat.value = '';
  if (score) score.value = '';
  if (years) years.value = '';
  // Re-run loadCandidates with the new query (switchView already called it,
  // but with the prior empty input — this guarantees the filter is applied).
  if (typeof loadCandidates === 'function') loadCandidates();
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

const PIPELINE_STATUS = [
  { min: 80, key: 'completed',  label: 'Completed'   },
  { min: 65, key: 'inprogress', label: 'In Progress' },
  { min: 50, key: 'scheduled',  label: 'Scheduled'   },
  { min: 40, key: 'followup',   label: 'Follow-up'   },
  { min: 0,  key: 'rejected',   label: 'Resume Rejected' }
];
function deriveStatus(score) {
  if (score == null) return { key: 'pending', label: 'Pending' };
  return PIPELINE_STATUS.find((s) => score >= s.min) || PIPELINE_STATUS[PIPELINE_STATUS.length - 1];
}

function fmtUpdated(ts) {
  if (!ts) return '<span class="muted">—</span>';
  const d = new Date(typeof ts === 'number' ? ts : ts);
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `<div class="upd-date">${date}</div><div class="upd-time">${time}</div>`;
}

// "Posted By" isn't stored — derive a stable display from the file/source so
// the column reads sensibly without inventing a recruiter name per row.
function postedByCell(r) {
  const name = 'Auto-import';
  const when = r.created_at
    ? new Date(r.created_at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
  return `<div class="upd-date">${name}</div><div class="upd-time">${when}</div>`;
}

function applicantId(id) {
  return `#CAN${String(id).padStart(5, '0')}`;
}

function contactCell(r) {
  const phone = r.phone ? `+91-${String(r.phone).replace(/^\+?91-?/, '')}` : '';
  const email = r.email || '';
  return `
    ${phone ? `<div class="contact-phone">${phone}</div>` : ''}
    ${email ? `<div class="contact-email">${email}</div>` : ''}
    ${!phone && !email ? '<span class="muted">—</span>' : ''}
  `;
}

function renderCandidates(rows) {
  const body = $('candidatesBody');
  body.innerHTML = '';
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="8" class="muted">No candidates match.</td></tr>';
    return;
  }
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="cell-num">${i + 1}</td>
      <td class="cell-id">${applicantId(r.id)}</td>
      <td class="cell-candidate">
        <div class="cand-name"></div>
        <div class="cand-role"></div>
      </td>
      <td class="cell-skills"></td>
      <td class="cell-contact">${contactCell(r)}</td>
      <td class="cell-updated">${fmtUpdated(r.created_at)}</td>
      <td class="cell-score">${scoreRingHTML(r.score)}</td>
      <td class="cell-actions">
        <button class="row-icon-btn" data-act="view" title="View" aria-label="View">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" stroke="currentColor" stroke-width="1.2"/>
            <circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.2"/>
          </svg>
        </button>
        <button class="row-icon-btn" data-act="chat" title="Chat" aria-label="Chat">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2.5 3.5h11a1 1 0 011 1v6a1 1 0 01-1 1H6l-3 2.5v-2.5H2.5a1 1 0 01-1-1v-6a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
          </svg>
        </button>
      </td>
    `;
    tr.querySelector('.cand-name').textContent = r.candidate_name || r.filename;
    tr.querySelector('.cand-role').textContent = r.role_title || r.current_title || '—';
    // Skills column — render the top few as chips, click a chip to refilter
    // the table to that skill (matches the dashboard's clickable chips).
    const skillsCell = tr.querySelector('.cell-skills');
    const skills = (r.top_skills || []).slice(0, 4);
    if (!skills.length) {
      skillsCell.innerHTML = '<span class="muted">—</span>';
    } else {
      for (const s of skills) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'row-skill-chip';
        chip.title = `Filter by "${s}"`;
        chip.textContent = s;
        chip.addEventListener('click', (ev) => {
          ev.stopPropagation();
          filterCandidatesBySkill(s);
        });
        skillsCell.appendChild(chip);
      }
      const extra = (r.top_skills || []).length - skills.length;
      if (extra > 0) {
        const more = document.createElement('span');
        more.className = 'row-skill-more muted';
        more.textContent = `+${extra}`;
        skillsCell.appendChild(more);
      }
    }
    tr.querySelector('[data-act="view"]').addEventListener('click', () => openCandidate(r.id));
    tr.querySelector('[data-act="chat"]').addEventListener('click', () => startChatForResume(r));
    body.appendChild(tr);
  });
  animateScoreRings(body);
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

$('candRefreshBtn').addEventListener('click', () => loadCandidates());
$('candFiltersBtn').addEventListener('click', () => {
  const panel = $('candFiltersPanel');
  const open = panel.classList.toggle('hidden');
  $('candFiltersBtn').classList.toggle('active', !open);
});
$('candExportBtn').addEventListener('click', async () => {
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
  if (window.refreshAutomationSettings) window.refreshAutomationSettings();
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

// =================== Segregate (bulk JD bucketing) ===================
// State holds the user's queued JDs only; the buckets returned by /segregate
// are rendered straight to the DOM each run and don't need to live here.
const segState = {
  inited: false,
  running: false,
  jds: [],          // [{ id, name, text, source: 'manual'|'paste'|'file' }]
  nextId: 1
};

function initSegregateIfNeeded() {
  if (segState.inited) return;
  segState.inited = true;

  $('segAddBtn').addEventListener('click', () => addJd({ source: 'manual' }));
  $('segClearBtn').addEventListener('click', () => {
    if (!segState.jds.length) return;
    if (!confirm('Clear all queued JDs?')) return;
    segState.jds = [];
    renderJdList();
  });
  $('segBulkBtn').addEventListener('click', () => {
    const wrap = $('segBulkWrap');
    wrap.classList.toggle('hidden');
    if (!wrap.classList.contains('hidden')) $('segBulkInput').focus();
  });
  $('segBulkCancel').addEventListener('click', () => {
    $('segBulkWrap').classList.add('hidden');
    $('segBulkInput').value = '';
  });
  $('segBulkApply').addEventListener('click', applyBulkPaste);

  $('segFileInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // allow re-selecting the same file
    if (!files.length) return;
    await loadJdFiles(files);
  });

  const threshEl = $('segThreshold');
  threshEl.addEventListener('input', () => { $('segThresholdVal').textContent = threshEl.value; });

  $('segRunBtn').addEventListener('click', runSegregation);

  renderJdList();
}

function addJd({ name = '', text = '', source = 'manual', expanded = true } = {}) {
  const jd = { id: segState.nextId++, name, text, source, expanded };
  segState.jds.push(jd);
  renderJdList();
  return jd;
}

function renderJdList() {
  const wrap = $('segJdList');
  wrap.innerHTML = '';
  $('segCounter').textContent = `${segState.jds.length} JD${segState.jds.length === 1 ? '' : 's'} queued`;

  if (!segState.jds.length) {
    const empty = document.createElement('div');
    empty.className = 'seg-empty';
    empty.innerHTML = `
      <div class="seg-empty-title">No JDs yet</div>
      <div class="seg-empty-sub">Click <strong>+ Add JD</strong>, paste a batch, or drop in <code>.pdf</code> / <code>.docx</code> / <code>.txt</code> files.</div>
    `;
    wrap.appendChild(empty);
    return;
  }

  segState.jds.forEach((jd, i) => {
    const row = document.createElement('div');
    row.className = 'seg-jd-row' + (jd.expanded ? ' expanded' : '');
    row.dataset.id = String(jd.id);

    const charCount = jd.text ? jd.text.length : 0;
    const tooShort  = charCount < 20;

    row.innerHTML = `
      <div class="seg-jd-head">
        <div class="seg-jd-rank">${i + 1}</div>
        <input class="seg-jd-name" type="text" placeholder="Job title (e.g. Senior Backend Engineer)" />
        <span class="seg-jd-meta ${tooShort ? 'warn' : ''}">${charCount} chars${tooShort ? ' · too short' : ''}</span>
        <button class="seg-jd-toggle" type="button" title="Expand / collapse">${jd.expanded ? '▾' : '▸'}</button>
        <button class="seg-jd-del" type="button" title="Remove this JD">×</button>
      </div>
      <textarea class="seg-jd-text" rows="6" placeholder="Paste the job description here..."></textarea>
    `;

    const nameEl = row.querySelector('.seg-jd-name');
    const textEl = row.querySelector('.seg-jd-text');
    nameEl.value = jd.name;
    textEl.value = jd.text;

    nameEl.addEventListener('input', () => { jd.name = nameEl.value; });
    textEl.addEventListener('input', () => {
      jd.text = textEl.value;
      const meta = row.querySelector('.seg-jd-meta');
      const n = jd.text.length;
      const short = n < 20;
      meta.textContent = `${n} chars${short ? ' · too short' : ''}`;
      meta.classList.toggle('warn', short);
    });
    row.querySelector('.seg-jd-toggle').addEventListener('click', () => {
      jd.expanded = !jd.expanded;
      row.classList.toggle('expanded', jd.expanded);
      row.querySelector('.seg-jd-toggle').textContent = jd.expanded ? '▾' : '▸';
    });
    row.querySelector('.seg-jd-del').addEventListener('click', () => {
      segState.jds = segState.jds.filter((x) => x.id !== jd.id);
      renderJdList();
    });

    wrap.appendChild(row);
  });
}

function applyBulkPaste() {
  const raw = $('segBulkInput').value;
  if (!raw.trim()) return;
  // Split on a line containing only --- or === (with optional whitespace).
  const blocks = raw.split(/\n\s*(?:-{3,}|={3,})\s*\n/g).map((b) => b.trim()).filter(Boolean);
  let added = 0;
  for (const block of blocks) {
    const lines = block.split('\n');
    const firstNonEmpty = lines.find((l) => l.trim()) || '';
    let name = firstNonEmpty.trim().slice(0, 80);
    let text = block;
    // If the first line is short and looks like a title, strip it from the body.
    if (name.length <= 80 && lines.length > 1 && firstNonEmpty.length < 100) {
      const idx = lines.indexOf(firstNonEmpty);
      text = lines.slice(idx + 1).join('\n').trim();
      if (!text) text = block;
    } else {
      name = `Pasted JD ${segState.jds.length + added + 1}`;
    }
    addJd({ name, text, source: 'paste', expanded: false });
    added++;
  }
  $('segBulkInput').value = '';
  $('segBulkWrap').classList.add('hidden');
  if (added > 0) toast(`Added ${added} JD${added === 1 ? '' : 's'} from paste.`, 'success');
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function loadJdFiles(files) {
  let added = 0, skipped = 0;
  for (const file of files) {
    const lower = file.name.toLowerCase();
    const baseName = file.name.replace(/\.[^.]+$/, '');
    try {
      if (lower.endsWith('.txt')) {
        const text = await file.text();
        if (text.trim().length < 20) { skipped++; continue; }
        addJd({ name: baseName, text: text.trim(), source: 'file', expanded: false });
        added++;
      } else if (lower.endsWith('.pdf') || lower.endsWith('.docx')) {
        // PDFs/DOCX can't be parsed in the browser cleanly — round-trip to the
        // backend's extractor and store the resulting text in the JD row.
        const contentBase64 = await fileToBase64(file);
        const out = await fetch('/segregate/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type,
            contentBase64
          })
        }).then((r) => r.json());
        if (out.error || !out.text || out.text.trim().length < 20) {
          skipped++;
          continue;
        }
        addJd({ name: baseName, text: out.text.trim(), source: 'file', expanded: false });
        added++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.warn('JD file load failed:', file.name, err);
      skipped++;
    }
  }
  if (added)   toast(`Loaded ${added} JD${added === 1 ? '' : 's'} from file${added === 1 ? '' : 's'}.`, 'success');
  if (skipped) toast(`Skipped ${skipped} file${skipped === 1 ? '' : 's'} (unsupported or too short).`, 'error');
}

async function runSegregation() {
  if (segState.running) return;
  const usable = segState.jds.filter((j) => (j.text || '').trim().length >= 20);
  if (!usable.length) {
    toast('Add at least one JD with 20+ characters.', 'error');
    return;
  }
  const threshold = Number($('segThreshold').value) || 0;
  segState.running = true;
  $('segRunBtn').disabled = true;
  $('segResults').innerHTML = '';
  $('segStatus').textContent = `Embedding ${usable.length} JD${usable.length === 1 ? '' : 's'} and sorting resumes…`;

  try {
    const t0 = performance.now();
    const out = await api('/segregate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threshold,
        jds: segState.jds.map((j) => ({ name: j.name || '', text: j.text || '' }))
      })
    });
    const ms = Math.round(performance.now() - t0);
    renderSegResults(out);
    const total = (out.buckets || []).reduce((a, b) => a + b.candidates.length, 0);
    $('segStatus').textContent = `Sorted ${total} candidate${total === 1 ? '' : 's'} across ${out.validJdCount}/${out.jdCount} JDs · ${out.unmatched.length} unmatched · ${ms} ms.`;
  } catch (err) {
    $('segStatus').textContent = `Could not segregate: ${err.message}`;
  } finally {
    segState.running = false;
    $('segRunBtn').disabled = false;
  }
}

function renderSegResults(out) {
  const wrap = $('segResults');
  wrap.innerHTML = '';
  const buckets = out.buckets || [];
  if (!buckets.length) {
    const empty = document.createElement('div');
    empty.className = 'seg-results-empty';
    empty.textContent = 'No JDs were valid. Make sure each JD has at least 20 characters.';
    wrap.appendChild(empty);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'seg-bucket-grid';

  const allBuckets = [...buckets];
  allBuckets.push({
    jdIndex: -1,
    jdName: 'Unmatched',
    candidates: out.unmatched || [],
    _unmatched: true
  });

  allBuckets.forEach((b) => {
    const col = document.createElement('div');
    col.className = 'seg-bucket' + (b._unmatched ? ' unmatched' : '');
    const n = b.candidates.length;
    col.innerHTML = `
      <div class="seg-bucket-head">
        <div class="seg-bucket-title"></div>
        <span class="seg-bucket-count">${n}</span>
      </div>
      <div class="seg-bucket-body"></div>
    `;
    col.querySelector('.seg-bucket-title').textContent = b.jdName || `Job #${b.jdIndex + 1}`;

    const body = col.querySelector('.seg-bucket-body');
    if (!n) {
      const empty = document.createElement('div');
      empty.className = 'seg-bucket-empty';
      empty.textContent = b._unmatched ? 'Everyone matched.' : 'No candidates fit above the threshold.';
      body.appendChild(empty);
    } else {
      b.candidates.forEach((c) => {
        const card = document.createElement('div');
        card.className = 'seg-cand';
        const band = scoreBand(c.score || 0);
        const fitBand = c.matchScore >= 70 ? 'good' : c.matchScore >= 45 ? 'warn' : 'bad';
        const runnerName = c.runnerUp
          ? (allBuckets.find((bb) => bb.jdIndex === c.runnerUp.jdIndex)?.jdName || `Job #${c.runnerUp.jdIndex + 1}`)
          : '';
        card.innerHTML = `
          <div class="seg-cand-top">
            <div class="seg-cand-name"></div>
            <span class="seg-cand-fit ${fitBand}">${c.matchScore}%</span>
          </div>
          <div class="seg-cand-meta">
            <span class="score-pill ${band}">${c.score ?? '—'}</span>
            <span class="seg-cand-cat"></span>
          </div>
          ${runnerName ? `<div class="seg-cand-runner">also fits: <span></span> · ${c.runnerUp.matchScore}%</div>` : ''}
        `;
        card.querySelector('.seg-cand-name').textContent = c.candidateName || c.filename || `Resume #${c.resumeId}`;
        card.querySelector('.seg-cand-cat').textContent = c.category || '';
        if (runnerName) card.querySelector('.seg-cand-runner span').textContent = runnerName;
        card.addEventListener('click', () => openCandidate(c.resumeId));
        body.appendChild(card);
      });
    }

    grid.appendChild(col);
  });

  wrap.appendChild(grid);
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
