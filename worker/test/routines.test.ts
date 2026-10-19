// Routine tools against a fake Hevy that follows the request shapes recorded
// from hevy.com's routine editor (scripts/capture_routes.py).

import { beforeEach, describe, expect, it } from "vitest";

import { isAllowedRequest } from "../src/hevy";
import { FakeD1 } from "./d1";
import { callTool, FakeHevy, setup } from "./fake-hevy";
let db: FakeD1;
let hevy: FakeHevy;

beforeEach(async () => {
  ({ db, hevy } = await setup());
});

const call = (name: string, args: Record<string, unknown> = {}) => callTool(db, hevy, name, args);

const BENCH = { exercise_template_id: "79D0BB3A", rest_seconds: 120, notes: "test note", sets: [
  { type: "warmup", weight_lb: 135, reps: 8 }, { weight_lb: 135, reps: 8 }, { weight_lb: 135, reps: 8 },
] };
const PULLDOWN = { exercise_template_id: "6A6C31A5", sets: [{ weight_lb: 100, reps: 10 }, { weight_lb: 100, reps: 10 }] };

describe("the request allowlist", () => {
  it("lets routines and folders change, and nothing else", () => {
    expect(isAllowedRequest("POST", "/routine")).toBe(true);
    expect(isAllowedRequest("PUT", "/routine/f475d4c4-1d3e-497c-892b-1749d6277e0f")).toBe(true);
    expect(isAllowedRequest("DELETE", "/routine_folder/3867755")).toBe(true);
    expect(isAllowedRequest("PUT", "/routine_locations")).toBe(true);
    for (const [method, path] of [
      ["POST", "/workout"],
      ["PUT", "/workout/f475d4c4-1d3e-497c-892b-1749d6277e0f"],
      ["DELETE", "/workout/f475d4c4-1d3e-497c-892b-1749d6277e0f"],
      ["DELETE", "/user/account"],
      ["PUT", "/routine/../workout/x"],
      ["POST", "/routine_folder_order"],
    ] as const) {
      expect(isAllowedRequest(method, path), `${method} ${path}`).toBe(false);
    }
  });
});

describe("reading routines", () => {
  it("groups routines by folder in app order and reports the free limit", async () => {
    hevy.addRoutine("2. Back", 308196, [hevy["expand"]({ exercise_template_id: "6A6C31A5", sets: [{ index: 0, indicator: "normal" }] })]);
    hevy.addRoutine("1. Push", 308196);
    hevy.routines[1].index = 0;
    hevy.routines[0].index = 1;
    hevy.addRoutine("loose", null);
    const { payload } = await call("list_routines");
    expect(payload.folders.map((f: any) => [f.folder, f.routines.map((r: any) => r.title)])).toEqual([
      ["PPL", ["1. Push", "2. Back"]],
      ["My Routines", ["loose"]],
    ]);
    expect(payload.folders[0].routines[1].exercises).toEqual(["Lat Pulldown (Cable) (1 sets)"]);
    expect(payload).toMatchObject({ routine_count: 3, routine_limit: 4 });
    expect(payload.note).toBeUndefined();

    hevy.addRoutine("fourth", null);
    expect((await call("list_routines")).payload.note).toMatch(/at most 4/);
    hevy.pro = true;
    expect((await call("list_routines")).payload.routine_limit).toBeNull();
  });

  it("renders a routine with weights in kg and lb", async () => {
    const id = hevy.addRoutine("Push", 308196, [hevy["expand"]({
      exercise_template_id: "79D0BB3A", rest_seconds: 120, notes: "", sets: [
        { index: 0, indicator: "warmup", weight_kg: 61.235042773811365, reps: 8 },
      ],
    })]);
    const { payload } = await call("get_routine", { routine_id: id });
    expect(payload.routine).toMatchObject({ title: "Push", folder: "PPL" });
    expect(payload.routine.exercises[0]).toMatchObject({
      exercise: "Bench Press (Barbell)", rest_seconds: 120, sets: [{ type: "warmup", kg: 61.24, lb: 135, reps: 8 }],
    });
    expect((await call("get_routine", { routine_id: "nope" })).payload.error).toBe("not_found");
  });
});

describe("search_exercises", () => {
  it("ranks by match, then by what the user actually logs", async () => {
    const { payload } = await call("search_exercises", { query: "bench press" });
    expect(payload.exercises.slice(0, 2).map((e: any) => e.title)).toEqual(["Bench Press (Dumbbell)", "Bench Press (Barbell)"]);
    expect(payload.exercises[0]).toMatchObject({ exercise_template_id: "3601968B", times_logged: 2 });
  });

  it("understands Hevy's alternative names and keywords", async () => {
    expect((await call("search_exercises", { query: "humble row" })).payload.exercises[0].title).toBe(
      "Chest Supported Incline Row (Dumbbell)",
    );
    expect((await call("search_exercises", { query: "rdl" })).payload.exercises[0].title).toBe("Romanian Deadlift (Barbell)");
  });

  it("filters by muscle without a query", async () => {
    const { payload } = await call("search_exercises", { muscle_group: "lats" });
    expect(payload.exercises.map((e: any) => e.title).sort()).toEqual(["Lat Pulldown (Cable)", "Pull Up"]);
  });

  it("says so when the library was never loaded", async () => {
    db.sqlite.exec("DELETE FROM exercise_template");
    expect((await call("search_exercises", { query: "bench" })).payload.error).toBe("library_empty");
  });
});

