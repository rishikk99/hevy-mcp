// Routines: read them live from Hevy, and create, edit, move, or delete them
// the way hevy.com's routine editor does (request shapes recorded from it).
//
// Unlike workouts, routines are not cached: they are few, the user edits them
// in the app too, and a stale copy is exactly what an edit must not start from.
//
// Every change is two calls. Without confirm=true a tool only validates and
// returns a preview of what it would write; nothing reaches Hevy. That lets
// Claude show the user the plan before anything changes in their account.

import { DEFAULT_REST_SECONDS, FREE_ROUTINE_LIMIT, KG_PER_LB_DIVISOR, METERS_PER_MILE } from "./config";
import { getState, setState } from "./db";
import { HevyClient } from "./hevy";
import { scoreCandidate } from "./matching";
import { normalizeName } from "./normalize";
import { pyRound } from "./pyjson";

type Json = Record<string, any>;

export const SYNC_EVENT = { sendSyncEventToMobileApp: "true" };

// --- reading ---------------------------------------------------------------

export interface HevyRoutine {
  id: string;
  title: string;
  folder_id: number | null;
  index: number;
  notes: string | null;
  program_id: string | null;
  coach_force_rpe_enabled: boolean;
  updated_at: string;
  exercises: Json[];
}

export interface HevyFolder {
  id: number;
  title: string;
  index: number;
}

/** Every routine, via the sync endpoint the web app uses (it pages with isMore). */
export async function fetchRoutines(client: HevyClient): Promise<HevyRoutine[]> {
  const seen = new Map<string, HevyRoutine>();
  for (let page = 0; page < 10; page++) {
    const known = Object.fromEntries([...seen.values()].map((r) => [r.id, r.updated_at]));
    const batch = (await client.request("POST", "/routines_sync_batch", { body: known })) as Json;
    for (const r of batch?.updated ?? []) seen.set(r.id, r);
    for (const id of batch?.deleted ?? []) seen.delete(typeof id === "string" ? id : id?.id);
    if (!batch?.isMore) break;
  }
  return [...seen.values()];
}

export async function fetchFolders(client: HevyClient): Promise<HevyFolder[]> {
  const folders = await client.get("/routine_folders");
  return Array.isArray(folders) ? (folders as HevyFolder[]) : [];
}

export async function isPro(client: HevyClient): Promise<boolean> {
  const sub = (await client.get("/user_subscription")) as Json;
  return Boolean(sub?.is_pro);
}

export async function defaultRestSeconds(client: HevyClient): Promise<number> {
  const prefs = (await client.get("/v2/user_preferences")) as Json;
  return typeof prefs?.default_rest_timer_seconds === "number" ? prefs.default_rest_timer_seconds : DEFAULT_REST_SECONDS;
}

const toLb = (kg: number | null | undefined) =>
  typeof kg === "number" ? pyRound(kg * KG_PER_LB_DIVISOR, 1) : undefined;

function compact(row: Json): Json {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined && v !== ""));
}

function renderSet(set: Json): Json {
  return compact({
    type: set.indicator,
    kg: typeof set.weight_kg === "number" ? pyRound(set.weight_kg, 2) : undefined,
    lb: toLb(set.weight_kg),
    reps: set.reps,
    distance_m: set.distance_meters,
    duration_s: set.duration_seconds,
    count: set.custom_metric,
    rpe: set.rpe,
  });
}

export function renderRoutine(r: HevyRoutine, folders: HevyFolder[] = []): Json {
  return compact({
    id: r.id,
    title: r.title,
    folder: folders.find((f) => f.id === r.folder_id)?.title ?? (r.folder_id === null ? "My Routines" : undefined),
    folder_id: r.folder_id,
    notes: r.notes,
    updated_at: r.updated_at,
    exercises: r.exercises.map((e) =>
      compact({
        exercise: e.title,
        exercise_template_id: e.exercise_template_id,
        type: e.exercise_type,
        rest_seconds: e.rest_seconds,
        superset_id: e.superset_id,
        notes: e.notes,
        sets: (e.sets ?? []).map(renderSet),
      }),
    ),
  });
}

