// Popup orchestration: connect, list resumes, score one on click, render.

import { BACKEND_URL } from './config.js';
import { login as outlookLogin, isLoggedIn as outlookLoggedIn, clearTokens as outlookClearTokens, getRedirectUri } from './auth.js';
import { listResumeEmails as listOutlookEmails, downloadAttachment as downloadOutlookAttachment } from './graph.js';
import {
  gmailStatus, isGmailConnected, connectGmail, disconnectGmail,
  listResumeEmails as listGmailEmails, downloadAttachment as downloadGmailAttachment
} from './gmail.js';

// Source-aware attachment downloader. Items carry `source: 'outlook' | 'gmail'`
// so the popup can fetch from whichever inbox they came from without the rest
// of the code caring.
async function downloadFor(item) {
  if (item.source === 'gmail') {
    return downloadGmailAttachment(item.messageId, item.attachmentId, {
      filename: item.filename,
      contentType: item.contentType
    });
  }
  return downloadOutlookAttachment(item.messageId, item.attachmentId);
}

const $ = (id) => document.getElementById(id);

// Always print the redirect URI to the popup console -- handy during setup.
console.log('[Resume Scorer] OAuth redirect URI (paste into Azure as SPA redirect):\n  ' + getRedirectUri());

// -------- UI helpers ------------------------------------------------------
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }
function setText(id, text) { $(id).textContent = text; }

