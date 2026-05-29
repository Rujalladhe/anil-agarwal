// IMAP integration -- pull resume attachments out of ANY custom-domain mailbox.
//
// Unlike the Outlook (Microsoft Graph) and Gmail flows, which use per-provider
// OAuth, IMAP is a vendor-neutral protocol that every serious mail host speaks
// (Zoho, Google Workspace, Microsoft 365, Hostinger, cPanel, Namecheap, ...).
// That makes it the right fit for a mailbox on a domain you own, e.g.
// hr@yourcompany.com.
//
// IMAP needs a username + password, NOT an OAuth token, so -- per the project's
// hard rule that secrets never touch the extension -- all of this runs in the
// backend. The credentials live either in .env (preferred for the password) or
// in the automation_kv store when configured from the dashboard.
//
//   IMAP_HOST=imap.zoho.com         # or imap.gmail.com, outlook.office365.com
//   IMAP_PORT=993
//   IMAP_SECURE=true                # implicit TLS on 993; false = STARTTLS/143
//   IMAP_USER=hr@yourcompany.com
//   IMAP_PASS=app-password-here     # use a provider APP PASSWORD, not the login
//   IMAP_MAILBOX=INBOX
//
// Flow (server-side, one shot):
//   1. UI POSTs /imap/config to save host/user/etc (or it comes from .env).
//   2. UI POSTs /imap/test to verify the credentials connect.
//   3. UI POSTs /imap/sync -> fetchImapResumes() connects, pulls the newest
//      messages, extracts PDF/DOCX attachments, and hands each to the SAME
//      scoring pipeline /score uses. Re-syncing is cheap: each attachment is
//      keyed by (messageId, partId) so already-scored ones hit the cache.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { kvGet, kvSet, kvDel } from './automationDb.js';

const CONFIG_KEY = 'imap.config';

// Resolve effective config: dashboard-saved values (automation_kv) win over
// .env, field by field, so you can keep the password in .env but tweak the
// mailbox from the UI. The password is NEVER returned by imapStatus().
export async function getImapConfig() {
  const saved = (await kvGet(CONFIG_KEY)) || {};
  const envSecure = process.env.IMAP_SECURE;
  return {
    host:    saved.host    || process.env.IMAP_HOST    || '',
    port:    Number(saved.port || process.env.IMAP_PORT || 993),
    secure:  saved.secure != null
               ? !!saved.secure
               : (envSecure != null ? envSecure !== 'false' : true),
    user:    saved.user    || process.env.IMAP_USER    || '',
    pass:    saved.pass    || process.env.IMAP_PASS    || '',
    mailbox: saved.mailbox || process.env.IMAP_MAILBOX || 'INBOX'
  };
}

export async function imapConfigured() {
  const c = await getImapConfig();
  return !!(c.host && c.user && c.pass);
}

// Persist a partial config from the dashboard. Omitted/blank fields keep their
// previous value -- importantly, sending the form without a password does NOT
// wipe a stored one, so you can edit the host without re-typing the secret.
export async function setImapConfig({ host, port, secure, user, pass, mailbox } = {}) {
  const prev = (await kvGet(CONFIG_KEY)) || {};
  const next = {
    host:    host    != null ? String(host).trim()    : prev.host,
    port:    port    != null ? Number(port)           : prev.port,
    secure:  secure  != null ? !!secure               : prev.secure,
    user:    user    != null ? String(user).trim()    : prev.user,
    pass:    (pass != null && pass !== '') ? String(pass) : prev.pass,
    mailbox: mailbox != null ? String(mailbox).trim()  : prev.mailbox
  };
  await kvSet(CONFIG_KEY, next);
  return imapStatus();
}

export async function disconnectImap() {
  await kvDel(CONFIG_KEY);
}

// Safe-to-expose status: connection coordinates minus the password.
export async function imapStatus() {
  const c = await getImapConfig();
  return {
    configured: !!(c.host && c.user && c.pass),
    host:    c.host,
    port:    c.port,
    secure:  c.secure,
    user:    c.user,
    mailbox: c.mailbox
  };
}

// --- connection helper ---------------------------------------------------