function summarize(r: HevyRoutine): Json {
  return {
    id: r.id,
    title: r.title,
    exercises: r.exercises.map((e) => `${e.title} (${(e.sets ?? []).length} sets)`),
  };
}

export async function listRoutines(client: HevyClient): Promise<Json> {
  const [routines, folders, pro] = [await fetchRoutines(client), await fetchFolders(client), await isPro(client)];
  const byIndex = (a: { index: number }, b: { index: number }) => a.index - b.index;
  const groups: { folder: string; folder_id: number | null; routines: Json[] }[] = [...folders]
    .sort(byIndex)
    .map((f) => ({
      folder: f.title,
      folder_id: f.id,
      routines: routines.filter((r) => r.folder_id === f.id).sort(byIndex).map(summarize),
    }));
  // Hevy shows routines outside any folder under "My Routines".
  const loose = routines.filter((r) => r.folder_id === null || !folders.some((f) => f.id === r.folder_id));
  if (loose.length) groups.push({ folder: "My Routines", folder_id: null, routines: loose.sort(byIndex).map(summarize) });

  return {
    folders: groups,
    routine_count: routines.length,
    routine_limit: pro ? null : FREE_ROUTINE_LIMIT,
    ...(pro || routines.length < FREE_ROUTINE_LIMIT
      ? {}
      : {
          note:
            `Free Hevy accounts hold at most ${FREE_ROUTINE_LIMIT} routines and this one is full. ` +
            "New plans have to replace existing routines (save_routine with routine_id) " +
            "or the user must delete one first.",
        }),
  };
}

export async function getRoutine(client: HevyClient, routineId: string): Promise<Json> {
  const [routines, folders] = [await fetchRoutines(client), await fetchFolders(client)];
  const routine = routines.find((r) => r.id === routineId);
  if (!routine) return notFound(routineId, routines);
  return { routine: renderRoutine(routine, folders) };
}

function notFound(routineId: string, routines: HevyRoutine[]): Json {
  return {
    error: "not_found",
    message: `No routine with id ${routineId}. Use list_routines for the current ids.`,
    routines: routines.map((r) => ({ id: r.id, title: r.title })),
  };
}

// --- exercise templates ----------------------------------------------------

const CUSTOM_REFRESH_MS = 60 * 60 * 1000;

/** Mirror the user's custom exercises into exercise_template, at most hourly. */
export async function refreshCustomTemplates(db: D1Database, client: HevyClient, force = false): Promise<void> {
  const last = Number((await getState(db, "custom_templates_at")) ?? 0);
  if (!force && Date.now() - last < CUSTOM_REFRESH_MS) return;

  const customs = await client.get("/custom_exercise_templates");
  if (!Array.isArray(customs)) return;
  const writes = [db.prepare("DELETE FROM exercise_template WHERE is_custom = 1")];
  for (const t of customs as Json[]) {
    if (!t?.id || !t?.title || !t?.exercise_type) continue;
    writes.push(
      db
        .prepare(
          "INSERT OR REPLACE INTO exercise_template (id, title, title_norm, muscle_group, other_muscles, " +
            "exercise_type, equipment_category, aka, tags, priority, is_custom, is_archived, full_bodyweight) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1, ?, 0)",
        )
        .bind(
          String(t.id),
          String(t.title),
          normalizeName(String(t.title)),
          t.muscle_group ?? null,
          JSON.stringify(t.other_muscles ?? []),
          String(t.exercise_type),
          t.equipment_category ?? null,
          Number(t.priority ?? 0),
          t.is_archived ? 1 : 0,
        ),
    );
  }
  await db.batch(writes);
  await setState(db, "custom_templates_at", String(Date.now()));
}

interface TemplateRow {
  id: string;
  title: string;
  title_norm: string;
  muscle_group: string | null;
  other_muscles: string | null;
  exercise_type: string;
  equipment_category: string | null;
  aka: string | null;
  tags: string | null;
  priority: number;
  is_custom: number;
  is_archived: number;
  times_logged: number;
  last_logged: string | null;
}

