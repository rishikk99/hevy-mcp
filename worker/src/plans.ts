// Training plans: routines kept in D1 rather than in Hevy, loaded into a Hevy
// routine one day at a time.
//
// Free Hevy accounts hold 4 routines. A plan can hold any number of days, but
// loading only ever rewrites or fills routines within the limit, so Hevy
// never holds more: a day either fills a free slot or replaces a routine the
// user picked. When it's unclear which, the tool says so and Claude asks.
//
// A plan can also be a copy of existing routines (save_routines_as_plan),
// taken exactly as Hevy stores them, so a folder can be swapped out for
// another program and put back later with restore_plan.

import { FREE_ROUTINE_LIMIT } from "./config";
import { HevyClient } from "./hevy";
import {
  defaultRestSeconds,
  describeChanges,
  type ExerciseInput,
  fetchFolders,
  fetchRoutines,
  type HevyRoutine,
  isPro,
  previewOf,
  refreshCustomTemplates,
  resolveExercises,
  saveRoutine,
  SYNC_EVENT,
} from "./routines";

type Json = Record<string, any>;

export interface PlanDay {
  label: string;
  title: string;
  notes?: string;
  exercises: ExerciseInput[];
  /** Set when the day was copied from a Hevy routine; restore_plan puts it back there. */
  source?: { routine_id: string; folder_title: string | null; index: number };
}

interface PlanRow {
  id: string;
  name: string;
  notes: string | null;
  days: string;
  created_at: string;
  updated_at: string;
}

export const MAX_PLAN_DAYS = 60;

async function findPlan(db: D1Database, plan: string): Promise<PlanRow | null> {
  return db.prepare("SELECT * FROM plan WHERE id = ? OR name = ?").bind(plan, plan).first<PlanRow>();
}

async function planChoices(db: D1Database): Promise<Json[]> {
  return (await db.prepare("SELECT id, name FROM plan ORDER BY updated_at DESC").all<Json>()).results;
}

async function planNotFound(db: D1Database, plan: string): Promise<Json> {
  return { error: "not_found", message: `No plan with id or name "${plan}".`, plans: await planChoices(db) };
}

/** Check every day's exercises the way save_routine would. Returns problems, prefixed by day. */
async function validateDays(db: D1Database, days: PlanDay[]): Promise<{ problems: string[]; warnings: string[] }> {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(days) || !days.length) problems.push("a plan needs at least one day");
  if (Array.isArray(days) && days.length > MAX_PLAN_DAYS) problems.push(`a plan holds at most ${MAX_PLAN_DAYS} days`);

  const labels = new Set<string>();
  for (const [i, day] of (Array.isArray(days) ? days : []).entries()) {
    const where = `day ${i + 1}${day?.label ? ` (${day.label})` : ""}`;
    if (!day?.label?.trim()) problems.push(`${where}: needs a label, e.g. "Week 1 Day A"`);
    else if (labels.has(day.label.trim().toLowerCase())) problems.push(`${where}: label is used twice`);
    else labels.add(day.label.trim().toLowerCase());
    if (!day?.title?.trim()) problems.push(`${where}: needs a title (the routine name shown in Hevy)`);
    if (!Array.isArray(day?.exercises)) {
      problems.push(`${where}: exercises must be a list`);
      continue;
    }
    // The rest default only matters for the body, which isn't stored here.
    const resolved = await resolveExercises(db, day.exercises, 0);
    problems.push(...resolved.problems.map((p) => `${where}: ${p}`));
    warnings.push(...resolved.warnings.map((w) => `${where}: ${w}`));
  }
  return { problems, warnings };
}

function cleanDays(days: PlanDay[]): PlanDay[] {
  return days.map((d) => ({
    label: d.label.trim(),
    title: d.title.trim(),
    ...(d.notes ? { notes: d.notes } : {}),
    exercises: d.exercises,
    ...(d.source ? { source: d.source } : {}),
  }));
}

async function storePlan(
  db: D1Database,
  existing: PlanRow | null,
  name: string,
  notes: string | null,
  days: PlanDay[],
): Promise<string> {
  const now = new Date().toISOString();
  const id = existing?.id ?? crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO plan (id, name, notes, days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET name = excluded.name, notes = excluded.notes, " +
        "  days = excluded.days, updated_at = excluded.updated_at",
    )
    .bind(id, name, notes, JSON.stringify(days), existing?.created_at ?? now, now)
    .run();
  return id;
}

