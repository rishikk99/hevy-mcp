// Ported from tests/test_client.py and tests/test_sync.py, plus the Worker's
// lease, page budget, and token persistence in D1.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { EP_ACCOUNT, EP_REFRESH, EP_WORKOUTS_PAGED } from "../src/config";
import { getState } from "../src/db";
import { AuthRequired, HevyAPIError, HevyClient, type Tokens, loadTokens, saveTokensStatement } from "../src/hevy";
import { getWorkouts } from "../src/queries";
import { AUTH_HELP, runSync, syncWorkouts } from "../src/sync";
import { FakeD1 } from "./d1";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf8"));
const PAGE_1 = fixture("workouts_page_1.json");
const PAGE_2 = fixture("workouts_page_2.json");
const ACCOUNT = fixture("account.json");

const TOKENS: Tokens = { access_token: "access-1", refresh_token: "refresh-1", user_id: "u1", expires_at: null };

type Handler = (req: Request) => Response | Promise<Response>;

/** A fetch that records requests and answers from a handler. */
function recorder(handler: Handler) {
  const requests: Request[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push(req.clone());
    return handler(req);
  }) as typeof fetch;
  return { requests, fetchImpl, paths: () => requests.map((r) => new URL(r.url).pathname) };
}

const json = (status: number, body: unknown) => Response.json(body, { status });

function pagedHandler(pages: Record<number, unknown>, account: unknown = ACCOUNT): Handler {
  return (req) => {
    const url = new URL(req.url);
    if (url.pathname === EP_ACCOUNT) return json(200, account);
    if (url.pathname === EP_WORKOUTS_PAGED) {
      return json(200, pages[Number(url.searchParams.get("offset"))] ?? { workouts: [] });
    }
    return json(404, { error: "unexpected" });
  };
}

function client(handler: Handler, persisted: Tokens[] = []) {
  const rec = recorder(handler);
  const c = new HevyClient({ ...TOKENS }, async (t) => void persisted.push(t), rec.fetchImpl);
  return { client: c, ...rec };
}

describe("Hevy client", () => {
  it("sends the web client's headers", async () => {
    const { client: c, requests } = client(() => json(200, { username: "lifter" }));
    await c.getAccount();
    const h = requests[0].headers;
    expect(h.get("x-api-key")).toBe("shelobs_hevy_web");
    expect(h.get("hevy-platform")).toBe("web");
    expect(h.get("Origin")).toBe("https://hevy.com");
    expect(h.get("Authorization")).toBe("Bearer access-1");
    expect(h.get("x-client-time")).toBeTruthy();
  });

  it("refreshes once, retries with the new token, and persists the rotation", async () => {
    let accountCalls = 0;
    const persisted: Tokens[] = [];
    const { client: c, requests, paths } = client(async (req) => {
      if (new URL(req.url).pathname === EP_REFRESH) {
        expect(await req.json()).toEqual({ refresh_token: "refresh-1" });
        expect(req.headers.get("Authorization")).toBe("Bearer access-1");
        return json(200, { access_token: "access-2", refresh_token: "refresh-2", expires_at: "2026-10-12T00:00:00Z" });
      }
      return ++accountCalls === 1 ? json(401, { error: "AccessTokenExpired" }) : json(200, { username: "lifter" });
    }, persisted);

    expect(await c.getAccount()).toEqual({ username: "lifter" });
    expect(paths()).toEqual([EP_ACCOUNT, EP_REFRESH, EP_ACCOUNT]);
    expect(requests[2].headers.get("Authorization")).toBe("Bearer access-2");
    expect(persisted).toEqual([
      { access_token: "access-2", refresh_token: "refresh-2", user_id: "u1", expires_at: "2026-10-12T00:00:00Z" },
    ]);
  });

  it("retries only once, then gives up with AuthRequired", async () => {
    const { client: c, requests } = client((req) =>
      new URL(req.url).pathname === EP_REFRESH
        ? json(200, { access_token: "a2", refresh_token: "r2" })
        : json(401, { error: "AccessTokenExpired" }),
    );
    await expect(c.getAccount()).rejects.toBeInstanceOf(AuthRequired);
    expect(requests).toHaveLength(3);
  });

  it("treats a failed refresh as AuthRequired without retrying", async () => {
    const { client: c, paths } = client((req) =>
      new URL(req.url).pathname === EP_REFRESH ? json(401, { error: "RefreshTokenExpired" }) : json(401, { error: "AccessTokenExpired" }),
    );
    await expect(c.getAccount()).rejects.toThrow(/refresh failed/);
    expect(paths()).toEqual([EP_ACCOUNT, EP_REFRESH]);
  });

  it("does not refresh on a non-refreshable 401", async () => {
    const { client: c, paths } = client(() => json(401, { error: "AccountDisabled" }));
    await expect(c.getAccount()).rejects.toBeInstanceOf(AuthRequired);
    expect(paths()).not.toContain(EP_REFRESH);
  });

  it("rejects a refresh body without an access token", async () => {
    const { client: c } = client((req) =>
      new URL(req.url).pathname === EP_REFRESH ? json(200, { detail: "nope" }) : json(401, {}),
    );
    await expect(c.getAccount()).rejects.toThrow(/unexpected body/);
  });

  it("surfaces HTTP errors as HevyAPIError", async () => {
    const { client: c } = client(() => json(500, { error: "boom" }));
    await expect(c.getAccount()).rejects.toMatchObject({ statusCode: 500 });
    await expect(c.getAccount()).rejects.toBeInstanceOf(HevyAPIError);
  });

  it("only ever issues GETs, apart from the refresh POST", async () => {
    const { client: c, requests } = client((req) => {
      if (new URL(req.url).pathname === EP_REFRESH) return json(200, { access_token: "a2", refresh_token: "r2" });
      return req.headers.get("Authorization") === "Bearer a2" ? json(200, { workouts: [] }) : json(401, { error: "AccessTokenExpired" });
    });
    await c.getAccount();
    await c.getWorkoutsPage("lifter", 5, 0);
    for (const r of requests) {
      if (r.method !== "GET") expect([r.method, new URL(r.url).pathname]).toEqual(["POST", EP_REFRESH]);
    }
  });
});

