// Worker entry point.
//
// The MCP endpoint is https://<host>/mcp, behind OAuth (see auth.ts): clients
// discover the authorization server from the 401, register themselves, send
// the owner to /authorize once, and refresh their own tokens afterwards.
// The only other data route is /public/last-workout (see public.ts), off unless
// PUBLIC_LAST_WORKOUT is "true".
// Observability logging is off: it would record request URLs and headers.

import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";

import { handleAuthorize, OWNER_ID, page, SCOPE } from "./auth";
import { handleMcp } from "./mcp";
import { LAST_WORKOUT_PATH, lastWorkout } from "./public";
import { runSync } from "./sync";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  PUBLIC_HOST: string;
  /** "true" turns on /public/last-workout (see public.ts). */
  PUBLIC_LAST_WORKOUT?: string;
  OWNER_PASSWORD_HASH?: string;
}

const DAY = 24 * 60 * 60;

const mcpApi: ExportedHandler<Env> = {
  // Only reached with a valid access token; the provider checked its audience.
  fetch(request, env, ctx) {
    const auth = (ctx as unknown as { auth?: { scope: string[]; userId?: string } }).auth;
    if (!auth?.scope.includes(SCOPE) || auth.userId !== OWNER_ID) {
      return new Response("Forbidden", { status: 403 });
    }
    return handleMcp(request, env.DB);
  },
};

const site: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== env.PUBLIC_HOST) return new Response("Bad Request", { status: 400 });

    if (url.pathname === "/healthz") return Response.json({ ok: true });
    if (url.pathname === "/authorize") return handleAuthorize(request, env);
    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      return page(
        "Hevy connector",
        "<h1>Hevy connector</h1>" +
          "<p>This is a private connector that lets Claude read Hevy workout history and build routines.</p>" +
          "<p>There's nothing to browse here. Claude connects to it directly, after its owner signs in.</p>",
      );
    }
    if (
      url.pathname === LAST_WORKOUT_PATH &&
      env.PUBLIC_LAST_WORKOUT === "true" &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return lastWorkout(env.DB);
    }
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
    }
    return new Response("Not Found", { status: 404 });
  },
};

function provider(env: Env): OAuthProvider<Env> {
  const origin = `https://${env.PUBLIC_HOST}`;
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpApi as ExportedHandler<Env> & { fetch: NonNullable<ExportedHandler<Env>["fetch"]> },
    defaultHandler: site,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [SCOPE],
    requiredScopes: [SCOPE],
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      resource_name: "Hevy",
    },
    // Sign in once: a grant lives while Claude keeps using it, and lapses
    // after 90 idle days.
    refreshTokenTTL: 90 * DAY,
    refreshTokenIdleTTL: 90 * DAY,
  });
}

// One provider per isolate; PUBLIC_HOST never changes within one.
let cached: OAuthProvider<Env> | null = null;

/** A person opening the MCP address in a browser, as opposed to an MCP client. */
function isBrowserVisit(request: Request): boolean {
  return (
    request.method === "GET" &&
    !request.headers.has("Authorization") &&
    (request.headers.get("Accept") ?? "").includes("text/html")
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    cached ??= provider(env);
    const response = await cached.fetch(request, env, ctx);

    // The 401 for /mcp has no body, so a browser shows its own error page.
    // Give people a readable one; the status and WWW-Authenticate challenge
    // that MCP clients rely on stay exactly as the provider set them.
    if (response.status === 401 && new URL(request.url).pathname === "/mcp" && isBrowserVisit(request)) {
      const headers = new Headers(response.headers);
      const origin = `https://${env.PUBLIC_HOST}`;
      return page(
        "Hevy connector",
        "<h1>Sign in through Claude</h1>" +
          "<p>This address is a Claude connector for Hevy, not a web page, so a browser has nothing to show here.</p>" +
          "<p>To use it, sign in from Claude instead:</p>" +
          "<ol>" +
          "<li>On <strong>claude.ai</strong>, open <strong>Settings &rarr; Connectors</strong>.</li>" +
          `<li>Choose <strong>Add custom connector</strong> and enter <strong>${origin}/mcp</strong>.</li>` +
          "<li>Claude opens this site's sign-in page. Enter the connector password there.</li>" +
          "</ol>" +
          "<p>Only the owner has the password.</p>",
        401,
        headers,
      );
    }
    return response;
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runSync(env.DB).then((result) => {
        // Counts only: never log tokens or payloads.
        const { added, updated, unchanged, error } = result as Record<string, unknown>;
        console.log(JSON.stringify(error ? { sync: "failed", error } : { sync: "ok", added, updated, unchanged }));
      }),
    );
    // Once a day, sweep expired grants and tokens out of KV.
    if (new Date(controller.scheduledTime).getUTCHours() === 9) {
      cached ??= provider(env);
      ctx.waitUntil(cached.purgeExpiredData(env).then((r) => console.log(JSON.stringify({ oauth_purge: r }))));
    }
  },
} satisfies ExportedHandler<Env>;