function showAuthError(msg) {
  const el = $('authError');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearAuthError() { hide('authError'); }

function showMainError(msg) {
  const el = $('mainError');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearMainError() { hide('mainError'); }

function setLoading(on, text = 'Working…') {
  if (on) {
    $('loadingText').textContent = text;
    show('loading');
  } else {
    hide('loading');
  }
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch { return iso; }
}

// -------- Top-level views -------------------------------------------------
// Tracks which inboxes are currently connected. Updated by refreshConnectionStatus().
const connected = { outlook: false, gmail: false };

async function refreshConnectionStatus() {
  const [out, gm] = await Promise.all([
    outlookLoggedIn().catch(() => false),
    gmailStatus().catch(() => ({ connected: false }))
  ]);
  connected.outlook = !!out;
  connected.gmail = !!gm.connected;

  // Auth panel rows: show "Connected as ..." vs "Not connected", and flip
  // the row class so connected ones get the sage tint.
  const outlookRow = document.querySelector('[data-provider="outlook"]');
  const gmailRow   = document.querySelector('[data-provider="gmail"]');
  if (outlookRow) outlookRow.classList.toggle('connected', connected.outlook);
  if (gmailRow)   gmailRow.classList.toggle('connected',   connected.gmail);

  setText('outlookStatus', connected.outlook ? 'Connected' : 'Not connected');
  setText('gmailStatus',
    connected.gmail
      ? (gm.profile?.email ? `Connected · ${gm.profile.email}` : 'Connected')
      : (gm.configured === false
          ? 'Backend missing Google OAuth credentials'
          : 'Not connected'));

  // Flip the buttons between "Connect" and "Disconnect" based on state.
  const outBtn = $('connectOutlookBtn');
  const gmBtn  = $('connectGmailBtn');
  outBtn.textContent = connected.outlook ? 'Disconnect' : 'Connect';
  outBtn.classList.toggle('primary', false);
  outBtn.classList.toggle('secondary', true);
  gmBtn.textContent  = connected.gmail   ? 'Disconnect' : 'Connect';
  gmBtn.classList.toggle('primary', false);
  gmBtn.classList.toggle('secondary', true);
  // Gmail connect is meaningless when the backend doesn't have client creds.
  if (gm.configured === false && !connected.gmail) {
    gmBtn.disabled = true;
    gmBtn.title = 'Set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in backend/.env';
  } else {
    gmBtn.disabled = false;
    gmBtn.title = '';
  }

  return connected;
}

async function renderInitial() {
  await refreshConnectionStatus();
  const anyConnected = connected.outlook || connected.gmail;

  if (anyConnected) {
    hide('authPanel');
    show('mainPanel');
    show('signOutBtn');
    show('manageConnectionsBtn');
    await refreshInbox();
  } else {
    show('authPanel');
    hide('mainPanel');
    hide('signOutBtn');
    hide('manageConnectionsBtn');
    hide('continueBtn');
  }
}

// -------- Classification cache --------------------------------------------
// Classification of an attachment is deterministic from its bytes. We cache
// the verdict in chrome.storage.local keyed by attachmentId + size so we
// don't re-download + re-classify every time the popup opens.
const CLASSIFY_CACHE_KEY = 'classify_cache_v1';

async function loadClassifyCache() {
  const obj = await chrome.storage.local.get(CLASSIFY_CACHE_KEY);
  return obj[CLASSIFY_CACHE_KEY] || {};
}
async function saveClassifyCache(cache) {
  await chrome.storage.local.set({ [CLASSIFY_CACHE_KEY]: cache });
}
function cacheKey(item) {
  // Prefix with source so a Gmail attId can't ever collide with an Outlook one.
  return `${item.source || 'outlook'}|${item.attachmentId}|${item.size}`;
}

// -------- Inbox listing ---------------------------------------------------
let lastResumes = [];

async function refreshInbox() {
  clearMainError();
  setText('statusLine', '');
  $('resumeList').innerHTML = '';
  hide('resultPanel');

  // Re-check connection state in case the user just connected/disconnected.
  await refreshConnectionStatus();
  const sources = [];
  if (connected.outlook) sources.push('Outlook');
  if (connected.gmail)   sources.push('Gmail');
  setLoading(true, `Scanning ${sources.join(' + ') || 'inboxes'} for attachments…`);

  // Pull both inboxes in parallel; surface each one's error independently so
  // a Gmail outage doesn't block Outlook results (and vice versa).
  const tasks = [];
  if (connected.outlook) tasks.push(listOutlookEmails().then(
    (r) => ({ ok: true, source: 'outlook', items: r }),
    (err) => ({ ok: false, source: 'outlook', err })
  ));
  if (connected.gmail) tasks.push(listGmailEmails().then(
    (r) => ({ ok: true, source: 'gmail', items: r }),
    (err) => ({ ok: false, source: 'gmail', err })
  ));

  const results = await Promise.all(tasks);
  const items = [];
  const errors = [];
  for (const r of results) {
    if (r.ok) items.push(...r.items);
    else      errors.push(`${r.source}: ${r.err.message}`);
  }
  // Newest first across both inboxes.
  items.sort((a, b) => (b.receivedDateTime || '').localeCompare(a.receivedDateTime || ''));
  lastResumes = items;

  if (errors.length) showMainError(errors.join('\n'));
  setLoading(false);

  if (!items.length) {
    renderEmpty('No recent emails with PDF or DOCX attachments.');
    return;
  }

  // Two tiers:
  //   - filename match  -> render immediately as confirmed resume
  //   - unknown         -> render in "checking..." state, classify in bg
  const cache = await loadClassifyCache();

  // Pre-apply cache so we don't show "checking" for files we've already seen.
  for (const it of items) {
    if (it.isResumeByFilename) {
      it._verdict = 'filename';
    } else if (cache[cacheKey(it)] !== undefined) {
      it._verdict = cache[cacheKey(it)] ? 'content' : 'rejected';
    } else {
      it._verdict = 'pending';
    }
  }

  renderResumeList(items);
  updateStatus(items);

  // Kick off classification for unknowns. Don't block the UI.
  const pending = items.filter((it) => it._verdict === 'pending');
  if (pending.length) {
    classifyPending(pending, cache).catch((err) => console.error('classify batch error:', err));
  }
}

function visibleItems(items) {
  // We hide rejected items entirely. Show: filename matches, content matches,
  // and still-pending ones (so the user sees the checking spinner).
  return items.filter((it) => it._verdict !== 'rejected');
}

function updateStatus(items) {
  const v = visibleItems(items);
  const confirmed = v.filter((it) => it._verdict === 'filename' || it._verdict === 'content').length;
  const pending = v.filter((it) => it._verdict === 'pending').length;
  let txt = `${confirmed} resume${confirmed === 1 ? '' : 's'} found`;
  if (pending) txt += ` · checking ${pending} more…`;
  setText('statusLine', txt);
}

function renderEmpty(message) {
  const list = $('resumeList');
  list.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = message;
  list.appendChild(empty);
}

function renderResumeList(items) {
  const list = $('resumeList');
  list.innerHTML = '';
  const v = visibleItems(items);
  if (!v.length) {
    renderEmpty('No resumes detected in your recent emails.');
    return;
  }
  for (const it of v) {
    list.appendChild(buildCard(it));
  }
}

function buildCard(item) {
  const card = document.createElement('div');
  card.className = 'resume-card';
  card.dataset.cacheKey = cacheKey(item);
  card.dataset.messageId = item.messageId;
  card.dataset.attachmentId = item.attachmentId;

  card.innerHTML = `
    <div class="card-top">
      <span class="filename"></span>
      <span class="badges">
        <span class="badge badge-source"></span>
        <span class="badge"></span>
      </span>
    </div>
    <div class="subject"></div>
    <div class="meta"></div>
    <div class="card-actions">
      <button class="btn-summarize" type="button">Summarize</button>
    </div>
    <div class="summary-panel hidden"></div>
  `;
  card.querySelector('.filename').textContent = item.filename;
  card.querySelector('.subject').textContent = item.subject;
  card.querySelector('.meta').textContent =
    `${item.fromName ? item.fromName + ' · ' : ''}${item.from} · ${fmtDate(item.receivedDateTime)}`;

  // Source badge (Outlook / Gmail) so the user knows which inbox the resume
  // came from when they've connected both.
  const src = item.source || 'outlook';
  const srcEl = card.querySelector('.badge-source');
  srcEl.textContent = src === 'gmail' ? 'Gmail' : 'Outlook';
  srcEl.classList.add(src);

  const sumBtn = card.querySelector('.btn-summarize');
  sumBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleInboxSummary(item, card, sumBtn);
  });

  applyVerdictToCard(card, item);
  card.addEventListener('click', () => {
    if (item._verdict === 'pending') return; // ignore clicks while checking
    scoreOne(item, card);
  });
  return card;
}

