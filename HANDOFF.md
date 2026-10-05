# Vidu Kadhu — Project Handoff

Real-time multiplayer social-deduction party game (Telugu, "It's not him"). Everyone in a room gets a secret **word** except the **imposter(s)**, who instead see only the clues the host enabled. Players discuss, vote, and try to catch the imposter.

- **Live:** https://prudhvish11.github.io/vidu_kadu/
- **Repo:** `prudhvish11/vidu_kadu` — every push to `main` auto-deploys (GitHub Actions → Pages).
- **Backend:** Supabase project `odmxlbfmovmhtsygtgov` (Postgres + Realtime). Currently **15 categories / 750 words**.

---

## 1. Tech stack
- **Next.js 16** (App Router) · **React 19** · **TypeScript**
- **Tailwind v4** — only `@import "tailwindcss"`; actual styling is CSS variables + inline styles in `app/globals.css`.
- **Supabase** — Postgres, Realtime (live sync + presence). All data access is client-side via the anon key; there are **no API routes**.
- **Static export** (`output: "export"`) hosted on **GitHub Pages**.

> ⚠️ `AGENTS.md`: this Next.js version has breaking changes vs. older docs — read `node_modules/next/dist/docs/` before writing Next-specific code.

## 2. Run / build
```bash
npm install
npm run dev          # http://localhost:3000
npm run build        # static export -> ./out   (serve with: cd out && python3 -m http.server 4173)
npx tsc --noEmit     # type-check
```
`.env.local` (gitignored) must contain:
```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```
The anon key is public by design (RLS-protected) and is baked into the client bundle — that's expected.

## 3. Deployment (already live)
`.github/workflows/deploy.yml` runs on every push to `main`: `npm ci` → `npm run build` → upload `out/` → deploy to Pages. It **auto-enables Pages** (`configure-pages` `enablement: true`), auto-derives `basePath` (project site → `/<repo>`; user/custom-domain → empty), and adds `.nojekyll`.

Configured on the repo (only re-do for a fresh fork): Actions **secrets** `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`; Settings → Pages → Source: **GitHub Actions**. Note: Next does **not** basePath-prefix `metadata` icon/manifest URLs, so `app/layout.tsx` prefixes them manually from `NEXT_PUBLIC_BASE_PATH`.

## 4. Routes & files
Room code lives in the **query string** (not a path segment) so every route is a static SPA shell — required for Pages. Pages read the code via `useSearchParams()` and are wrapped in `<Suspense>`.
- `app/page.tsx` — home (create / join). `?join=CODE` pre-fills join.
- `app/room/page.tsx` — **lobby** (`/room?code=XXXX`): host settings modal, player list, start game.
- `app/room/game/page.tsx` — **game** (`/room/game?code=XXXX`): every phase is an early-return; helper components (`RevealCard`, `OwnRevealScreen`, `PassRevealScreen`, `PassVoteScreen`, `WaitingScreen`, `LeaveButton`) live at the bottom.
- `app/globals.css` — design system: Mango-Fizz palette, Liquid Glass classes, animations (incl. floating-reaction keyframe), `prefers-reduced-motion` guard.
- `app/layout.tsx` — metadata, manifest + favicon (basePath-prefixed), theme color.
- `lib/supabase.ts` — client · `lib/presence.ts` — `useRoomPresence(roomId, myId, players, allowRemoval)` + `removePlayerFromRoom` · `lib/avatar.ts` — deterministic avatar color · `lib/sound.ts` — Web-Audio SFX + haptics + mute · `lib/id.ts` — secure-context-safe UUID.
- `components/` — `Logo.tsx` (peeking-eyes SVG, animated pupils), `SoundToggle.tsx`, `Confetti.tsx`, `QRCode.tsx` (join-link QR), `HowToPlay.tsx` (rules modal), `InstallHint.tsx` (add-to-home-screen nudge), `Reactions.tsx` (emoji reactions over a Realtime broadcast channel).
- `public/` — `manifest.json`, `icon.svg` (peeking-eyes favicon/PWA icon).
- `supabase/rls.sql` — Row Level Security policy script (run in the SQL Editor; see §9).
- **Both pages** also run a *catch-up sync* (re-fetch on `visibilitychange`/`focus`/`pageshow` + a 4s poll while visible), because iOS Safari suspends the Realtime socket when a phone locks — see §11.

## 5. Game flow
Home → Lobby → **Word reveal** (own-phone or pass-device; **hold-to-reveal** with a filling ring) → **Discussion** (optional timer, host ends it; shows a random **speaking order**) → **Voting** (secret; self excluded; **tie → runoff**) → **Reveal** (one auto screen: result + vote tally with who-voted-for-whom + **awards** + scoreboard; confetti on crew win) → **Play again** (same room/players, new round).

