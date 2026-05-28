// Gmail wrapper. Unlike graph.js (which hits Microsoft Graph directly with
// the extension's PKCE token), Gmail goes through the local backend:
//
//   extension --HTTP--> backend --OAuth--> Gmail API
//
// Why: the Google OAuth client (id + secret) is configured in backend/.env
// and per the project's "no secrets in the extension" rule it stays there.
// The backend already manages Google tokens (used by the automation engine)
// so we reuse that infra instead of mirroring it in the extension.
//
// The user kicks off the connect flow by opening BACKEND_URL/automation/google/auth
// in a normal tab; once approved, gmailIsConnected() below flips to true.

import { BACKEND_URL } from './config.js';

async function backendJson(path, init = {}) {
  const res = await fetch(`${BACKEND_URL}${path}`, init);
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  if (!res.ok) {
    const msg = body?.error || `backend ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Is Google connected on the backend AND does the backend even have OAuth
// credentials configured? Both must be true before we attempt anything.
export async function gmailStatus() {
  try {
    return await backendJson('/gmail/status');
  } catch (err) {
    // Backend not running -> treat as "not connected" so the UI can still
    // load and show the user a useful error.
    return { configured: false, connected: false, profile: null, error: err.message };
  }
}

export async function isGmailConnected() {
  const s = await gmailStatus();
  return !!s.connected;
}

// Kick the user through the Google OAuth flow. We open the consent URL in a
// real browser tab (not chrome.identity) because the OAuth callback lives on
// the backend at /automation/google/callback -- it closes itself once the
// token exchange succeeds. After it closes, the caller should re-check
// gmailStatus().
export async function connectGmail() {
  const { url, error } = await backendJson('/gmail/auth');
  if (!url) throw new Error(error || 'Could not get Google auth URL from backend.');
  await chrome.tabs.create({ url });
}

export async function disconnectGmail() {
  await backendJson('/gmail/disconnect', { method: 'POST' });
}

// Returns the same item shape as graph.js's listResumeEmails(), tagged with
// source: 'gmail' so the popup can merge both lists and render a source badge.
export async function listResumeEmails({ topMessages = 75 } = {}) {
  const { items } = await backendJson(`/gmail/messages?top=${topMessages}`);
  // Backend already tags source='gmail'; defensively ensure it's set.
  return (items || []).map((it) => ({ ...it, source: it.source || 'gmail' }));
}

// Mirrors graph.js's downloadAttachment(): returns { filename, contentType,
// contentBase64 } so popup.js can POST the same shape to /score regardless of
// which inbox the file came from.
export async function downloadAttachment(messageId, attachmentId, hint = {}) {
  const att = await backendJson(
    `/gmail/attachments/${encodeURIComponent(messageId)}/${encodeURIComponent(attachmentId)}`
  );
  return {
    filename: hint.filename || 'resume',
    contentType: hint.contentType || 'application/octet-stream',
    contentBase64: att.contentBase64
  };
}