// Quick "what's in this resume?" without committing to a full score.
// Downloads the attachment, sends to /summarize, shows result inline.
// Caches the resolved summary on the panel itself so re-toggling is free.
async function toggleInboxSummary(item, cardEl, btn) {
  const panel = cardEl.querySelector('.summary-panel');

  if (panel.dataset.loaded === 'true') {
    const hide = !panel.classList.contains('hidden');
    panel.classList.toggle('hidden', hide);
    btn.textContent = hide ? 'Summarize' : 'Hide summary';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Summarizing…';
  panel.classList.remove('hidden', 'error');
  panel.textContent = 'Working…';

  try {
    const att = await downloadFor(item);
    const res = await fetch(`${BACKEND_URL}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: att.filename,
        contentType: att.contentType,
        contentBase64: att.contentBase64
      })
    });
    if (!res.ok) {
      let body = '';
      try { body = (await res.json()).error || ''; } catch { body = await res.text(); }
      throw new Error(body || `backend ${res.status}`);
    }
    const { summary } = await res.json();
    panel.textContent = summary;
    panel.dataset.loaded = 'true';
    btn.textContent = 'Hide summary';
  } catch (err) {
    panel.classList.add('error');
    panel.textContent = `Could not summarize: ${err.message}`;
    btn.textContent = 'Retry summary';
    delete panel.dataset.loaded;
  } finally {
    btn.disabled = false;
  }
}

function applyVerdictToCard(card, item) {
  // The card has two badges (source + verdict). Pick the one that isn't the
  // source pill so the "Resume / Checking / Not a resume" label lands right.
  const badge = card.querySelector('.badge:not(.badge-source)');
  card.classList.remove('pending', 'rejected', 'confirmed');
  if (item._verdict === 'pending') {
    card.classList.add('pending');
    badge.textContent = 'Checking…';
    badge.className = 'badge badge-pending';
  } else if (item._verdict === 'filename') {
    card.classList.add('confirmed');
    badge.textContent = 'Resume';
    badge.className = 'badge badge-good';
  } else if (item._verdict === 'content') {
    card.classList.add('confirmed');
    badge.textContent = 'Resume (content)';
    badge.className = 'badge badge-good';
  } else if (item._verdict === 'rejected') {
    badge.textContent = 'Not a resume';
    badge.className = 'badge badge-bad';
  }
}

// Background classification for unknowns. Concurrency-capped so we don't
// hammer Graph or the backend.
async function classifyPending(pending, cache) {
  const concurrency = 3;
  let cursor = 0;

  async function worker() {
    while (cursor < pending.length) {
      const it = pending[cursor++];
      try {
        const att = await downloadFor(it);
        const res = await fetch(`${BACKEND_URL}/classify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: att.filename,
            contentType: att.contentType,
            contentBase64: att.contentBase64
          })
        });
        if (!res.ok) throw new Error(`backend ${res.status}`);
        const verdict = await res.json();
        const isResume = !!verdict.isResume;
        it._verdict = isResume ? 'content' : 'rejected';
        cache[cacheKey(it)] = isResume;
      } catch (err) {
        console.warn(`[classify] ${it.filename}: ${err.message}`);
        // On error, leave as rejected so the user isn't stuck with "checking"
        // forever. Don't cache so a future retry can succeed.
        it._verdict = 'rejected';
      }
      // Re-render after each one so the UI stays live.
      renderResumeList(lastResumes);
      updateStatus(lastResumes);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  await saveClassifyCache(cache);
}

