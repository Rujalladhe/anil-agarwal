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
  'https://www.googleapis.com/auth/gmail.send'
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
  availabilityWindows = []
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
  const body = {
    summary,
    description,
    start: { dateTime: startIso, timeZone },
    end:   { dateTime: endIso,   timeZone },
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
    const msg = data?.error?.message || data?.error_description || data?.error || `HTTP ${res.status}`;
    const err = new Error(`Google API: ${msg}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}
