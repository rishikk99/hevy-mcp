// Read-only queries behind the MCP tools. Port of src/hevy_mcp/queries.py; the
// SQL is unchanged and results have the same shape, which a test checks against
// the Python output on the real history.
//
// volume_kg includes warmups and reconciles with Hevy; working_volume_kg
// excludes them. Muscle exposure is deliberately separate: it credits primary
// and secondary muscles and does not sum to tonnage.

import {
  DEFAULT_WORKOUTS,
  MAX_EXERCISES,
  MAX_EXERCISE_HISTORY_SETS,
  MAX_PRS,
  MAX_VOLUME_BUCKETS,
  MAX_WORKOUTS,
  TIMEZONE,
} from "./config";
import { getState } from "./db";
import { bestMatch } from "./matching";
import { pyRound } from "./pyjson";

type Row = Record<string, any>;
type Result = Record<string, unknown>;

export class InvalidArgument extends Error {}

async function all(db: D1Database, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.prepare(sql).bind(...params).all<Row>()).results;
}

async function first(db: D1Database, sql: string, params: unknown[] = []): Promise<Row | null> {
  return db.prepare(sql).bind(...params).first<Row>();
}

async function cacheMeta(db: D1Database): Promise<Result> {
  const meta: Result = {
    // Dates and workout times are in this zone; last_sync_at stays UTC.
    timezone: TIMEZONE,
    last_sync_at: await getState(db, "last_sync_at"),
    cached_workouts: (await first(db, "SELECT COUNT(*) AS n FROM raw_workouts"))!.n,
  };
  // Set by a failed sync and cleared by the next good one, so the answer itself
  // says when the data is going stale.
  const syncError = await getState(db, "last_sync_error");
  if (syncError) meta.sync_error = syncError;
  return meta;
}

function dateClause(startDate?: string | null, endDate?: string | null, column = "date"): [string, unknown[]] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (startDate) {
    clauses.push(`${column} >= ?`);
    params.push(startDate);
  }
  if (endDate) {
    clauses.push(`${column} <= ?`);
    params.push(endDate);
  }
  return [clauses.join(" AND "), params];
}

const round = (value: unknown, places: number) => (typeof value === "number" ? pyRound(value, places) : value);

/** Drop nulls so tool output stays small in a context window. */
function compact(row: Result): Result {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined));
}

const clamp = (value: number, max: number) => Math.max(1, Math.min(Math.trunc(value), max));

// --- workouts --------------------------------------------------------------

export async function getWorkouts(
  db: D1Database,
  opts: { start_date?: string | null; end_date?: string | null; limit?: number } = {},
): Promise<Result> {
  const limit = clamp(opts.limit ?? DEFAULT_WORKOUTS, MAX_WORKOUTS);
  const [where, params] = dateClause(opts.start_date, opts.end_date);
  const whereSql = where ? `WHERE ${where}` : "";

  const total = (await first(db, `SELECT COUNT(*) AS n FROM v_workout ${whereSql}`, params))!.n as number;
  const rows = await all(
    db,
    `SELECT * FROM v_workout ${whereSql} ORDER BY date DESC, start_time DESC LIMIT ?`,
    [...params, limit],
  );

  const workouts = rows.map((r) =>
    compact({
      id: r.workout_id,
      date: r.date,
      start: r.start_time,
      end: r.end_time,
      name: r.name,
      duration_s: r.duration_seconds,
      exercises: r.exercise_count,
      sets: r.set_count,
      volume_kg: round(r.volume_kg, 1),
      working_volume_kg: round(r.working_volume_kg, 1),
      calories: r.calories,
      note: r.description,
      nth: r.nth_workout,
    }),
  );

  return {
    workouts,
    returned: workouts.length,
    total,
    truncated: total > workouts.length,
    limit,
    ...(await cacheMeta(db)),
  };
}