/** Resolve plan_id and name the way every saving tool does. Returns an error result or the row to replace. */
async function checkName(
  db: D1Database,
  name: string | undefined,
  planId: string | undefined,
): Promise<{ error: Json } | { existing: PlanRow | null; name: string }> {
  const trimmed = name?.trim();
  if (!trimmed) return { error: { error: "invalid_argument", message: "a plan needs a name" } };
  const existing = planId ? await findPlan(db, planId) : null;
  if (planId && !existing) return { error: await planNotFound(db, planId) };
  const clash = await db.prepare("SELECT id FROM plan WHERE name = ?").bind(trimmed).first<{ id: string }>();
  if (clash && clash.id !== existing?.id) {
    return {
      error: {
        error: "already_exists",
        message: `A plan named "${trimmed}" already exists. Pass its plan_id to replace it, or choose another name.`,
        plan_id: clash.id,
      },
    };
  }
  return { existing, name: trimmed };
}

/** A day as get_plan shows it: exercise names alongside the stored input. */
async function renderDays(db: D1Database, days: PlanDay[]): Promise<Json[]> {
  const names = new Map(
    (await db.prepare("SELECT id, title FROM exercise_template").all<{ id: string; title: string }>()).results.map(
      (t) => [t.id, t.title],
    ),
  );
  return days.map((d, i) => ({
    day: i + 1,
    label: d.label,
    title: d.title,
    ...(d.notes ? { notes: d.notes } : {}),
    exercises: d.exercises.map((e) => ({ exercise: names.get(e.exercise_template_id) ?? "(unknown exercise)", ...e })),
  }));
}

// --- tools -------------------------------------------------------------------

export async function savePlan(
  db: D1Database,
  client: HevyClient,
  args: { plan_id?: string; name: string; notes?: string; days: PlanDay[] },
): Promise<Json> {
  const checked = await checkName(db, args.name, args.plan_id);
  if ("error" in checked) return checked.error;
  const { existing, name } = checked;

  await refreshCustomTemplates(db, client);
  const { problems, warnings } = await validateDays(db, args.days);
  if (problems.length) return { error: "invalid_plan", problems, ...(warnings.length ? { warnings } : {}) };

  // Hand-written days carry no source; restore_plan is for copies of routines.
  const days = cleanDays(args.days.map(({ source: _, ...day }) => day));
  const id = await storePlan(db, existing, name, args.notes ?? null, days);

  return {
    saved: true,
    action: existing ? "updated" : "created",
    plan: { id, name, days: days.map((d, i) => `${i + 1}. ${d.label}: ${d.title}`) },
    ...(warnings.length ? { warnings } : {}),
    note: "Stored on the connector, not in Hevy. Use load_plan_day to put a day into a Hevy routine.",
  };
}

export async function listPlans(db: D1Database): Promise<Json> {
  const rows = (await db.prepare("SELECT * FROM plan ORDER BY updated_at DESC").all<PlanRow>()).results;
  return {
    plans: rows.map((p) => {
      const days = JSON.parse(p.days) as PlanDay[];
      return {
        id: p.id,
        name: p.name,
        ...(p.notes ? { notes: p.notes } : {}),
        days: days.map((d, i) => `${i + 1}. ${d.label}: ${d.title}`),
        updated_at: p.updated_at,
      };
    }),
    returned: rows.length,
  };
}

