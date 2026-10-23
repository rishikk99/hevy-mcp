// The public last-workout summary: what it shows, and what it must never show.

import { describe, expect, it } from "vitest";

import worker, { type Env } from "../src/index";
import { lastWorkout, publicLabel } from "../src/public";
import { FakeD1 } from "./d1";
import { FakeKV } from "./kv";

const HOST = "hevy.example.com";
const ctx = () => ({ waitUntil: () => {}, passThroughOnException: () => {}, props: {} }) as unknown as ExecutionContext;

function seeded(name: string): FakeD1 {
  const db = new FakeD1();
  db.sqlite.exec(`
    INSERT INTO exercise (template_id, title, title_norm, muscle_group) VALUES
      ('A', 'Bench Press', 'bench press', 'chest'),
      ('B', 'Triceps Pushdown', 'triceps pushdown', 'triceps');
    INSERT INTO workout (workout_id, name, start_time, start_date, duration_seconds, set_count, payload_hash) VALUES
      ('old', 'Legs', '2026-10-10T18:00:00-05:00', '2026-10-10', 3000, 12, 'h1'),
      ('new', '${name.replace(/'/g, "''")}', '2026-10-16T19:30:00-05:00', '2026-10-16', 3840, 5, 'h2');
    INSERT INTO workout_set (workout_id, position, set_index, start_date, template_id) VALUES
      ('new', 0, 0, '2026-10-16', 'A'), ('new', 0, 1, '2026-10-16', 'A'), ('new', 0, 2, '2026-10-16', 'A'),
      ('new', 1, 0, '2026-10-16', 'B'), ('new', 1, 1, '2026-10-16', 'B');
  `);
  return db;
}

// 2026-10-18 12:00 in Chicago.
const NOW = Date.parse("2026-10-18T17:00:00Z");

describe("public last workout", () => {
  it("summarises the newest workout", async () => {
    const res = await lastWorkout(seeded("Push day").d1, NOW);
    expect(await res.json()).toEqual({ label: "Push", days_ago: 2, sets: 5, minutes: 64 });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("never publishes a free-text name", async () => {
    const res = await lastWorkout(seeded("3am crying session w/ Jake").d1, NOW);
    const body = await res.json();
    expect(body).toEqual({ label: "Chest & triceps", days_ago: 2, sets: 5, minutes: 64 });
    expect(JSON.stringify(body)).not.toMatch(/crying|Jake/);
  });

  it("labels from a fixed list only", () => {
    expect(publicLabel("Day C - Back", [])).toBe("Back");
    expect(publicLabel("FULL-BODY blast", [])).toBe("Full body");
    expect(publicLabel("pushing my luck", ["quadriceps"])).toBe("Quads");
    expect(publicLabel(null, [])).toBe("Workout");
  });

  it("is off unless the deployment turns it on", async () => {
    const env = { DB: seeded("Pull").d1, OAUTH_KV: new FakeKV().kv, PUBLIC_HOST: HOST } as Env;
    const res = await worker.fetch(new Request(`https://${HOST}/public/last-workout`), env, ctx());
    expect(res.status).toBe(404);
  });

  it("when on, is reachable without signing in, and nothing else is", async () => {
    const env = { DB: seeded("Pull").d1, OAUTH_KV: new FakeKV().kv, PUBLIC_HOST: HOST, PUBLIC_LAST_WORKOUT: "true" } as Env;
    const ok = await worker.fetch(new Request(`https://${HOST}/public/last-workout`), env, ctx());
    expect(ok.status).toBe(200);
    expect((await ok.json()).label).toBe("Pull");
    const other = await worker.fetch(new Request(`https://${HOST}/public/workouts`), env, ctx());
    expect(other.status).toBe(404);
  });

  it("says so when there are no workouts", async () => {
    const res = await lastWorkout(new FakeD1().d1, NOW);
    expect(res.status).toBe(404);
  });
});
