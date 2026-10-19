// A stateful stand-in for Hevy's routine endpoints, shared by the routine and
// plan tests. Request shapes follow hevy.com's routine editor
// (scripts/capture_routes.py).

import { saveTokensStatement, type Tokens } from "../src/hevy";
import { handleMcp } from "../src/mcp";
import { FakeD1 } from "./d1";
export const TOKENS: Tokens = { access_token: "a1", refresh_token: "r1", user_id: "u1", expires_at: null };
const MCP_URL = "https://hevy.example/mcp";

// A handful of library rows, shaped like update_exercise_library.py writes them.
export const LIBRARY: [string, string, string, string, string | null, string | null][] = [
  // id, title, type, muscle, aka, tags
  ["79D0BB3A", "Bench Press (Barbell)", "weight_reps", "chest", null, "chest bb"],
  ["3601968B", "Bench Press (Dumbbell)", "weight_reps", "chest", null, "db"],
  ["6A6C31A5", "Lat Pulldown (Cable)", "weight_reps", "lats", null, null],
  ["2B4B7310", "Romanian Deadlift (Barbell)", "weight_reps", "hamstrings", null, "rdl bb"],
  ["E1F3AB98", "Chest Supported Incline Row (Dumbbell)", "weight_reps", "upper_back", "Humble Row", "db"],
  ["243710DE", "Treadmill", "distance_duration", "cardio", null, "running"],
  ["1B2B1E7C", "Pull Up", "reps_only", "lats", null, null],
  ["C6C9B8A0", "Plank", "duration", "abdominals", null, null],
];

export function seed(db: FakeD1) {
  const insert = db.sqlite.prepare(
    "INSERT INTO exercise_template (id, title, title_norm, muscle_group, other_muscles, exercise_type, " +
      "equipment_category, aka, tags, priority, is_custom, is_archived, full_bodyweight) " +
      "VALUES (?, ?, ?, ?, '[]', ?, NULL, ?, ?, 0, 0, 0, 0)",
  );
  for (const [id, title, type, muscle, aka, tags] of LIBRARY) {
    insert.run(id, title, title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean).join(" "), muscle, type, aka, tags);
  }
  // Two logged sets of dumbbell bench, so it outranks barbell for "bench".
  db.sqlite.exec(
    "INSERT INTO workout (workout_id, start_date, payload_hash) VALUES ('w1', '2026-10-01', 'h');" +
      "INSERT INTO workout_set (workout_id, position, set_index, start_date, template_id) VALUES " +
      "('w1', 0, 0, '2026-10-01', '3601968B'), ('w1', 0, 1, '2026-10-01', '3601968B');",
  );
}

/** A stateful stand-in for api.hevyapp.com's routine endpoints. */
export class FakeHevy {
  routines: any[] = [];
  folders: any[] = [{ id: 308196, title: "PPL", index: 0 }];
  pro = false;
  writes: { method: string; path: string; body: any }[] = [];
  calls: string[] = [];
  private seq = 0;

  addRoutine(title: string, folderId: number | null, exercises: any[] = []) {
    const id = `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`;
    this.routines.push({
      id, title, folder_id: folderId, index: this.routines.filter((r) => r.folder_id === folderId).length,
      notes: null, program_id: null, coach_force_rpe_enabled: false, updated_at: `2026-10-0${this.seq}T00:00:00Z`,
      exercises,
    });
    return id;
  }

  private expand(e: any) {
    const t = LIBRARY.find(([id]) => id === e.exercise_template_id)!;
    return {
      ...e, title: t[1], exercise_type: t[2], superset_id: e.superset_id ?? null,
      sets: e.sets.map((s: any) => ({ weight_kg: null, reps: null, distance_meters: null, duration_seconds: null, custom_metric: null, rpe: null, ...s })),
    };
  }

  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const path = url.pathname;
    const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.json();
    this.calls.push(`${req.method} ${path}`);
    if (req.method !== "GET" && path !== "/routines_sync_batch") this.writes.push({ method: req.method, path, body });
    const ok = (data: unknown, status = 200) => Response.json(data, { status });

    if (req.method === "POST" && path === "/routines_sync_batch") {
      return ok({ updated: this.routines, deleted: [], isMore: false, updated_at: "2026-10-13T00:00:00Z" });
    }
    if (path === "/routine_folders") return ok(this.folders);
    if (path === "/user_subscription") return ok({ is_pro: this.pro });
    if (path === "/v2/user_preferences") return ok({ default_rest_timer_seconds: 105, weight_unit: "lbs" });
    if (path === "/custom_exercise_templates") return ok([]);
    if (req.method === "POST" && path === "/routine") {
      const id = this.addRoutine(body.routine.title, body.routine.folder_id, body.routine.exercises.map((e: any) => this.expand(e)));
      this.routines.find((r) => r.id === id).notes = body.routine.notes;
      return ok({ routineId: id });
    }
    const one = /^\/routine\/(.+)$/.exec(path);
    if (one && req.method === "PUT") {
      const r = this.routines.find((x) => x.id === one[1]);
      Object.assign(r, { ...body.routine, exercises: body.routine.exercises.map((e: any) => this.expand(e)) });
      return ok({});
    }
    if (one && req.method === "DELETE") {
      this.routines = this.routines.filter((x) => x.id !== one[1]);
      return new Response(null, { status: 200 });
    }
    if (req.method === "POST" && path === "/routine_folder") {
      const folder = { id: 3867755, title: body.folder.title, index: 0 };
      this.folders.push(folder);
      return ok(folder, 201);
    }
    const folderPath = /^\/routine_folder\/(\d+)$/.exec(path);
    if (folderPath && req.method === "DELETE") {
      this.folders = this.folders.filter((f) => f.id !== Number(folderPath[1]));
      return new Response(null, { status: 200 });
    }
    if (req.method === "PUT" && path === "/routine_locations") {
      for (const loc of body.locations) Object.assign(this.routines.find((r) => r.id === loc.routineId), { folder_id: loc.folderId, index: loc.index });
      return ok({});
    }
    return ok({ error: "unexpected" }, 404);
  }) as typeof fetch;
}

/** A fresh database with the library seeded and a stored Hevy login. */
export async function setup(): Promise<{ db: FakeD1; hevy: FakeHevy }> {
  const db = new FakeD1();
  seed(db);
  await saveTokensStatement(db.d1, TOKENS).run();
  return { db, hevy: new FakeHevy() };
}

/** Call one MCP tool and return its parsed payload. */
export async function callTool(db: FakeD1, hevy: FakeHevy, name: string, args: Record<string, unknown> = {}) {
  const response = await handleMcp(
    new Request("https://hevy.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    db.d1,
    hevy.fetch,
  );
  const result = ((await response.json()) as any).result;
  return { payload: JSON.parse(result.content[0].text), isError: result.isError as boolean };
}