// Opens a connection, runs `fn(client, config)`, and always logs out. Throws a
// friendly error if the mailbox isn't configured yet.
async function withClient(fn) {
  const c = await getImapConfig();
  if (!c.host || !c.user || !c.pass) {
    throw new Error('IMAP not configured. Set host, user, and password in Settings → IMAP (or .env).');
  }
  const client = new ImapFlow({
    host: c.host,
    port: c.port,
    secure: c.secure,            // true = implicit TLS (993); false = STARTTLS (143)
    auth: { user: c.user, pass: c.pass },
    logger: false,               // imapflow is chatty by default
    // Give a slow/free host a little room before we give up.
    socketTimeout: 60_000
  });

  // Translate raw socket/auth failures into something the UI can show.
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`IMAP connect failed for ${c.user}@${c.host}:${c.port} — ${friendly(err)}`);
  }

  try {
    return await fn(client, c);
  } finally {
    try { await client.logout(); } catch { /* best effort */ }
  }
}

function friendly(err) {
  const m = err?.message || String(err);
  if (/auth/i.test(m) || err?.authenticationFailed) {
    return 'authentication failed. For Gmail/Zoho/M365 use an APP PASSWORD (not your normal login password) and make sure IMAP is enabled in the mail settings.';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return 'host not found — check IMAP_HOST.';
  if (/ECONNREFUSED/i.test(m))        return 'connection refused — check the port (993 for TLS, 143 for STARTTLS).';
  if (/timed out|ETIMEDOUT/i.test(m)) return 'connection timed out.';
  return m;
}

// Verifies credentials by connecting and opening the mailbox. Returns a small
// summary the UI can show ("Connected — 1,284 messages in INBOX").
export async function testImapConnection() {
  return withClient(async (client, c) => {
    const lock = await client.getMailboxLock(c.mailbox);
    try {
      return {
        ok: true,
        mailbox: c.mailbox,
        messages: client.mailbox?.exists ?? null
      };
    } finally {
      lock.release();
    }
  });
}

// --- attachment filtering (mirrors google.js / graph.js) -----------------

function isPdfOrDocx(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return lower.endsWith('.pdf') || lower.endsWith('.docx');
}

export function isResumeByFilename(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (lower.includes('resume')) return true;
  if (lower.includes('curriculum')) return true;
  // "cv" only as a whole word so "cvs.pdf" / "discover.pdf" don't match.
  if (/(^|[^a-z0-9])cv([^a-z0-9]|$)/i.test(lower)) return true;
  return false;
}

// Pull a display name + bare address out of a mailparser address object.
function fromParts(addr) {
  const first = addr?.value?.[0];
  if (!first) return { from: addr?.text || '(unknown sender)', fromName: '' };
  return { from: first.address || addr.text || '', fromName: first.name || '' };
}

// --- fetch resumes --------------------------------------------------------

// Connects, walks the newest `limit` messages in the mailbox, parses each, and
// returns every PDF/DOCX attachment. Inline parts (signatures, logos) are
// dropped unless the filename looks like a resume.
//
//   limit:          how many of the most-recent messages to scan (default 25)
//   sinceDays:      if >0, also drop messages older than this many days
//   includeContent: when true, attach the bytes as base64 (heavier); when
//                   false, return metadata only (for a light inbox listing)
//
// Each returned item:
//   { source:'imap', messageId, uid, partId, subject, from, fromName,
//     receivedDateTime, filename, contentType, size, isResumeByFilename
//     [, contentBase64] }
//
// messageId is `imap:<uidValidity>:<uid>` — stable per mailbox — and partId is
// the attachment's index within the message, so (messageId, partId) is a stable
// cache key for the scoring layer AND a download handle for the extension.
async function collectResumeAttachments({ limit = 25, sinceDays = 0, includeContent = false } = {}) {
  return withClient(async (client, c) => {
    const lock = await client.getMailboxLock(c.mailbox);
    const out = [];
    try {
      const total = client.mailbox?.exists || 0;
      if (!total) return [];
      const uidValidity = String(client.mailbox?.uidValidity ?? '0');

      // Newest `limit` messages by sequence number. Sequence N is the newest.
      const want = Math.max(1, Math.min(limit, total));
      const start = total - want + 1;
      const range = `${start}:${total}`;

      const cutoff = sinceDays > 0
        ? Date.now() - sinceDays * 86400_000
        : null;

      // Stream the raw source for each message and parse it. `source` pulls the
      // full RFC822 body; fine for an MVP-scale scan of a couple dozen mails.
      for await (const msg of client.fetch(range, { uid: true, source: true })) {
        let parsed;
        try {
          parsed = await simpleParser(msg.source);
        } catch (err) {
          console.warn(`[imap] failed to parse uid ${msg.uid}:`, err.message);
          continue;
        }

        const received = parsed.date ? parsed.date.getTime() : null;
        if (cutoff && received != null && received < cutoff) continue;

        const { from, fromName } = fromParts(parsed.from);
        const subject = parsed.subject || '(no subject)';
        const receivedDateTime = parsed.date ? parsed.date.toISOString() : '';

        const atts = parsed.attachments || [];
        atts.forEach((att, idx) => {
          const filename = att.filename || '';
          if (!isPdfOrDocx(filename)) return;
          // mailparser marks inline parts with contentDisposition 'inline'.
          const inline = (att.contentDisposition || '').toLowerCase() === 'inline' || !!att.cid;
          if (inline && !isResumeByFilename(filename)) return;

          const item = {
            source: 'imap',
            messageId: `imap:${uidValidity}:${msg.uid}`,
            uid: msg.uid,
            partId: String(idx),
            subject,
            from,
            fromName,
            receivedDateTime,
            filename,
            contentType: att.contentType || 'application/octet-stream',
            size: att.size || att.content?.length || 0,
            isResumeByFilename: isResumeByFilename(filename)
          };
          if (includeContent) {
            item.contentBase64 = Buffer.isBuffer(att.content) ? att.content.toString('base64') : '';
          }
          out.push(item);
        });
      }
    } finally {
      lock.release();
    }

    out.sort((a, b) => (b.receivedDateTime || '').localeCompare(a.receivedDateTime || ''));
    return out;
  });
}

// Bulk path used by POST /imap/sync: attachments WITH bytes, for server-side
// scoring of the whole mailbox in one shot.
export async function fetchImapResumes(opts = {}) {
  return collectResumeAttachments({ ...opts, includeContent: true });
}

// Listing path used by GET /imap/messages: metadata only, so the extension can
// render an inbox like Gmail/Outlook and download each attachment lazily on
// click. Same item shape as google.js's listGmailResumeEmails(), tagged
// source:'imap'.
export async function listImapResumeEmails(opts = {}) {
  return collectResumeAttachments({ ...opts, includeContent: false });
}

// Downloads ONE attachment by the id pair the listing handed out. Reconnects,
// fetches just that message by UID, and returns the bytes base64-encoded so the
// caller (GET /imap/attachments/...) can hand them straight to /score — exactly
// like downloadGmailAttachment(). partId is the attachment's index within the
// message.
export async function downloadImapAttachment(messageId, partId) {
  const m = /^imap:([^:]*):(\d+)$/.exec(String(messageId || ''));
  if (!m) throw new Error(`Bad IMAP messageId: ${messageId}`);
  const wantUidValidity = m[1];
  const uid = Number(m[2]);
  const idx = Number(partId);

  return withClient(async (client, c) => {
    const lock = await client.getMailboxLock(c.mailbox);
    try {
      // UIDs are only stable while uidValidity is unchanged. If the mailbox was
      // recreated server-side, the cached ids are stale and the user must
      // refresh the listing.
      const curValidity = String(client.mailbox?.uidValidity ?? '0');
      if (wantUidValidity && wantUidValidity !== '0' && curValidity !== wantUidValidity) {
        throw new Error('Mailbox changed since this list was loaded — refresh the inbox and try again.');
      }

      // Fetch the single message by UID (third arg flags the range as a UID).
      let source = null;
      for await (const msg of client.fetch(uid, { uid: true, source: true }, { uid: true })) {
        source = msg.source;
        break;
      }
      if (!source) throw new Error(`Message uid ${uid} not found (it may have been deleted).`);

      const parsed = await simpleParser(source);
      const att = (parsed.attachments || [])[idx];
      if (!att || !Buffer.isBuffer(att.content)) {
        throw new Error(`Attachment part ${idx} not found on message uid ${uid}.`);
      }
      return {
        filename: att.filename || 'resume',
        contentType: att.contentType || 'application/octet-stream',
        contentBase64: att.content.toString('base64'),
        size: att.size || att.content.length
      };
    } finally {
      lock.release();
    }
  });
}
