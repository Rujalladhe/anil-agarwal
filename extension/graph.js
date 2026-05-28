// Thin Microsoft Graph wrapper. All calls go through getValidToken() so the
// access token is refreshed automatically when it expires.

import { getValidToken } from './auth.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

async function graphGet(path, { maxRetries = 4 } = {}) {
  // Graph throttles aggressively (per-mailbox concurrency cap is 4) and
  // responds 429 with a Retry-After header. Honour it with exponential
  // fallback for safety.
  let attempt = 0;
  while (true) {
    const token = await getValidToken();
    const res = await fetch(`${GRAPH}${path}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) return res.json();

    const retryable = res.status === 429 || res.status === 503;
    if (!retryable || attempt >= maxRetries) {
      const txt = await res.text();
      throw new Error(`Graph GET ${path} -> ${res.status}: ${txt}`);
    }
    const headerWait = Number(res.headers.get('Retry-After')) * 1000;
    const backoff = Math.min(15000, 500 * 2 ** attempt);
    const wait = Number.isFinite(headerWait) && headerWait > 0 ? headerWait : backoff;
    await new Promise((r) => setTimeout(r, wait));
    attempt++;
  }
}

function isPdfOrDocx(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return lower.endsWith('.pdf') || lower.endsWith('.docx');
}

// Filename-based "is this a resume?" hint. If true, we can show the item
// immediately and skip the (expensive) content-based classification.
// If false, popup.js will fetch the file and ask the backend to classify.
export function isResumeByFilename(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (lower.includes('resume')) return true;
  if (lower.includes('curriculum')) return true;
  // "cv" only as a whole word, so "cvs.pdf" or "discover.pdf" don't match.
  if (/(^|[^a-z0-9])cv([^a-z0-9]|$)/i.test(lower)) return true;
  return false;
}

// Lists recent messages that have attachments, then for each one pulls the
// attachment list and keeps only PDF/DOCX. Returns a flat array suitable for
// rendering in the popup.
//
// Shape returned per item:
//   {
//     messageId, subject, from, receivedDateTime,
//     attachmentId, filename, contentType, size
//   }
export async function listResumeEmails({ topMessages = 75 } = {}) {
  // We deliberately do NOT use `$filter=hasAttachments eq true`. Some senders
  // (auto-forwarders, recruiter platforms) attach files with MIME headers
  // that cause Microsoft to leave `hasAttachments` unset, so the filter hides
  // messages whose PDFs are clearly visible in Outlook. Scanning more messages
  // and asking each one for its attachment list is the reliable path.
  const list = await graphGet(
    `/me/messages?$top=${topMessages}` +
    `&$select=id,subject,from,receivedDateTime,hasAttachments`
  );

  const messages = list.value || [];
  const out = [];

  // Pull attachments in parallel. Microsoft's per-mailbox concurrency cap is
  // 4 simultaneous requests, so we stay at 3 to leave headroom for retries.
  const concurrency = 3;
  let cursor = 0;
  async function worker() {
    while (cursor < messages.length) {
      const m = messages[cursor++];
      try {
        const atts = await graphGet(
          `/me/messages/${m.id}/attachments?$select=id,name,contentType,size,isInline`
        );
        for (const a of atts.value || []) {
          if (!isPdfOrDocx(a.name)) continue;
          // Inline attachments are usually signatures / embedded logos, but
          // some forwarders flag genuine resume PDFs as inline. Keep them if
          // the filename clearly looks like a resume; otherwise skip.
          if (a.isInline && !isResumeByFilename(a.name)) continue;
          out.push({
            source: 'outlook',
            messageId: m.id,
            subject: m.subject || '(no subject)',
            from: m.from?.emailAddress?.address || '(unknown sender)',
            fromName: m.from?.emailAddress?.name || '',
            receivedDateTime: m.receivedDateTime,
            attachmentId: a.id,
            filename: a.name,
            contentType: a.contentType,
            size: a.size,
            // Fast hint: filename strongly suggests a resume.
            // If false, the popup will run a content-based classify call.
            isResumeByFilename: isResumeByFilename(a.name)
          });
        }
      } catch (err) {
        // One bad message shouldn't kill the whole listing.
        console.warn(`[graph] failed to list attachments for ${m.id}:`, err);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  // Newest first.
  out.sort((a, b) => (b.receivedDateTime || '').localeCompare(a.receivedDateTime || ''));
  return out;
}

// Downloads a single attachment. Microsoft Graph returns base64 already in
// `contentBytes`, so we pass it straight through to the backend.
export async function downloadAttachment(messageId, attachmentId) {
  const att = await graphGet(`/me/messages/${messageId}/attachments/${attachmentId}`);
  return {
    filename: att.name,
    contentType: att.contentType,
    contentBase64: att.contentBytes
  };
}