// -------- Scoring a single resume ----------------------------------------
async function scoreOne(item, cardEl) {
  clearMainError();
  hide('resultPanel');

  document.querySelectorAll('.resume-card.active').forEach((el) => el.classList.remove('active'));
  cardEl.classList.add('active');

  setLoading(true, `Downloading ${item.filename}…`);
  try {
    const att = await downloadFor(item);

    setLoading(true, 'Sending to backend for AI scoring…');
    const res = await fetch(`${BACKEND_URL}/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: att.filename,
        contentType: att.contentType,
        contentBase64: att.contentBase64
      })
    });

    if (!res.ok) {
      let body = '';
      try { body = (await res.json()).error || ''; } catch { body = await res.text(); }
      throw new Error(`Backend ${res.status}: ${body || 'unknown error'}`);
    }

    const scored = await res.json();
    renderResult(scored, item);
  } catch (err) {
    console.error(err);
    if (err.message && err.message.toLowerCase().includes('failed to fetch')) {
      showMainError(`Could not reach backend at ${BACKEND_URL}. Is it running? (cd backend && npm run dev)`);
    } else {
      showMainError(err.message || 'Scoring failed.');
    }
  } finally {
    setLoading(false);
  }
}

function bandClass(score) {
  if (score >= 75) return 'good';
  if (score >= 50) return 'warn';
  return 'bad';
}

function renderResult(scored, item) {
  setText('scoreFilename', item.filename);
  setText('scoreFrom', `${item.fromName ? item.fromName + ' · ' : ''}${item.from}`);

  // Category badge + role title
  const catEl = $('scoreCategory');
  if (scored.categoryLabel) {
    catEl.textContent = scored.categoryLabel;
    catEl.classList.remove('hidden');
  } else {
    catEl.classList.add('hidden');
  }
  setText('scoreRoleTitle', scored.roleTitle || '');

  const circle = $('scoreCircle');
  circle.classList.remove('good', 'warn', 'bad');
  circle.classList.add(bandClass(scored.score));
  setText('scoreNumber', String(scored.score));

  const breakdown = $('breakdown');
  breakdown.innerHTML = '';
  for (const [k, v] of Object.entries(scored.breakdown || {})) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <span class="label"></span>
      <div class="bar"><span></span></div>
      <span class="val"></span>
    `;
    row.querySelector('.label').textContent = k;
    row.querySelector('.bar > span').style.width = `${Math.max(0, Math.min(100, v))}%`;
    row.querySelector('.val').textContent = String(v);
    breakdown.appendChild(row);
  }

  setText('summary', scored.summary || '');

  fillList('strengths', scored.strengths);
  fillList('concerns', scored.concerns);
  fillList('recommendations', scored.recommendations);

  show('resultPanel');
  // Scroll the result into view for nicer UX.
  $('resultPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function fillList(id, items) {
  const ul = $(id);
  ul.innerHTML = '';
  (items || []).forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    ul.appendChild(li);
  });
}

// -------- Rankings view ---------------------------------------------------
async function loadRankings() {
  const list = $('rankingsList');
  list.innerHTML = '';
  setText('rankingsStatus', 'Loading…');
  try {
    const res = await fetch(`${BACKEND_URL}/resumes/by-category`);
    if (!res.ok) throw new Error(`backend ${res.status}`);
    const { groups } = await res.json();
    renderRankings(groups);
    const total = groups.reduce((acc, g) => acc + g.count, 0);
    setText('rankingsStatus', `${total} resume${total === 1 ? '' : 's'} across ${groups.length} categor${groups.length === 1 ? 'y' : 'ies'}`);
  } catch (err) {
    console.error('[rankings]', err);
    list.innerHTML = '';
    setText('rankingsStatus', '');
    const msg = err.message?.toLowerCase().includes('failed to fetch')
      ? `Could not reach backend at ${BACKEND_URL}.`
      : `Could not load rankings: ${err.message}`;
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = msg;
    list.appendChild(empty);
  }
}

