// Training plans: stored on the connector, loaded into Hevy one day at a time,
// never past the free 4-routine limit, and never into a routine the user
// didn't pick.

import { beforeEach, describe, expect, it } from "vitest";

import { FakeD1 } from "./d1";
import { callTool, FakeHevy, setup } from "./fake-hevy";

let db: FakeD1;
let hevy: FakeHevy;
const call = (name: string, args: Record<string, unknown> = {}) => callTool(db, hevy, name, args);

beforeEach(async () => {
  ({ db, hevy } = await setup());
});

// No weights: plans are usually written that way.
const BENCH = { exercise_template_id: "79D0BB3A", rest_seconds: 120, sets: [{ type: "warmup", reps: 10 }, { reps: 8 }, { reps: 8 }] };
const PULLDOWN = { exercise_template_id: "6A6C31A5", sets: [{ reps: 10 }, { reps: 10 }] };
const PLANK = { exercise_template_id: "C6C9B8A0", sets: [{ duration_s: 60 }] };

const BLOCK = {
  name: "Hypertrophy block",
  notes: "4 weeks, add a rep each week",
  days: [
    { label: "Week 1 Day A", title: "Upper A", exercises: [BENCH, PULLDOWN] },
    { label: "Week 1 Day B", title: "Core", notes: "Short day", exercises: [PLANK] },
    { label: "Week 2 Day A", title: "Upper A", exercises: [BENCH, PULLDOWN] },
  ],
};

async function savedBlock(): Promise<string> {
  const { payload } = await call("save_plan", BLOCK);
  return payload.plan.id;
}

describe("saving plans", () => {
  it("stores a plan without touching Hevy", async () => {
    const { payload, isError } = await call("save_plan", BLOCK);
    expect(isError).toBe(false);
    expect(payload).toMatchObject({ saved: true, action: "created" });
    expect(payload.plan.days).toEqual(["1. Week 1 Day A: Upper A", "2. Week 1 Day B: Core", "3. Week 2 Day A: Upper A"]);
    expect(hevy.writes).toEqual([]);
  });

  it("lists and shows plans with exercise names, and keeps weights empty as written", async () => {
    const id = await savedBlock();
    const list = (await call("list_plans")).payload;
    expect(list.plans).toHaveLength(1);
    expect(list.plans[0]).toMatchObject({ id, name: "Hypertrophy block", notes: "4 weeks, add a rep each week" });

    for (const key of [id, "Hypertrophy block", "hypertrophy BLOCK"]) {
      const plan = (await call("get_plan", { plan_id: key })).payload.plan;
      expect(plan.id).toBe(id);
      expect(plan.days[0].exercises[0]).toMatchObject({ exercise: "Bench Press (Barbell)", sets: BENCH.sets });
      expect(JSON.stringify(plan)).not.toContain("weight");
    }
  });

  it("reports every problem at once, naming the day", async () => {
    const { payload, isError } = await call("save_plan", {
      name: "Broken",
      days: [
        { label: "Day 1", title: "A", exercises: [{ exercise_template_id: "NOPE", sets: [{ reps: 5 }] }] },
        { label: "day 1", title: "", exercises: [{ exercise_template_id: "C6C9B8A0", sets: [{ reps: 5 }] }] },
      ],
    });
    expect(isError).toBe(true);
    expect(payload.error).toBe("invalid_plan");
    const text = payload.problems.join("\n");
    expect(text).toContain("day 1 (Day 1): exercise 1: unknown exercise_template_id 'NOPE'");
    expect(text).toContain("day 2 (day 1): label is used twice");
    expect(text).toContain("day 2 (day 1): needs a title");
    expect(text).toContain("Plank records duration only, not reps");
    expect((await call("list_plans")).payload.plans).toEqual([]);
  });

  it("refuses a second plan with the same name, and replaces one by id", async () => {
    const id = await savedBlock();
    const dupe = await call("save_plan", BLOCK);
    expect(dupe.payload).toMatchObject({ error: "already_exists", plan_id: id });

    const replaced = await call("save_plan", { ...BLOCK, plan_id: id, days: [BLOCK.days[1]] });
    expect(replaced.payload).toMatchObject({ saved: true, action: "updated" });
    expect((await call("get_plan", { plan_id: id })).payload.plan.days).toHaveLength(1);
  });

  it("deletes only after confirmation", async () => {
    const id = await savedBlock();
    const preview = await call("delete_plan", { plan_id: id });
    expect(preview.payload).toMatchObject({ saved: false, action: "delete" });
    expect((await call("list_plans")).payload.plans).toHaveLength(1);
    expect((await call("delete_plan", { plan_id: id, confirm: true })).payload).toMatchObject({ deleted: true });
    expect((await call("list_plans")).payload.plans).toEqual([]);
  });
});

