// Pull workouts from Hevy into D1. Port of src/hevy_mcp/sync.py plus the
// sync_workouts wrapper in server.py, with two Worker-specific additions:
//
// * The session lease (session.ts) stands in for the Python process lock.
// * A per-run page budget. The free plan allows 50 outbound fetches per
//   invocation, so a walk that cannot finish records where it stopped and the
//   next run continues from there as a full walk.

import { MAX_PAGES_PER_RUN, PAGE_SIZE } from "./config";
import { deleteState, getState, setState, setStateStatement } from "./db";
import { AuthRequired, HevyAPIError, HevyClient } from "./hevy";
import { workoutStatements } from "./normalize";
import { payloadHash } from "./pyjson";
import { withHevy } from "./session";

export { AUTH_HELP } from "./session";

type Json = Record<string, unknown>;

export interface SyncReport {
  added: number;
  updated: number;
  unchanged: number;
  pages_fetched: number;
  workouts_seen: number;
  full_backfill: boolean;
  stopped_early: boolean;
  more_remaining: boolean;
  last_sync_at: string | null;
}

/** Python's datetime.now(timezone.utc).isoformat(). */
function nowIso(): string {
  return new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");
}

async function resolveUsername(db: D1Database, client: HevyClient): Promise<string> {
  const cached = await getState(db, "username");
  if (cached) return cached;
  const account = await client.getAccount();
  const username = typeof account === "object" && account !== null ? (account as Json).username : undefined;
  if (!username) {
    const keys = typeof account === "object" && account !== null ? Object.keys(account).sort() : typeof account;
    throw new Error(`/user/account did not return a username (keys: ${JSON.stringify(keys)})`);
  }
  await setState(db, "username", String(username));
  return String(username);
}

function pageWorkouts(page: unknown): Json[] {
  const list = Array.isArray(page)
    ? page
    : typeof page === "object" && page !== null && Array.isArray((page as Json).workouts)
      ? ((page as Json).workouts as unknown[])
      : [];
  return list.filter((w): w is Json => typeof w === "object" && w !== null && !Array.isArray(w));
}

export async function syncWorkouts(
  db: D1Database,
  client: HevyClient,
  opts: { full?: boolean; pageSize?: number; maxPages?: number } = {},
): Promise<SyncReport> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const maxPages = opts.maxPages ?? MAX_PAGES_PER_RUN;
  const backfillDone = (await getState(db, "backfill_complete")) === "1";
  const resumeAt = await getState(db, "full_walk_offset");
  const doFull = Boolean(opts.full) || !backfillDone;

  const report: SyncReport = {
    added: 0,
    updated: 0,
    unchanged: 0,
    pages_fetched: 0,
    workouts_seen: 0,
    full_backfill: doFull,
    stopped_early: false,
    more_remaining: false,
    last_sync_at: null,
  };
  const username = await resolveUsername(db, client);

  const known = new Map<string, string>();
  for (const row of (await db.prepare("SELECT workout_id, payload_hash FROM raw_workouts").all<Json>()).results) {
    known.set(String(row.workout_id), String(row.payload_hash));
  }

  let offset = doFull && resumeAt ? Number(resumeAt) : 0;
  let finished = false;
  while (report.pages_fetched < maxPages) {
    const workouts = pageWorkouts(await client.getWorkoutsPage(username, pageSize, offset));
    report.pages_fetched++;
    if (!workouts.length) {
      finished = true;
      break;
    }

    const writes: D1PreparedStatement[] = [];
    let pageAllKnown = true;
    for (const workout of workouts) {
      if (!workout.id) {
        console.warn(`Skipping a workout with no id at offset ${offset}`);
        continue;
      }
      const workoutId = String(workout.id);
      report.workouts_seen++;

      const digest = await payloadHash(workout);
      const existing = known.get(workoutId);
      if (existing === digest) {
        report.unchanged++;
        continue;
      }

      pageAllKnown = false;
      writes.push(
        db
          .prepare(
            "INSERT INTO raw_workouts (workout_id, payload, payload_hash, fetched_at) VALUES (?, ?, ?, ?) " +
              "ON CONFLICT(workout_id) DO UPDATE SET payload = excluded.payload, " +
              "  payload_hash = excluded.payload_hash, fetched_at = excluded.fetched_at",
          )
          .bind(workoutId, JSON.stringify(workout), digest, nowIso()),
      );
      for (const { sql, params } of workoutStatements(workoutId, workout, digest)) {
        writes.push(db.prepare(sql).bind(...params));
      }
      known.set(workoutId, digest);
      if (existing === undefined) report.added++;
      else report.updated++;
    }
    // One atomic batch per page: a page is either fully stored or not at all.
    if (writes.length) await db.batch(writes);

    // An entire page already cached unchanged means we have caught up.
    if (!doFull && pageAllKnown) {
      report.stopped_early = true;
      finished = true;
      break;
    }
    offset += pageSize;
    if (workouts.length < pageSize) {
      finished = true;
      break;
    }
  }

  const now = nowIso();
  const tail = [setStateStatement(db, "last_sync_at", now)];
  if (finished) {
    if (doFull) tail.push(setStateStatement(db, "backfill_complete", "1"));
    tail.push(db.prepare("DELETE FROM sync_state WHERE key = 'full_walk_offset'"));
  } else {
    // Out of budget: the next run picks the walk up from here.
    report.more_remaining = true;
    tail.push(setStateStatement(db, "full_walk_offset", String(offset)));
    tail.push(setStateStatement(db, "backfill_complete", "0"));
  }
  await db.batch(tail);
  report.last_sync_at = now;
  return report;
}

// --- the tool-facing wrapper -----------------------------------------------

/** Pull new and changed workouts. Never throws; failures come back as {error}. */
export async function runSync(
  db: D1Database,
  opts: { full?: boolean; waitMs?: number } = {},
  fetchImpl?: typeof fetch,
): Promise<Json> {
  const result = await withHevy(
    db,
    async (client) => {
      try {
        return { ...(await syncWorkouts(db, client, opts)) };
      } catch (exc) {
        // withHevy turns these two into {error} objects; anything else here is
        // a sync bug or a payload shape change.
        if (exc instanceof AuthRequired || exc instanceof HevyAPIError) throw exc;
        return { error: "sync_failed", message: exc instanceof Error ? exc.message : String(exc) };
      }
    },
    { waitMs: opts.waitMs ?? 0, fetchImpl },
  );

  // Another holder is not a failed sync, so it is not stamped on results.
  if (result.error === "busy") {
    return {
      error: "sync_in_progress",
      message: "Another sync is running right now; its results will appear within a minute.",
    };
  }
  if ("error" in result) {
    const stamp = new Date().toISOString().slice(0, 19) + "+00:00";
    await setState(db, "last_sync_error", `${stamp} ${result.error}: ${result.next_step ?? result.message}`);
  } else {
    await deleteState(db, "last_sync_error");
  }
  return result;
}