export async function getPlan(db: D1Database, plan: string): Promise<Json> {
  const row = await findPlan(db, plan);
  if (!row) return planNotFound(db, plan);
  return {
    plan: {
      id: row.id,
      name: row.name,
      ...(row.notes ? { notes: row.notes } : {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
      days: await renderDays(db, JSON.parse(row.days)),
    },
  };
}

export async function deletePlan(db: D1Database, args: { plan_id: string; confirm?: boolean }): Promise<Json> {
  const row = await findPlan(db, args.plan_id);
  if (!row) return planNotFound(db, args.plan_id);
  const days = (JSON.parse(row.days) as PlanDay[]).map((d, i) => `${i + 1}. ${d.label}: ${d.title}`);
  if (!args.confirm) {
    return {
      action: "delete",
      plan: { id: row.id, name: row.name, days },
      saved: false,
      message:
        "Nothing was deleted. This removes the plan from the connector (routines already in Hevy stay). " +
        "Confirm with the user, then call again with confirm=true.",
    };
  }
  await db.prepare("DELETE FROM plan WHERE id = ?").bind(row.id).run();
  return { deleted: true, plan: { id: row.id, name: row.name } };
}

// --- copying routines in, and putting them back ----------------------------

/** A Hevy routine's exercises in save_routine's input format, exactly as stored. */
function routineToExercises(routine: HevyRoutine): { exercises: ExerciseInput[]; dropped: string[] } {
  const dropped = new Set<string>();
  const exercises = routine.exercises.map((e) => ({
    exercise_template_id: e.exercise_template_id,
    ...(typeof e.rest_seconds === "number" ? { rest_seconds: e.rest_seconds } : {}),
    ...(e.notes ? { notes: e.notes } : {}),
    ...(e.superset_id !== null && e.superset_id !== undefined ? { superset_id: e.superset_id } : {}),
    sets: (e.sets ?? []).map((s: Json) => {
      // Routine editors don't set RPE targets; note it rather than lose it silently.
      if (s.rpe !== null && s.rpe !== undefined) dropped.add(`RPE targets on ${e.title}`);
      return Object.fromEntries(
        Object.entries({
          type: s.indicator ?? "normal",
          // kg as stored: converting through pounds would round.
          weight_kg: s.weight_kg,
          reps: s.reps,
          distance_m: s.distance_meters,
          duration_s: s.duration_seconds,
          count: s.custom_metric,
        }).filter(([, v]) => v !== null && v !== undefined),
      );
    }),
  }));
  return { exercises, dropped: [...dropped] };
}

export async function saveRoutinesAsPlan(
  db: D1Database,
  client: HevyClient,
  args: { name: string; folder_id?: number | null; routine_ids?: string[]; notes?: string; plan_id?: string },
): Promise<Json> {
  const checked = await checkName(db, args.name, args.plan_id);
  if ("error" in checked) return checked.error;
  const { existing, name } = checked;

  const hasFolder = args.folder_id !== undefined;
  if (hasFolder === Boolean(args.routine_ids?.length)) {
    return { error: "invalid_argument", message: "pass either folder_id (null for My Routines) or routine_ids, not both" };
  }

  const [routines, folders] = [await fetchRoutines(client), await fetchFolders(client)];
  let chosen: HevyRoutine[];
  if (hasFolder) {
    if (args.folder_id !== null && !folders.some((f) => f.id === args.folder_id)) {
      return { error: "not_found", message: `No folder with id ${args.folder_id}.`, folders };
    }
    chosen = routines.filter((r) => r.folder_id === args.folder_id).sort((a, b) => a.index - b.index);
    if (!chosen.length) return { error: "invalid_argument", message: "that folder has no routines" };
  } else {
    const missing = args.routine_ids!.filter((id) => !routines.some((r) => r.id === id));
    if (missing.length) {
      return {
        error: "not_found",
        message: `No routine with id ${missing.join(", ")}.`,
        routines: routines.map((r) => ({ id: r.id, title: r.title })),
      };
    }
    chosen = args.routine_ids!.map((id) => routines.find((r) => r.id === id)!);
  }

  const folderTitle = (id: number | null) => folders.find((f) => f.id === id)?.title ?? null;
  const labels = new Map<string, number>();
  const notes: string[] = [];
  const days: PlanDay[] = chosen.map((r) => {
    // Labels must be unique; two routines can share a title.
    const n = (labels.get(r.title.toLowerCase()) ?? 0) + 1;
    labels.set(r.title.toLowerCase(), n);
    const { exercises, dropped } = routineToExercises(r);
    notes.push(...dropped);
    return {
      label: n === 1 ? r.title : `${r.title} (${n})`,
      title: r.title,
      ...(r.notes ? { notes: r.notes } : {}),
      exercises,
      source: { routine_id: r.id, folder_title: folderTitle(r.folder_id), index: r.index },
    };
  });

  await refreshCustomTemplates(db, client);
  const { problems, warnings } = await validateDays(db, days);
  if (problems.length) return { error: "invalid_plan", problems, ...(warnings.length ? { warnings } : {}) };

  const id = await storePlan(db, existing, name, args.notes ?? null, days);
  return {
    saved: true,
    action: existing ? "updated" : "created",
    plan: { id, name, days: days.map((d, i) => `${i + 1}. ${d.label}`) },
    copied_from: hasFolder ? (folderTitle(args.folder_id ?? null) ?? "My Routines") : "selected routines",
    ...(notes.length ? { not_copied: notes } : {}),
    ...(warnings.length ? { warnings } : {}),
    note:
      "An exact copy, stored on the connector. Hevy was not changed. restore_plan puts these " +
      "routines back where they were, even after they have been rewritten.",
  };
}

interface RestoreStep {
  day: PlanDay;
  body: Json[];
  target: HevyRoutine | null;
  folderTitle: string | null;
}

export async function restorePlan(
  db: D1Database,
  client: HevyClient,
  args: { plan_id: string; confirm?: boolean },
): Promise<Json> {
  const row = await findPlan(db, args.plan_id);
  if (!row) return planNotFound(db, args.plan_id);
  const days = JSON.parse(row.days) as PlanDay[];
  if (days.some((d) => !d.source)) {
    return {
      error: "not_a_copy",
      message:
        `"${row.name}" was written by hand, not copied from Hevy routines, so it has nowhere to be ` +
        "restored to. Load its days one at a time with load_plan_day.",
    };
  }

  const [routines, folders] = [await fetchRoutines(client), await fetchFolders(client)];
  await refreshCustomTemplates(db, client);
  const restDefault = await defaultRestSeconds(client);

  const steps: RestoreStep[] = [];
  const problems: string[] = [];
  for (const day of days) {
    const resolved = await resolveExercises(db, day.exercises, restDefault);
    problems.push(...resolved.problems.map((p) => `${day.label}: ${p}`));
    steps.push({
      day,
      body: resolved.body,
      target: routines.find((r) => r.id === day.source!.routine_id) ?? null,
      folderTitle: day.source!.folder_title,
    });
  }
  if (problems.length) return { error: "invalid_plan", problems };

  // Routines that no longer exist are recreated, which needs free slots.
  const toCreate = steps.filter((s) => !s.target);
  const free = FREE_ROUTINE_LIMIT - routines.length;
  if (toCreate.length && toCreate.length > free && !(await isPro(client))) {
    return {
      error: "choose_routine",
      message:
        `${toCreate.length} of these routines no longer exist and must be recreated, but Hevy has room for ` +
        `${Math.max(0, free)} more (${routines.length} of ${FREE_ROUTINE_LIMIT}). Ask the user which routines to ` +
        "delete or overwrite first. Do not guess. To put a single day into a routine they choose, use load_plan_day.",
      to_recreate: toCreate.map((s) => s.day.title),
      routines: routines.map((r) => ({ id: r.id, title: r.title })),
    };
  }

  const names = new Map(
    (await db.prepare("SELECT id, title FROM exercise_template").all<{ id: string; title: string }>()).results.map(
      (t) => [t.id, t.title],
    ),
  );
  // Every original folder, including ones whose routines still exist elsewhere.
  const missingFolders = [...new Set(steps.map((s) => s.folderTitle).filter((t): t is string => t !== null))].filter(
    (t) => !folders.some((f) => f.title.toLowerCase() === t.toLowerCase()),
  );

  if (!args.confirm) {
    return {
      action: "restore",
      plan: row.name,
      steps: await Promise.all(
        steps.map(async (s) => ({
          routine: s.day.title,
          action: s.target ? "rewrite in place" : `recreate in ${s.folderTitle ?? "My Routines"}`,
          ...(s.target ? { changes: describeChanges(s.target, s.day.title, s.body, names) } : {}),
          preview: await previewOf(db, s.day.title, s.day.notes ?? null, s.body),
        })),
      ),
      ...(missingFolders.length ? { creates_folders: missingFolders } : {}),
      saved: false,
      message:
        "Nothing was changed. Show the user which routines get rewritten or recreated, and only " +
        "after they agree, call again with confirm=true.",
    };
  }

  // Folders first, so recreated routines have somewhere to go.
  const folderIds = new Map(folders.map((f) => [f.title.toLowerCase(), f.id]));
  for (const title of missingFolders) {
    const created = (await client.request("POST", "/routine_folder", { params: SYNC_EVENT, body: { folder: { title } } })) as Json;
    folderIds.set(title.toLowerCase(), created?.id);
  }

  const locations: Json[] = [];
  const restored: string[] = [];
  for (const s of steps) {
    const routine = {
      title: s.day.title,
      exercises: s.body,
      folder_id: s.target ? s.target.folder_id : null,
      index: s.target ? s.target.index : 0,
      program_id: s.target ? s.target.program_id : null,
      notes: s.day.notes ?? null,
      coach_force_rpe_enabled: s.target ? s.target.coach_force_rpe_enabled : false,
    };
    let routineId: string;
    if (s.target) {
      await client.request("PUT", `/routine/${s.target.id}`, { params: SYNC_EVENT, body: { routine } });
      routineId = s.target.id;
    } else {
      const created = (await client.request("POST", "/routine", { params: SYNC_EVENT, body: { routine } })) as Json;
      routineId = String(created?.routineId ?? "");
      if (!routineId) return { error: "api_error", message: `Hevy did not return an id for "${s.day.title}".` };
    }
    restored.push(s.day.title);
    // Back to the original folder and position, as one reorder below.
    const folderId = s.folderTitle === null ? null : (folderIds.get(s.folderTitle.toLowerCase()) ?? null);
    locations.push({ routineId, folderId, index: s.day.source!.index });
  }
  await client.request("PUT", "/routine_locations", { params: SYNC_EVENT, body: { locations } });

  // Recreated routines get new ids; record them so the next restore finds them.
  const after = await fetchRoutines(client);
  const updatedDays = days.map((d, i) => {
    const loc = locations[i];
    const now = after.find((r) => r.id === loc.routineId);
    return { ...d, source: { ...d.source!, routine_id: String(loc.routineId), index: now?.index ?? d.source!.index } };
  });
  await db.prepare("UPDATE plan SET days = ? WHERE id = ?").bind(JSON.stringify(updatedDays), row.id).run();

  return {
    restored: true,
    plan: row.name,
    routines: restored,
    ...(missingFolders.length ? { created_folders: missingFolders } : {}),
    note: "The Hevy app picks this up on its next sync; pull down on the Routines screen if it does not show.",
  };
}

function pickDay(days: PlanDay[], day: string | number): PlanDay | null {
  if (typeof day === "number") return days[day - 1] ?? null;
  const wanted = day.trim().toLowerCase();
  if (/^\d+$/.test(wanted)) return days[Number(wanted) - 1] ?? null;
  return days.find((d) => d.label.toLowerCase() === wanted) ?? null;
}

export async function loadPlanDay(
  db: D1Database,
  client: HevyClient,
  args: { plan_id: string; day: string | number; routine_id?: string; confirm?: boolean },
): Promise<Json> {
  const row = await findPlan(db, args.plan_id);
  if (!row) return planNotFound(db, args.plan_id);
  const days = JSON.parse(row.days) as PlanDay[];
  const day = pickDay(days, args.day);
  if (!day) {
    return {
      error: "not_found",
      message: `"${row.name}" has no day "${args.day}". Pass a day number or one of these labels.`,
      days: days.map((d, i) => `${i + 1}. ${d.label}: ${d.title}`),
    };
  }

  // Without a target, only fill a free slot. When Hevy is full, the choice of
  // what to replace belongs to the user.
  if (!args.routine_id) {
    const routines = await fetchRoutines(client);
    if (routines.length >= FREE_ROUTINE_LIMIT && !(await isPro(client))) {
      const planTitles = new Set(days.map((d) => d.title.toLowerCase()));
      return {
        error: "choose_routine",
        message:
          `Hevy is full (${routines.length} of ${FREE_ROUTINE_LIMIT} routines). Ask the user which routine ` +
          `"${day.title}" should replace, then call again with that routine_id. Do not guess.`,
        routines: routines.map((r) => ({
          id: r.id,
          title: r.title,
          ...(planTitles.has(r.title.toLowerCase()) ? { from_this_plan: true } : {}),
        })),
      };
    }
  }

  const result = await saveRoutine(db, client, {
    routine_id: args.routine_id,
    title: day.title,
    notes: day.notes ?? null,
    exercises: day.exercises,
    confirm: args.confirm,
  });
  return { plan: row.name, day: `${day.label}: ${day.title}`, ...result };
}