describe("loading a day into Hevy", () => {
  beforeEach(() => {
    hevy.addRoutine("1. Chest Shoulders and Triceps", 308196);
    hevy.addRoutine("2. Back and Biceps", 308196);
    hevy.addRoutine("3. Legs and Abs", 308196);
  });

  it("previews first, then fills the free slot on confirm, by number or label", async () => {
    const id = await savedBlock();
    const preview = await call("load_plan_day", { plan_id: id, day: "Week 1 Day B" });
    expect(preview.payload).toMatchObject({ saved: false, action: "create", day: "Week 1 Day B: Core" });
    expect(hevy.writes).toEqual([]);

    const done = await call("load_plan_day", { plan_id: "Hypertrophy block", day: "2", confirm: true });
    expect(done.payload).toMatchObject({ saved: true, action: "created", plan: "Hypertrophy block" });
    expect(hevy.routines).toHaveLength(4);
    const loaded = hevy.routines.find((r) => r.title === "Core");
    expect(loaded.notes).toBe("Short day");
    expect(loaded.exercises[0].sets[0]).toMatchObject({ duration_seconds: 60, weight_kg: null });
  });

  it("asks which routine to replace when Hevy is full, and never picks one itself", async () => {
    const id = await savedBlock();
    await call("load_plan_day", { plan_id: id, day: "1", confirm: true });
    const before = JSON.stringify(hevy.routines);

    const { payload, isError } = await call("load_plan_day", { plan_id: id, day: "3", confirm: true });
    expect(isError).toBe(true);
    expect(payload.error).toBe("choose_routine");
    expect(payload.message).toContain("Do not guess");
    // The routine an earlier load of this plan created is flagged as a likely candidate.
    expect(payload.routines.filter((r: any) => r.from_this_plan).map((r: any) => r.title)).toEqual(["Upper A"]);
    expect(JSON.stringify(hevy.routines)).toBe(before);
  });

  it("replaces the routine the user chose, keeping its folder and place", async () => {
    const id = await savedBlock();
    const target = hevy.routines[2];
    const preview = await call("load_plan_day", { plan_id: id, day: "Week 2 Day A", routine_id: target.id });
    expect(preview.payload).toMatchObject({ saved: false, action: "update", routine_id: target.id });
    expect(preview.payload.changes).toEqual(expect.arrayContaining(['title: "3. Legs and Abs" -> "Upper A"']));

    await call("load_plan_day", { plan_id: id, day: "Week 2 Day A", routine_id: target.id, confirm: true });
    const after = hevy.routines.find((r) => r.id === target.id);
    expect(after).toMatchObject({ title: "Upper A", folder_id: 308196, index: 2 });
    expect(after.exercises.map((e: any) => e.title)).toEqual(["Bench Press (Barbell)", "Lat Pulldown (Cable)"]);
    expect(hevy.routines).toHaveLength(3);
    expect(hevy.writes.map((w) => `${w.method} ${w.path}`)).toEqual([`PUT /routine/${target.id}`]);
  });

  it("explains a missing plan or day instead of loading something else", async () => {
    const id = await savedBlock();
    expect((await call("load_plan_day", { plan_id: "Nope", day: "1" })).payload.error).toBe("not_found");
    const bad = await call("load_plan_day", { plan_id: id, day: "Week 9 Day Z" });
    expect(bad.payload.error).toBe("not_found");
    expect(bad.payload.days).toHaveLength(3);
    expect(hevy.writes).toEqual([]);
  });

  it("re-checks exercises at load time, in case the library changed", async () => {
    const id = await savedBlock();
    db.sqlite.exec("DELETE FROM exercise_template WHERE id = '6A6C31A5'");
    const { payload } = await call("load_plan_day", { plan_id: id, day: "1" });
    expect(payload.error).toBe("invalid_routine");
    expect(hevy.writes).toEqual([]);
  });
});

