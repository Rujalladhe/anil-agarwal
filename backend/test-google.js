// Quick sanity check that Google Calendar + Meet integration actually work
// with the stored OAuth tokens. Run with:  node test-google.js
//
// Reads tokens from the same automation_kv row the engine uses, so this
// proves the engine will succeed at runtime.

import 'dotenv/config';
import { getAccessToken, findNextFreeSlot, createMeetEvent, sendGmail, googleProfile } from './google.js';
import { getDb } from './db.js';
import { ensureAutomationSchema } from './automationDb.js';

getDb();
ensureAutomationSchema();

const args = new Set(process.argv.slice(2));
const wantSendTest = args.has('--send-test');     // creates a real calendar event + email — opt-in!

(async () => {
  console.log('Profile:', googleProfile());

  // --- access token / Calendar read ---
  const token = await getAccessToken();
  console.log(`Access token OK (${token.slice(0, 12)}…)`);

  const r = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=3&orderBy=startTime&singleEvents=true&timeMin=${new Date().toISOString()}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) throw new Error('Calendar list failed: ' + (await r.text()));
  const data = await r.json();
  console.log(`Calendar list OK — next ${data.items?.length || 0} events:`);
  for (const ev of (data.items || [])) {
    const when = ev.start?.dateTime || ev.start?.date;
    console.log(`  · ${when} — ${ev.summary}`);
  }

  // --- free/busy: find next free 30-min slot today/tomorrow ---
  const slot = await findNextFreeSlot({
    calendarIds: ['primary'],
    durationMinutes: 30,
    dayStart: '10:00',
    dayEnd:   '18:00',
    daysAhead: 3
  });
  console.log('Next free 30-min slot in next 3 days:', slot || '(none)');

  if (!wantSendTest) {
    console.log('\nSkipping real event/email creation. Pass --send-test to actually create one.');
    return;
  }

  // --- create a calendar event with a Meet link, invite self ---
  const me = googleProfile().email;
  const event = await createMeetEvent({
    calendarId: 'primary',
    summary: '[Resume Scorer test] Calendar + Meet integration check',
    description: 'Created by test-google.js — feel free to delete.',
    startIso: slot.start,
    endIso:   slot.end,
    attendees: [{ email: me, displayName: googleProfile().name }]
  });
  console.log('Calendar event created:', event.htmlLink);
  console.log('Google Meet URL:', event.hangoutLink || event.conferenceData?.entryPoints?.[0]?.uri || '(none)');

  // --- send a test email via Gmail ---
  const id = await sendGmail({
    to: me,
    subject: '[Resume Scorer] Gmail send test',
    body: `If you can read this, Gmail send works end-to-end.\n\nMeet link from this run: ${event.hangoutLink || ''}`
  });
  console.log('Gmail send OK — messageId:', id);
})().catch((err) => {
  console.error('FAILED:', err.message);
  if (err.body) console.error('Body:', JSON.stringify(err.body, null, 2));
  process.exitCode = 1;
});