export async function getWorkoutDetail(db: D1Database, workoutId: string): Promise<Result> {
  const workout = await first(db, "SELECT * FROM v_workout WHERE workout_id = ?", [workoutId]);
  if (!workout) return { error: "not_found", workout_id: workoutId, ...(await cacheMeta(db)) };

  // Three queries for the whole workout rather than two per exercise.
  const exerciseRows = await all(
    db,
    "SELECT we.position, we.title, we.notes, we.rest_seconds, " +
      "       e.muscle_group, e.exercise_type, e.equipment_category " +
      "FROM workout_exercise we LEFT JOIN exercise e ON e.template_id = we.template_id " +
      "WHERE we.workout_id = ? ORDER BY we.position",
    [workoutId],
  );
  const setRows = await all(db, "SELECT * FROM v_set WHERE workout_id = ? ORDER BY position, set_index", [workoutId]);
  const prRows = await all(
    db,
    "SELECT position, pr_type, value FROM personal_record WHERE workout_id = ? ORDER BY position, pr_type",
    [workoutId],
  );

  const exercises = exerciseRows.map((row) => {
    const sets = setRows
      .filter((s) => s.position === row.position)
      .map((s) =>
        compact({
          set: s.set_index,
          type: s.set_type,
          kg: round(s.weight_kg, 2),
          lb: s.weight_lb,
          reps: s.reps,
          rpe: s.rpe,
          distance_m: s.distance_m,
          duration_s: s.duration_s,
          steps: s.custom_metric,
        }),
      );
    const prs = prRows
      .filter((p) => p.position === row.position)
      .map((p) => ({ type: p.pr_type, value: round(p.value, 2) }));
    return compact({
      position: row.position,
      exercise: row.title,
      muscle_group: row.muscle_group,
      type: row.exercise_type,
      equipment: row.equipment_category,
      rest_s: row.rest_seconds,
      notes: row.notes,
      sets,
      prs: prs.length ? prs : null,
    });
  });

  return {
    workout: compact({
      id: workout.workout_id,
      date: workout.date,
      start: workout.start_time,
      end: workout.end_time,
      name: workout.name,
      duration_s: workout.duration_seconds,
      volume_kg: round(workout.volume_kg, 1),
      working_volume_kg: round(workout.working_volume_kg, 1),
      calories: workout.calories,
      note: workout.description,
      nth: workout.nth_workout,
    }),
    exercises,
    ...(await cacheMeta(db)),
  };
}

// --- exercises -------------------------------------------------------------

async function knownExerciseNames(db: D1Database): Promise<string[]> {
  return (await all(db, "SELECT title FROM exercise ORDER BY title")).map((r) => r.title as string);
}

/** Python's repr() of a str, as used in the "no match" messages. */
function pyQuote(text: string): string {
  const escaped = text.replace(/\\/g, "\\\\");
  if (text.includes("'") && !text.includes('"')) return `"${escaped}"`;
  return `'${escaped.replace(/'/g, "\\'")}'`;
}

export async function getExerciseHistory(
  db: D1Database,
  exerciseName: string,
  opts: { start_date?: string | null; end_date?: string | null; limit?: number } = {},
): Promise<Result> {
  const limit = clamp(opts.limit ?? MAX_EXERCISE_HISTORY_SETS, MAX_EXERCISE_HISTORY_SETS);
  const names = await knownExerciseNames(db);

  if (!names.length) {
    return {
      query: exerciseName,
      matched: null,
      sets: [],
      returned: 0,
      total: 0,
      truncated: false,
      ...(await cacheMeta(db)),
    };
  }

  const [match, alternatives] = bestMatch(exerciseName, names);
  if (!match) {
    return {
      query: exerciseName,
      matched: null,
      message: `No exercise in your history matched ${pyQuote(exerciseName)}.`,
      known_exercise_count: names.length,
      sets: [],
      returned: 0,
      total: 0,
      truncated: false,
      ...(await cacheMeta(db)),
    };
  }

  const [where, params] = dateClause(opts.start_date, opts.end_date);
  const whereSql = where ? `AND ${where}` : "";

  const total = (await first(db, `SELECT COUNT(*) AS n FROM v_set WHERE exercise = ? ${whereSql}`, [
    match.name,
    ...params,
  ]))!.n as number;
  const rows = await all(
    db,
    `SELECT * FROM v_set WHERE exercise = ? ${whereSql} ORDER BY date DESC, workout_id, set_index LIMIT ?`,
    [match.name, ...params, limit],
  );
  const meta = await first(
    db,
    "SELECT muscle_group, exercise_type, equipment_category FROM exercise WHERE title = ?",
    [match.name],
  );

  const sets = rows.map((r) =>
    compact({
      date: r.date,
      set: r.set_index,
      type: r.set_type,
      kg: round(r.weight_kg, 2),
      lb: r.weight_lb,
      reps: r.reps,
      rpe: r.rpe,
      distance_m: r.distance_m,
      duration_s: r.duration_s,
      steps: r.custom_metric,
    }),
  );

  return compact({
    query: exerciseName,
    matched: match.name,
    match_score: match.score,
    match_how: match.how,
    alternatives: alternatives.map((m) => m.name),
    muscle_group: meta ? meta.muscle_group : null,
    exercise_type: meta ? meta.exercise_type : null,
    equipment: meta ? meta.equipment_category : null,
    sets,
    returned: sets.length,
    total,
    truncated: total > sets.length,
    ...(await cacheMeta(db)),
  });
}

