# Vidu Kadhu — Database Reference

Everything about the game's database in one place: the schema, what each column means, how to add content (categories & words — the common task), migrations, and security. Self-contained — you don't need to read any other file to add data.

- **Backend:** Supabase (Postgres + Realtime), project `odmxlbfmovmhtsygtgov`.
- **Where to run SQL:** Supabase dashboard → **SQL Editor** (runs as service role, bypasses RLS). This is the safe place for all inserts/migrations below.
- **How the app connects:** client-side only, with the public **anon key** (no backend/API routes). Adding rows in the dashboard shows up in the app immediately — no deploy needed.

---

## 1. Tables at a glance

| Table | What it holds | You edit it? |
|---|---|---|
| `categories` | The category labels (chips) | ✅ to add content |
| `words` | Each word + the imposter's hint, linked to a category | ✅ to add content |
| `rooms` | One row per game room (settings + live status) | ❌ app-managed |
| `players` | One row per player in a room (stats + per-round flags) | ❌ app-managed |
| `votes` | One row per cast vote | ❌ app-managed |

**To add game content you only ever touch `categories` and `words`.** The other three are written by the app during play; leave them alone.

Realtime is enabled for `rooms`, `players`, `votes` (the app subscribes to live changes).

---

## 2. Content tables (the ones you add to)

### `categories`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid (pk) | auto-generated |
| `name` | text | The chip label **and** the imposter's "Category" clue. Keep it short and human: "Cartoons", "Telugu Movies". |

### `words`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid (pk) | auto-generated |
| `category_id` | uuid (fk → `categories.id`) | which category this word belongs to |
| `word` | text | **What the crew sees.** Keep it recognizable. Word length + first letter are derived from it (spaces ignored for the letter count). |
| `hint` | text | **The single clue the imposter sees** (when "Hint about the word" is on). ⚠️ Must **not contain the word**. Aim for an oblique nudge. |
| `created_at` | timestamptz | auto |

**The three content rules:**
1. **Hints never contain the word** and shouldn't be a dead giveaway — the imposter should still have to bluff. Example: word `Baahubali` → hint `Kingdom & waterfall` (good), not `Baahubali movie` (bad).
2. **Every category needs ≥ 1 word.** If a game randomly lands on an empty category it errors ("selected categories have no words").
3. **No app or schema change is needed to add data** — it's purely `insert`s.

---

## 3. How to add data (copy-paste SQL)

> Run these in Supabase → SQL Editor. The `(select id from categories where name = '…')` subquery looks up the category id by name so you never paste raw uuids.

### A) Add a new category **and** its words
```sql
-- 1) the category
insert into categories (name) values ('Cartoons');

-- 2) its words (word + hint)
insert into words (category_id, word, hint) values
  ((select id from categories where name = 'Cartoons'), 'Tom and Jerry', 'Cat chases mouse'),
  ((select id from categories where name = 'Cartoons'), 'Doraemon',      'Robot cat, future gadgets'),
  ((select id from categories where name = 'Cartoons'), 'Chhota Bheem',  'Ladoo-powered hero'),
  ((select id from categories where name = 'Cartoons'), 'Shinchan',      'Cheeky kid, crayon');
```

### B) Add words to an **existing** category
```sql
insert into words (category_id, word, hint) values
  ((select id from categories where name = 'Cricket'), 'Wide Ball', 'Too far to reach'),
  ((select id from categories where name = 'Cricket'), 'Yorker',    'Aimed at the toes');
```

### C) Bulk-add many words to one category (less repetition)
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

### D) No-SQL option (dashboard UI)
Table Editor → `categories` → **Insert row** (type the `name`). Then Table Editor → `words` → **Insert row**, pick the `category_id` from the dropdown, fill `word` + `hint`. For large batches use **Import data from CSV** on the `words` table with columns `category_id,word,hint` (look up the category id in the `categories` table first).

### Prompt you can hand another LLM
> "Add a new category `<NAME>` to my Supabase game with ~15 words. Output one SQL block: first `insert into categories (name) values ('<NAME>');`, then a single `insert into words (category_id, word, hint) select c.id, v.word, v.hint from categories c join (values (...) ) as v(word,hint) on c.name='<NAME>';`. Each hint must be a short, oblique clue that does NOT contain the word and isn't a dead giveaway."

