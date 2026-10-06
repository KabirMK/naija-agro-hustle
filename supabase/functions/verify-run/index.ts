// Supabase Edge Function: verify-run
// The ONLY way a score reaches the leaderboard. The browser sends its recorded inputs
// (seed + every tap/choice); this function re-plays them with the exact game rules from
// your deployed index.html and writes the score it computed itself.
//
// Deploy:  supabase functions deploy verify-run --no-verify-jwt
// Secrets: supabase secrets set SITE_URL=https://your-game.vercel.app
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.)
import { createEngine, extractGameScript } from './headless.js';

const SITE_URL = (Deno.env.get('SITE_URL') || '').replace(/\/+$/, '');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const MAX_BODY = 4 * 1024 * 1024;
const CACHE_MS = 5 * 60 * 1000;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Game code per rules version. Current rules live at /index.html; when you change the rules,
// bump RULES_VERSION in the game and keep a copy of the old file at /versions/v<old>.html.
const scripts = new Map<number, { src: string; at: number }>();
async function gameScript(v: number): Promise<string> {
  const hit = scripts.get(v);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.src;
  for (const path of [`/index.html`, `/versions/v${v}.html`]) {
    const r = await fetch(`${SITE_URL}${path}`, { headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) continue;
    const src = extractGameScript(await r.text());
    const m = src.match(/RULES_VERSION\s*=\s*(\d+)/);
    if (m && Number(m[1]) === v) { scripts.set(v, { src, at: Date.now() }); return src; }
  }
  throw new Error(`This game version (rules v${v}) is no longer accepted. Please update the game.`);
}

const watDate = (offsetDays = 0) => new Date(Date.now() + 3600000 - offsetDays * 86400000).toISOString().slice(0, 10);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rpc(fn: string, body: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`database error: ${(await r.text()).slice(0, 200)}`);
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!SITE_URL || !SUPABASE_URL || !SERVICE_KEY) return json({ error: 'Server not configured (SITE_URL secret missing).' }, 500);
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return json({ error: 'Run too large.' }, 413);
    const { device, run } = JSON.parse(raw);
    if (typeof device !== 'string' || !UUID.test(device)) return json({ error: 'Invalid device id.' }, 400);
    if (!run || typeof run !== 'object' || !Number.isInteger(run.v) || !run.h || !Array.isArray(run.c)) return json({ error: 'Invalid run.' }, 400);
    if (run.bad) return json({ error: 'This farm cannot be verified.' }, 400);
    if (!run.c.length) return json({ error: 'Play a little first!' }, 400);

    const h = run.h;
    if (h.mode === 'daily' && h.date !== watDate(0) && h.date !== watDate(1)) return json({ error: 'That Daily Challenge has closed.' }, 400);

    const t0 = performance.now();
    const engine = createEngine(await gameScript(run.v));
    const r = engine.replayRun(run);
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) {
      console.warn('rejected run', device, r.error);
      return json({ error: `Your moves could not be verified (${r.error}).` }, 422);
    }

    if (r.mode === 'daily') {
      if (!r.dailyDone || r.final == null) return json({ error: 'Finish all the Daily Challenge days first.' }, 400);
      await rpc('submit_daily_score', { p_day: r.date, p_device: device, p_name: r.name, p_sector: r.sector, p_profile: r.profile, p_net_worth: r.final, p_rules: run.v, p_cmds: r.cmds });
      return json({ ok: true, mode: 'daily', net_worth: r.final, day: r.day, ms });
    }
    const score = r.over ? r.peak : r.worth;
    await rpc('submit_verified_score', { p_device: device, p_name: r.name, p_sector: r.sector, p_profile: r.profile, p_net_worth: score, p_day: Math.max(1, Math.min(3650, r.day)), p_won: r.won, p_rules: run.v, p_cmds: r.cmds });
    return json({ ok: true, mode: 'free', net_worth: score, day: r.day, ms });
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : 'Server error' }, 500);
  }
});
