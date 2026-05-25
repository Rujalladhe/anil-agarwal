// Cheap, AI-free "is this a resume?" classifier.
//
// We extract text from the attachment (PDF / DOCX) then score it on three
// axes:
//   - presence of common resume section headers (experience, education, ...)
//   - presence of contact signals (email, phone, LinkedIn, GitHub)
//   - presence of resume keywords (the word "resume" / "curriculum vitae")
//
// A document is treated as a resume if it has at least 2 distinct section
// headers AND at least one contact or keyword signal. This rejects invoices,
// tickets, brochures, contracts, etc. while still catching resumes named
// "JohnDoe.pdf" or "MyApplication.pdf".

const SECTION_HEADERS = [
  'experience',
  'work experience',
  'professional experience',
  'employment',
  'employment history',
  'work history',
  'education',
  'academic',
  'qualifications',
  'skills',
  'technical skills',
  'projects',
  'certifications',
  'achievements',
  'awards',
  'summary',
  'objective',
  'profile',
  'career objective',
  'professional summary'
];

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
// Loose phone — at least 8 digits in a row, possibly with separators / +country.
const PHONE_RE = /(?:\+?\d[\s-]?){8,}/;
const LINKEDIN_RE = /linkedin\.com\/(in|pub)\//i;
const GITHUB_RE = /github\.com\/[\w-]+/i;
// Date range like "2018 - 2021", "2020-Present", "Jan 2020 — Dec 2022".
const DATE_RANGE_RE = /\b(19|20)\d{2}\s*[-–—to]+\s*((19|20)\d{2}|present|current|now)\b/i;

function matchSectionHeader(text, header) {
  // Treat as a section header only if it appears at the start of a line
  // (possibly indented), optionally followed by ":" — this avoids matching
  // the word "skills" buried inside a sentence.
  const escaped = header.replace(/\s+/g, '\\s+');
  const re = new RegExp(`(^|\\r|\\n)\\s*${escaped}\\s*:?\\s*(\\r|\\n|$)`, 'i');
  return re.test(text);
}

export function classifyAsResume(text) {
  if (!text || text.trim().length < 50) {
    return { isResume: false, confidence: 0, signals: [], reason: 'Too little text extracted.' };
  }

  const lower = text.toLowerCase();
  const signals = [];

  // --- Contact signals (any one of these is a strong hint) -----------------
  if (EMAIL_RE.test(text))    signals.push('email');
  if (PHONE_RE.test(text))    signals.push('phone');
  if (LINKEDIN_RE.test(text)) signals.push('linkedin');
  if (GITHUB_RE.test(text))   signals.push('github');

  // --- Section headers (count distinct ones) -------------------------------
  const matchedHeaders = new Set();
  for (const h of SECTION_HEADERS) {
    if (matchSectionHeader(text, h)) {
      // Group near-synonyms so "experience" and "work experience" don't
      // double-count.
      if (h.includes('experience') || h.includes('employment') || h.includes('work history')) {
        matchedHeaders.add('experience');
      } else if (h.includes('education') || h.includes('academic') || h.includes('qualifications')) {
        matchedHeaders.add('education');
      } else if (h.includes('skills')) {
        matchedHeaders.add('skills');
      } else if (h.includes('summary') || h.includes('objective') || h.includes('profile')) {
        matchedHeaders.add('summary');
      } else {
        matchedHeaders.add(h);
      }
    }
  }
  matchedHeaders.forEach((h) => signals.push(`header:${h}`));

  // --- Date ranges (work/education timelines) ------------------------------
  if (DATE_RANGE_RE.test(text)) signals.push('date-range');

  // --- Explicit keywords ---------------------------------------------------
  if (lower.includes('resume') || lower.includes('curriculum vitae')) {
    signals.push('keyword:resume');
  }

  // --- Decision ------------------------------------------------------------
  const headerCount = matchedHeaders.size;
  const hasContact = ['email', 'phone', 'linkedin', 'github'].some((s) => signals.includes(s));
  const hasKeyword = signals.includes('keyword:resume');
  const hasDateRange = signals.includes('date-range');

  // Primary rule: 2+ resume sections AND a contact-or-keyword hint.
  // Secondary rule: 3+ sections is enough on its own (some resumes lack
  // explicit contact info on page 1).
  // Tertiary rule: explicit "resume" keyword + at least 1 section + a date
  // range is enough (covers minimal one-pagers).
  let isResume = false;
  let reason = '';
  if (headerCount >= 2 && (hasContact || hasKeyword)) {
    isResume = true;
    reason = `${headerCount} resume sections + ${hasContact ? 'contact info' : 'keyword'}`;
  } else if (headerCount >= 3) {
    isResume = true;
    reason = `${headerCount} resume sections`;
  } else if (hasKeyword && headerCount >= 1 && hasDateRange) {
    isResume = true;
    reason = `keyword + section + date range`;
  } else {
    reason = `only ${headerCount} resume sections; contact=${hasContact}; keyword=${hasKeyword}`;
  }

  // Confidence: just a rough 0..1 score for UI display.
  const confidence = Math.min(
    1,
    headerCount * 0.22 + (hasContact ? 0.25 : 0) + (hasKeyword ? 0.15 : 0) + (hasDateRange ? 0.1 : 0)
  );

  return { isResume, confidence: Number(confidence.toFixed(2)), signals, reason };
}