describe("save_routine", () => {
  it("previews without writing anything", async () => {
    const { payload } = await call("save_routine", { title: "Claude test", exercises: [BENCH, PULLDOWN] });
    expect(payload).toMatchObject({ action: "create", saved: false });
    expect(payload.message).toMatch(/confirm=true/);
    expect(payload.preview.exercises[0].sets[0]).toEqual({ type: "warmup", kg: 61.24, lb: 135, reps: 8 });
    // The user's own default rest timer fills in where none was given.
    expect(payload.preview.exercises[1].rest_seconds).toBe(105);
    expect(hevy.writes).toEqual([]);
  });

  it("creates with exactly the body hevy.com sends", async () => {
    const { payload } = await call("save_routine", { title: "Claude test", exercises: [BENCH, PULLDOWN], confirm: true });
    expect(payload).toMatchObject({ saved: true, action: "created", routine: { title: "Claude test" } });
    expect(hevy.writes).toHaveLength(1);
    expect(hevy.writes[0]).toEqual({
      method: "POST",
      path: "/routine",
      body: {
        routine: {
          title: "Claude test",
          exercises: [
            {
              exercise_template_id: "79D0BB3A",
              rest_seconds: 120,
              sets: [
                { index: 0, indicator: "warmup", weight_kg: 61.235042773811365, reps: 8 },
                { index: 1, indicator: "normal", weight_kg: 61.235042773811365, reps: 8 },
                { index: 2, indicator: "normal", weight_kg: 61.235042773811365, reps: 8 },
              ],
              notes: "test note",
            },
            {
              exercise_template_id: "6A6C31A5",
              rest_seconds: 105,
              sets: [
                { index: 0, indicator: "normal", weight_kg: 45.35929094356398, reps: 10 },
                { index: 1, indicator: "normal", weight_kg: 45.35929094356398, reps: 10 },
              ],
              notes: "",
            },
          ],
          folder_id: null,
          index: 0,
          program_id: null,
          notes: null,
          coach_force_rpe_enabled: false,
        },
      },
    });
  });

  it("places a new routine in a folder after creating it", async () => {
    hevy.addRoutine("1. Push", 308196);
    await call("save_routine", { title: "2. Pull", exercises: [PULLDOWN], folder_id: 308196, confirm: true });
    expect(hevy.writes.map((w) => `${w.method} ${w.path}`)).toEqual(["POST /routine", "PUT /routine_locations"]);
    expect(hevy.writes[1].body.locations[0]).toMatchObject({ folderId: 308196, index: 1 });
  });

  it("refuses a fifth routine on a free account, and says what to do instead", async () => {
    for (const t of ["a", "b", "c", "d"]) hevy.addRoutine(t, null);
    const { payload, isError } = await call("save_routine", { title: "e", exercises: [PULLDOWN], confirm: true });
    expect(isError).toBe(true);
    expect(payload.error).toBe("routine_limit");
    expect(payload.routines).toHaveLength(4);
    expect(hevy.writes).toEqual([]);

    hevy.pro = true;
    expect((await call("save_routine", { title: "e", exercises: [PULLDOWN], confirm: true })).payload.saved).toBe(true);
  });

  it("updates in place, keeping the routine's folder, position, and program", async () => {
    const id = hevy.addRoutine("2. Back", 308196, [hevy["expand"]({ exercise_template_id: "6A6C31A5", rest_seconds: 90, notes: "", sets: [{ index: 0, indicator: "normal" }] })]);
    hevy.routines[0].index = 1;
    hevy.routines[0].program_id = "prog-1";

    const preview = (await call("save_routine", { routine_id: id, title: "2. Pull", exercises: [BENCH, PULLDOWN] })).payload;
    expect(preview.action).toBe("update");
    expect(preview.changes).toEqual([
      'title: "2. Back" -> "2. Pull"',
      "adds Bench Press (Barbell)",
      "Lat Pulldown (Cable): 1 -> 2 sets",
    ]);
    expect(hevy.writes).toEqual([]);

    await call("save_routine", { routine_id: id, title: "2. Pull", exercises: [BENCH, PULLDOWN], confirm: true });
    expect(hevy.writes).toHaveLength(1);
    expect(hevy.writes[0].method).toBe("PUT");
    expect(hevy.writes[0].path).toBe(`/routine/${id}`);
    expect(hevy.writes[0].body.routine).toMatchObject({ folder_id: 308196, index: 1, program_id: "prog-1", title: "2. Pull" });
  });

  it("renames without touching the exercises", async () => {
    const id = hevy.addRoutine("old", null, [hevy["expand"]({
      exercise_template_id: "79D0BB3A", rest_seconds: 120, notes: "keep", superset_id: 3,
      sets: [{ index: 0, indicator: "warmup", weight_kg: 60, reps: 8 }],
    })]);
    await call("save_routine", { routine_id: id, title: "new", confirm: true });
    expect(hevy.writes[0].body.routine.exercises).toEqual([
      { exercise_template_id: "79D0BB3A", rest_seconds: 120, superset_id: 3, notes: "keep",
        sets: [{ index: 0, indicator: "warmup", weight_kg: 60, reps: 8 }] },
    ]);
  });

  it("reports every problem at once, naming the exercise and set", async () => {
    const { payload, isError } = await call("save_routine", {
      title: "bad",
      exercises: [
        { exercise_template_id: "NOPE", sets: [{ reps: 5 }] },
        { exercise_template_id: "C6C9B8A0", sets: [{ weight_lb: 45, duration_s: 60 }] },
        { exercise_template_id: "79D0BB3A", sets: [{ weight_lb: 135, weight_kg: 60, reps: 8.5, type: "heavy" }] },
        { exercise_template_id: "6A6C31A5", sets: [] },
        { exercise_template_id: "243710DE", superset_id: 7, sets: [{ distance_mi: 1, duration_s: 600 }] },
      ],
    });
    expect(isError).toBe(true);
    expect(payload.error).toBe("invalid_routine");
    expect(payload.problems).toEqual([
      "exercise 1: unknown exercise_template_id 'NOPE'. Look it up with search_exercises.",
      "exercise 2 (Plank) set 1: Plank records duration only, not weight",
      "exercise 3 (Bench Press (Barbell)) set 1: type must be normal, warmup, failure, or dropset",
      "exercise 3 (Bench Press (Barbell)) set 1: give weight_kg or weight_lb, not both",
      "exercise 3 (Bench Press (Barbell)) set 1: reps and duration_s must be whole numbers",
      "exercise 4 (Lat Pulldown (Cable)): needs at least one set",
      "superset_id 7 is used by only one exercise",
    ]);
    expect(hevy.writes).toEqual([]);
  });

  it("converts cardio distances and accepts reps-only sets", async () => {
    const { payload } = await call("save_routine", {
      title: "cardio",
      exercises: [
        { exercise_template_id: "243710DE", sets: [{ distance_mi: 1, duration_s: 600 }] },
        { exercise_template_id: "1B2B1E7C", sets: [{ reps: 10 }] },
      ],
    });
    expect(payload.preview.exercises[0].sets[0]).toEqual({ type: "normal", distance_m: 1609.344, duration_s: 600 });
    expect(payload.preview.exercises[1].sets[0]).toEqual({ type: "normal", reps: 10 });
  });
});

