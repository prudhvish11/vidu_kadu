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
- `app/room/game/page.tsx` — **game** (`/room/game?code=XXXX`): every phase is an early-return; helper components (`RevealCard`, `OwnRevealScreen`, `PassRevealScreen`, `WaitingScreen`, `LeaveButton`) live at the bottom.
- `app/globals.css` — design system: Mango-Fizz palette, Liquid Glass classes, animations, `prefers-reduced-motion` guard.
- `app/layout.tsx` — metadata, manifest + favicon (basePath-prefixed), theme color.
- `lib/supabase.ts` — client · `lib/presence.ts` — `useRoomPresence` + `removePlayerFromRoom` · `lib/avatar.ts` — deterministic avatar color · `lib/sound.ts` — Web-Audio SFX + haptics + mute · `lib/id.ts` — secure-context-safe UUID.
- `components/` — `Logo.tsx` (peeking-eyes SVG, animated pupils), `SoundToggle.tsx`, `Confetti.tsx`.
- `public/` — `manifest.json`, `icon.svg` (peeking-eyes favicon/PWA icon).

## 5. Game flow
Home → Lobby → **Word reveal** (own-phone or pass-device; **hold-to-reveal** with a filling ring) → **Discussion** (optional timer, host ends it; shows a random **speaking order**) → **Voting** (secret; self excluded) → **Vote reveal** (bar chart + who-voted-for-whom) → **Result** (crew vs. imposter; confetti on crew win) → **Scoreboard** (W/L/caught, medals) → **Play again** (same room/players, new round).

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
- The **Save** button is a sticky footer (always visible above the scrolling list).

The imposter's Category clue is derived from the chosen word's own category (`words.category_id` → `categories.name`), so it's correct even when the category pool was random.

## 7. Players leaving / disconnects
- **Leave** deletes the player row + their votes (lobby and game).
- **Host handoff**: when the host leaves, the earliest-joined remaining player is promoted (`rooms.host_id` + the `is_host` flag); an empty room is deleted.
- **Disconnect detection** (`lib/presence.ts`): Supabase Realtime presence. A single "leader" (host if online, else lowest online id) removes players absent past an 8s grace (`GRACE_MS`), so a disconnected host is cleaned up and replaced by another client.

## 8. UI
Mango-Fizz light palette, drifting **aurora** backdrop, **Apple Liquid Glass** cards/buttons (refraction, specular edge, squircle corners, hover sheen), ticket-style room code, colored avatars + online dots, animated vote bars, dramatic flip reveal, confetti on crew win, **sound + haptics** with a persisted mute toggle (🔊 top-right), and the **peeking-eyes logo** (favicon + PWA icon). Fully responsive (`100dvh`, safe-area insets, `clamp()` type, centered column that scales up on tablets/laptops/large screens).

---

## 9. Supabase schema (current)
- **`rooms`**: `id, code, host_id, status ('lobby'|'playing'|'voting'|'reveal'), word, category_id (legacy single, may be null), category_ids (jsonb — selected category pool; [] = all), imposter_count, reveal_mode ('own'|'pass'), timer_enabled, timer_seconds, hints_enabled, show_category, show_word_length, show_first_letter, created_at`
- **`players`**: `id, room_id, name, is_host, is_imposter, is_eliminated, has_revealed, wins, losses, times_caught, joined_at`
- **`votes`**: `id, room_id, voter_id, target_id`
- **`categories`**: `id, name`
- **`words`**: `id, category_id (fk → categories.id), word, hint, created_at`

Realtime is enabled for `rooms`, `players`, `votes`.

---

## 10. How to add categories & words (data)

Do this in the **Supabase dashboard → SQL Editor** (runs as service role, bypasses RLS). New categories appear in the host's multi-select automatically (the lobby loads the `categories` table on open). New words are eligible immediately.

