// The connector's sign-in end to end, the way claude.ai drives it: 401 and
// discovery, dynamic registration, the password page, the code exchange, MCP
// with the token, and refresh. Plus the guard rails: only Claude's redirect
// hosts, rate-limited passwords, and Deny.

import { pbkdf2Sync, randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { hashPassword, MAX_FAILURES, verifyPassword } from "../src/auth";
import worker, { type Env } from "../src/index";
import { FakeD1 } from "./d1";
import { FakeKV } from "./kv";

const HOST = "hevy.example.com";
const ORIGIN = `https://${HOST}`;
const RESOURCE = `${ORIGIN}/mcp`;
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const PASSWORD = "correct horse battery staple";

let passwordHash: string;
beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

let env: Env;
beforeEach(() => {
  env = {
    DB: new FakeD1().d1,
    OAUTH_KV: new FakeKV().kv,
    PUBLIC_HOST: HOST,
    OWNER_PASSWORD_HASH: passwordHash,
  } as Env;
});

const ctx = () =>
  ({ waitUntil: () => {}, passThroughOnException: () => {}, props: {} }) as unknown as ExecutionContext;

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(new URL(path, ORIGIN), init), env, ctx());
}

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function pkce() {
  const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}

async function register(redirect = CLAUDE_CALLBACK, name = "Claude") {
  const res = await send("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** GET the password page; returns the form handle and the binding cookie. */
async function openAuthorize(clientId: string, redirect = CLAUDE_CALLBACK) {
  const { verifier, challenge } = await pkce();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    scope: "hevy",
    resource: RESOURCE,
  });
  const res = await send(`/authorize?${params}`);
  const html = await res.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  return { res, html, handle: handle ?? "", cookie: cookiesFrom(res), verifier };
}

async function submit(page: { handle: string; cookie: string }, fields: Record<string, string>) {
  const init = form({ handle: page.handle, ...fields });
  (init.headers as Record<string, string>).Cookie = page.cookie;
  return send("/authorize", init);
}

async function signIn() {
  const clientId = await register();
  const page = await openAuthorize(clientId);
  const done = await submit(page, { decision: "approve", password: PASSWORD });
  expect(done.status).toBe(302);
  const redirect = new URL(done.headers.get("Location")!);
  const code = redirect.searchParams.get("code")!;

  const token = await send(
    "/oauth/token",
    form({
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: clientId,
      code_verifier: page.verifier,
      resource: RESOURCE,
    }),
  );
  expect(token.status, await token.clone().text()).toBe(200);
  return { clientId, redirect, tokens: (await token.json()) as Record<string, any> };
}

const rpc = (method: string, token?: string) =>
  send("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
  });

describe("password hashing", () => {
  it("verifies the right password and rejects others and malformed hashes", async () => {
    expect(await verifyPassword(PASSWORD, passwordHash)).toBe(true);
    expect(await verifyPassword("wrong", passwordHash)).toBe(false);
    expect(await verifyPassword(PASSWORD, undefined)).toBe(false);
    expect(await verifyPassword(PASSWORD, "plain-text")).toBe(false);
    expect(await verifyPassword(PASSWORD, passwordHash.replace("100000", "999999"))).toBe(false);
  });

  it("accepts the hash set-password.ps1 writes with Node's crypto", async () => {
    const salt = randomBytes(16);
    const hash = pbkdf2Sync(PASSWORD, salt, 100000, 32, "sha256");
    const stored = `pbkdf2-sha256$100000$${salt.toString("base64")}$${hash.toString("base64")}`;
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword(PASSWORD + "x", stored)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });
});

