// IMAP wrapper. Like gmail.js, everything goes through the local backend:
//
//   extension --HTTP--> backend --IMAP/TLS--> your custom-domain mailbox
//
// IMAP is a raw-socket protocol and needs a username + password, neither of
// which an MV3 extension can handle: a service worker can't open a TCP socket,
// and per the project's "no secrets in the extension" rule the password must
// never live in extension code/storage. So the popup just collects the mailbox
// settings, hands them to the backend (over localhost), and the backend holds
// the credentials and does the actual IMAP work.
//
// Connect flow (no OAuth, simpler than Gmail):
//   1. saveImapConfig({host,port,secure,user,pass,mailbox}) -> POST /imap/config
//   2. testImap()    -> POST /imap/test    (verify it connects)
//   3. listResumeEmails()/downloadAttachment() feed the same inbox UI as Gmail.

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

// { configured, host, port, secure, user, mailbox } — never includes password.
export async function imapStatus() {
  try {
    return await backendJson('/imap/status');
  } catch (err) {
    return { configured: false, error: err.message };
  }
}

export async function isImapConnected() {
  const s = await imapStatus();
  return !!s.configured;
}

// Save the mailbox settings on the backend. A blank `pass` keeps the stored one
// (so the user can edit the host without re-typing the password).
export async function saveImapConfig({ host, port, secure, user, pass, mailbox }) {
  return backendJson('/imap/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, port, secure, user, pass, mailbox })
  });
}

// Verify the saved credentials connect. Returns { ok, mailbox, messages }.
export async function testImap() {
  return backendJson('/imap/test', { method: 'POST' });
}

export async function disconnectImap() {
  return backendJson('/imap/disconnect', { method: 'POST' });
}

// Same item shape as gmail.js/graph.js, tagged source:'imap'.
export async function listResumeEmails({ topMessages = 50 } = {}) {
  const { items } = await backendJson(`/imap/messages?top=${topMessages}`);
  return (items || []).map((it) => ({ ...it, source: it.source || 'imap' }));
}

// Mirrors gmail.js downloadAttachment(): { filename, contentType, contentBase64 }.
// IMAP attachments are addressed by (messageId, partId) instead of an attachmentId.
export async function downloadAttachment(messageId, partId, hint = {}) {
  const att = await backendJson(
    `/imap/attachments/${encodeURIComponent(messageId)}/${encodeURIComponent(partId)}`
  );
  return {
    filename: hint.filename || att.filename || 'resume',
    contentType: hint.contentType || att.contentType || 'application/octet-stream',
    contentBase64: att.contentBase64
  };
}
