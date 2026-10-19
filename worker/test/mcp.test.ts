// The public surface: routing and sign-in at the edge, then the MCP handshake,
// the tool list, and argument checking behind it. Mirrors tests/test_server.py
// and tests/test_remote.py. The full OAuth flow is in auth.test.ts.

import { describe, expect, it } from "vitest";

import worker, { type Env } from "../src/index";
import { handleMcp, SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp";
import { FakeD1 } from "./d1";
import { FakeKV } from "./kv";

const HOST = "hevy.example.com";
const MCP_URL = `https://${HOST}/mcp`;

function env(db = new FakeD1()): Env {
  return { DB: db.d1, OAUTH_KV: new FakeKV().kv, PUBLIC_HOST: HOST } as Env;
}

const ctx = () => ({ waitUntil: () => {}, passThroughOnException: () => {}, props: {} }) as unknown as ExecutionContext;

const jsonRequest = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });

/** Through the whole Worker: routing and the OAuth gate. */
const edge = (url: string, body: unknown = { jsonrpc: "2.0", id: 1, method: "ping" }) =>
  worker.fetch(jsonRequest(url, body), env(), ctx());

/** Straight to the MCP handler, as an authenticated request reaches it. */
const post = (body: unknown, e = env()) => handleMcp(jsonRequest(MCP_URL, body), e.DB);

const rpc = async (method: string, params: unknown = {}, e = env()) =>
  (await (await post({ jsonrpc: "2.0", id: 1, method, params }, e)).json()) as Record<string, any>;

const callTool = async (name: string, args: unknown = {}, e = env()) => {
  const reply = await rpc("tools/call", { name, arguments: args }, e);
  return { ...reply.result, payload: JSON.parse(reply.result.content[0].text) };
};