- **Reveal is one auto-shown screen** — once voting completes it shows the result (crew vs. imposter), the vote tally (bars + who voted for whom), end-of-round **awards** (🥇 Most wins / 🎯 Most caught, derived from cumulative stats), and the scoreboard. No "reveal imposter / see scoreboard" click-through; only the host's **Play Again**.
- **Tie-breaker runoff**: if the top vote ties, a single runoff runs between the tied players (others marked out of contention via `is_eliminated`, votes cleared, re-vote). A second tie falls through to reveal, where ties favor the imposter. See `advanceToReveal()` + `awaitingRunoffClearRef` in `app/room/game/page.tsx`.
- **Reactions**: during discussion/voting/reveal, tapping an emoji floats it up on every connected device via a Supabase Realtime **broadcast** channel (`components/Reactions.tsx`) — ephemeral, no DB rows.

- **Speaking order** (discussion screen): a random turn order — "X starts · Y ends" plus the numbered sequence. It's derived on-device from a hash of the shared per-round state (`word` + the imposter ids), so every device shows the **same** order with no stored column, and it changes each round because both the word and imposter assignment are re-randomized. Anyone can be first, including the imposter. See `startingOrder()` in `app/room/game/page.tsx`.

- Crew sees the word; the imposter sees only the enabled clues.
- **The word is always drawn at random in `startGame`** — the host plays too and can be the imposter, so they never pick or see the word. Resolved fresh each round (Play Again re-randomizes).
- Result logic: the most-voted player is "caught"; ties favor the imposter.
- **Waiting screens name who's pending**: the word-reveal wait shows "Still looking: <names>" and the voting wait shows "Yet to vote: <names>" (avatar chips), so the group sees who's holding up the round.

## 6. Host settings (lobby → ⚙️ Game Settings)
- **Categories** — multi-select chips for all categories. The word is drawn from the **union** of the selected ones. `[]` (all chips on) = draw from everything; "Select all" resets to that. Stored in `rooms.category_ids` (jsonb). There is **no word picker**.
- **Hints — what the imposter sees** (four independent toggles):
  | Toggle | Column (default) | Source |
  |---|---|---|
  | Hint about the word | `hints_enabled` (true) | `words.hint` |
  | Category | `show_category` (false) | the word's category name |
  | Word length | `show_word_length` (false) | derived from `word` (spaces ignored) |
  | First letter | `show_first_letter` (false) | derived from `word` |
  With all off, the imposter card says "No clues — blend in and don't get caught."
