# Vidu Kadhu — Project Handoff

Real-time multiplayer social-deduction party game (Telugu, "It's not him"). Everyone in a room gets a secret word except the imposter(s), who instead get host-chosen clues. Players discuss, vote, and try to catch the imposter.

## Tech stack
- **Next.js 16** (App Router) · **React 19** · **TypeScript**
- **Tailwind v4** (only `@import`; styling is CSS variables + inline styles in `app/globals.css`)
- **Supabase** — Postgres + Realtime (data, live sync, presence)
- **Deploy:** GitHub Pages via static export (`output: "export"`)

> ⚠️ `AGENTS.md`: this Next.js version has breaking changes vs. older docs — read `node_modules/next/dist/docs/` before writing Next-specific code.

## Run it
```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # static export -> ./out
npx tsc --noEmit # type-check
```
Requires `.env.local` (gitignored):
```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

## Routes & structure
Room code lives in the **query string** (not a path segment) so every route is a static SPA shell — required for GitHub Pages.
- `app/page.tsx` — home (create / join). `?join=CODE` pre-fills join.
- `app/room/page.tsx` — lobby (`/room?code=XXXX`): host settings, player list, start game.
- `app/room/game/page.tsx` — game (`/room/game?code=XXXX`): all phases as early-returns + reveal/waiting/leave helper components.
- `app/globals.css` — design system: Mango Fizz palette, Liquid Glass classes, animations, `prefers-reduced-motion` guard.
- `lib/supabase.ts` — client. `lib/presence.ts` — `useRoomPresence` + `removePlayerFromRoom`. `lib/avatar.ts` — deterministic avatar color. `lib/sound.ts` — Web Audio SFX + haptics + mute.
- `components/SoundToggle.tsx`, `components/Confetti.tsx`.
- `.github/workflows/deploy.yml` — Pages deploy.

Both client pages read the code via `useSearchParams()` and are wrapped in `<Suspense>`.

## Game flow
Home → Lobby → **Word reveal** (own-phone or pass-device; hold-to-reveal with a filling ring) → **Discussion** (optional timer, host ends it) → **Voting** (secret; self excluded) → **Vote reveal** (bar chart + who-voted-for-whom) → **Result** (crew vs. imposter; confetti on crew win) → **Scoreboard** (W/L/caught, medals) → **Play again** (same room/players, new round).

Crew sees the word. The imposter sees only the clues the host enabled (below). Result logic: the most-voted player is "caught"; ties favor the imposter.

## Host settings ("Hints — what the imposter sees")
Four independent on/off toggles, each controlling one clue on the imposter's card:
| Toggle | Column | Source |
|---|---|---|
| Hint about the word | `rooms.hints_enabled` (default true) | `words.hint` |
| Category | `rooms.show_category` | `categories.name` |
| Word length | `rooms.show_word_length` | derived from `word` |
| First letter | `rooms.show_first_letter` | derived from `word` |
Plus: category + word picker, imposter count (1–3), reveal mode (own/pass), discussion timer.

## Players leaving / disconnects
- **Leave button** deletes the player row + their votes (lobby and game).
- **Host handoff**: when the host leaves, the earliest-joined remaining player is promoted (updates `rooms.host_id` and the `is_host` flag); empty room is deleted.
- **Disconnect detection** (`lib/presence.ts`): Supabase Realtime presence; a single "leader" (host if online, else lowest online id) removes players absent past an 8s grace, so a disconnected host is cleaned up and replaced by another client.

## UI
Mango Fizz light palette, drifting **aurora** backdrop, **Apple Liquid Glass** cards/buttons (refraction, specular edge, squircle corners, hover sheen), ticket-style room code, colored avatars + online dots, animated vote bars, dramatic flip reveal, confetti, **sound + haptics** with a persisted mute toggle (🔊 top-right). Fully responsive (`100dvh`, safe-area insets, `clamp()` type, centered column that scales up on tablets/laptops/large screens).

## Supabase schema (current)
- `rooms`: `id, code, host_id, status ('lobby'|'playing'|'voting'|'reveal'), word, category_id, imposter_count, reveal_mode ('own'|'pass'), timer_enabled, timer_seconds, hints_enabled, show_category, show_word_length, show_first_letter, created_at`
- `players`: `id, room_id, name, is_host, is_imposter, is_eliminated, has_revealed, wins, losses, times_caught, joined_at`
- `votes`: `id, room_id, voter_id, target_id`
- `categories`: `id, name` · `words`: `id, category_id, word, hint`

All data access is client-side Supabase (no API routes). Realtime is enabled for `rooms`, `players`, `votes`.

## Deploy (GitHub Pages)
1. Repo secrets (Settings → Secrets and variables → Actions): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
2. Settings → Pages → Source: **GitHub Actions**.
3. Push to `main` → `.github/workflows/deploy.yml` builds and publishes `out/`. `basePath` is auto-derived (project site → `/<repo>`, user/custom-domain → empty).

## Gotchas (these bit us — don't repeat)
- **supabase-js query builders are lazy** — a `supabase.from().update().eq()` only runs when `await`ed / `.then()`-ed. Never fire-and-forget in effects.
- **`crypto.randomUUID()` needs a secure context** (HTTPS/localhost) — throws over plain-HTTP LAN. Use `lib/id.ts`. `navigator.clipboard` is likewise gated (has a fallback).
- **Static export**: no dynamic route segments without `generateStaticParams`; no server-only features (route handlers reading Request, cookies, redirects, server actions). `useSearchParams` needs `<Suspense>`.
- **Presence reconcile** runs on Realtime `sync` events; a DB row that never connects is cleaned on the next presence event (normal in real use).
- **Testing multiplayer locally**: two tabs in one browser share `localStorage` (`vk_player_id`) → same player. Use two browsers/incognito, or seed players via the Supabase REST API.

## Status
Home, lobby, full game flow, hint toggles, player-leave/host-handoff/presence, UI redesign, and static export are all built and verified end-to-end. Deploy runs from `main` once the repo secrets + Pages source are set.
