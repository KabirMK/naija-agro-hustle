# 🌾 Naija Agro-Hustle

A Nigerian farming adventure game for mobile browsers. Walk around your farm, Agbado Village and six cities (Lagos, Ibadan, Kano, Jos, Aba, Abuja). Survive FX shocks, floods, agberos and loan sharks, and grow from hustler to Agro-Tycoon.

- **Single-file game:** everything is in `index.html`, written in vanilla JS with no libraries and no external assets.
- **Installable app (PWA):** works offline after the first visit.
- **🔊 Sound and 🎶 music:** sound effects and a highlife-style music loop, generated live with the Web Audio API (no audio files). Toggle them in ⚙️ Settings.
- **🧭 First-day tutorial quest:** five guided steps (open farm operations, tend or hire help, check the phone or store, walk to the village, end the day). Players can skip it or replay it from Settings.
- **📅 Daily Challenge:** everyone in Nigeria gets the same farm, the same luck and the same events for 10 days. The setup is fixed by the date (West Africa Time), and there's a separate "Today" leaderboard.
- **🌐 Languages:** English, Pidgin, Yorùbá, Hausa and Igbo, for the menus, HUD, tutorial and online screens. The translations were machine-assisted, so ask native speakers to review them. The dictionaries are in the `I18N` object near the end of `index.html`.
- **🛡️ Server-verified leaderboard (Supabase):** scores can't be faked by editing the browser. See [Anti-cheat](#anti-cheat-how-scores-stay-honest).

## Files

| File | Purpose |
|---|---|
| `index.html` | The whole game, plus the `NAH_CONFIG` block in `<head>` for online settings |
| `manifest.webmanifest`, `sw.js` | Installable app and offline play |
| `icon-*.png`, `apple-touch-icon.png`, `og-image.jpg` | App icons and the share preview image |
| `vercel.json` | Hosting headers (caching and security) |
| `supabase/schema.sql` | Tables and functions for leaderboards and cloud saves (run once) |
| `supabase/functions/verify-run/` | Edge Function that replays a run and writes the verified score |
| `tools/replay-test.mjs` | Local test: replays recorded runs in Node exactly as the server does |

## 1. Deploy on Vercel (from GitHub)

1. In vercel.com, go to **Add New → Project** and import this GitHub repository.
2. Framework preset: **Other**. Leave the build command empty and keep the output directory at the root.
3. Click **Deploy**. Every `git push` to `main` redeploys automatically.

If your URL is not `https://naija-agro-hustle.vercel.app`:

- replace that domain in the `og:url`, `og:image` and `twitter:image` tags in `index.html`;
- set `siteUrl` in `NAH_CONFIG`.

WhatsApp needs the full URL to show the preview picture.

## 2. Connect Supabase (leaderboards and cloud saves)

The game works fully offline without this step; the online buttons simply stay hidden.

1. Create a project at supabase.com.
2. In **SQL Editor**, paste all of `supabase/schema.sql` and click **Run**.
3. Deploy the verifier with the [Supabase CLI](https://supabase.com/docs/guides/cli):
   ```bash
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase functions deploy verify-run --no-verify-jwt
   npx supabase secrets set SITE_URL=https://<your-vercel-domain>
   ```
   - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to the function automatically. **Never** put the service-role key in `index.html`.
   - `--no-verify-jwt` is needed because players are anonymous. The function validates everything itself.
4. From **Project Settings → API**, copy the Project URL and the **anon/publishable** key into `index.html`:
   ```js
   window.NAH_CONFIG = {
     supabaseUrl: 'https://abcd1234.supabase.co',
     supabaseAnonKey: 'eyJ...or sb_publishable_...',
     siteUrl: 'https://naija-agro-hustle.vercel.app/'
   };
   ```
5. Commit and push. Vercel redeploys on its own.

## Anti-cheat: how scores stay honest

The browser never sends a score or an amount of money. Instead:

1. Each farm starts from a random **seed**, and all game luck comes from a seeded generator, so the same seed always produces the same events.
2. The game records every move the player makes: taps, choices, NPC talks, map exits.
3. "Post my score" sends only the seed and that list of moves to the `verify-run` Edge Function.
4. The function downloads the live `index.html` from your `SITE_URL`, then **replays every move** in a headless copy of the game, using the same rules and checks as real play:
   - a button must actually be on screen;
   - the player must be able to afford the purchase;
   - a choice must exist.

   This takes about 40 ms for 1,000 moves.
5. The function writes the net worth it computed itself, using the service-role key. Browsers have **no write access** to the score tables.

As a result, editing `localStorage`, changing variables in DevTools, or sending made-up numbers does nothing. Any illegal move rejects the whole run, and a tampered save can't be posted. Daily Challenge runs must use that date's fixed seed and setup, and the server only accepts today's or yesterday's date (WAT).

**Limits of this approach:**

- Reloading saves or restarting until luck is good ("save-scumming") is still possible. It is legal play, not fake numbers.
- Someone could script a bot that plays real moves. That run is legitimately earned.
- For cash prizes, still check winners (for example, ask for a screen recording of the run).

### Changing game rules after launch

Any change that affects gameplay (prices, events, balance) changes what a replay produces, so it must come with a version bump:

1. Copy the current `index.html` to `versions/v<N>.html`, where N is the current `RULES_VERSION`.
2. Bump `const RULES_VERSION` in `index.html`.
3. Push.

Runs started on the old rules keep verifying against the archived copy. Purely visual changes (CSS, wording, translations) don't need a bump.

### Testing replays locally

```bash
node tools/replay-test.mjs                # smoke test of the headless engine
node tools/replay-test.mjs my-run.json    # replay {run, expect:{worth,day,peak}} files
```

## 3. Getting people to play

- **The Daily Challenge is your hook.** Everyone plays the same farm, so "I made ₦4.2M today, beat me" on WhatsApp is a fair fight. The 📤 button shares the result with your link.
- Post the "Today" leaderboard screenshot every evening on WhatsApp Status, X and Instagram, and run a weekly airtime prize.
- **Share in Pidgin, Yorùbá, Hausa and Igbo groups.** Players can pick their language on the start screen.
- Post short TikTok or Reels clips of funny moments: agbero extortion, the Mile 12 trip, fuel scarcity.
- **Reach agric communities:** agripreneur Facebook groups, agric students (FUNAAB, ABU, UNN, LAUTECH), and Young Farmers Clubs.
- **Turn on Vercel Analytics** (free tier) to see where players come from.

## Local testing

You can open `index.html` directly. For the service worker and install prompt, serve it over http instead: run `npx serve .` and open the URL it prints. If you change icons or the manifest, bump `CACHE` in `sw.js`.