function renderRankings(groups) {
  const list = $('rankingsList');
  list.innerHTML = '';
  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No resumes scored yet. Score a few from the Inbox tab.';
    list.appendChild(empty);
    return;
  }
  for (const g of groups) {
    const wrap = document.createElement('div');
    wrap.className = 'rank-group';
    const h = document.createElement('h4');
    h.innerHTML = `<span></span><span class="group-count"></span>`;
    h.firstChild.textContent = g.label;
    h.lastChild.textContent = `${g.count}`;
    wrap.appendChild(h);

    g.resumes.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'rank-row';
      const score = Number.isFinite(r.score) ? r.score : 0;
      row.innerHTML = `
        <span class="rank-num"></span>
        <div>
          <div class="rank-name"></div>
          <div class="rank-meta"></div>
        </div>
        <span class="rank-score"></span>
        <button class="btn-summarize" type="button">Summarize</button>
        <div class="summary-panel hidden"></div>
      `;
      row.querySelector('.rank-num').textContent = `#${i + 1}`;
      row.querySelector('.rank-name').textContent = r.candidate_name || r.filename;
      row.querySelector('.rank-meta').textContent =
        [r.role_title, r.filename !== r.candidate_name ? r.filename : null]
          .filter(Boolean).join(' · ');
      const scoreEl = row.querySelector('.rank-score');
      scoreEl.textContent = String(score);
      scoreEl.classList.add(bandClass(score));

      const sumBtn = row.querySelector('.btn-summarize');
      sumBtn.addEventListener('click', () => toggleStoredSummary(r.id, row, sumBtn));

      wrap.appendChild(row);
    });

    list.appendChild(wrap);
  }
}

// Summarize a resume already stored in the backend. Cheap: /summarize
// returns the cached review.summary, no AI call. Result is held on the
// panel element so toggling is instant after first load.
async function toggleStoredSummary(resumeId, rowEl, btn) {
  const panel = rowEl.querySelector('.summary-panel');

  if (panel.dataset.loaded === 'true') {
    const hide = !panel.classList.contains('hidden');
    panel.classList.toggle('hidden', hide);
    btn.textContent = hide ? 'Summarize' : 'Hide';
    return;
  }

  btn.disabled = true;
  btn.textContent = '…';
  panel.classList.remove('hidden', 'error');
  panel.textContent = 'Loading…';

  try {
    const res = await fetch(`${BACKEND_URL}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId })
    });
    if (!res.ok) {
      let body = '';
      try { body = (await res.json()).error || ''; } catch { body = await res.text(); }
      throw new Error(body || `backend ${res.status}`);
    }
    const { summary } = await res.json();
    panel.textContent = summary;
    panel.dataset.loaded = 'true';
    btn.textContent = 'Hide';
  } catch (err) {
    panel.classList.add('error');
    panel.textContent = `Could not summarize: ${err.message}`;
    btn.textContent = 'Retry';
    delete panel.dataset.loaded;
  } finally {
    btn.disabled = false;
  }
}

// -------- Tab switching ---------------------------------------------------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.add('hidden'));
    $(`tab-${btn.dataset.tab}`).classList.remove('hidden');
    if (btn.dataset.tab === 'rankings') loadRankings();
  });
});

$('refreshRankingsBtn').addEventListener('click', loadRankings);

// Download every scored candidate as an Excel file. We fetch the XLSX bytes
// from the backend, wrap them in a blob URL, and trigger an <a download>
// click. This keeps the popup open and gives a "real" Save dialog.
$('downloadXlsxBtn').addEventListener('click', async () => {
  const btn = $('downloadXlsxBtn');
  const url = `${BACKEND_URL}/resumes/export.xlsx`;
  btn.disabled = true;
  setText('rankingsStatus', 'Preparing Excel…');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`backend ${res.status}`);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = `resumes-${stamp}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke after a short delay so Chrome has time to start the download.
    setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
    setText('rankingsStatus', 'Excel downloaded.');
  } catch (err) {
    console.error('[xlsx]', err);
    const msg = err.message?.toLowerCase().includes('failed to fetch')
      ? `Could not reach backend at ${BACKEND_URL}.`
      : `Could not download Excel: ${err.message}`;
    setText('rankingsStatus', '');
    showMainError(msg);
  } finally {
    btn.disabled = false;
  }
});