// --- setting routines aside and bringing them back --------------------------

// Hevy-shaped exercises, as the routines endpoint returns them.
const hevyExercise = (id: string, title: string, sets: any[], extra: Record<string, unknown> = {}) => ({
  exercise_template_id: id,
  title,
  exercise_type: id === "C6C9B8A0" ? "duration" : "weight_reps",
  rest_seconds: 105,
  notes: "",
  superset_id: null,
  sets: sets.map((s, index) => ({
    index, indicator: "normal", weight_kg: null, reps: null, distance_meters: null,
    duration_seconds: null, custom_metric: null, rpe: null, ...s,
  })),
  ...extra,
});

describe("save_routines_as_plan and restore_plan", () => {
  let ppl: string[];

  beforeEach(() => {
    ppl = [
      hevy.addRoutine("1. Push", 308196, [
        hevyExercise("79D0BB3A", "Bench Press (Barbell)", [
          { indicator: "warmup", weight_kg: 9.071858188712795, reps: 10 },
          { weight_kg: 61.235042773811365, reps: 8 },
        ], { rest_seconds: 150, notes: "Different machine" }),
      ]),
      hevy.addRoutine("2. Pull", 308196, [
        hevyExercise("6A6C31A5", "Lat Pulldown (Cable)", [{ weight_kg: 19.27769865101469, reps: 9 }], { superset_id: 0 }),
        hevyExercise("1B2B1E7C", "Pull Up", [{ reps: 8 }], { superset_id: 0 }),
      ]),
      hevy.addRoutine("3. Core", 308196, [hevyExercise("C6C9B8A0", "Plank", [{ duration_seconds: 60 }])]),
    ];
    hevy.addRoutine("Day C - Back", null, [hevyExercise("6A6C31A5", "Lat Pulldown (Cable)", [{ reps: 10 }])]);
  });

  /** What matters for "the same routine": everything save_routine can set. */
  const shape = (id: string) => {
    const r = hevy.routines.find((x) => x.id === id);
    return {
      title: r.title, folder_id: r.folder_id, index: r.index, notes: r.notes ?? null,
      exercises: r.exercises.map((e: any) => ({
        id: e.exercise_template_id, rest: e.rest_seconds, notes: e.notes || "", superset: e.superset_id ?? null,
        sets: e.sets.map((s: any) => [s.indicator, s.weight_kg, s.reps, s.duration_seconds]),
      })),
    };
  };

  async function saveAside() {
    const { payload } = await call("save_routines_as_plan", { name: "PPL backup", folder_id: 308196 });
    return payload;
  }

  /** "Replace PPL with something else": rewrite every PPL routine in place. */
  async function replacePpl() {
    for (const id of ppl) {
      await call("save_routine", { routine_id: id, title: "New program", exercises: [{ exercise_template_id: "C6C9B8A0", sets: [{ duration_s: 30 }] }], confirm: true });
    }
  }

  it("copies a folder exactly, in order, without touching Hevy", async () => {
    const saved = await saveAside();
    expect(saved).toMatchObject({ saved: true, copied_from: "PPL" });
    expect(saved.plan.days).toEqual(["1. 1. Push", "2. 2. Pull", "3. 3. Core"]);
    expect(hevy.writes).toEqual([]);

    const day = (await call("get_plan", { plan_id: "PPL backup" })).payload.plan.days[0];
    expect(day.exercises[0]).toMatchObject({
      rest_seconds: 150,
      notes: "Different machine",
      sets: [{ type: "warmup", weight_kg: 9.071858188712795, reps: 10 }, { type: "normal", weight_kg: 61.235042773811365, reps: 8 }],
    });
  });

  it("brings the folder back exactly after it was replaced, previewing first", async () => {
    const before = ppl.map(shape);
    await saveAside();
    await replacePpl();
    expect(shape(ppl[0]).title).toBe("New program");
    const writesBefore = hevy.writes.length;

    const preview = await call("restore_plan", { plan_id: "PPL backup" });
    expect(preview.payload).toMatchObject({ saved: false, action: "restore" });
    expect(preview.payload.steps.map((s: any) => s.action)).toEqual(["rewrite in place", "rewrite in place", "rewrite in place"]);
    expect(preview.payload.steps[0].changes).toContain('title: "New program" -> "1. Push"');
    expect(hevy.writes.length).toBe(writesBefore);

    const done = await call("restore_plan", { plan_id: "PPL backup", confirm: true });
    expect(done.payload).toMatchObject({ restored: true, routines: ["1. Push", "2. Pull", "3. Core"] });
    expect(ppl.map(shape)).toEqual(before);
    expect(hevy.routines).toHaveLength(4);
  });

  it("recreates deleted routines and their folder, in the original order", async () => {
    await saveAside();
    hevy.routines = hevy.routines.filter((r) => r.folder_id !== 308196);
    hevy.folders = [];

    const preview = await call("restore_plan", { plan_id: "PPL backup" });
    expect(preview.payload.creates_folders).toEqual(["PPL"]);
    expect(preview.payload.steps.map((s: any) => s.action)).toEqual(Array(3).fill("recreate in PPL"));

    await call("restore_plan", { plan_id: "PPL backup", confirm: true });
    const folder = hevy.folders.find((f) => f.title === "PPL");
    const back = hevy.routines.filter((r) => r.folder_id === folder.id).sort((a, b) => a.index - b.index);
    expect(back.map((r) => r.title)).toEqual(["1. Push", "2. Pull", "3. Core"]);
    expect(back[0].exercises[0].sets[1].weight_kg).toBe(61.235042773811365);

    // The plan now points at the new routines, so a second restore rewrites them in place.
    const again = await call("restore_plan", { plan_id: "PPL backup" });
    expect(again.payload.steps.map((s: any) => s.action)).toEqual(Array(3).fill("rewrite in place"));
  });

  it("asks rather than guesses when there's no room to recreate", async () => {
    await saveAside();
    hevy.routines = hevy.routines.filter((r) => r.folder_id !== 308196);
    hevy.addRoutine("Other 1", null);
    hevy.addRoutine("Other 2", null);
    hevy.addRoutine("Other 3", null);
    const before = JSON.stringify(hevy.routines);

    const { payload, isError } = await call("restore_plan", { plan_id: "PPL backup", confirm: true });
    expect(isError).toBe(true);
    expect(payload).toMatchObject({ error: "choose_routine", to_recreate: ["1. Push", "2. Pull", "3. Core"] });
    expect(payload.message).toContain("Do not guess");
    expect(JSON.stringify(hevy.routines)).toBe(before);
  });

  it("copies hand-picked routines, and refuses to restore a hand-written plan", async () => {
    const picked = await call("save_routines_as_plan", { name: "Two", routine_ids: [ppl[2], ppl[0]] });
    expect(picked.payload.plan.days).toEqual(["1. 3. Core", "2. 1. Push"]);

    const neither = await call("save_routines_as_plan", { name: "Bad" });
    expect(neither.payload.error).toBe("invalid_argument");
    const both = await call("save_routines_as_plan", { name: "Bad", folder_id: 308196, routine_ids: [ppl[0]] });
    expect(both.payload.error).toBe("invalid_argument");

    await call("save_plan", BLOCK);
    expect((await call("restore_plan", { plan_id: "Hypertrophy block" })).payload.error).toBe("not_a_copy");
  });
});