### What each field means
- `categories.name` — the label shown on the chip **and** as the imposter's "Category" clue. Keep it short and human ("Cartoons", "Telugu Movies").
- `words.word` — what the **crew sees**. Keep it recognizable; length + first letter are derived from it (spaces are ignored for the letter count).
- `words.hint` — the **single clue the imposter sees** when "Hint about the word" is on. ⚠️ It must **not contain the word** (that gives it away). Aim for an oblique nudge, e.g. word `Baahubali` → hint `Kingdom & waterfall`.

### Add one category + its words
```sql
-- 1) the category
insert into categories (name) values ('Cartoons');

-- 2) its words (word + hint). The subquery resolves the category id by name.
insert into words (category_id, word, hint) values
  ((select id from categories where name = 'Cartoons'), 'Tom and Jerry',  'Cat chases mouse'),
  ((select id from categories where name = 'Cartoons'), 'Doraemon',       'Robot cat, future gadgets'),
  ((select id from categories where name = 'Cartoons'), 'Chhota Bheem',   'Ladoo-powered hero'),
  ((select id from categories where name = 'Cartoons'), 'Shinchan',       'Cheeky kid, crayon');
```

### Add words to an existing category
```sql
insert into words (category_id, word, hint) values
  ((select id from categories where name = 'Cricket'), 'Wide Ball', 'Too far to reach');
```

### Bulk-insert many words for one category (less repetition)
```sql
insert into words (category_id, word, hint)
select c.id, v.word, v.hint
from categories c
join (values
  ('Mickey Mouse', 'Disney icon, big ears'),
  ('SpongeBob',    'Lives in a pineapple'),
  ('Popeye',       'Spinach strongman')
) as v(word, hint) on c.name = 'Cartoons';
```

### Via the dashboard UI (no SQL)
Table Editor → `categories` → **Insert row** (name). Then Table Editor → `words` → **Insert row**, pick the `category_id` from the dropdown, fill `word` + `hint`. For large batches use the table's **Import data from CSV** with columns `category_id,word,hint` (get the category id from the `categories` table first).

### Tips / gotchas for data
- **Hints never contain the word.** Also avoid making the hint a dead giveaway; the imposter should still have to bluff.
- **Every category needs ≥1 word**, or a game that randomly lands on it errors ("selected categories have no words"). The app draws from the union of selected categories, so a single empty category in a large pool is usually harmless, but keep each populated.
- **Renaming a category**: just `update categories set name = '…' where …` — the clue text follows automatically.
- **Deleting**: delete a category's words first (or set up `on delete cascade`), then the category. Rooms store `category_ids` as plain ids, so a deleted category simply drops out of any room's pool.
- No app or schema change is needed to add data — it's purely inserts.

---

## 11. Gotchas (these bit us — don't repeat)
- **supabase-js query builders are lazy** — `supabase.from().update().eq()` only runs when `await`ed / `.then()`-ed. Never fire-and-forget in effects.
- **`crypto.randomUUID()` needs a secure context** (HTTPS/localhost) — throws over plain-HTTP LAN. Use `lib/id.ts`. `navigator.clipboard` is likewise gated (has a fallback).
- **Static export**: no dynamic route segments without `generateStaticParams`; no server-only features (route handlers reading Request, cookies, redirects, server actions). `useSearchParams` needs `<Suspense>`.
- **basePath + metadata**: Next doesn't prefix `metadata.icons`/`manifest` — `app/layout.tsx` does it manually.
- **Presence reconcile** runs on Realtime `sync` events; a DB row that never connects is cleaned on the next presence event (normal in real use).
- **Testing multiplayer locally**: two tabs in one browser share `localStorage` (`vk_player_id`) → same player. Use two browsers/incognito, or seed players via the Supabase REST API. Because presence removes never-connected (REST-seeded) players after the 8s grace, temporarily raise `GRACE_MS` in `lib/presence.ts` when driving a full flow by hand.

## 12. Status
Complete and **live**. Home, lobby, full game flow, the four imposter-clue toggles, multi-select/random categories, player-leave / host-handoff / presence, waiting-screen "who's pending", the Mango-Fizz + Liquid Glass redesign (logo, sound, confetti), and static export are all built and verified end-to-end. Deployed at https://prudhvish11.github.io/vidu_kadu/ and auto-redeploys on every push to `main`.
