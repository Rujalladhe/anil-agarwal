// One-shot maintenance script: re-score every existing resume with the
// enriched (L2) schema so the new structured fields (workLocations,
// remoteExperience, companies, domains, managedPeople, etc.) get populated
// for resumes that were scored under the old schema.
//
// Run this AFTER pulling the L2 changes, ONCE.
//   node rescore.js                       -- re-score all
//   node rescore.js --only=12,17          -- re-score specific ids
//   node rescore.js --throttle=10000      -- wait 10s between calls (default 8s)
//   node rescore.js --skip-reindex        -- only update fields, don't re-chunk
//
// Rate limiting: Groq free tier is 12k TPM. Each resume burns ~2-3k tokens,
// so 4-5 resumes/min is the ceiling. The default 8s throttle keeps us under.
// callGroq() in ai.js also retries on 429 with the suggested delay, so even
// if we burst slightly we recover automatically.

import 'dotenv/config';
import { getDb, remirrorResume } from './db.js';
import { scoreResume } from './ai.js';
import { indexResume } from './rag.js';

function parseOnlyArg() {
  const arg = process.argv.find((a) => a.startsWith('--only='));
  if (!arg) return null;
  return arg
    .slice('--only='.length)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Number.isFinite);
}

function parseFlagInt(name, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const v = Number(arg.split('=')[1]);
  return Number.isFinite(v) ? v : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function nullable(v) { return v === undefined || v === '' ? null : v; }
function jsonOrNull(v) { return Array.isArray(v) ? JSON.stringify(v) : null; }
function boolToInt(v) { return v === true ? 1 : v === false ? 0 : null; }
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

async function main() {
  const db = getDb();
  const onlyIds = parseOnlyArg();
  const throttleMs = parseFlagInt('throttle', 8000);
  const skipReindex = hasFlag('skip-reindex');
  console.log(`[rescore] throttle=${throttleMs}ms skip-reindex=${skipReindex}`);

  let rows;
  if (onlyIds && onlyIds.length) {
    const ph = onlyIds.map(() => '?').join(',');
    rows = db.prepare(`SELECT id, candidate_name, filename, raw_text FROM resumes WHERE id IN (${ph}) ORDER BY id`).all(...onlyIds);
  } else {
    rows = db.prepare('SELECT id, candidate_name, filename, raw_text FROM resumes ORDER BY id').all();
  }

  console.log(`[rescore] processing ${rows.length} resumes...`);

  // Direct UPDATE -- insertResume's existing-row path requires email/attachment
  // ids which not every row has. Keeping this inline so the script is
  // self-contained and obviously matches the new schema columns.
  const update = db.prepare(`
    UPDATE resumes SET
      score             = ?,
      category          = ?,
      role_title        = ?,
      review_json       = ?,
      candidate_name    = COALESCE(?, candidate_name),
      email             = COALESCE(?, email),
      phone             = COALESCE(?, phone),
      location          = COALESCE(?, location),
      linkedin          = COALESCE(?, linkedin),
      github            = COALESCE(?, github),
      portfolio         = COALESCE(?, portfolio),
      current_title     = COALESCE(?, current_title),
      current_company   = COALESCE(?, current_company),
      years_experience  = COALESCE(?, years_experience),
      highest_education = COALESCE(?, highest_education),
      top_skills        = COALESCE(?, top_skills),
      languages         = COALESCE(?, languages),
      notice_period     = COALESCE(?, notice_period),
      expected_salary   = COALESCE(?, expected_salary),
      work_locations    = ?,
      companies         = ?,
      domains           = ?,
      remote_worked     = ?,
      remote_years      = ?,
      remote_evidence   = ?,
      managed_people    = ?,
      team_size_managed = ?,
      open_to_relocate  = ?,
      education_json    = ?,
      certifications    = ?,
      publications      = ?
    WHERE id = ?
  `);

  let ok = 0, fail = 0;
  for (const r of rows) {
    const t0 = Date.now();
    try {
      const scored = await scoreResume(r.raw_text);
      const c = scored.candidate || {};
      const rem = c.remoteExperience || {};

      update.run(
        Number.isFinite(scored.score) ? scored.score : null,
        scored.category || null,
        scored.roleTitle || null,
        JSON.stringify(scored),
        nullable(c.name),
        nullable(c.email), nullable(c.phone), nullable(c.location),
        nullable(c.linkedin), nullable(c.github), nullable(c.portfolio),
        nullable(c.currentTitle), nullable(c.currentCompany),
        Number.isFinite(c.yearsExperience) ? c.yearsExperience : null,
        nullable(c.highestEducation),
        jsonOrNull(c.topSkills), jsonOrNull(c.languages),
        nullable(c.noticePeriod), nullable(c.expectedSalary),
        jsonOrNull(c.workLocations),
        jsonOrNull(c.companies),
        jsonOrNull(c.domains),
        boolToInt(rem.worked),
        numOrNull(rem.years),
        nullable(rem.evidence),
        boolToInt(c.managedPeople),
        numOrNull(c.teamSizeManaged),
        boolToInt(c.openToRelocate),
        jsonOrNull(c.education),
        jsonOrNull(c.certifications),
        boolToInt(c.publications),
        r.id
      );

      // Push the refreshed row into Mongo too. Dual-write happens automatically
      // for insertResume, but this script uses a direct UPDATE so we mirror
      // explicitly. No-op when MONGODB_URI is unset.
      remirrorResume(r.id);

      // Re-index chunks too unless skipped. raw_text didn't change, so this
      // is mostly to ensure FTS5 is populated for resumes scored before FTS
      // was added. Skip with --skip-reindex if you've already done it once.
      if (!skipReindex) {
        try {
          await indexResume(r.id, r.raw_text);
        } catch (err) {
          console.warn(`  #${r.id} reindex chunks failed: ${err.message}`);
        }
      }

      const label = r.candidate_name || r.filename;
      console.log(`  ok #${r.id} ${label} -> score ${scored.score} cat ${scored.category} remote=${rem.worked === true} (${Date.now() - t0}ms)`);
      ok++;
    } catch (err) {
      console.error(`  fail #${r.id} ${r.filename}: ${err.message}`);
      fail++;
    }

    // Throttle between calls to stay under Groq's TPM budget. Skip the
    // final sleep since the loop is about to exit.
    if (throttleMs > 0 && rows.indexOf(r) < rows.length - 1) {
      await sleep(throttleMs);
    }
  }

  console.log(`[rescore] done. ok=${ok} fail=${fail} total=${rows.length}`);
}

main().catch((err) => {
  console.error('[rescore] fatal:', err);
  process.exit(1);
});