export async function listExercises(db: D1Database): Promise<Result> {
  let rows = await all(
    db,
    "SELECT e.title AS name, e.muscle_group, e.exercise_type, e.equipment_category, " +
      "       MIN(s.start_date) AS first_seen, MAX(s.start_date) AS last_seen, " +
      "       COUNT(*) AS total_sets, COUNT(DISTINCT s.workout_id) AS workouts " +
      "FROM workout_set s JOIN exercise e ON e.template_id = s.template_id " +
      "GROUP BY e.template_id ORDER BY total_sets DESC, name LIMIT ?",
    [MAX_EXERCISES + 1],
  );
  const truncated = rows.length > MAX_EXERCISES;
  rows = rows.slice(0, MAX_EXERCISES);

  return {
    exercises: rows.map((r) => ({
      name: r.name,
      muscle_group: r.muscle_group,
      type: r.exercise_type,
      equipment: r.equipment_category,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      workouts: r.workouts,
      total_sets: r.total_sets,
    })),
    returned: rows.length,
    truncated,
    max_exercises: MAX_EXERCISES,
    ...(await cacheMeta(db)),
  };
}

// --- aggregates ------------------------------------------------------------

function bucketExpr(period: string, column = "date"): string {
  return period === "week" ? `strftime('%Y-W%W', ${column})` : `strftime('%Y-%m', ${column})`;
}

const GROUP_EXPR: Record<string, string> = {
  muscle_group: "COALESCE(muscle_group, 'unknown')",
  exercise: "exercise",
  equipment: "COALESCE(equipment_category, 'unknown')",
};

export async function getVolumeSummary(
  db: D1Database,
  opts: { period?: string; start_date?: string | null; end_date?: string | null; group_by?: string | null } = {},
): Promise<Result> {
  const period = opts.period ?? "week";
  const groupBy = opts.group_by ?? null;
  if (period !== "week" && period !== "month") throw new InvalidArgument("period must be 'week' or 'month'");
  if (groupBy !== null && !(groupBy in GROUP_EXPR)) {
    throw new InvalidArgument("group_by must be None, 'muscle_group', 'exercise', or 'equipment'");
  }

  const [where, params] = dateClause(opts.start_date, opts.end_date);
  const whereSql = where ? `WHERE ${where}` : "";
  const groupExpr = groupBy ? GROUP_EXPR[groupBy] : "NULL";

  let rows = await all(
    db,
    `SELECT ${bucketExpr(period)} AS bucket, ${groupExpr} AS grp, ` +
      `       COUNT(*) AS sets, ` +
      `       COALESCE(SUM(reps), 0) AS reps, ` +
      `       COALESCE(SUM(volume_kg), 0.0) AS volume_kg, ` +
      `       COALESCE(SUM(working_volume_kg), 0.0) AS working_volume_kg, ` +
      `       COUNT(DISTINCT workout_id) AS workouts ` +
      `FROM v_set ${whereSql} ` +
      `GROUP BY bucket, grp ORDER BY bucket DESC, volume_kg DESC LIMIT ?`,
    [...params, MAX_VOLUME_BUCKETS + 1],
  );
  const truncated = rows.length > MAX_VOLUME_BUCKETS;
  rows = rows.slice(0, MAX_VOLUME_BUCKETS);

  const buckets = rows.map((r) => {
    const entry: Result = {
      period: r.bucket,
      workouts: r.workouts,
      sets: r.sets,
      reps: r.reps,
      volume_kg: pyRound(r.volume_kg, 1),
      working_volume_kg: pyRound(r.working_volume_kg, 1),
    };
    if (groupBy) entry.group = r.grp;
    return entry;
  });

  return {
    period,
    group_by: groupBy,
    metric_note:
      "volume_kg includes warmup sets and matches Hevy's own total; working_volume_kg excludes them.",
    buckets,
    returned: buckets.length,
    truncated,
    max_buckets: MAX_VOLUME_BUCKETS,
    ...(await cacheMeta(db)),
  };
}