async function loadTemplates(db: D1Database): Promise<TemplateRow[]> {
  return (
    await db
      .prepare(
        "SELECT t.*, COALESCE(u.n, 0) AS times_logged, u.last_logged FROM exercise_template t " +
          "LEFT JOIN (SELECT template_id, COUNT(*) AS n, MAX(start_date) AS last_logged " +
          "           FROM workout_set GROUP BY template_id) u ON u.template_id = t.id",
      )
      .all<TemplateRow>()
  ).results;
}

function scoreTemplate(queryNorm: string, t: TemplateRow): number {
  let best = scoreCandidate(queryNorm, t.title_norm)[0];
  if (t.aka) best = Math.max(best, 0.95 * scoreCandidate(queryNorm, normalizeName(t.aka))[0]);
  // Hevy's own keywords ("db", "bb", "rdl", ...) count only when every word is covered.
  const words = new Set([...t.title_norm.split(" "), ...normalizeName(t.tags ?? "").split(" ")]);
  if (queryNorm.split(" ").every((w) => words.has(w))) best = Math.max(best, 0.8);
  return best;
}

function renderTemplate(t: TemplateRow, score?: number): Json {
  return compact({
    exercise_template_id: t.id,
    title: t.title,
    type: t.exercise_type,
    muscle_group: t.muscle_group,
    other_muscles: JSON.parse(t.other_muscles ?? "[]").length ? JSON.parse(t.other_muscles ?? "[]") : undefined,
    equipment: t.equipment_category,
    also_known_as: t.aka,
    custom: t.is_custom ? true : undefined,
    times_logged: t.times_logged || undefined,
    last_logged: t.last_logged,
    match_score: score === undefined ? undefined : pyRound(score, 3),
  });
}

export async function searchExercises(
  db: D1Database,
  opts: { query?: string | null; muscle_group?: string | null; equipment?: string | null; limit?: number },
): Promise<Json> {
  const limit = Math.max(1, Math.min(opts.limit ?? 15, 50));
  let rows = (await loadTemplates(db)).filter(
    (t) =>
      (!opts.muscle_group || t.muscle_group === opts.muscle_group) &&
      (!opts.equipment || t.equipment_category === opts.equipment),
  );
  if (!rows.length) {
    const total = (await db.prepare("SELECT COUNT(*) AS n FROM exercise_template").first<{ n: number }>())?.n ?? 0;
    if (!total) {
      return {
        error: "library_empty",
        message: "The exercise library has not been loaded. Run worker/scripts/update_exercise_library.py.",
      };
    }
  }

  const queryNorm = normalizeName(opts.query ?? "");
  let ranked: [TemplateRow, number | undefined][];
  if (queryNorm) {
    ranked = rows
      .map((t) => [t, scoreTemplate(queryNorm, t)] as [TemplateRow, number])
      .filter(([, s]) => s >= 0.6)
      // Best match first; among equals, what the user actually does, then Hevy's popularity.
      .sort(([a, sa], [b, sb]) => sb - sa || b.times_logged - a.times_logged || b.priority - a.priority);
  } else {
    ranked = rows
      .sort((a, b) => b.times_logged - a.times_logged || b.priority - a.priority || (a.title < b.title ? -1 : 1))
      .map((t) => [t, undefined]);
  }
  // Archived exercises only when nothing current matches.
  const current = ranked.filter(([t]) => !t.is_archived);
  if (current.length) ranked = current;

  return {
    query: opts.query ?? null,
    exercises: ranked.slice(0, limit).map(([t, s]) => renderTemplate(t, s)),
    returned: Math.min(limit, ranked.length),
    total_matches: ranked.length,
    note: "times_logged counts the user's own logged sets, so prefer exercises they already do.",
  };
}

// --- writing: validation ---------------------------------------------------

const SET_TYPES = new Set(["normal", "warmup", "failure", "dropset"]);