- **Number of imposters** (1–3) · **Reveal mode** (own phone / pass device) · **Discussion timer** (off / 60–300s).
- **Imposters know each other** (`imposters_know`, shown at 2+ imposters): each imposter's reveal card lists their teammates.
- **Pass-device mode** is a true single-phone flow: the host can **add players** (deviceless rows) from the lobby, reveal passes the phone per player, and **voting** passes too (`PassVoteScreen` records each player's ballot in turn). Lobby auto-reaping is disabled in pass mode (nobody is "online"); the host manages the roster with the ✕ kick button.
- The **Save** button is a sticky footer (always visible above the scrolling list).

The imposter's Category clue is derived from the chosen word's own category (`words.category_id` → `categories.name`), so it's correct even when the category pool was random.

## 7. Players leaving / disconnects
- **Leave** deletes the player row + their votes (lobby and game).
- **Host handoff**: when the host leaves, the earliest-joined remaining player is promoted (`rooms.host_id` + the `is_host` flag); an empty room is deleted.
- **Disconnect detection** (`lib/presence.ts`): Supabase Realtime presence. A single "leader" (host if online, else lowest online id) removes players absent past `GRACE_MS` (60s) — **but only in the lobby**. `useRoomPresence(..., allowRemoval)` is called with `allowRemoval=false` on the game page, so **nobody is auto-removed once the game starts**. This is essential: a locked phone drops its Realtime socket (iOS suspends it), and in **pass-device mode** everyone but the phone-holder is offline the whole round — auto-removal would wipe players mid-game. In-game, players only leave via the **Leave** button.
- **Host "continue" overrides**: because absent players aren't auto-removed, a genuinely away player could stall a round, so the host gets manual controls on the waiting screens — **"Continue without them →"** (word reveal: marks remaining players looked, moves to discussion) and **"Reveal results now →"** (voting: tallies and reveals without the missing votes). See `skipRemainingReveals()` / `advanceToReveal()` in `app/room/game/page.tsx`.

## 8. UI & conveniences
Mango-Fizz light palette, drifting **aurora** backdrop, **Apple Liquid Glass** cards/buttons (refraction, specular edge, squircle corners, hover sheen), ticket-style room code, colored avatars + online dots, animated vote bars, dramatic flip reveal, confetti on crew win, **sound + haptics** with a persisted mute toggle (🔊 top-right), and the **peeking-eyes logo** (favicon + PWA icon). Fully responsive (`100dvh`, safe-area insets, `clamp()` type, centered column that scales up on tablets/laptops/large screens).

Also: **QR code** in the lobby (scan to join, `components/QRCode.tsx`), **How to Play** rules modal (home + lobby, `components/HowToPlay.tsx`), **Add to Home Screen** hint on home (`components/InstallHint.tsx`; native prompt on Android, Share tip on iOS), **Rejoin room** button on home (remembers `vk_last_room` in localStorage, cleared on Leave), host **kick** (✕ on a roster row), and **emoji reactions** in-game.

---

## 9. Supabase schema (current)
- **`rooms`**: `id, code, host_id, status ('lobby'|'playing'|'voting'|'reveal'), word, category_id (legacy single, may be null), category_ids (jsonb — selected category pool; [] = all), imposter_count, reveal_mode ('own'|'pass'), timer_enabled, timer_seconds, hints_enabled, show_category, show_word_length, show_first_letter, imposters_know, created_at`
  - `imposters_know` (boolean, default false, **migrated & live**) — with 2+ imposters, show each imposter their teammates on the reveal card. The app writes it via a decoupled best-effort update, so it degrades gracefully if ever missing. Migration that added it: `alter table rooms add column if not exists imposters_know boolean not null default false;`
- **`players`**: `id, room_id, name, is_host, is_imposter, is_eliminated, has_revealed, wins, losses, times_caught, joined_at`
  - `is_eliminated` — currently only used to mark who is **out of contention during a tie-breaker runoff** (reset on Play Again). There is no other elimination mechanic.
- **`votes`**: `id, room_id, voter_id, target_id`
- **`categories`**: `id, name`
- **`words`**: `id, category_id (fk → categories.id), word, hint, created_at`

Realtime is enabled for `rooms`, `players`, `votes`.

**Row Level Security:** see `supabase/rls.sql` — turns RLS on everywhere (content tables read-only to the public anon key; game tables fully usable by the client). The app has no auth, so it can't stop cross-room tampering (needs auth/RPC), but it protects the word lists and clears the "RLS disabled" warning. ⏳ **Not yet applied** — run it in the SQL Editor and smoke-test a game before sharing widely.

---

## 10. Database & adding data
The full database reference — every table and column, Realtime, RLS, migrations, and copy-paste SQL for **adding categories & words** (the common task) — lives in its own doc: **[`DATABASE.md`](DATABASE.md)**. It's written to be self-contained so you (or an LLM) can add data without reading the rest of this file.

---

## 11. Gotchas (these bit us — don't repeat)
- **supabase-js query builders are lazy** — `supabase.from().update().eq()` only runs when `await`ed / `.then()`-ed. Never fire-and-forget in effects.
- **`crypto.randomUUID()` needs a secure context** (HTTPS/localhost) — throws over plain-HTTP LAN. Use `lib/id.ts`. `navigator.clipboard` is likewise gated (has a fallback).
- **Static export**: no dynamic route segments without `generateStaticParams`; no server-only features (route handlers reading Request, cookies, redirects, server actions). `useSearchParams` needs `<Suspense>`.
- **basePath + metadata**: Next doesn't prefix `metadata.icons`/`manifest` — `app/layout.tsx` does it manually.
- **iOS Safari suspends the Realtime socket** when a phone locks/backgrounds, so pushes alone let a device fall behind (and once wiped players mid-game). Two defenses: (1) both pages run a **catch-up sync** (re-fetch on `visibilitychange`/`focus`/`pageshow` + a 4s poll while visible); (2) presence **auto-removal is lobby-only** (`allowRemoval=false` in-game) so nobody is dropped for locking their phone or playing pass-device. Don't re-enable in-game removal.
- **Tie-breaker race**: when a runoff starts, the `is_eliminated` realtime update can arrive before the cleared votes, briefly making "all voted" look true and advancing early. Gated with `awaitingRunoffClearRef` — don't remove it.
- **Subscription keyed on `room.id`**, not the whole `room` object — otherwise the channel tears down/rebuilds on every phase change and misses pushes.
- **Presence reconcile** runs on Realtime `sync` events; a DB row that never connects is cleaned on the next presence event (lobby only).
- **Testing multiplayer locally**: two tabs in one browser share `localStorage` (`vk_player_id`) → same player. Use two browsers/incognito, or seed players via the Supabase REST API. In-game, REST-seeded players survive (removal is off); **in the lobby** they're reaped after `GRACE_MS` (60s) unless the room is in pass mode — so set up game-phase state, or seed + navigate quickly.

## 12. Status
Complete and **live** at https://prudhvish11.github.io/vidu_kadu/ (auto-redeploys on every push to `main`). Built & verified end-to-end:
- Core: home/lobby/full game flow, random word draw, four imposter-clue toggles, multi-select/random categories, host-handoff, waiting-screen "who's pending", one-screen auto reveal, Mango-Fizz + Liquid Glass UI (logo, sound, confetti), static export.
- Added since: random **speaking order**; **iOS catch-up sync** + **lobby-only presence removal** (phones no longer dropped on screen-off / in pass-device); host **continue** overrides; **QR join**; **How to Play**; **imposters-know-each-other** toggle; host **kick**; **add-to-home-screen** hint; **reaction emojis**; **end-of-round awards**; **rejoin** button; **tie-breaker runoff**; **full pass-device mode** (host-adds-players + pass-the-phone voting).

**Pending (requires DB admin, not code):** apply `supabase/rls.sql` in the Supabase SQL Editor (RLS is still off). The `imposters_know` column has been migrated.

See **`DATABASE.md`** for the complete database reference (schema, every column, migrations, and how to add categories/words).
