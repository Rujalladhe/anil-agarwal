// Split resume text into retrieval-sized chunks.
//
// Resumes are small (1-3 pages, ~500-2000 words), so we target ~250 words
// per chunk with a one-paragraph overlap. We split on blank lines first
// (paragraph boundaries) which preserves resume structure -- a single bullet
// or section header rarely runs to 250 words on its own.

const TARGET_WORDS = Number(process.env.CHUNK_TARGET_WORDS) || 250;
const OVERLAP_WORDS = Number(process.env.CHUNK_OVERLAP_WORDS) || 40;

function wordCount(s) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function takeLastWords(s, n) {
  const words = s.trim().split(/\s+/).filter(Boolean);
  return words.slice(-n).join(' ');
}

export function chunkResumeText(text) {
  const cleaned = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!cleaned) return [];

  // Paragraphs = blocks separated by one or more blank lines.
  const paragraphs = cleaned.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  // Edge case: a single dense paragraph (PDF extraction sometimes joins
  // everything). Fall back to splitting on single newlines.
  const blocks = paragraphs.length <= 1
    ? cleaned.split('\n').map((l) => l.trim()).filter(Boolean)
    : paragraphs;

  const chunks = [];
  let buf = '';
  let bufWords = 0;

  for (const block of blocks) {
    const w = wordCount(block);

    // A single block bigger than the target: emit it as its own chunk
    // (resumes occasionally have one giant "Experience" block).
    if (w >= TARGET_WORDS) {
      if (buf) { chunks.push(buf.trim()); buf = ''; bufWords = 0; }
      chunks.push(block);
      continue;
    }

    if (bufWords + w > TARGET_WORDS && buf) {
      chunks.push(buf.trim());
      const carry = takeLastWords(buf, OVERLAP_WORDS);
      buf = carry ? carry + '\n\n' + block : block;
      bufWords = wordCount(buf);
    } else {
      buf = buf ? buf + '\n\n' + block : block;
      bufWords += w;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());

  // Defensive: ensure no chunk is absurdly long for an embedding API.
  // Most providers cap around 8k tokens; 4000 words is safely under.
  return chunks.flatMap(hardSplit);
}

function hardSplit(chunk) {
  const MAX_WORDS = 4000;
  const words = chunk.split(/\s+/);
  if (words.length <= MAX_WORDS) return [chunk];
  const out = [];
  for (let i = 0; i < words.length; i += MAX_WORDS) {
    out.push(words.slice(i, i + MAX_WORDS).join(' '));
  }
  return out;
}