// Which measures each exercise type records, as Hevy's set editor shows them.
const MEASURES: Record<string, Set<string>> = {
  weight_reps: new Set(["weight", "reps"]),
  reps_only: new Set(["reps"]),
  bodyweight_reps: new Set(["weight", "reps"]),
  bodyweight_assisted_reps: new Set(["weight", "reps"]),
  duration: new Set(["duration"]),
  distance_duration: new Set(["distance", "duration"]),
  steps_duration: new Set(["count", "duration"]),
  floors_duration: new Set(["count", "duration"]),
  short_distance_weight: new Set(["distance", "weight"]),
};

const MEASURE_LABEL: Record<string, string> = {
  weight_reps: "weight and reps",
  reps_only: "reps only",
  bodyweight_reps: "reps, plus optional added weight",
  bodyweight_assisted_reps: "reps, plus the assistance weight",
  duration: "duration only",
  distance_duration: "distance and duration",
  steps_duration: "steps (count) and duration",
  floors_duration: "floors (count) and duration",
  short_distance_weight: "distance and weight",
};

export interface SetInput {
  type?: string;
  weight_kg?: number;
  weight_lb?: number;
  reps?: number;
  distance_m?: number;
  distance_mi?: number;
  duration_s?: number;
  count?: number;
}

export interface ExerciseInput {
  exercise_template_id: string;
  rest_seconds?: number;
  notes?: string;
  superset_id?: number;
  sets: SetInput[];
}

export interface RoutineInput {
  title?: string;
  notes?: string | null;
  exercises?: ExerciseInput[];
}

interface Resolved {
  body: Json[];
  problems: string[];
  warnings: string[];
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export async function resolveExercises(db: D1Database, exercises: ExerciseInput[], restDefault: number): Promise<Resolved> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const body: Json[] = [];
  if (!exercises.length) problems.push("a routine needs at least one exercise");

  const ids = [...new Set(exercises.map((e) => e.exercise_template_id))];
  const placeholders = ids.map(() => "?").join(", ");
  const templates = new Map(
    ids.length
      ? (
          await db
            .prepare(`SELECT id, title, exercise_type, is_archived FROM exercise_template WHERE id IN (${placeholders})`)
            .bind(...ids)
            .all<{ id: string; title: string; exercise_type: string; is_archived: number }>()
        ).results.map((t) => [t.id, t])
      : [],
  );

  exercises.forEach((exercise, i) => {
    const where = `exercise ${i + 1}`;
    const template = templates.get(exercise.exercise_template_id);
    if (!template) {
      problems.push(
        `${where}: unknown exercise_template_id '${exercise.exercise_template_id}'. Look it up with search_exercises.`,
      );
      return;
    }
    if (template.is_archived) warnings.push(`${where}: ${template.title} is archived in Hevy's library.`);
    if (!Array.isArray(exercise.sets) || !exercise.sets.length) {
      problems.push(`${where} (${template.title}): needs at least one set`);
      return;
    }
    if (exercise.rest_seconds !== undefined && !(isNum(exercise.rest_seconds) && exercise.rest_seconds >= 0)) {
      problems.push(`${where} (${template.title}): rest_seconds must be a non-negative number`);
    }

    const allowed = MEASURES[template.exercise_type] ?? new Set(["weight", "reps", "distance", "duration", "count"]);
    const sets = exercise.sets.map((set, s) => {
      const label = `${where} (${template.title}) set ${s + 1}`;
      const type = set.type ?? "normal";
      if (!SET_TYPES.has(type)) problems.push(`${label}: type must be normal, warmup, failure, or dropset`);

      if (set.weight_kg !== undefined && set.weight_lb !== undefined) problems.push(`${label}: give weight_kg or weight_lb, not both`);
      if (set.distance_m !== undefined && set.distance_mi !== undefined) problems.push(`${label}: give distance_m or distance_mi, not both`);
      // Same conversion as Hevy's app, so 135 lb shows as 135 again.
      const weight = set.weight_lb !== undefined ? set.weight_lb / KG_PER_LB_DIVISOR : set.weight_kg;
      const distance = set.distance_mi !== undefined ? set.distance_mi * METERS_PER_MILE : set.distance_m;

      const given: [string, unknown][] = [
        ["weight", weight],
        ["reps", set.reps],
        ["distance", distance],
        ["duration", set.duration_s],
        ["count", set.count],
      ];
      for (const [measure, value] of given) {
        if (value === undefined) continue;
        if (!allowed.has(measure)) {
          problems.push(`${label}: ${template.title} records ${MEASURE_LABEL[template.exercise_type]}, not ${measure}`);
        } else if (!(isNum(value) && value >= 0)) {
          problems.push(`${label}: ${measure} must be a non-negative number`);
        }
      }
      if ((isNum(set.reps) && !Number.isInteger(set.reps)) || (isNum(set.duration_s) && !Number.isInteger(set.duration_s))) {
        problems.push(`${label}: reps and duration_s must be whole numbers`);
      }

      return compact({
        index: s,
        indicator: type,
        weight_kg: weight,
        reps: set.reps,
        distance_meters: distance,
        duration_seconds: set.duration_s,
        custom_metric: set.count,
      });
    });

    body.push({
      exercise_template_id: template.id,
      rest_seconds: exercise.rest_seconds ?? restDefault,
      ...(exercise.superset_id !== undefined ? { superset_id: exercise.superset_id } : {}),
      sets,
      // The web editor always sends notes, as "" when empty.
      notes: exercise.notes ?? "",
    });
  });