export async function getMuscleExposure(
  db: D1Database,
  opts: { period?: string; start_date?: string | null; end_date?: string | null; role?: string | null } = {},
): Promise<Result> {
  const period = opts.period ?? "month";
  const role = opts.role ?? null;
  if (period !== "week" && period !== "month") throw new InvalidArgument("period must be 'week' or 'month'");
  if (role !== null && role !== "primary" && role !== "secondary") {
    throw new InvalidArgument("role must be None, 'primary', or 'secondary'");
  }

  const [where, params] = dateClause(opts.start_date, opts.end_date);
  const clauses = where ? [where] : [];
  if (role) {
    clauses.push("role = ?");
    params.push(role);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  let rows = await all(
    db,
    `SELECT ${bucketExpr(period)} AS bucket, muscle, role, ` +
      `       COUNT(*) AS sets, ` +
      `       COALESCE(SUM(volume_kg), 0.0) AS exposure_kg, ` +
      `       COALESCE(SUM(working_volume_kg), 0.0) AS working_exposure_kg ` +
      `FROM v_muscle_exposure ${whereSql} ` +
      `GROUP BY bucket, muscle, role ORDER BY bucket DESC, exposure_kg DESC LIMIT ?`,
    [...params, MAX_VOLUME_BUCKETS + 1],
  );
  const truncated = rows.length > MAX_VOLUME_BUCKETS;
  rows = rows.slice(0, MAX_VOLUME_BUCKETS);

  return {
    period,
    role,
    metric_note:
      "Exposure credits each set to its primary and secondary muscles, so it " +
      "double-counts and does NOT equal tonnage. Use get_volume_summary for volume.",
    buckets: rows.map((r) => ({
      period: r.bucket,
      muscle: r.muscle,
      role: r.role,
      sets: r.sets,
      exposure_kg: pyRound(r.exposure_kg, 1),
      working_exposure_kg: pyRound(r.working_exposure_kg, 1),
    })),
    returned: rows.length,
    truncated,
    ...(await cacheMeta(db)),
  };
}

export async function getPersonalRecords(
  db: D1Database,
  opts: {
    exercise_name?: string | null;
    pr_type?: string | null;
    start_date?: string | null;
    end_date?: string | null;
    limit?: number;
  } = {},
): Promise<Result> {
  const limit = clamp(opts.limit ?? MAX_PRS, MAX_PRS);
  const [where, params] = dateClause(opts.start_date, opts.end_date);
  const clauses = where ? [where] : [];

  let matched: string | null = null;
  if (opts.exercise_name) {
    const [match] = bestMatch(opts.exercise_name, await knownExerciseNames(db));
    if (!match) {
      return {
        query: opts.exercise_name,
        matched: null,
        message: `No exercise in your history matched ${pyQuote(opts.exercise_name)}.`,
        records: [],
        returned: 0,
        truncated: false,
        ...(await cacheMeta(db)),
      };
    }
    matched = match.name;
    clauses.push("exercise = ?");
    params.push(matched);
  }

  if (opts.pr_type) {
    clauses.push("pr_type = ?");
    params.push(opts.pr_type);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  let rows = await all(
    db,
    `SELECT date, exercise, muscle_group, pr_type, value FROM v_pr ${whereSql} ` +
      `ORDER BY date DESC, exercise, pr_type LIMIT ?`,
    [...params, limit + 1],
  );
  const truncated = rows.length > limit;
  rows = rows.slice(0, limit);

  return compact({
    query: opts.exercise_name ?? null,
    matched,
    pr_type: opts.pr_type ?? null,
    records: rows.map((r) => ({
      date: r.date,
      exercise: r.exercise,
      muscle_group: r.muscle_group,
      type: r.pr_type,
      value: round(r.value, 2),
    })),
    returned: rows.length,
    truncated,
    ...(await cacheMeta(db)),
  });
}
