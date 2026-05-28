// MV3 service worker.
//
// Three jobs:
//   1. Log the OAuth redirect URI on install (for the Azure setup step).
//   2. Re-focus an existing popup.html tab if the user clicks the icon
//      with the popup tab already open.
//   3. PERIODICALLY POLL OUTLOOK (every 1 min) for new resume attachments
//      and POST them to /score in the background, so the dashboard updates
//      the moment a candidate emails their resume -- no user click required.
//
// The poller is silent + idempotent: the backend dedupes by (email_id,
// attachment_id), and we keep a local "seen" cache so we don't re-classify
// or re-score the same attachment more than once.

import { isLoggedIn as outlookLoggedIn } from './auth.js';
import { listResumeEmails as listOutlookEmails, downloadAttachment as downloadOutlookAttachment } from './graph.js';
import {
  isGmailConnected,
  listResumeEmails as listGmailEmails,
  downloadAttachment as downloadGmailAttachment
} from './gmail.js';
import { BACKEND_URL } from './config.js';

const ALARM_NAME  = 'inbox-poll';
const SEEN_KEY    = 'auto_score_seen_v1';   // map of "<attId>|<size>" -> "scored" | "rejected"
const ENABLED_KEY = 'auto_score_enabled_v1';// boolean (default: true)
const BADGE_KEY   = 'auto_score_unseen_v1'; // counter shown on the toolbar badge

const BADGE_COLOR = '#3c6e64';  // sage, matches the rest of the UI

// ------------------------------------------------------------------ install
chrome.runtime.onInstalled.addListener(async () => {
  const redirect = chrome.identity.getRedirectURL();
  console.log(
    '[Resume Scorer] OAuth redirect URI for Azure registration (Single-page application):\n  ' +
    redirect
  );
  // Kick off the poller. periodInMinutes minimum is 1 (Chrome silently
  // clamps anything smaller). 30s startup delay so we don't poll mid-install.
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 0.5,
    periodInMinutes: 1
  });
});

// Some browsers (re)start the SW on browser launch -- re-arm just in case.
chrome.runtime.onStartup?.addListener(async () => {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) await chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.5, periodInMinutes: 1 });
});

// ----------------------------------------------------------- icon click ---
// Make the toolbar icon open the side panel (native Chrome sidebar on the
// right, ~20% width, stays open across tabs). Chrome handles the open call
// itself when openPanelOnActionClick is true, so we don't register
// chrome.action.onClicked here. We still clear the badge when the panel
// loads -- that's done from popup.js on DOMContentLoaded via a message.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn('[bg] sidePanel.setPanelBehavior failed:', err));

// ------------------------------------------------------- inbox poll loop ---
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  try { await runPoll(); }
  catch (err) { console.warn('[bg] poll failed:', err.message); }
});

// Manual trigger from the popup ("Refresh inbox" button) -- runs the same
// loop synchronously and replies with how many were freshly scored.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'auto-score:run-now') {
    runPoll().then(
      (n) => sendResponse({ ok: true, scored: n }),
      (err) => sendResponse({ ok: false, error: err.message })
    );
    return true; // keep the channel open for the async reply
  }
  if (msg?.type === 'auto-score:clear-badge') {
    clearBadge().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ---------------------------------------------------------------- runner ---
async function runPoll() {
  if (!(await getEnabled())) return 0;

  // Discover which inboxes are connected -- skip whichever isn't.
  const [hasOutlook, hasGmail] = await Promise.all([
    outlookLoggedIn().catch(() => false),
    isGmailConnected().catch(() => false)
  ]);
  if (!hasOutlook && !hasGmail) return 0;

  // Fetch each inbox independently; one failing shouldn't block the other.
  const tasks = [];
  if (hasOutlook) tasks.push(listOutlookEmails({ topMessages: 15 }).catch((err) => {
    console.warn('[bg] outlook list failed:', err.message); return [];
  }));
  if (hasGmail) tasks.push(listGmailEmails({ topMessages: 15 }).catch((err) => {
    console.warn('[bg] gmail list failed:', err.message); return [];
  }));
  const buckets = await Promise.all(tasks);
  const items = buckets.flat();

  const seen = await getSeen();
  const fresh = items.filter((it) => !(cacheKey(it) in seen));
  if (fresh.length === 0) return 0;

  let scoredCount = 0;
  for (const it of fresh) {
    try {
      const att = await downloadFor(it);

      // Filename-based hint is fast-path; otherwise ask backend to classify
      // the content first so we don't waste a Groq call on a contract.
      if (!it.isResumeByFilename) {
        const verdict = await classify(att);
        if (!verdict?.isResume) {
          seen[cacheKey(it)] = 'rejected';
          continue;
        }
      }

      const scored = await score(att, it);
      if (scored) {
        seen[cacheKey(it)] = 'scored';
        scoredCount++;
      }
    } catch (err) {
      console.warn('[bg] item failed:', it.filename, err.message);
      // don't cache the failure -- we'll retry next tick
    }
  }

  await setSeen(seen);

  if (scoredCount > 0) {
    await bumpBadge(scoredCount);
  }
  return scoredCount;
}

// Source-aware downloader -- routes to Microsoft Graph or the backend Gmail
// proxy based on the item's `source` tag.
async function downloadFor(it) {
  if (it.source === 'gmail') {
    return downloadGmailAttachment(it.messageId, it.attachmentId, {
      filename: it.filename,
      contentType: it.contentType
    });
  }
  return downloadOutlookAttachment(it.messageId, it.attachmentId);
}

async function classify(att) {
  const res = await fetch(`${BACKEND_URL}/classify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: att.filename,
      contentType: att.contentType,
      contentBase64: att.contentBase64
    })
  });
  if (!res.ok) return null;
  return res.json();
}

async function score(att, item) {
  const res = await fetch(`${BACKEND_URL}/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: att.filename,
      contentType: att.contentType,
      contentBase64: att.contentBase64,
      emailId: item.messageId,
      attachmentId: item.attachmentId
    })
  });
  if (!res.ok) {
    console.warn(`[bg] /score ${res.status} for ${item.filename}`);
    return null;
  }
  return res.json();
}

// ------------------------------------------------------------------ utils
function cacheKey(it) {
  // Source prefix prevents a Gmail attachment id from ever colliding with an
  // Outlook one in the seen map.
  return `${it.source || 'outlook'}|${it.attachmentId}|${it.size}`;
}

async function getEnabled() {
  const obj = await chrome.storage.local.get(ENABLED_KEY);
  return obj[ENABLED_KEY] !== false; // default: ON
}

async function getSeen() {
  const obj = await chrome.storage.local.get(SEEN_KEY);
  return obj[SEEN_KEY] || {};
}
async function setSeen(seen) {
  await chrome.storage.local.set({ [SEEN_KEY]: seen });
}

async function bumpBadge(delta) {
  const obj = await chrome.storage.local.get(BADGE_KEY);
  const next = (obj[BADGE_KEY] || 0) + delta;
  await chrome.storage.local.set({ [BADGE_KEY]: next });
  try {
    await chrome.action.setBadgeText({ text: String(next) });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  } catch { /* */ }
}
async function clearBadge() {
  await chrome.storage.local.set({ [BADGE_KEY]: 0 });
  try { await chrome.action.setBadgeText({ text: '' }); } catch { /* */ }
}
