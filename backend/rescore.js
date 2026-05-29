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

import 'dotenv/config';
import { getMongoDb, closeMongo } from './mongo.js';
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

const arr  = (x) => (Array.isArray(x) ? x : []);
const num  = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : null);
const bool = (x) => x === true;

async function main() {
  const db = await getMongoDb();
  const onlyIds = parseOnlyArg();
  const throttleMs = parseFlagInt('throttle', 8000);
  const skipReindex = hasFlag('skip-reindex');
  console.log(`[rescore] throttle=${throttleMs}ms skip-reindex=${skipReindex}`);

  const filter = (onlyIds && onlyIds.length) ? { _id: { $in: onlyIds } } : {};
  const rows = await db.collection('resumes')
    .find(filter, { projection: { _id: 0, id: 1, candidate_name: 1, filename: 1, raw_text: 1 } })
    .sort({ id: 1 })
    .toArray();

  console.log(`[rescore] processing ${rows.length} resumes...`);

  let ok = 0, fail = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const t0 = Date.now();
    try {
      const scored = await scoreResume(r.raw_text);
      const c = scored.candidate || {};
      const rem = c.remoteExperience || {};

      // Always-overwrite fields (score, classification, review, L2 structured).
      const $set = {
        score: Number.isFinite(scored.score) ? scored.score : null,
        category: scored.category || null,
        role_title: scored.roleTitle || null,
        review: scored,
        work_locations: arr(c.workLocations),
        companies: arr(c.companies),
        domains: arr(c.domains),
        remote_worked: bool(rem.worked),
        remote_years: num(rem.years),
        remote_evidence: rem.evidence ? String(rem.evidence) : null,
        managed_people: bool(c.managedPeople),
        team_size_managed: num(c.teamSizeManaged),
        open_to_relocate: bool(c.openToRelocate),
        education: arr(c.education),
        certifications: arr(c.certifications),
        publications: bool(c.publications)
      };
      // COALESCE fields: only overwrite when the new value is present.
      const coalesce = {
        candidate_name: c.name, email: c.email, phone: c.phone, location: c.location,
        linkedin: c.linkedin, github: c.github, portfolio: c.portfolio,
        current_title: c.currentTitle, current_company: c.currentCompany,
        years_experience: Number.isFinite(c.yearsExperience) ? c.yearsExperience : undefined,
        highest_education: c.highestEducation,
        top_skills: Array.isArray(c.topSkills) ? c.topSkills : undefined,
        languages: Array.isArray(c.languages) ? c.languages : undefined,
        notice_period: c.noticePeriod, expected_salary: c.expectedSalary
      };
      for (const [k, v] of Object.entries(coalesce)) {
        if (v !== undefined && v !== null && v !== '') $set[k] = v;
      }

      await db.collection('resumes').updateOne({ _id: r.id }, { $set });

      // Re-index chunks unless skipped (raw_text unchanged, but ensures the
      // Mongo chunks + Pinecone vectors exist for older rows).
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

    if (throttleMs > 0 && i < rows.length - 1) {
      await sleep(throttleMs);
    }
  }

  await closeMongo();
  console.log(`[rescore] done. ok=${ok} fail=${fail} total=${rows.length}`);
}

main().catch((err) => {
  console.error('[rescore] fatal:', err);
  process.exit(1);
});
