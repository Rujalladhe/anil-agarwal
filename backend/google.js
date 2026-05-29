// Google OAuth + Calendar + Meet + Gmail send.
//
// Zero external SDK on purpose — we hit the REST endpoints with fetch and the
// access token cached in automation_kv ('google.tokens'). The user wires up
// their OAuth client in .env:
//
//   GOOGLE_CLIENT_ID=...
//   GOOGLE_CLIENT_SECRET=...
//   GOOGLE_REDIRECT_URI=http://localhost:8787/automation/google/callback
//
// Flow:
//   1. UI calls GET  /automation/google/auth      -> { url }
//   2. User visits url, approves, Google redirects back to /callback
//   3. /callback exchanges the code, persists tokens, redirects to dashboard
//   4. Engine calls getAccessToken() and uses it for Calendar/Gmail.
//
// Tokens are refreshed lazily; we look at expiry_ts on every call and refresh
// if we're within 60s of expiry.

import { kvGet, kvSet, kvDel } from './automationDb.js';

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  // Needed so the extension can pull resume attachments out of the user's
  // Gmail inbox alongside the Outlook flow.
  'https://www.googleapis.com/auth/gmail.readonly'
].join(' ');

const TOKENS_KEY  = 'google.tokens';
const PROFILE_KEY = 'google.profile';

function clientCreds() {
  const id     = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  const redir  = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8787/automation/google/callback';
  return { id, secret, redir };
}

export function googleConfigured() {
  const { id, secret } = clientCreds();
  return Boolean(id && secret);
}

export function googleConnected() {
  const t = kvGet(TOKENS_KEY);
  return !!(t && t.refresh_token);
}

export function googleProfile() {
  return kvGet(PROFILE_KEY) || null;
}

