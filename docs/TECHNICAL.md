# Technical reference

How hevy-mcp works underneath: the two implementations, authentication on both sides, sync,
the schema, the volume rules, routines and plans, and every tool. The
[README](../README.md) covers what it does and how to set it up.

- [Two implementations](#two-implementations)
- [Logging in to Hevy](#logging-in-to-hevy)
- [Sign-in to the connector](#sign-in-to-the-connector)
- [Sync](#sync)
- [Schema](#schema)
- [Metrics](#metrics)
- [Dates and times](#dates-and-times)
- [Routines](#routines)
- [Plans](#plans)
- [Tools](#tools)
- [Free-plan limits](#free-plan-limits)
- [Testing](#testing)

---

## Two implementations

The project started as a local Python MCP server (`src/hevy_mcp/`, stdio), then moved to a
Cloudflare Worker (`worker/`, TypeScript) so it could be a hosted connector usable from the
Claude mobile app. Both remain:

| | Python (`src/hevy_mcp`) | Worker (`worker/src`) |
|---|---|---|
| Transport | stdio, via the MCP Python SDK | Streamable HTTP, a small stateless JSON-RPC handler (`mcp.ts`) |
| Storage | SQLite file in `.hevy/` | D1 database `hevy`, same schema (`worker/migrations/`) |
| Hevy login | `tokens.json` | `hevy_auth` table, rewritten on every rotation |
| Sync | on demand | Cron Trigger hourly at :07, plus on demand |
| Concurrency guard | process lock | lease row in `sync_state` (`session.ts`) |
| Clients | Claude Desktop, Claude Code | claude.ai, the mobile apps, Claude Code, over OAuth |
| Writes | none | routines and folders only |

Python also owns the browser login, which needs a real browser. The Worker can't run one, so
`worker/push-login.ps1` hands it over.

The Worker's MCP handler is hand-written rather than the TypeScript SDK, whose schema
validator compiles code with `eval`, which Workers forbid. It implements `initialize`, `ping`,
`tools/list` and `tools/call`, answers one JSON response per request, and negotiates protocol
versions up to 2025-11-25.

## Logging in to Hevy

Hevy's web login is behind reCAPTCHA, so there's no scripted login. You log in by hand once,
in a browser `hevy-mcp-authenticate` opens (`browser_auth.py`):

- It uses a persistent profile in `.hevy/chrome-profile/`, prefers installed Chrome over
  Playwright's Chromium, and disables the `AutomationControlled` flag, because Google's OAuth
  rejects browsers it detects as automated. Google, Apple and email logins all work. Nothing
  scripts the login; it only reads the tokens the session produces.
- Tokens are captured three ways, in order:
  1. a request interceptor reads the bearer token from the first authenticated call to
     `api.hevyapp.com`;
  2. the refresh token comes from the `auth2.0-token` cookie, since the `Authorization` header
     only ever carries an access token;
  3. only if both come up empty, localStorage is scanned **by value shape** for an object
     holding both tokens. No key name is assumed, and the result says when this path was used.
- It times out after 180 seconds, then verifies the pair with one `GET /user/account` before
  reporting success.

Tokens can also be pasted by hand: in DevTools, under **Application → Cookies →
`https://hevy.com`**, URL-decode the `auth2.0-token` cookie and write its `access_token` and
`refresh_token` into `.hevy/tokens.json`.

The access token lasts about 15 minutes. On a 401 the client refreshes once and retries. A
failed refresh becomes `auth_required` with the steps to fix it, never a silent retry, and
cached results keep reporting `last_sync_at` so stale data is never passed off as fresh.

**Hevy rotates the refresh token on every refresh.** Two holders of one login will knock each
other out, so a login lives in exactly one place. `push-login.ps1` deletes the local copy once
the Worker holds it, and every Hevy call in the Worker, the hourly sync included, runs inside
one lease, so two refreshes can never overlap.

## Sign-in to the connector

The Worker is its own OAuth 2.1 authorization server and resource server, built on
Cloudflare's [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
(grants and hashed tokens in KV `OAUTH_KV`):

1. An unauthenticated request to `/mcp` gets a 401 whose `WWW-Authenticate` header points at
   `/.well-known/oauth-protected-resource/mcp` (RFC 9728), which names the authorization
   server.
2. claude.ai identifies itself with a **Client ID Metadata Document** hosted by Anthropic (or
   registers dynamically), then sends the owner to `/authorize` with a PKCE challenge.
3. `/authorize` (`auth.ts`) is a password page that shows the client's verified domain and
   where access will be sent. The password is checked against a PBKDF2-SHA256 hash (100,000
   iterations, the Workers maximum) held in the `OWNER_PASSWORD_HASH` secret.
4. Claude exchanges the code for tokens and refreshes them itself. Grants slide: they live
   while used and lapse after 90 idle days.

Rules on top of the library's checks:
- **Redirects:** access can only be sent to `claude.ai`, `claude.com` or a loopback address
  (Claude Code), so a lookalike client can't receive a token even if the owner is tricked into
  signing in.
- **Rate limit:** ten wrong passwords pause sign-in for an hour.
- **No search indexing:** `/robots.txt` disallows everything, and pages carry `noindex`.
- **Browsers:** a browser that opens `/mcp` gets a readable "sign in through Claude" page
  rather than a bare 401, with the same `WWW-Authenticate` header for MCP clients.

## Sync

`/user_workouts_paged` rejects `limit > 5` with HTTP 400, although the reference package
defaults to 10, so pages are pulled five at a time.

- **The first run is a full backfill.** Later runs walk from the newest page and stop at the
  first page whose workouts are all already stored with an identical payload hash. `full=true`
  forces a complete re-walk.
- **Change detection is by SHA-256 of the raw payload,** not the payload's `updated_at`.
  Hashing catches any edit and doesn't depend on the endpoint's undocumented ordering.
- **Every raw payload is stored verbatim** in `raw_workouts` next to the normalized rows, so a
  schema change is reprocessed locally with no refetch (`sync.renormalize()`).
- **In the Worker, each page is written as one atomic D1 batch,** and a run that hits its
  request budget checkpoints its offset and resumes on the next run.

## Schema

A star schema: one `exercise` dimension, facts hanging off it. `set` is a SQL keyword, so the
set table is `workout_set`.

```
raw_workouts      workout_id, payload (verbatim JSON), payload_hash, fetched_at
exercise          template_id PK, title, title_norm, muscle_group, equipment_category, exercise_type
exercise_muscle   template_id, muscle, role('primary'|'secondary')
workout           workout_id PK, name, start_time, end_time, start_date, duration_seconds,
                  nth_workout, routine_id, description, calories, exercise_count, set_count,
                  volume_kg, working_volume_kg, hevy_volume_kg, updated_at
workout_exercise  workout_id, position, template_id, title, notes, rest_seconds
workout_set       workout_id, position, set_index, start_date, template_id, set_type,
                  weight_kg, reps, rpe, distance_m, duration_s, custom_metric, volume_kg
personal_record   workout_id, position, set_index, pr_type, value
sync_state        key/value: last_sync_at, username, backfill_complete, lease, ...
```

The Worker adds `hevy_auth` (the login), `exercise_template` (Hevy's library plus custom
exercises) and `plan`.

| View | One row per | Notes |
|---|---|---|
| `v_set` | set | Date, exercise, muscle group, equipment, weight in **kg and lb**, reps, cardio measures, volume, working volume, notes |
| `v_workout` | session | Rollups per workout |
| `v_pr` | personal record | With date, exercise, and muscle group |
| `v_muscle_exposure` | set × muscle | Primary and secondary; double-counts by design |

How the payload maps, read off real captured responses:

| Source | Column | Note |
|---|---|---|
| `start_time`, `end_time` | `start_time`, `end_time`, `duration_seconds` | epoch **seconds**, not ISO |
| exercise `title` | `workout_exercise.title` | array position becomes `position`; there's no index field |
| exercise `muscle_group`, `other_muscles` | `exercise_muscle` rows | inline per exercise |
| set `indicator` | `set_type` | `normal`, `warmup`, `dropset`, `failure`; not called `set_type` upstream |
| set `prs[]` `{type,value}` | `personal_record` | six types, including `best_1rm` and `best_volume` |

Which measures a set carries depends on `exercise_type`: `weight_reps` uses weight and reps,
`distance_duration` distance and duration, `duration` duration alone, `steps_duration` adds a
step count. **A NULL weight on a treadmill set is correct, not missing data.** Weights are
stored at full precision (logging in pounds produces 15-digit kilograms) and rounded in output.

## Metrics

| Metric | Includes warm-ups | Sums to tonnage | Use it for |
|---|---|---|---|
| `volume_kg` | yes | yes | tonnage; reconciles exactly with Hevy |
| `working_volume_kg` | no | yes | working-set trends |
| `exposure_kg` | yes | **no** | finding under-trained muscles |

`get_muscle_exposure` credits each set to its primary **and** secondary muscles, so it roughly
doubles the total and must never be read as tonnage. It exists for the blind spot primary-only
grouping can't see: muscles such as glutes or calves that train hard as secondary muscles but
never appear as a primary one, so they show zero volume.

**Bodyweight-loaded exercises.** Volume is usually `weight_kg × reps`, but Hevy folds
bodyweight in where the body is the load, using the weight on the user's profile, which isn't
in the workout payload. It was solved from the history instead: every affected workout implied
one exact bodyweight with zero spread, which suggests Hevy recomputes historical volume from
the current profile weight. It is configured as `BODYWEIGHT_KG`.

| Case | Volume |
|---|---|
| Assisted (`bodyweight_assisted_reps`) | `(bodyweight − assistance) × reps`: less assistance means *more* volume |
| Pull Up, Triceps Dip (`reps_only`) | `bodyweight × reps`; these log no weight at all |
| Supported `reps_only` (sit ups, leg raises, back extensions, push ups) | no volume; solved at factor 0 |
| Everything else | `weight_kg × reps` |

With this rule every workout reconciles with Hevy's own `estimated_volume_kg` to 0.000000 kg.
`hevy_volume_kg` is kept as the check, and a test asserts the reconciliation.

## Dates and times

Hevy sends start and end times as epoch seconds with no time zone. Times are stored in a
configured zone (`TIMEZONE` in `worker/src/config.ts`, `DEFAULT_TIMEZONE` or
`HEVY_MCP_TIMEZONE` in Python), so `start_time` reads like `2026-10-13T19:57:53-05:00`, and a
workout's `date` is its local start date. In UTC, an evening session in the Americas lands on
the next day, which skews weekly totals and PR dates.

Changing the zone means rebuilding stored dates: `sync.renormalize()` in Python, and
`node scripts/redate.mjs` from `worker/` after deploying. Results carry `start`, `end` and the
`timezone`; `last_sync_at` stays in UTC.

## Routines

Hevy's web app can build routines but can't log workouts, so routines are the one thing worth
writing. Their request shapes were recorded from hevy.com's own routine editor with
`scripts/capture_routes.py`, which strips tokens before saving.

- **Routines are read live, not cached.** You edit them in the app too, and an edit must never
  start from a stale copy.
- **Every change is two calls.** The first returns a preview, and for edits a list of what
  changes. Claude shows it, then repeats the call with `confirm=true`.
- **Validation is complete and specific.** A set may only record what its exercise type
  allows (no weight on a plank), and every problem comes back at once, naming the exercise and
  set.
- **Pounds use Hevy's own conversion** (`lb / 2.20462`), so 135 lb is stored as exactly the
  value the app writes and shows as 135 again.
- **Free accounts hold four routines.** Creating a fifth is refused with the options instead;
  the limit is never worked around.
- **Writes are allowlisted** in `hevy.ts`: only the routine, folder and routine-location
  endpoints, each matched exactly.

**Hevy's exercise library isn't in its API.** The ~450 built-in exercises ship inside the web
app's JavaScript bundle. `worker/scripts/update_exercise_library.py` extracts them into SQL for
D1, and custom exercises are refreshed from `/custom_exercise_templates`. The library is Hevy's
data, so it's loaded into your own database and never committed. `search_exercises` ranks
matches by score, then by how often you've logged each exercise, and understands Hevy's own
aliases and keywords ("humble row", "rdl").

## Plans

Plans live in D1 (the `plan` table): any number of labelled days, each in `save_routine`'s
exercise format. Hevy never holds more than its limit; a plan works like a notebook beside the
app.

- **`load_plan_day`** puts one day into Hevy. Without a `routine_id` it only fills a free
  slot. When Hevy is full it returns `choose_routine`, marking routines an earlier load of the
  same plan created, and Claude asks which to replace. It never picks one itself. Exercises are
  checked again at load time, in case the library changed.
- **`save_routines_as_plan`** copies a folder or chosen routines exactly as Hevy stores them:
  sets, weights in kilograms as stored, rest timers, notes, supersets, and each routine's folder
  and position.
- **`restore_plan`** puts them back. A routine that still exists is rewritten in place (same
  id, folder and position). A deleted one is recreated in its original folder, which is
  recreated if needed, and positions are restored in one reorder. If recreating needs more room
  than Hevy has, it returns `choose_routine`. Afterwards the plan records any new routine ids,
  so the next restore rewrites in place. RPE targets are the only thing not copied, and the
  result says so when they exist.

## Tools

Dates are `YYYY-MM-DD`. Output is compact JSON with nulls omitted, and every capped list carries
`returned`, `total` and `truncated`, so nothing is cut off silently.

| Tool | What it does |
|---|---|
| `sync_workouts(full)` | Pull new and changed workouts. Hourly on its own |
| `get_workouts(start_date, end_date, limit)` | Summaries, newest first, with local start and end. Max 200 |
| `get_workout_detail(workout_id)` | One session: exercises, notes, rest, every set, PRs |
| `get_exercise_history(exercise_name, start_date, end_date)` | Every set of one exercise, name fuzzy-matched with runner-ups. Max 500 sets |
| `get_volume_summary(period, start_date, end_date, group_by)` | Sets, reps and tonnage by week or month, by muscle, exercise or equipment. Max 200 buckets |
| `get_muscle_exposure(period, start_date, end_date, role)` | Primary and secondary muscle exposure. Not tonnage |
| `get_personal_records(exercise_name, pr_type, start_date, end_date)` | PRs, newest first. Max 200 |
| `list_exercises()` | Exercises you've logged, with coverage. Max 300 |
| `list_routines()` | Routines by folder in app order, plus the routine limit |
| `get_routine(routine_id)` | One routine in full |
| `search_exercises(query, muscle_group, equipment, limit)` | Find exercises and their template ids for building routines |
| `save_routine(routine_id, title, notes, exercises, folder_id, confirm)` | Create, or replace a routine's contents. Previews unless confirmed |
| `delete_routine(routine_id, confirm)` | Previews unless confirmed |
| `create_routine_folder`, `move_routine`, `delete_routine_folder` | Folders; only empty ones can be deleted |
| `save_plan`, `list_plans`, `get_plan`, `delete_plan` | Stored plans |
| `load_plan_day(plan_id, day, routine_id, confirm)` | One day of a plan into Hevy |
| `save_routines_as_plan(name, folder_id \| routine_ids)` | Exact copy of routines into a plan |
| `restore_plan(plan_id, confirm)` | Put a copied plan back |

The Python server has the first eight plus `authenticate`. Fuzzy matching in
`get_exercise_history` deliberately doesn't expand gym acronyms: it returns no match rather than
a confident wrong one.

## Free-plan limits

The free Workers plan allows 50 outbound requests and about 10 ms of CPU per run (time spent
waiting on the network doesn't count).

- **Sync** stops after 40 pages, records `full_walk_offset`, and the next run continues.
  Incremental syncs use one or two pages.
- **The initial history** is loaded from the local cache (`worker/scripts/export_to_d1.py`)
  instead of being re-downloaded. Floats are exported with `repr()`, which round-trips exactly.
- **Database writes** for one page go in a single D1 batch.

## Testing

```powershell
uv run pytest            # Python: 173 tests
cd worker; npm test      # TypeScript: 172 tests
```

- **Offline by construction.** Python exercises the HTTP layer through `httpx.MockTransport`.
  The Worker tests run against `FakeHevy` (`test/fake-hevy.ts`), a stateful fake of Hevy's
  routine endpoints built from the recorded request shapes, plus an in-memory D1 on
  `node:sqlite` and an in-memory KV. No test can reach Hevy.
- **The OAuth flow is tested end to end:** discovery, registration, the password page,
  denial, lockout, the redirect allowlist, token exchange and refresh.
- **Equivalence tests** (`worker/test/equivalence.test.ts`) replay the owner's real history
  through the TypeScript code and compare against what Python wrote:
  - every payload hash, byte for byte, which needs Python's `json.dumps` reproduced exactly,
    down to `ensure_ascii` and float `repr`;
  - every normalized row;
  - 28 recorded query outputs (`worker/test/golden_queries.py`), which needs Python's
    round-half-even reproduced exactly.

  They read `.hevy/hevy.sqlite3` and `worker/test/.golden.json`, which are personal and
  gitignored, and skip themselves without them.
