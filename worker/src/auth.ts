// The connector's sign-in: an OAuth 2.1 authorization server (Cloudflare's
// workers-oauth-provider) whose /authorize page asks for one owner password.
//
// claude.ai registers itself, sends the owner here once, and then keeps
// refreshing its own tokens, so the password is typed on this page and never
// into a chat. The password is stored only as a PBKDF2 hash in the
// OWNER_PASSWORD_HASH Worker secret (set by worker/set-password.ps1).
//
// Two extra rules on top of the library's checks:
// * Access may only be sent to Claude: claude.ai, claude.com, or a loopback
//   address for Claude Code. A lookalike client that registers itself can't
//   receive a token even if the owner is tricked into signing in.
// * Wrong passwords are rate-limited across all clients.

import { AuthorizationError, CimdFetchError, type ConsentDescription, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";

import { getState, setState } from "./db";

export const OWNER_ID = "owner";
export const SCOPE = "hevy";

// Where an authorization may send its code. Loopback is Claude Code on this PC.
export const ALLOWED_REDIRECT_HOSTS = new Set(["claude.ai", "claude.com"]);

export function redirectAllowed(details: Pick<ConsentDescription, "redirectHost" | "redirectIsLoopback">): boolean {
  return details.redirectIsLoopback || ALLOWED_REDIRECT_HOSTS.has(details.redirectHost.toLowerCase());
}

// --- password -------------------------------------------------------------

// Workers cap PBKDF2 at 100,000 iterations.
export const PBKDF2_ITERATIONS = 100_000;

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** "pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>", the format set-password.ps1 writes. */
export async function hashPassword(password: string, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<string> {
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}

export async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  const expected = unb64(parts[3]);
  const actual = await pbkdf2(password, unb64(parts[2]), iterations);
  let diff = expected.length ^ actual.length;
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) diff |= (expected[i] ?? 0) ^ (actual[i] ?? 0);
  return diff === 0;
}

// --- rate limit -------------------------------------------------------------

export const MAX_FAILURES = 10;
export const FAILURE_WINDOW_MS = 60 * 60 * 1000;

interface Failures {
  count: number;
  since: number;
}

async function readFailures(db: D1Database): Promise<Failures> {
  try {
    const parsed = JSON.parse((await getState(db, "auth_failures")) ?? "") as Failures;
    if (Date.now() - parsed.since < FAILURE_WINDOW_MS) return parsed;
  } catch {
    // no record, or an unreadable one: start fresh
  }
  return { count: 0, since: Date.now() };
}

async function lockedUntil(db: D1Database): Promise<number | null> {
  const f = await readFailures(db);
  return f.count >= MAX_FAILURES ? f.since + FAILURE_WINDOW_MS : null;
}

async function recordFailure(db: D1Database): Promise<void> {
  const f = await readFailures(db);
  await setState(db, "auth_failures", JSON.stringify({ count: f.count + 1, since: f.since }));
}

// --- the page ---------------------------------------------------------------

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A small self-contained HTML page in the site's style. `body` must already be escaped. */
export function page(title: string, body: string, status = 200, headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex");
  return new Response(
    `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --text: #16181d; --muted: #5d6470; --line: #d9dde3; --accent: #1f6feb; --warn: #9a5b00; --err: #b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg: #121417; --card: #1b1e23; --text: #e8eaed; --muted: #a0a6b0; --line: #343a43; --accent: #4c8dff; --warn: #f0b04a; --err: #ff6b5e; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
  h1 { font-size: 1.3rem; margin: 0 0 12px; }
  p { margin: 0 0 12px; color: var(--muted); }
  strong { color: var(--text); }
  .warn { color: var(--warn); }
  .err { color: var(--err); font-weight: 600; }
  label { display: block; font-weight: 600; margin: 16px 0 6px; }
  input[type=password] { width: 100%; padding: 10px 12px; font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; }
  .row { display: flex; gap: 10px; margin-top: 18px; }
  button { flex: 1; padding: 10px 14px; font: inherit; font-weight: 600; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--text); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
</style>
<main>${body}</main>
</html>`,
    { status, headers },
  );
}

function consentPage(details: ConsentDescription, handle: string, error?: string): string {
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  const local = details.redirectIsLoopback
    ? `<p class="warn">This sends access to an app on this computer (Claude Code). Continue only if you just started connecting from it.</p>`
    : "";
  return `<h1>Connect ${escape(details.clientName)} to your Hevy data?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
<p>It will be able to read your workout history and create, edit, and delete your Hevy routines.</p>
${local}
${error ? `<p class="err">${escape(error)}</p>` : ""}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <label for="password">Connector password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
  <div class="row">
    <button class="primary" name="decision" value="approve">Allow</button>
    <button name="decision" value="deny" formnovalidate>Deny</button>
  </div>
</form>`;
}

export interface AuthEnv {
  DB: D1Database;
  OAUTH_PROVIDER: OAuthHelpers;
  OWNER_PASSWORD_HASH?: string;
}

/** GET and POST /authorize. */
export async function handleAuthorize(request: Request, env: AuthEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (!env.OWNER_PASSWORD_HASH) {
      return page(
        "Not set up",
        "<h1>Sign-in isn't set up yet</h1><p>Run <strong>worker\\set-password.ps1</strong> on the owner's PC first.</p>",
        503,
      );
    }

    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      if (!redirectAllowed(details)) {
        return page(
          "Not allowed",
          `<h1>This app can't connect</h1><p>Only Claude may connect to this server. This request would send access to <strong>${escape(details.redirectHost)}</strong>.</p>`,
          403,
        );
      }
      const consent = await oauth.beginConsent(authRequest);
      return page(`Connect ${details.clientName}`, consentPage(details, consent.handle), 200, consent.headers);
    }

    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });

    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");

    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    const until = await lockedUntil(env.DB);
    if (until) {
      const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
      return page("Locked", `<h1>Too many wrong passwords</h1><p>Sign-in is paused. Try again in ${minutes} minutes.</p>`, 429);
    }

    if (!(await verifyPassword(String(form.get("password") ?? ""), env.OWNER_PASSWORD_HASH))) {
      await recordFailure(env.DB);
      // The handle was not consumed, so the same page can be shown again.
      return page(
        "Wrong password",
        `<h1>Wrong password</h1><p>Go back and try again.</p><form><button type="button" onclick="history.back()">Back</button></form>`,
        401,
      );
    }

    const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
    // The approval is re-checked against the stored request, not the form.
    const details = await oauth.describeConsent(approved.request);
    if (!redirectAllowed(details)) return page("Not allowed", "<h1>This app can't connect</h1>", 403);

    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: OWNER_ID,
      metadata: { client: details.clientName, connected_at: new Date().toISOString() },
      scope: [SCOPE],
      props: { userId: OWNER_ID },
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message =
        error instanceof AuthorizationError
          ? error.description
          : "This app could not be verified.";
      return page(
        "Can't sign in",
        `<h1>This sign-in link didn't work</h1><p>${escape(message)}</p><p>Start connecting again from Claude.</p>`,
        400,
      );
    }
    throw error;
  }
}