export function getAuthUrl(state = '') {
  const { id, redir } = clientCreds();
  if (!id) throw new Error('GOOGLE_CLIENT_ID not set. See README.');
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id',     id);
  u.searchParams.set('redirect_uri',  redir);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope',         SCOPES);
  u.searchParams.set('access_type',   'offline');  // we want a refresh token
  u.searchParams.set('prompt',        'consent');  // force refresh-token emit
  u.searchParams.set('include_granted_scopes', 'true');
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

export async function exchangeCode(code) {
  const { id, secret, redir } = clientCreds();
  if (!id || !secret) throw new Error('Google OAuth client not configured.');
  const body = new URLSearchParams({
    code,
    client_id:     id,
    client_secret: secret,
    redirect_uri:  redir,
    grant_type:    'authorization_code'
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google token exchange failed: ${data.error_description || data.error || res.status}`);

  const tokens = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || null,
    scope:         data.scope,
    token_type:    data.token_type || 'Bearer',
    expiry_ts:     Date.now() + ((data.expires_in || 3600) * 1000)
  };
  // If refresh_token is missing on a re-consent, keep the old one.
  if (!tokens.refresh_token) {
    const old = kvGet(TOKENS_KEY) || {};
    tokens.refresh_token = old.refresh_token || null;
  }
  kvSet(TOKENS_KEY, tokens);

  // Stash profile (email/name) for the UI.
  try {
    const me = await fetchJson('https://openidconnect.googleapis.com/v1/userinfo', tokens.access_token);
    kvSet(PROFILE_KEY, { email: me.email, name: me.name, picture: me.picture });
  } catch { /* not fatal */ }

  return tokens;
}

export async function getAccessToken() {
  const t = kvGet(TOKENS_KEY);
  if (!t) throw new Error('Google not connected. Visit Settings → Integrations to authorize.');

  // Refresh proactively if expiring in <60s.
  if (!t.expiry_ts || (Date.now() > (t.expiry_ts - 60_000))) {
    if (!t.refresh_token) throw new Error('No refresh token stored. Reconnect Google.');
    const refreshed = await refreshAccessToken(t.refresh_token);
    return refreshed.access_token;
  }
  return t.access_token;
}

async function refreshAccessToken(refreshToken) {
  const { id, secret } = clientCreds();
  const body = new URLSearchParams({
    client_id:     id,
    client_secret: secret,
    refresh_token: refreshToken,
    grant_type:    'refresh_token'
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google token refresh failed: ${data.error_description || data.error || res.status}`);

  const old = kvGet(TOKENS_KEY) || {};
  const merged = {
    ...old,
    access_token: data.access_token,
    expiry_ts:    Date.now() + ((data.expires_in || 3600) * 1000),
    token_type:   data.token_type || old.token_type || 'Bearer'
  };
  kvSet(TOKENS_KEY, merged);
  return merged;
}

export function disconnectGoogle() {
  kvDel(TOKENS_KEY);
  kvDel(PROFILE_KEY);
}

// --- Calendar / Meet -----------------------------------------------------

// Finds the next free interview slot.
//
// The candidate slot must satisfy ALL of:
//   - inside EVERY interviewer's stated availability windows (if they gave any)
//   - inside the fallback dayStart..dayEnd workday for any interviewer who
//     hasn't specified explicit windows
//   - NOT overlap a busy block on ANY of the chosen calendars
//
//   calendarIds: ['primary', 'team@…']
//   durationMinutes: 30
//   dayStart/dayEnd: '10:00' / '17:00'      (fallback when no explicit windows)
//   daysAhead: 7
//   timeZone: optional
//   availabilityWindows: [
//     { calendarId, windows: [{ start: ISO, end: ISO }, ...] },
//     ...
//   ]
//     If `windows` is empty for a calendar, that calendar uses the fallback
//     dayStart..dayEnd for every day in [now, now+daysAhead].
export async function findNextFreeSlot({
  calendarIds = ['primary'],
  durationMinutes = 30,
  dayStart = '10:00',
  dayEnd   = '17:00',
  daysAhead = 7,
  timeZone,
  availabilityWindows = [],
  // In-run bookings (slots that will be created on the calendar imminently
  // but haven't been written yet) treated as busy alongside Google's freeBusy.
  // Same shape as Google busy blocks: [{ start: Date|ISO, end: Date|ISO }].
  extraBusy = []
} = {}) {
  const token = await getAccessToken();
  const now   = new Date();
  const start = new Date(now.getTime() + 5 * 60 * 1000);     // not "right now"
  const end   = new Date(now.getTime() + daysAhead * 86400_000);
  const durMs = durationMinutes * 60 * 1000;

  // 1. Pull busy blocks across every calendar from Google.
  const fb = await fetchJson('https://www.googleapis.com/calendar/v3/freeBusy', token, {
    method: 'POST',
    body: JSON.stringify({
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      timeZone,
      items: calendarIds.map((id) => ({ id }))
    })
  });
  const busy = [];
  for (const cid of calendarIds) {
    const cal = fb.calendars?.[cid];
    if (cal?.busy) busy.push(...cal.busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) })));
  }
  // Add in-run bookings to the busy list so we don't double-book a slot
  // scheduled earlier in this same workflow run.
  for (const b of extraBusy) {
    busy.push({ start: new Date(b.start), end: new Date(b.end) });
  }
  busy.sort((a, b) => a.start - b.start);

  // 2. Build the per-calendar set of "available intervals" inside [start, end].
  //    Calendars without explicit windows get the fallback workday slabs.
  const availByCal = new Map();
  for (const cid of calendarIds) {
    const entry = availabilityWindows.find((a) => a.calendarId === cid);
    const wins  = entry?.windows || [];
    if (wins.length) {
      const clipped = wins
        .map((w) => ({ start: new Date(w.start), end: new Date(w.end) }))
        .map((w) => ({
          start: w.start < start ? start : w.start,
          end:   w.end   > end   ? end   : w.end
        }))
        .filter((w) => w.end > w.start);
      availByCal.set(cid, mergeIntervals(clipped));
    } else {
      availByCal.set(cid, buildFallbackSlabs(start, end, dayStart, dayEnd));
    }
  }

  // 3. Intersection of every calendar's intervals = times when EVERYONE is free
  //    according to their stated availability (before considering busy).
  let intersection = availByCal.get(calendarIds[0]) || [];
  for (let i = 1; i < calendarIds.length; i++) {
    intersection = intersectIntervals(intersection, availByCal.get(calendarIds[i]));
    if (!intersection.length) break;
  }

  // 4. Walk each intersected interval looking for a durMs gap that isn't busy.
  for (const slab of intersection) {
    let cursor = new Date(slab.start);
    while ((cursor.getTime() + durMs) <= slab.end.getTime()) {
      const slotEnd = new Date(cursor.getTime() + durMs);
      const overlap = busy.find((b) => b.start < slotEnd && b.end > cursor);
      if (!overlap) {
        return { start: cursor.toISOString(), end: slotEnd.toISOString() };
      }
      cursor = new Date(overlap.end.getTime());
      const m = cursor.getMinutes();
      const next = Math.ceil(m / 15) * 15;
      cursor.setMinutes(next, 0, 0);
    }
  }
  return null;
}

