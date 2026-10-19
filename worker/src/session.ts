// One Hevy session at a time.
//
// Hevy rotates the refresh token on every refresh, so two overlapping
// refreshes leave one side holding a revoked token and the connector logged
// out. Anything that talks to Hevy (the hourly sync, a sync_workouts call, a
// routine edit) runs inside withHevy, which holds a lease row in sync_state
// for its duration. D1 serializes writes, so the conditional upsert below is
// an atomic test-and-set.

import { SYNC_LEASE_SECONDS } from "./config";
import { AuthRequired, HevyAPIError, HevyClient, loadTokens, saveTokensStatement } from "./hevy";

type Json = Record<string, unknown>;

export const AUTH_HELP =
  "The Hevy login on the server has expired and cannot be renewed from here. " +
  "On the owner's PC, in the hevy-mcp folder, run `.\\worker\\push-login.ps1`: it opens " +
  "a browser to log in to Hevy and sends the new login to Cloudflare.";

async function acquireLease(db: D1Database, holder: string): Promise<boolean> {
  const now = Date.now();
  const result = await db
    .prepare(
      "INSERT INTO sync_state (key, value) VALUES ('sync_lease', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value " +
        "WHERE CAST(substr(sync_state.value, 1, instr(sync_state.value, ':') - 1) AS INTEGER) < ?",
    )
    .bind(`${now + SYNC_LEASE_SECONDS * 1000}:${holder}`, now)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

async function releaseLease(db: D1Database, holder: string): Promise<void> {
  await db.prepare("DELETE FROM sync_state WHERE key = 'sync_lease' AND value LIKE ?").bind(`%:${holder}`).run();
}

export function authError(exc: Error): Json {
  return { error: "auth_required", message: exc.message, next_step: AUTH_HELP };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run fn with a HevyClient while holding the lease. Never throws for the
 * expected failures: a busy lease, a missing or rejected login, and Hevy API
 * errors all come back as {error} objects a tool can return as-is.
 *
 * waitMs: how long to wait for another holder before giving up. The cron sync
 * passes 0; interactive tools wait a little, since a sync takes about a second.
 */
export async function withHevy(
  db: D1Database,
  fn: (client: HevyClient) => Promise<Json>,
  opts: { waitMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Json> {
  const holder = crypto.randomUUID();
  const deadline = Date.now() + (opts.waitMs ?? 0);
  while (!(await acquireLease(db, holder))) {
    if (Date.now() >= deadline) {
      return {
        error: "busy",
        message: "Another request is talking to Hevy right now; try again in a few seconds.",
      };
    }
    await sleep(250);
  }

  try {
    let client: HevyClient;
    try {
      client = new HevyClient(
        await loadTokens(db),
        async (tokens) => {
          await saveTokensStatement(db, tokens).run();
        },
        opts.fetchImpl,
      );
    } catch (exc) {
      if (exc instanceof AuthRequired) return authError(exc);
      throw exc;
    }

    try {
      return await fn(client);
    } catch (exc) {
      if (exc instanceof AuthRequired) return authError(exc);
      if (exc instanceof HevyAPIError) {
        return { error: "api_error", status_code: exc.statusCode, message: exc.message, detail: exc.body };
      }
      throw exc;
    }
  } finally {
    await releaseLease(db, holder);
  }
}