  const supersets = new Map<number, number>();
  for (const e of exercises) if (e.superset_id !== undefined) supersets.set(e.superset_id, (supersets.get(e.superset_id) ?? 0) + 1);
  for (const [id, n] of supersets) if (n < 2) problems.push(`superset_id ${id} is used by only one exercise`);

  return { body, problems, warnings };
}

/** What the routine will look like, in the same shape get_routine returns. */
export async function previewOf(db: D1Database, title: string, notes: string | null, body: Json[]): Promise<Json> {
  const titles = new Map(
    (await db.prepare("SELECT id, title, exercise_type FROM exercise_template").all<Json>()).results.map((t) => [t.id, t]),
  );
  return compact({
    title,
    notes,
    exercises: body.map((e) =>
      compact({
        exercise: titles.get(e.exercise_template_id)?.title,
        exercise_template_id: e.exercise_template_id,
        type: titles.get(e.exercise_template_id)?.exercise_type,
        rest_seconds: e.rest_seconds,
        superset_id: e.superset_id,
        notes: e.notes,
        sets: e.sets.map(renderSet),
      }),
    ),
  });
}

export function describeChanges(before: HevyRoutine, title: string, body: Json[], names: Map<string, string>): string[] {
  const changes: string[] = [];
  if (before.title !== title) changes.push(`title: "${before.title}" -> "${title}"`);
  const old = before.exercises.map((e) => e.exercise_template_id as string);
  const now = body.map((e) => e.exercise_template_id as string);
  for (const id of now.filter((id) => !old.includes(id))) changes.push(`adds ${names.get(id) ?? id}`);
  for (const e of before.exercises.filter((e) => !now.includes(e.exercise_template_id))) changes.push(`removes ${e.title}`);
  for (const e of body) {
    const prev = before.exercises.find((p) => p.exercise_template_id === e.exercise_template_id);
    if (prev && (prev.sets ?? []).length !== e.sets.length) {
      changes.push(`${prev.title}: ${(prev.sets ?? []).length} -> ${e.sets.length} sets`);
    }
  }
  if (old.filter((id) => now.includes(id)).join() !== now.filter((id) => old.includes(id)).join()) {
    changes.push("reorders exercises");
  }
  if (before.exercises.some((e) => e.superset_id !== null && e.superset_id !== undefined) && !body.some((e) => e.superset_id !== undefined)) {
    changes.push("removes the existing supersets");
  }
  return changes.length ? changes : ["no structural changes (sets' weights, reps, rest, or notes may still differ)"];
}