describe("deleting and folders", () => {
  it("previews a delete, then deletes on confirm", async () => {
    const id = hevy.addRoutine("bye", null);
    const preview = (await call("delete_routine", { routine_id: id })).payload;
    expect(preview).toMatchObject({ action: "delete", saved: false, routine: { title: "bye" } });
    expect(hevy.writes).toEqual([]);
    expect((await call("delete_routine", { routine_id: id, confirm: true })).payload).toMatchObject({ deleted: true });
    expect(hevy.routines).toEqual([]);
  });

  it("creates folders, refuses duplicates, and only deletes empty ones", async () => {
    const created = (await call("create_routine_folder", { title: "Block 1" })).payload;
    expect(created).toMatchObject({ created: true, folder: { id: 3867755, title: "Block 1" } });
    expect((await call("create_routine_folder", { title: "block 1" })).payload.error).toBe("already_exists");

    const id = hevy.addRoutine("r", null);
    expect((await call("move_routine", { routine_id: id, folder_id: 3867755 })).payload).toMatchObject({ moved: true, folder: "Block 1" });
    expect((await call("delete_routine_folder", { folder_id: 3867755 })).payload.error).toBe("folder_not_empty");

    expect((await call("move_routine", { routine_id: id, folder_id: null })).payload.folder).toBe("My Routines");
    expect((await call("delete_routine_folder", { folder_id: 3867755 })).payload.deleted).toBe(true);
  });
});

describe("sharing the Hevy login", () => {
  it("waits for a running sync instead of refreshing the token alongside it", async () => {
    db.sqlite.exec(`INSERT INTO sync_state (key, value) VALUES ('sync_lease', '${Date.now() + 60_000}:sync')`);
    setTimeout(() => db.sqlite.exec("DELETE FROM sync_state WHERE key = 'sync_lease'"), 400);
    const started = Date.now();
    const { payload } = await call("list_routines");
    expect(payload.routine_count).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });
});
