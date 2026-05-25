// Text extraction for resume attachments.
// PDFs are parsed with pdf-parse; DOCX files with mammoth.
// We pick the parser from the filename extension first, then fall back to
// the contentType the extension forwarded from Microsoft Graph.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// pdf-parse ships as CJS and runs an example file on `import` of its index;
// requiring the inner lib avoids that side effect.
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
import mammoth from 'mammoth';

function pickKind(filename, contentType) {
  const name = (filename || '').toLowerCase();
  if (name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.docx')) return 'docx';
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('pdf')) return 'pdf';
  if (ct.includes('officedocument.wordprocessingml')) return 'docx';
  return null;
}

export async function extractText({ filename, contentType, buffer }) {
  const kind = pickKind(filename, contentType);
  if (!kind) {
    throw new Error(`Unsupported file type for "${filename}" (${contentType}). Only .pdf and .docx are supported.`);
  }

  if (kind === 'pdf') {
    const result = await pdfParse(buffer);
    return (result.text || '').trim();
  }

  // docx
  const result = await mammoth.extractRawText({ buffer });
  return (result.value || '').trim();
}