describe("sync", () => {
  let db: FakeD1;
  beforeEach(() => {
    db = new FakeD1();
  });
  const count = (table: string) => (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  it("backfills page by page until a short page", async () => {
    const { client: c, requests } = client(pagedHandler({ 0: PAGE_1, 10: PAGE_2 }));
    const report = await syncWorkouts(db.d1, c, { pageSize: 10 });
    expect(report).toMatchObject({ added: 14, updated: 0, pages_fetched: 2, full_backfill: true, more_remaining: false });
    expect(count("raw_workouts")).toBe(14);
    const offsets = requests
      .filter((r) => new URL(r.url).pathname === EP_WORKOUTS_PAGED)
      .map((r) => new URL(r.url).searchParams.get("offset"));
    expect(offsets).toEqual(["0", "10"]);
    expect(await getState(db.d1, "backfill_complete")).toBe("1");
  });

  it("stores the raw payload, unmodelled fields included", async () => {
    await syncWorkouts(db.d1, client(pagedHandler({ 0: PAGE_1 })).client, { pageSize: 10 });
    const row = db.sqlite.prepare("SELECT payload FROM raw_workouts WHERE workout_id = 'w000'").get() as { payload: string };
    expect(JSON.parse(row.payload)).toEqual(PAGE_1.workouts[0]);
  });

  it("is incremental afterwards and stops on the first fully known page", async () => {
    await syncWorkouts(db.d1, client(pagedHandler({ 0: PAGE_1, 10: PAGE_2 })).client, { pageSize: 10 });
    const report = await syncWorkouts(db.d1, client(pagedHandler({ 0: PAGE_1, 10: PAGE_2 })).client, { pageSize: 10 });
    expect(report).toMatchObject({ added: 0, updated: 0, unchanged: 10, stopped_early: true, full_backfill: false, pages_fetched: 1 });
  });

  it("counts an edited workout as updated and rewrites its rows", async () => {
    await syncWorkouts(db.d1, client(pagedHandler({ 0: PAGE_1 })).client, { pageSize: 10 });
    const edited = structuredClone(PAGE_1);
    edited.workouts[0].name = "Push A (edited)";
    const report = await syncWorkouts(db.d1, client(pagedHandler({ 0: edited })).client, { pageSize: 10 });
    expect(report).toMatchObject({ updated: 1, added: 0, unchanged: 9 });
    expect(db.sqlite.prepare("SELECT name FROM workout WHERE workout_id = 'w000'").get()).toEqual({ name: "Push A (edited)" });
  });

  it("keeps walking when the first page holds something new", async () => {
    await syncWorkouts(db.d1, client(pagedHandler({ 0: PAGE_1, 10: PAGE_2 })).client, { pageSize: 10 });
    const extended = structuredClone(PAGE_1);
    extended.workouts[0] = { id: "w999", name: "Brand New", start_time: "2026-08-21T17:30:00.000Z" };
    const report = await syncWorkouts(db.d1, client(pagedHandler({ 0: extended, 10: PAGE_2 })).client, { pageSize: 10 });
    expect(report).toMatchObject({ added: 1, stopped_early: true, pages_fetched: 2 });
  });

  it("caches the username after the first lookup", async () => {
    await syncWorkouts(db.d1, client(pagedHandler({ 0: PAGE_1 })).client, { pageSize: 10 });
    expect(await getState(db.d1, "username")).toBe("lifter");
    const second = client(pagedHandler({ 0: PAGE_1 }));
    await syncWorkouts(db.d1, second.client, { pageSize: 10 });
    expect(second.paths()).not.toContain(EP_ACCOUNT);
  });

  it("skips a workout without an id instead of failing", async () => {
    const page = { workouts: [{ name: "no id here" }, PAGE_1.workouts[0]] };
    const report = await syncWorkouts(db.d1, client(pagedHandler({ 0: page })).client, { pageSize: 10 });
    expect(report).toMatchObject({ added: 1, workouts_seen: 1 });
  });

  it("never asks for more than 5 per page", async () => {
    const { client: c, requests } = client(pagedHandler({ 0: PAGE_1 }));
    await syncWorkouts(db.d1, c);
    const limits = requests
      .filter((r) => new URL(r.url).pathname === EP_WORKOUTS_PAGED)
      .map((r) => Number(new URL(r.url).searchParams.get("limit")));
    expect(Math.max(...limits)).toBeLessThanOrEqual(5);
  });

  it("stops at the page budget and resumes the walk on the next run", async () => {
    // 14 workouts at 2 per page is 7 pages; a budget of 3 needs three runs.
    const all = [...PAGE_1.workouts, ...PAGE_2.workouts];
    const pages: Record<number, unknown> = {};
    for (let i = 0; i < all.length; i += 2) pages[i] = { workouts: all.slice(i, i + 2) };

    const first = await syncWorkouts(db.d1, client(pagedHandler(pages)).client, { pageSize: 2, maxPages: 3 });
    expect(first).toMatchObject({ added: 6, more_remaining: true });
    expect(await getState(db.d1, "full_walk_offset")).toBe("6");

    const second = await syncWorkouts(db.d1, client(pagedHandler(pages)).client, { pageSize: 2, maxPages: 3 });
    expect(second).toMatchObject({ added: 6, more_remaining: true, full_backfill: true });

    const third = await syncWorkouts(db.d1, client(pagedHandler(pages)).client, { pageSize: 2, maxPages: 3 });
    expect(third).toMatchObject({ added: 2, more_remaining: false });
    expect(count("raw_workouts")).toBe(14);
    expect(await getState(db.d1, "full_walk_offset")).toBeNull();
    expect(await getState(db.d1, "backfill_complete")).toBe("1");
  });
});

describe("runSync: login storage, errors, and the lease", () => {
  let db: FakeD1;
  beforeEach(async () => {
    db = new FakeD1();
    await saveTokensStatement(db.d1, TOKENS).run();
  });

  it("syncs with the stored login and saves the rotated one", async () => {
    let refreshed = false;
    const { fetchImpl } = recorder((req) => {
      const path = new URL(req.url).pathname;
      if (path === EP_REFRESH) {
        refreshed = true;
        return json(200, { access_token: "access-2", refresh_token: "refresh-2" });
      }
      if (!refreshed) return json(401, { error: "AccessTokenExpired" });
      return pagedHandler({ 0: PAGE_1 })(req);
    });
    const result = await runSync(db.d1, {}, fetchImpl);
    expect(result).toMatchObject({ added: 10 });
    expect(await loadTokens(db.d1)).toMatchObject({ access_token: "access-2", refresh_token: "refresh-2", user_id: "u1" });
  });

  it("reports auth_required with the re-login steps, and stamps it on every query", async () => {
    const { fetchImpl } = recorder((req) =>
      new URL(req.url).pathname === EP_REFRESH ? json(401, {}) : json(401, { error: "AccessTokenExpired" }),
    );
    const result = await runSync(db.d1, {}, fetchImpl);
    expect(result).toMatchObject({ error: "auth_required", next_step: AUTH_HELP });
    expect(String((await getWorkouts(db.d1)).sync_error)).toContain("auth_required");

    // The next good sync clears it.
    await saveTokensStatement(db.d1, TOKENS).run();
    await runSync(db.d1, {}, recorder(pagedHandler({ 0: PAGE_1 })).fetchImpl);
    expect((await getWorkouts(db.d1)).sync_error).toBeUndefined();
  });

  it("reports a missing login as auth_required", async () => {
    db.sqlite.exec("DELETE FROM hevy_auth");
    expect(await runSync(db.d1, {}, recorder(pagedHandler({})).fetchImpl)).toMatchObject({ error: "auth_required" });
  });

  it("lets only one sync hold the lease at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = recorder(async (req) => {
      await gate;
      return pagedHandler({ 0: PAGE_1 })(req);
    });

    const first = runSync(db.d1, {}, slow.fetchImpl);
    await new Promise((r) => setTimeout(r, 10));
    const second = await runSync(db.d1, {}, recorder(pagedHandler({ 0: PAGE_1 })).fetchImpl);
    expect(second).toMatchObject({ error: "sync_in_progress" });
    // A lease conflict is not a sync failure, so it is not stamped on results.
    expect(await getState(db.d1, "last_sync_error")).toBeNull();

    release();
    expect(await first).toMatchObject({ added: 10 });
    expect(await runSync(db.d1, {}, recorder(pagedHandler({ 0: PAGE_1 })).fetchImpl)).toMatchObject({ unchanged: 10 });
  });

  it("takes over a lease left behind by a crashed run", async () => {
    db.sqlite.exec(`INSERT INTO sync_state (key, value) VALUES ('sync_lease', '${Date.now() - 1000}:dead')`);
    expect(await runSync(db.d1, {}, recorder(pagedHandler({ 0: PAGE_1 })).fetchImpl)).toMatchObject({ added: 10 });
  });
});