describe("discovery", () => {
  it("answers an unauthenticated MCP call with a 401 pointing at the resource metadata", async () => {
    const res = await rpc("tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("publishes resource and authorization server metadata", async () => {
    const resource = (await (await send("/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, any>;
    expect(resource.resource).toBe(RESOURCE);
    expect(resource.authorization_servers).toEqual([ORIGIN]);

    const server = (await (await send("/.well-known/oauth-authorization-server")).json()) as Record<string, any>;
    expect(server).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
    });
    expect(server.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("keeps search engines out", async () => {
    expect(await (await send("/robots.txt")).text()).toContain("Disallow: /");
  });
});

describe("signing in", () => {
  it("runs the whole flow and then serves MCP with the token", async () => {
    const { redirect, tokens } = await signIn();
    expect(redirect.origin + redirect.pathname).toBe(CLAUDE_CALLBACK);
    expect(redirect.searchParams.get("state")).toBe("state-123");
    expect(redirect.searchParams.get("iss")).toBe(ORIGIN);
    expect(tokens).toMatchObject({ token_type: "bearer", scope: "hevy" });
    expect(tokens.refresh_token).toBeTruthy();

    const res = await rpc("tools/list", tokens.access_token);
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(result.tools.map((t) => t.name)).toContain("save_routine");
  });

  it("renews the access token from the refresh token without asking again", async () => {
    const { clientId, tokens } = await signIn();
    const refreshed = await send(
      "/oauth/token",
      form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }),
    );
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as Record<string, string>;
    expect(next.access_token).not.toBe(tokens.access_token);
    expect((await rpc("ping", next.access_token)).status).toBe(200);
  });

  it("shows who is asking and where access goes, and never stores the password in the page", async () => {
    const page = await openAuthorize(await register());
    expect(page.res.status).toBe(200);
    expect(page.html).toContain("Connect Claude to your Hevy data?");
    expect(page.html).toContain("<strong>claude.ai</strong>");
    expect(page.html).toContain('type="password"');
    expect(page.res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("escapes a client-chosen name", async () => {
    const page = await openAuthorize(await register(CLAUDE_CALLBACK, `<img src=x onerror=alert(1)>`));
    expect(page.html).not.toContain("<img src=x");
    expect(page.html).toContain("&#60;img src=x");
  });

  it("rejects a wrong password, then accepts the right one on the same page", async () => {
    const page = await openAuthorize(await register());
    const wrong = await submit(page, { decision: "approve", password: "nope" });
    expect(wrong.status).toBe(401);
    const right = await submit(page, { decision: "approve", password: PASSWORD });
    expect(right.status).toBe(302);
    expect(right.headers.get("Location")).toContain("code=");
  });

  it("sends Deny back to Claude as access_denied without needing the password", async () => {
    const page = await openAuthorize(await register());
    const denied = await submit(page, { decision: "deny" });
    expect(denied.status).toBe(302);
    expect(new URL(denied.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("only lets Claude receive access", async () => {
    const page = await openAuthorize(await register("https://evil.example/callback"), "https://evil.example/callback");
    expect(page.res.status).toBe(403);
    expect(page.html).toContain("Only Claude may connect");
    expect(page.handle).toBe("");
  });

  it("allows Claude Code's loopback callback, with a warning", async () => {
    const local = "http://localhost:51234/callback";
    const page = await openAuthorize(await register(local), local);
    expect(page.res.status).toBe(200);
    expect(page.html).toContain("an app on this computer");
  });

  it("pauses sign-in after repeated wrong passwords", async () => {
    const page = await openAuthorize(await register());
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect((await submit(page, { decision: "approve", password: `guess-${i}` })).status).toBe(401);
    }
    const locked = await submit(page, { decision: "approve", password: PASSWORD });
    expect(locked.status).toBe(429);
  });

  it("refuses to sign anyone in before a password is set", async () => {
    delete env.OWNER_PASSWORD_HASH;
    const page = await openAuthorize(await register());
    expect(page.res.status).toBe(503);
  });

  it("rejects a forged or replayed form", async () => {
    const page = await openAuthorize(await register());
    const forged = await submit({ handle: page.handle, cookie: "" }, { decision: "approve", password: PASSWORD });
    expect(forged.status).toBe(400);
    expect((await submit(page, { decision: "approve", password: PASSWORD })).status).toBe(302);
    expect((await submit(page, { decision: "approve", password: PASSWORD })).status).toBe(400);
  });
});