const NOT_SAVED =
  "Nothing was saved. Show this preview to the user, and only after they agree, " +
  "call again with the same arguments plus confirm=true.";

// --- writing: the tools ----------------------------------------------------

export async function saveRoutine(
  db: D1Database,
  client: HevyClient,
  args: RoutineInput & { routine_id?: string; folder_id?: number | null; confirm?: boolean },
): Promise<Json> {
  const routines = await fetchRoutines(client);
  const existing = args.routine_id ? routines.find((r) => r.id === args.routine_id) : undefined;
  if (args.routine_id && !existing) return notFound(args.routine_id, routines);

  if (!existing) {
    if (!args.title?.trim()) return { error: "invalid_argument", message: "a new routine needs a title" };
    if (!args.exercises) return { error: "invalid_argument", message: "a new routine needs exercises" };
    if (routines.length >= FREE_ROUTINE_LIMIT && !(await isPro(client))) {
      return {
        error: "routine_limit",
        message:
          `Free Hevy accounts hold at most ${FREE_ROUTINE_LIMIT} routines, and all ${routines.length} are used. ` +
          "Replace one by calling save_routine with its routine_id, or ask the user whether to delete one.",
        routines: routines.map((r) => ({ id: r.id, title: r.title })),
      };
    }
  }

  await refreshCustomTemplates(db, client);
  const restDefault = await defaultRestSeconds(client);
  const title = args.title?.trim() || existing!.title;
  const notes = args.notes !== undefined ? args.notes : (existing?.notes ?? null);

  let body: Json[];
  let warnings: string[] = [];
  if (args.exercises) {
    const resolved = await resolveExercises(db, args.exercises, restDefault);
    if (resolved.problems.length) return { error: "invalid_routine", problems: resolved.problems, warnings: resolved.warnings };
    body = resolved.body;
    warnings = resolved.warnings;
  } else {
    // Title or notes only: resend the exercises exactly as they are.
    body = existing!.exercises.map((e) => ({
        exercise_template_id: e.exercise_template_id,
        rest_seconds: e.rest_seconds,
        ...(e.superset_id !== null && e.superset_id !== undefined ? { superset_id: e.superset_id } : {}),
        notes: e.notes ?? "",
        sets: (e.sets ?? []).map((s: Json, index: number) =>
          compact({
            index,
            indicator: s.indicator,
            weight_kg: s.weight_kg,
            reps: s.reps,
            distance_meters: s.distance_meters,
            duration_seconds: s.duration_seconds,
            custom_metric: s.custom_metric,
          }),
        ),
    }));
  }

  const folders = await fetchFolders(client);
  if (args.folder_id !== undefined && args.folder_id !== null && !folders.some((f) => f.id === args.folder_id)) {
    return { error: "not_found", message: `No folder with id ${args.folder_id}.`, folders };
  }

  const preview = await previewOf(db, title, notes, body);
  const names = new Map((preview.exercises as Json[]).map((e) => [e.exercise_template_id, e.exercise]));
  if (!args.confirm) {
    return compact({
      action: existing ? "update" : "create",
      routine_id: existing?.id,
      changes: existing ? describeChanges(existing, title, body, names) : undefined,
      preview,
      warnings: warnings.length ? warnings : undefined,
      saved: false,
      message: NOT_SAVED,
    });
  }

  const routine = {
    title,
    exercises: body,
    folder_id: existing ? existing.folder_id : null,
    index: existing ? existing.index : 0,
    program_id: existing ? existing.program_id : null,
    notes,
    coach_force_rpe_enabled: existing ? existing.coach_force_rpe_enabled : false,
  };

  let routineId: string;
  if (existing) {
    await client.request("PUT", `/routine/${existing.id}`, { params: SYNC_EVENT, body: { routine } });
    routineId = existing.id;
  } else {
    const created = (await client.request("POST", "/routine", { params: SYNC_EVENT, body: { routine } })) as Json;
    routineId = String(created?.routineId ?? "");
    if (!routineId) return { error: "api_error", message: "Hevy did not return the new routine's id.", detail: created };
  }

  const targetFolder = args.folder_id;
  if (targetFolder !== undefined && (!existing || existing.folder_id !== targetFolder)) {
    await moveTo(client, routines, routineId, targetFolder);
  }

  const after = await fetchRoutines(client);
  const saved = after.find((r) => r.id === routineId);
  return compact({
    saved: true,
    action: existing ? "updated" : "created",
    routine: saved ? renderRoutine(saved, folders) : { id: routineId },
    warnings: warnings.length ? warnings : undefined,
    note: "The Hevy app picks this up on its next sync; pull down on the Routines screen if it does not show.",
  });
}

