// The Worker must agree with the Python server on the real history. These read
// the local cache (.hevy/hevy.sqlite3, personal and gitignored) and are skipped
// where it does not exist, like the Python sample-fixture test.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { workoutStatements } from "../src/normalize";
import { payloadHash } from "../src/pyjson";
import * as queries from "../src/queries";
import { FakeD1 } from "./d1";

const LOCAL_DB = fileURLToPath(new URL("../../.hevy/hevy.sqlite3", import.meta.url));
const HAVE_LOCAL = existsSync(LOCAL_DB);

// Primary-key order, so both sides list rows identically.
const TABLES: Record<string, string> = {
  workout: "workout_id",
  workout_exercise: "workout_id, position",
  workout_set: "workout_id, position, set_index",
  personal_record: "workout_id, position, set_index, pr_type",
  exercise: "template_id",
  exercise_muscle: "template_id, muscle, role",
};

function rows(db: DatabaseSync, table: string) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${TABLES[table]}`).all().map((r) => ({ ...r }));
}

describe.skipIf(!HAVE_LOCAL)("equivalence with the Python cache", () => {
  const local = HAVE_LOCAL ? new DatabaseSync(LOCAL_DB, { readOnly: true }) : (null as unknown as DatabaseSync);
  const raw = HAVE_LOCAL
    ? (local.prepare("SELECT workout_id, payload, payload_hash FROM raw_workouts ORDER BY rowid").all() as {
        workout_id: string;
        payload: string;
        payload_hash: string;
      }[])
    : [];

  it("reproduces every stored payload hash byte for byte", async () => {
    expect(raw.length).toBeGreaterThan(300);
    const mismatched: string[] = [];
    for (const r of raw) {
      if ((await payloadHash(JSON.parse(r.payload))) !== r.payload_hash) mismatched.push(r.workout_id);
    }
    expect(mismatched).toEqual([]);
  });

  it("normalizes every workout into exactly the rows Python wrote", () => {
    const fresh = new FakeD1();
    for (const r of raw) {
      for (const { sql, params } of workoutStatements(r.workout_id, JSON.parse(r.payload), r.payload_hash)) {
        fresh.sqlite.prepare(sql).run(...params);
      }
    }
    for (const table of Object.keys(TABLES)) {
      expect(rows(fresh.sqlite, table), table).toEqual(rows(local, table));
    }
  });

  it("still reconciles every workout with Hevy's own volume", () => {
    const off = local
      .prepare("SELECT COUNT(*) AS n FROM workout WHERE ABS(volume_kg - hevy_volume_kg) > 0.001")
      .get() as { n: number };
    expect(off.n).toBe(0);
  });
});

// Recorded by golden_queries.py from the Python server on the same cache.
const GOLDEN = fileURLToPath(new URL("./.golden.json", import.meta.url));

describe.skipIf(!HAVE_LOCAL || !existsSync(GOLDEN))("query output matches the Python server", () => {
  const cases = existsSync(GOLDEN)
    ? (JSON.parse(readFileSync(GOLDEN, "utf8")) as { tool: string; args: Record<string, any>; result: unknown }[])
    : [];
  const db = HAVE_LOCAL ? new FakeD1(LOCAL_DB, { migrate: false, readOnly: true }).d1 : (null as unknown as D1Database);

  const run = (tool: string, a: Record<string, any>) => {
    switch (tool) {
      case "get_workouts":
        return queries.getWorkouts(db, a);
      case "get_workout_detail":
        return queries.getWorkoutDetail(db, a.workout_id);
      case "get_exercise_history":
        return queries.getExerciseHistory(db, a.exercise_name, a);
      case "list_exercises":
        return queries.listExercises(db);
      case "get_volume_summary":
        return queries.getVolumeSummary(db, a);
      case "get_muscle_exposure":
        return queries.getMuscleExposure(db, a);
      case "get_personal_records":
        return queries.getPersonalRecords(db, a);
    }
    throw new Error(`unknown tool ${tool}`);
  };

  it.each(cases.map((c, i) => [`${i} ${c.tool} ${JSON.stringify(c.args)}`, c] as const))("%s", async (_, c) => {
    expect(await run(c.tool, c.args)).toEqual(c.result);
  });
});