// Generate one [dayStart..dayEnd] slab per day in the window, clipped to "now".
function buildFallbackSlabs(rangeStart, rangeEnd, dayStart, dayEnd) {
  const [sh, sm] = dayStart.split(':').map(Number);
  const [eh, em] = dayEnd.split(':').map(Number);
  const slabs = [];
  const d = new Date(rangeStart);
  d.setHours(0, 0, 0, 0);
  while (d < rangeEnd) {
    const slabStart = new Date(d); slabStart.setHours(sh, sm, 0, 0);
    const slabEnd   = new Date(d); slabEnd.setHours(eh, em, 0, 0);
    const s = slabStart < rangeStart ? rangeStart : slabStart;
    const e = slabEnd   > rangeEnd   ? rangeEnd   : slabEnd;
    if (e > s) slabs.push({ start: s, end: e });
    d.setDate(d.getDate() + 1);
  }
  return slabs;
}

function mergeIntervals(list) {
  if (!list.length) return [];
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const top = out[out.length - 1];
    if (sorted[i].start <= top.end) top.end = new Date(Math.max(top.end, sorted[i].end));
    else out.push(sorted[i]);
  }
  return out;
}

// Exposed for tests.
export const __schedTesting = { mergeIntervals: (l) => mergeIntervals(l), intersectIntervals: (a, b) => intersectIntervals(a, b), buildFallbackSlabs: (a, b, c, d) => buildFallbackSlabs(a, b, c, d) };

function intersectIntervals(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const lo = new Date(Math.max(a[i].start, b[j].start));
    const hi = new Date(Math.min(a[i].end,   b[j].end));
    if (hi > lo) out.push({ start: lo, end: hi });
    if (a[i].end < b[j].end) i++; else j++;
  }
  return out;
}