// -------- Event wiring ----------------------------------------------------

// Outlook connect / disconnect. Same button toggles role based on state.
$('connectOutlookBtn').addEventListener('click', async () => {
  clearAuthError();
  const btn = $('connectOutlookBtn');
  btn.disabled = true;
  try {
    if (connected.outlook) {
      await outlookClearTokens();
      await refreshConnectionStatus();
      await renderInitial();
    } else {
      await outlookLogin();
      await renderInitial();
    }
  } catch (err) {
    console.error(err);
    showAuthError(err.message || 'Outlook connect failed.');
  } finally {
    btn.disabled = false;
  }
});

// Gmail connect / disconnect. Connect opens a tab to the backend OAuth flow;
// once the callback succeeds we'll see it on the next refreshConnectionStatus.
$('connectGmailBtn').addEventListener('click', async () => {
  clearAuthError();
  const btn = $('connectGmailBtn');
  btn.disabled = true;
  try {
    if (connected.gmail) {
      await disconnectGmail();
      await refreshConnectionStatus();
      await renderInitial();
    } else {
      await connectGmail(); // opens a Google consent tab
      // The user is now in a Google tab. Poll status for ~90s waiting for
      // the OAuth callback to flip "connected" -> true, then auto-advance.
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        await refreshConnectionStatus();
        if (connected.gmail) {
          await renderInitial();
          return;
        }
      }
      // Timed out -- user may have closed the tab without finishing. Leave
      // them on the auth panel; "Continue" is available if Outlook is wired.
    }
  } catch (err) {
    console.error(err);
    showAuthError(err.message || 'Gmail connect failed.');
  } finally {
    btn.disabled = false;
  }
});

// Optional "Continue" button -- shown once at least one inbox is connected so
// the user can advance without waiting for the Gmail polling loop above.
$('continueBtn').addEventListener('click', async () => {
  await renderInitial();
});

// Bring the user back to the connections picker without signing out.
$('manageConnectionsBtn').addEventListener('click', async () => {
  await refreshConnectionStatus();
  show('authPanel');
  hide('mainPanel');
  // If at least one inbox is connected, surface the Continue button so they
  // can return to the inbox view without reconnecting.
  if (connected.outlook || connected.gmail) show('continueBtn');
});

$('refreshBtn').addEventListener('click', async () => {
  // Don't kick the background poller here -- it would scan the inbox
  // concurrently with refreshInbox() below and trip Microsoft's per-mailbox
  // concurrency limit. The poller runs every minute on its own alarm, so
  // any unscored attachments will be picked up within ~60s anyway.
  await refreshInbox();
});

// Auto-score toggle. Bound to chrome.storage.local key auto_score_enabled_v1
// which background.js checks at the top of runPoll(). Default ON to preserve
// previous behavior; flip OFF before a demo to avoid the 60s poller burning
// LLM tokens in the background.
const AUTO_SCORE_KEY = 'auto_score_enabled_v1';
(async () => {
  const obj = await chrome.storage.local.get(AUTO_SCORE_KEY);
  const enabled = obj[AUTO_SCORE_KEY] !== false; // default true
  const box = $('autoScoreCheck');
  if (box) box.checked = enabled;
})();
$('autoScoreCheck')?.addEventListener('change', async (e) => {
  await chrome.storage.local.set({ [AUTO_SCORE_KEY]: e.target.checked });
});

// Tell the service worker to wipe the toolbar badge counter, since the user
// is now looking at the inbox.
try { chrome.runtime.sendMessage({ type: 'auto-score:clear-badge' }, () => void chrome.runtime.lastError); }
catch { /* */ }

$('signOutBtn').addEventListener('click', async () => {
  // Disconnect every connected inbox. Each call is best-effort.
  await Promise.allSettled([
    outlookClearTokens(),
    connected.gmail ? disconnectGmail() : Promise.resolve()
  ]);
  await renderInitial();
});

// Open the full recruiter dashboard (served by the local backend).
$('openDashboardBtn').addEventListener('click', () => {
  chrome.tabs?.create
    ? chrome.tabs.create({ url: BACKEND_URL + '/' })
    : window.open(BACKEND_URL + '/', '_blank');
});

renderInitial();