describe("routing", () => {
  it("answers health checks without signing in", async () => {
    const res = await worker.fetch(new Request(`https://${HOST}/healthz`), env(), ctx());
    expect(await res.json()).toEqual({ ok: true });
  });

  it("asks for sign-in at /mcp rather than serving it openly", async () => {
    expect((await edge(MCP_URL)).status).toBe(401);
  });

  it("explains itself to a person who opens the site", async () => {
    const res = await worker.fetch(new Request(`https://${HOST}/`), env(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(await res.text()).toContain("private connector");
  });

  it("shows a browser a readable page at /mcp, keeping the sign-in challenge", async () => {
    const res = await worker.fetch(
      new Request(MCP_URL, { headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" } }),
      env(),
      ctx(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
    const html = await res.text();
    expect(html).toContain("Sign in through Claude");
    expect(html).toContain(`https://${HOST}/mcp`);
  });

  it("answers an MCP client's unsigned request exactly as before", async () => {
    const res = await edge(MCP_URL);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
    expect(await res.text()).not.toContain("<html");
  });

  it("serves nothing at the retired capability URL", async () => {
    expect((await edge(`https://${HOST}/${"s".repeat(43)}/mcp`)).status).toBe(404);
  });

  it.each([`https://${HOST}/admin`, `https://${HOST}/mcp-other`])("404s unknown paths: %s", async (url) => {
    expect((await edge(url)).status).toBe(404);
  });

  it("rejects other host names", async () => {
    const res = await worker.fetch(new Request("https://evil.example.com/healthz"), env(), ctx());
    expect(res.status).toBe(400);
  });
});
describe("MCP protocol", () => {
  it("negotiates the protocol version", async () => {
    const supported = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(supported.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "hevy" }, capabilities: { tools: {} } });
    const future = await rpc("initialize", { protocolVersion: "2099-01-01" });
    expect(future.result.protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
  });

  it("acknowledges notifications with 202 and no body", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("answers ping, and errors on unknown methods", async () => {
    expect((await rpc("ping")).result).toEqual({});
    expect((await rpc("resources/list")).error.code).toBe(-32601);
  });

  it("does not offer a GET stream", async () => {
    const res = await handleMcp(new Request(MCP_URL, { method: "GET" }), env().DB);
    expect(res.status).toBe(405);
  });

  it("handles a JSON-RPC batch", async () => {
    const res = await post([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    expect(((await res.json()) as unknown[]).length).toBe(2);
  });

  it("rejects malformed JSON", async () => {
    const res = await handleMcp(new Request(MCP_URL, { method: "POST", body: "{nope" }), env().DB);
    expect(res.status).toBe(400);
  });
});

describe("tools", () => {
  // Only routines can change. Workouts stay read-only: no tool may log,
  // edit, or delete one.
  const READ_ONLY = [
    "get_exercise_history",
    "get_muscle_exposure",
    "get_personal_records",
    "get_plan",
    "get_routine",
    "get_volume_summary",
    "get_workout_detail",
    "get_workouts",
    "list_exercises",
    "list_plans",
    "list_routines",
    "search_exercises",
  ];
  const CHANGES = [
    "create_routine_folder", "load_plan_day", "move_routine", "restore_plan",
    "save_plan", "save_routine", "save_routines_as_plan", "sync_workouts",
  ];
  const DESTRUCTIVE = ["delete_plan", "delete_routine", "delete_routine_folder"];

  it("lists exactly the expected tools, without authenticate, with honest annotations", async () => {
    const { tools } = (await rpc("tools/list")).result;
    expect(tools.map((t: { name: string }) => t.name).sort()).toEqual([...READ_ONLY, ...CHANGES, ...DESTRUCTIVE].sort());
    for (const tool of tools) {
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
      expect(tool.annotations.readOnlyHint, tool.name).toBe(READ_ONLY.includes(tool.name));
      if (!READ_ONLY.includes(tool.name)) {
        expect(tool.annotations.destructiveHint, tool.name).toBe(DESTRUCTIVE.includes(tool.name));
      }
    }
    expect(tools.filter((t: { name: string }) => /workout/.test(t.name) && !/^(get|sync)_/.test(t.name))).toEqual([]);
  });

  it("asks for confirmation on every routine change that is not trivially reversible", async () => {
    const { tools } = (await rpc("tools/list")).result;
    for (const name of ["save_routine", "delete_routine", "load_plan_day", "delete_plan", "restore_plan"]) {
      const tool = tools.find((t: { name: string }) => t.name === name);
      expect(tool.inputSchema.properties.confirm.default, name).toBe(false);
    }
  });

  it("publishes nullable folder ids as JSON Schema unions", async () => {
    const { tools } = (await rpc("tools/list")).result;
    const move = tools.find((t: { name: string }) => t.name === "move_routine");
    expect(move.inputSchema.properties.folder_id.type).toEqual(["integer", "null"]);
    expect(move.inputSchema.properties.folder_id.nullable).toBeUndefined();
  });

  it("answers from an empty database without the network", async () => {
    const e = env();
    expect((await callTool("get_workouts", {}, e)).payload.workouts).toEqual([]);
    expect((await callTool("list_exercises", {}, e)).payload.exercises).toEqual([]);
    expect((await callTool("get_exercise_history", { exercise_name: "bench" }, e)).payload.matched).toBeNull();
    expect((await callTool("get_volume_summary", { period: "month" }, e)).payload.buckets).toEqual([]);
  });

  it("reports a missing Hevy login as a tool error with the next step", async () => {
    const result = await callTool("sync_workouts");
    expect(result.isError).toBe(true);
    expect(result.payload).toMatchObject({ error: "auth_required" });
    expect(result.payload.next_step).toContain("push-login");
  });

  it.each([
    ["get_volume_summary", { period: "fortnight" }, "must be one of"],
    ["get_workouts", { limit: "ten" }, "must be an integer"],
    ["get_workout_detail", {}, "missing required argument"],
    ["get_workouts", { nonsense: 1 }, "unknown argument"],
  ])("rejects bad arguments to %s cleanly", async (name, args, message) => {
    const result = await callTool(name, args);
    expect(result.isError).toBe(true);
    expect(result.payload.error).toBe("invalid_argument");
    expect(result.payload.message).toContain(message);
  });

  it("errors on an unknown tool", async () => {
    expect((await rpc("tools/call", { name: "authenticate", arguments: {} })).error.code).toBe(-32602);
  });
});