// Creates a calendar event with a Google Meet conference link in one call.
// attendees are { email, displayName? }. Returns the new event object.
export async function createMeetEvent({
  calendarId = 'primary',
  summary,
  description = '',
  startIso, endIso,
  attendees = [],
  timeZone
}) {
  const token = await getAccessToken();
  // Strip invalid IANA timezone names ("asia" instead of "Asia/Kolkata", etc.)
  // before sending to Google -- otherwise it returns "Invalid time zone
  // definition for start time." and the event is never created. When dropped,
  // Google falls back to the calendar's own configured timezone.
  const safeTz = validIanaTimeZone(timeZone);
  const tzPart = safeTz ? { timeZone: safeTz } : {};
  const body = {
    summary,
    description,
    start: { dateTime: startIso, ...tzPart },
    end:   { dateTime: endIso,   ...tzPart },
    attendees,
    conferenceData: {
      createRequest: {
        requestId: `meet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    },
    reminders: { useDefault: true }
  };
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`;
  return fetchJson(url, token, { method: 'POST', body: JSON.stringify(body) });
}

// Returns the input if it's a recognised IANA timezone identifier; otherwise
// null. Uses Intl.DateTimeFormat as the source of truth -- it throws a
// RangeError for unknown tz names. Exported so the interviewer-create route
// can validate at write time too.
export function validIanaTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

// --- Gmail send ---------------------------------------------------------

// Sends an email via Gmail API as the authenticated user.
// Returns the Gmail message id.
export async function sendGmail({ to, subject, body, cc, bcc, replyTo }) {
  const token = await getAccessToken();
  const profile = googleProfile();
  const from = profile?.email ? `${profile.name || ''} <${profile.email}>`.trim() : undefined;

  const raw = buildRfc822({ from, to, cc, bcc, replyTo, subject, body });
  const b64 = Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const data = await fetchJson('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', token, {
    method: 'POST',
    body: JSON.stringify({ raw: b64 })
  });
  return data.id;
}

function buildRfc822({ from, to, cc, bcc, replyTo, subject, body }) {
  const headers = [];
  if (from)    headers.push(`From: ${from}`);
  if (to)      headers.push(`To: ${to}`);
  if (cc)      headers.push(`Cc: ${cc}`);
  if (bcc)     headers.push(`Bcc: ${bcc}`);
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);
  headers.push(`Subject: ${rfc2047(subject || '')}`);
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push('Content-Transfer-Encoding: 7bit');
  return headers.join('\r\n') + '\r\n\r\n' + (body || '');
}

// Encode non-ASCII subjects (UTF-8 base64) so candidate names with accents
// don't show up as ?? in the inbox.
function rfc2047(s) {
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  const b64 = Buffer.from(s, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

// --- Gmail read (inbox + attachments) -----------------------------------
//
// Mirrors the shape of extension/graph.js so popup.js can treat Outlook
// and Gmail items the same way.
//
// Two-tier filter, same as the Outlook side:
//   - filename ends in .pdf / .docx  -> attachment candidate
//   - filename suggests a resume     -> fast-path verdict, skip /classify
// Inline attachments (signatures, logos) are dropped unless the filename
// looks like a resume.

function gmailIsPdfOrDocx(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return lower.endsWith('.pdf') || lower.endsWith('.docx');
}

export function gmailIsResumeByFilename(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (lower.includes('resume')) return true;
  if (lower.includes('curriculum')) return true;
  // "cv" only as a whole word so "cvs.pdf" / "discover.pdf" don't match.
  if (/(^|[^a-z0-9])cv([^a-z0-9]|$)/i.test(lower)) return true;
  return false;
}

// Decode RFC 4648 §5 (URL-safe base64) with optional missing padding.
function b64urlDecode(s) {
  if (!s) return Buffer.alloc(0);
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return '';
  const h = headers.find((x) => x?.name?.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

// Walk Gmail's payload tree and collect every part that has a filename and an
// attachmentId. The Gmail v1 payload is a nested {parts: [...]} structure.
function collectAttachmentParts(payload, out = []) {
  if (!payload) return out;
  const filename = payload.filename || '';
  const attachmentId = payload.body?.attachmentId;
  if (filename && attachmentId) {
    out.push({
      filename,
      mimeType: payload.mimeType || 'application/octet-stream',
      size: Number(payload.body?.size || 0),
      attachmentId,
      // Gmail flags inline images via a Content-Disposition: inline header
      // OR a Content-ID. Treat either as inline so signatures get filtered.
      isInline:
        /(^|;)\s*inline\s*(;|$)/i.test(headerValue(payload.headers, 'Content-Disposition')) ||
        !!headerValue(payload.headers, 'Content-ID')
    });
  }
  if (Array.isArray(payload.parts)) {
    for (const p of payload.parts) collectAttachmentParts(p, out);
  }
  return out;
}

// Lists recent Gmail messages that have attachments, then for each one pulls
// the message metadata + attachment list and keeps only PDF/DOCX.
// Returns the same shape as graph.js's listResumeEmails().
export async function listGmailResumeEmails({ topMessages = 75 } = {}) {
  const token = await getAccessToken();

  // 1. Page the inbox for messages with attachments. Gmail's `has:attachment`
  //    operator is the equivalent of Microsoft's `hasAttachments eq true`.
  //    `in:inbox` restricts to RECEIVED mail: a resume the user *sends* from
  //    Gmail sits in Sent, and without this scope it would be ingested and
  //    tagged source:'gmail' even though it actually landed in another inbox.
  //    The source tag must mean "the inbox that received this resume," so we
  //    only read the inbox. `-in:chats` keeps Hangouts cruft out.
  const listUrl =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages` +
    `?maxResults=${Math.max(1, Math.min(100, topMessages))}` +
    `&q=${encodeURIComponent('in:inbox has:attachment -in:chats')}`;
  const list = await fetchJson(listUrl, token);
  const ids = (list.messages || []).map((m) => m.id);
  if (!ids.length) return [];

  // 2. Fetch each message's payload tree in parallel (small concurrency cap
  //    so we don't hit Gmail's per-user quota -- 250 quota units/sec, each
  //    messages.get costs 5).
  const out = [];
  const concurrency = 4;
  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      try {
        const msg = await fetchJson(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
          token
        );
        const headers = msg.payload?.headers || [];
        const subject = headerValue(headers, 'Subject') || '(no subject)';
        const fromRaw = headerValue(headers, 'From') || '(unknown sender)';
        const dateRaw = headerValue(headers, 'Date') || '';
        // Internal date is ms-since-epoch and reliable; the Date header can
        // be malformed. Fall back to Date header if internalDate is missing.
        const receivedDateTime = msg.internalDate
          ? new Date(Number(msg.internalDate)).toISOString()
          : (dateRaw ? new Date(dateRaw).toISOString() : '');

        // "Anil Agarwal <anil@example.com>" -> name + email
        let fromName = '';
        let from = fromRaw;
        const m = fromRaw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
        if (m) { fromName = m[1].trim(); from = m[2].trim(); }

        const parts = collectAttachmentParts(msg.payload);
        for (const p of parts) {
          if (!gmailIsPdfOrDocx(p.filename)) continue;
          if (p.isInline && !gmailIsResumeByFilename(p.filename)) continue;
          out.push({
            source: 'gmail',
            messageId: msg.id,
            subject,
            from,
            fromName,
            receivedDateTime,
            attachmentId: p.attachmentId,
            filename: p.filename,
            contentType: p.mimeType,
            size: p.size,
            isResumeByFilename: gmailIsResumeByFilename(p.filename)
          });
        }
      } catch (err) {
        // One bad message shouldn't kill the whole listing.
        console.warn(`[gmail] failed to get message ${id}:`, err.message);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  out.sort((a, b) => (b.receivedDateTime || '').localeCompare(a.receivedDateTime || ''));
  return out;
}

// Downloads a single Gmail attachment by id. Returns the bytes already
// base64-encoded so the route can pass them straight through to /score.
export async function downloadGmailAttachment(messageId, attachmentId) {
  const token = await getAccessToken();
  const data = await fetchJson(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}` +
    `/attachments/${encodeURIComponent(attachmentId)}`,
    token
  );
  // Gmail returns url-safe base64 with no padding. Decode then re-encode as
  // standard base64 so downstream consumers (Buffer.from(..., 'base64')) work
  // the same regardless of source.
  const buf = b64urlDecode(data.data || '');
  return {
    contentBase64: buf.toString('base64'),
    size: Number(data.size || buf.length)
  };
}

// --- fetch helper -------------------------------------------------------

async function fetchJson(url, token, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    let msg = data?.error?.message || data?.error_description || data?.error || `HTTP ${res.status}`;
    // Common case after we add a new scope: the cached refresh token was
    // issued before the scope existed. Translate Google's terse error into
    // an actionable hint so the user knows the popup can fix it.
    if (typeof msg === 'string' && /insufficient authentication scopes/i.test(msg)) {
      msg = 'Gmail needs to be reconnected to grant the new permissions. Open the extension popup → Connections → Disconnect Gmail → Connect Gmail again.';
    }
    const err = new Error(`Google API: ${msg}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}
