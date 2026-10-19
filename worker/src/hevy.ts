// Client for Hevy's undocumented web endpoints. Port of src/hevy_mcp/client.py:
// a stale access token is refreshed once and the request retried, and the
// rotated pair is persisted before anything else happens.
//
// Writes are limited to routines and routine folders, by an allowlist checked
// before any request leaves. Workouts, the account, and everything else stay
// read-only no matter what a tool asks for.

import {
  ACCEPT,
  ACCEPT_LANGUAGE,
  API_KEY,
  BASE_URL,
  EP_ACCOUNT,
  EP_REFRESH,
  EP_WORKOUTS_PAGED,
  PLATFORM,
  USER_AGENT,
  WEB_ORIGIN,
} from "./config";

export interface Tokens {
  access_token: string;
  refresh_token: string;
  user_id: string | null;
  expires_at: string | null;
}

/** The stored login is missing or Hevy rejected it; the owner must log in again. */
export class AuthRequired extends Error {}

export class HevyAPIError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null,
    readonly body: unknown = null,
  ) {
    super(message);
  }
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

// Every non-GET request the client may send, as observed from hevy.com's own
// routine editor. routines_sync_batch is a POST that only reads.
const WRITABLE: [Method, RegExp][] = [
  ["POST", /^\/routines_sync_batch$/],
  ["POST", /^\/routine$/],
  ["PUT", /^\/routine\/[0-9a-f-]{36}$/],
  ["DELETE", /^\/routine\/[0-9a-f-]{36}$/],
  ["POST", /^\/routine_folder$/],
  ["DELETE", /^\/routine_folder\/\d+$/],
  ["PUT", /^\/routine_locations$/],
];

export function isAllowedRequest(method: Method, path: string): boolean {
  return method === "GET" || WRITABLE.some(([m, re]) => m === method && re.test(path));
}

// 401 bodies carrying these codes (or none) mean "access token stale", the case
// a refresh can fix. Anything else is a real auth failure.
const REFRESHABLE_ERRORS = new Set<unknown>([undefined, null, "AccessTokenExpired", "AccessTokenInvalid"]);
const REFRESH_THROTTLE_MS = 5000;

export async function loadTokens(db: D1Database): Promise<Tokens> {
  const row = await db
    .prepare("SELECT access_token, refresh_token, user_id, expires_at FROM hevy_auth WHERE id = 1")
    .first<Tokens>();
  if (!row) throw new AuthRequired("No Hevy login is stored on the server.");
  return row;
}

export function saveTokensStatement(db: D1Database, tokens: Tokens): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO hevy_auth (id, access_token, refresh_token, user_id, expires_at, updated_at) " +
        "VALUES (1, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token, " +
        "  refresh_token = excluded.refresh_token, user_id = excluded.user_id, " +
        "  expires_at = excluded.expires_at, updated_at = excluded.updated_at",
    )
    .bind(tokens.access_token, tokens.refresh_token, tokens.user_id, tokens.expires_at, new Date().toISOString());
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class HevyClient {
  /** Outbound fetches made so far; the free plan allows 50 per invocation. */
  fetches = 0;
  private lastRefresh: number | null = null;

  constructor(
    public tokens: Tokens,
    private readonly persist: (tokens: Tokens) => Promise<void>,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Accept: ACCEPT,
      "Accept-Language": ACCEPT_LANGUAGE,
      "User-Agent": USER_AGENT,
      "x-api-key": API_KEY,
      "hevy-platform": PLATFORM,
      Origin: WEB_ORIGIN,
      Referer: `${WEB_ORIGIN}/`,
      Authorization: `Bearer ${this.tokens.access_token}`,
      "x-client-time": String(Date.now() / 1000),
      ...extra,
    };
  }

  private send(
    method: Method,
    path: string,
    params?: Record<string, string | number>,
    body?: unknown,
  ): Promise<Response> {
    const url = new URL(path, BASE_URL);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
    this.fetches++;
    return this.fetchImpl(url.toString(), {
      method,
      headers: this.headers(body === undefined ? {} : { "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** Send an authenticated request, refreshing once on a stale token. */
  async request(
    method: Method,
    path: string,
    opts: { params?: Record<string, string | number>; body?: unknown } = {},
  ): Promise<unknown> {
    if (!isAllowedRequest(method, path)) {
      throw new Error(`Refusing ${method} ${path}: only routines and routine folders may be changed.`);
    }
    let response = await this.send(method, path, opts.params, opts.body);
    if (response.status === 401) {
      const body = await safeJson(response);
      const code = typeof body === "object" && body !== null ? (body as Record<string, unknown>).error : undefined;
      if (REFRESHABLE_ERRORS.has(code)) {
        await this.refresh();
        response = await this.send(method, path, opts.params, opts.body);
      }
    }
    return this.parse(response, method, path);
  }

  get(path: string, params?: Record<string, string | number>): Promise<unknown> {
    return this.request("GET", path, { params });
  }

  private async refresh(): Promise<void> {
    const now = Date.now();
    // A refresh just happened on another call; reuse it rather than stampede.
    if (this.lastRefresh !== null && now - this.lastRefresh < REFRESH_THROTTLE_MS) return;

    this.fetches++;
    const response = await this.fetchImpl(new URL(EP_REFRESH, BASE_URL).toString(), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ refresh_token: this.tokens.refresh_token }),
    });

    if (response.status >= 400) {
      throw new AuthRequired(
        `Token refresh failed with HTTP ${response.status}. The refresh token is expired or revoked.`,
      );
    }
    const data = await safeJson(response);
    if (typeof data !== "object" || data === null || !(data as Record<string, unknown>).access_token) {
      throw new AuthRequired("Token refresh returned an unexpected body without an access_token.");
    }
    const fresh = data as Record<string, unknown>;
    this.tokens = {
      access_token: String(fresh.access_token),
      // Hevy rotates the refresh token; keep the old one only if absent.
      refresh_token: String(fresh.refresh_token || this.tokens.refresh_token),
      user_id: (fresh.user_id as string | undefined) || this.tokens.user_id,
      expires_at: (fresh.expires_at as string | undefined) ?? null,
    };
    this.lastRefresh = now;
    await this.persist(this.tokens);
  }

  private async parse(response: Response, method: Method, path: string): Promise<unknown> {
    if (response.status === 401) {
      throw new AuthRequired(`Still unauthorized after refreshing for ${method} ${path}.`);
    }
    if (response.status >= 400) {
      throw new HevyAPIError(
        `HTTP ${response.status} for ${method} ${path}`,
        response.status,
        await safeJson(response),
      );
    }
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  getAccount(): Promise<unknown> {
    return this.get(EP_ACCOUNT);
  }

  getWorkoutsPage(username: string, limit: number, offset: number): Promise<unknown> {
    return this.get(EP_WORKOUTS_PAGED, { username, limit, offset });
  }
}
