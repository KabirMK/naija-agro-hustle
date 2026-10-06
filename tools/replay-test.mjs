// Re-plays exported runs with the real game rules, exactly like the server does.
//   node tools/replay-test.mjs run.json [more.json ...]
// Each file is either a raw run (S.rec) or { run, expect: { worth, day } }.
// In the browser console, export the current run with:
//   copy(JSON.stringify({ run: S.rec, expect: { worth: Math.round(netWorth()), day: S.day } }))
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createEngine, extractGameScript } from '../supabase/functions/verify-run/headless.js';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const src = extractGameScript(html);
const files = process.argv.slice(2);
if (!files.length) {
  const e = createEngine(src), date = e.todayWAT(), d = e.dailySetup(date);
  const r = e.replayRun({ v: e.RULES_VERSION, h: { seed: d.seed, sector: d.sector, profile: d.profile, name: 'Smoke', mode: 'daily', date }, c: [] });
  console.log('smoke test (empty daily run):', r);
  process.exit(r.ok ? 0 : 1);
}
let fail = 0;
for (const f of files) {
  const j = JSON.parse(readFileSync(f, 'utf8')), run = j.run || j, exp = j.expect;
  const t0 = performance.now(), r = createEngine(src).replayRun(run), ms = Math.round(performance.now() - t0);
  const match = !exp || (r.ok && r.worth === exp.worth && r.day === exp.day && (exp.peak == null || r.peak === exp.peak));
  if (!match) fail++;
  console.log(`${match ? 'PASS' : 'FAIL'} ${f} (${run.c ? run.c.length : '?'} cmds, ${ms} ms)`, r.ok ? { worth: r.worth, day: r.day, final: r.final, over: r.over, won: r.won } : r.error, exp ? { expect: exp } : '');
}
process.exit(fail ? 1 : 0);