---

## 4. Editing & deleting content
```sql
-- Rename a category (the imposter "Category" clue follows automatically)
update categories set name = 'Tollywood' where name = 'Telugu Movies';

-- Fix a hint
update words set hint = 'Kingdom & waterfall' where word = 'Baahubali';

-- Delete a word
delete from words where word = 'Wide Ball';

-- Delete a whole category: remove its words first, then the category
delete from words where category_id = (select id from categories where name = 'Cartoons');
delete from categories where name = 'Cartoons';
```
Rooms store selected categories as plain ids (`category_ids`), so a deleted category simply drops out of any room's pool — no app change needed.

---

## 5. App-managed tables (reference only — don't hand-edit during play)

### `rooms` — one per game
| Column | Type | Meaning |
|---|---|---|
| `id` | uuid (pk) | room id |
| `code` | text | 4-char join code (shown/scanned) |
| `host_id` | uuid | current host's player id |
| `status` | text | `lobby` → `playing` → `voting` → `reveal` |
| `word` | text | the round's secret word (null in lobby; redrawn each round) |
| `category_id` | uuid | legacy single category; may be null |
| `category_ids` | jsonb | selected category pool (array of category ids); `[]`/all = draw from everything |
| `imposter_count` | int | 1–3 |
| `reveal_mode` | text | `own` (each phone) or `pass` (one shared phone) |
| `timer_enabled` | bool | discussion timer on/off |
| `timer_seconds` | int | discussion timer length |
| `hints_enabled` | bool | imposter sees `words.hint` |
| `show_category` | bool | imposter sees the category name |
| `show_word_length` | bool | imposter sees the word length |
| `show_first_letter` | bool | imposter sees the first letter |
| `imposters_know` | bool | with 2+ imposters, each imposter sees their teammates |
| `created_at` | timestamptz | auto |

### `players` — one per player in a room
| Column | Type | Meaning |
|---|---|---|
| `id` | uuid (pk) | player id (also stored in the device's localStorage) |
| `room_id` | uuid (fk → rooms) | which room |
| `name` | text | display name |
| `is_host` | bool | host flag (mirrors `rooms.host_id`) |
| `is_imposter` | bool | set at round start |
| `is_eliminated` | bool | **only** used to mark who's out of contention during a tie-breaker runoff; reset on Play Again |
| `has_revealed` | bool | has looked at their card this round |
| `wins` / `losses` / `times_caught` | int | cumulative stats (scoreboard + awards) |
| `joined_at` | timestamptz | join order (drives roster order, host handoff) |

### `votes` — one per cast vote
| Column | Type | Meaning |
|---|---|---|
| `id` | uuid (pk) | vote id |
| `room_id` | uuid (fk → rooms) | which room |
| `voter_id` | uuid | who voted |
| `target_id` | uuid | who they voted for |

Cleared between rounds and at the start of a tie-breaker runoff.

---

## 6. Migrations (schema changes already applied)
Run in the SQL Editor. All are idempotent (`if not exists`).

```sql
-- Multi-select category pool
alter table rooms add column if not exists category_ids jsonb;

-- Imposter-clue toggles
alter table rooms add column if not exists show_category     boolean not null default false;
alter table rooms add column if not exists show_word_length  boolean not null default false;
alter table rooms add column if not exists show_first_letter boolean not null default false;

-- Imposters know each other (APPLIED)
alter table rooms add column if not exists imposters_know boolean not null default false;
```
> The app writes new/optional columns best-effort, so a missing column never breaks saving — it just won't persist that one setting until the migration runs.

---

## 7. Row Level Security (RLS)
Policy script: **`supabase/rls.sql`**. It turns RLS on everywhere, makes `categories`/`words` **read-only** to the public anon key (your content can't be wiped via the client), and leaves `rooms`/`players`/`votes` fully writable (the game needs that). The app has no user auth, so RLS can't stop cross-room tampering — that would need auth or server-side RPCs.

Status: ⏳ **not yet applied** — run `supabase/rls.sql` in the SQL Editor and play one quick round to confirm nothing broke. Content edits above (done in the dashboard as service role) work regardless of RLS.