async function moveTo(client: HevyClient, routines: HevyRoutine[], routineId: string, folderId: number | null): Promise<void> {
  const index = routines.filter((r) => r.folder_id === folderId && r.id !== routineId).length;
  await client.request("PUT", "/routine_locations", {
    params: SYNC_EVENT,
    body: { locations: [{ routineId, folderId, index }] },
  });
}

export async function deleteRoutine(client: HevyClient, args: { routine_id: string; confirm?: boolean }): Promise<Json> {
  const [routines, folders] = [await fetchRoutines(client), await fetchFolders(client)];
  const routine = routines.find((r) => r.id === args.routine_id);
  if (!routine) return notFound(args.routine_id, routines);
  if (!args.confirm) {
    return {
      action: "delete",
      routine: renderRoutine(routine, folders),
      saved: false,
      message:
        "Nothing was deleted. Deleting cannot be undone from here. Confirm with the user, " +
        "then call again with confirm=true.",
    };
  }
  await client.request("DELETE", `/routine/${routine.id}`, { params: SYNC_EVENT });
  return { deleted: true, routine: { id: routine.id, title: routine.title } };
}

export async function createFolder(client: HevyClient, args: { title: string }): Promise<Json> {
  const title = args.title?.trim();
  if (!title) return { error: "invalid_argument", message: "a folder needs a title" };
  const folders = await fetchFolders(client);
  const clash = folders.find((f) => f.title.toLowerCase() === title.toLowerCase());
  if (clash) return { error: "already_exists", message: `A folder named "${clash.title}" already exists.`, folder_id: clash.id };
  const created = (await client.request("POST", "/routine_folder", { params: SYNC_EVENT, body: { folder: { title } } })) as Json;
  return { created: true, folder: { id: created?.id, title: created?.title ?? title } };
}

export async function moveRoutine(client: HevyClient, args: { routine_id: string; folder_id: number | null }): Promise<Json> {
  const [routines, folders] = [await fetchRoutines(client), await fetchFolders(client)];
  const routine = routines.find((r) => r.id === args.routine_id);
  if (!routine) return notFound(args.routine_id, routines);
  if (args.folder_id !== null && !folders.some((f) => f.id === args.folder_id)) {
    return { error: "not_found", message: `No folder with id ${args.folder_id}.`, folders };
  }
  await moveTo(client, routines, routine.id, args.folder_id);
  return {
    moved: true,
    routine: { id: routine.id, title: routine.title },
    folder: folders.find((f) => f.id === args.folder_id)?.title ?? "My Routines",
  };
}

export async function deleteFolder(client: HevyClient, args: { folder_id: number }): Promise<Json> {
  const [routines, folders] = [await fetchRoutines(client), await fetchFolders(client)];
  const folder = folders.find((f) => f.id === args.folder_id);
  if (!folder) return { error: "not_found", message: `No folder with id ${args.folder_id}.`, folders };
  const inside = routines.filter((r) => r.folder_id === folder.id);
  if (inside.length) {
    return {
      error: "folder_not_empty",
      message: `"${folder.title}" still holds ${inside.length} routine(s). Move or delete them first.`,
      routines: inside.map((r) => ({ id: r.id, title: r.title })),
    };
  }
  await client.request("DELETE", `/routine_folder/${folder.id}`, { params: SYNC_EVENT });
  return { deleted: true, folder: { id: folder.id, title: folder.title } };
}
