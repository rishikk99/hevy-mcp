// A minimal, stateless MCP server over Streamable HTTP: JSON-RPC in, one JSON
// response out, no sessions and no server-initiated streams. That covers
// everything these tools need (initialize, ping, tools/list, tools/call), and
// keeps the Worker free of SDK code that relies on eval, which Workers forbid.
//
// The workout-history tools match the Python server, minus `authenticate`,
// which opens a browser and has no meaning here. The routine tools are
// Worker-only; see routines.ts.

import { DEFAULT_WORKOUTS, VERSION } from "./config";
import * as plans from "./plans";
import * as queries from "./queries";
import * as routines from "./routines";
import { withHevy } from "./session";
import { runSync } from "./sync";

// Newest first. A client asking for something else gets the newest we speak,
// which is how the spec's version negotiation works.
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS =
  "Access to the user's Hevy account. Workout history is read-only, kept in a " +
  "database that syncs with Hevy every hour: call sync_workouts first if the user " +
  "may have logged a workout since last_sync_at. If a result carries sync_error, " +
  "tell the user the data may be out of date and pass on what it says to do. " +
  "Routines can be read and changed. To build or edit one: look exercises up with " +
  "search_exercises, call save_routine without confirm to get a preview, show the " +
  "user that preview, and only call it again with confirm=true once they agree. " +
  "Leave set weights empty unless the user asks for them; many people fill weights in " +
  "as they lift. Free Hevy accounts hold at most 4 routines; list_routines reports the " +
  "limit. Longer programs go in plans (save_plan), stored on this connector: load one " +
  "day at a time into Hevy with load_plan_day. If it is unclear which Hevy routine a " +
  "day should replace, ask the user rather than guessing. To set routines aside (\"save " +
  "my PPL folder\") use save_routines_as_plan, which copies them exactly; restore_plan " +
  "later puts them back in their folder and order.";

type Json = Record<string, unknown>;

interface Property {
  type: "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: Json;
  nullable?: boolean;
}

export interface ToolContext {
  db: D1Database;
  fetchImpl?: typeof fetch;
}

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, Property>;
  required?: string[];
  readOnly: boolean;
  destructive?: boolean;
  run: (ctx: ToolContext, args: Json) => Promise<Json>;
}

// Interactive tools wait this long for the hourly sync to finish with the
// Hevy login rather than failing straight away.
const HEVY_WAIT_MS = 10_000;

const hevy = (ctx: ToolContext, fn: Parameters<typeof withHevy>[1]) =>
  withHevy(ctx.db, fn, { waitMs: HEVY_WAIT_MS, fetchImpl: ctx.fetchImpl });

const SET_SCHEMA: Json = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["normal", "warmup", "failure", "dropset"], default: "normal" },
    weight_lb: { type: "number", description: "Target weight in pounds (or use weight_kg)." },
    weight_kg: { type: "number", description: "Target weight in kilograms (or use weight_lb)." },
    reps: { type: "integer" },
    duration_s: { type: "integer", description: "For timed exercises." },
    distance_mi: { type: "number", description: "For distance exercises (or use distance_m)." },
    distance_m: { type: "number" },
    count: { type: "number", description: "Steps or floors, for step/floor machines." },
  },
  additionalProperties: false,
};

const EXERCISE_SCHEMA: Json = {
  type: "object",
  properties: {
    exercise_template_id: { type: "string", description: "From search_exercises or get_routine." },
    sets: { type: "array", items: SET_SCHEMA, minItems: 1 },
    rest_seconds: { type: "integer", description: "Rest timer. Defaults to the user's Hevy default." },
    notes: { type: "string", description: "Shown on the exercise in the app, e.g. cues or tempo." },
    superset_id: {
      type: "integer",
      description: "Give two or more consecutive exercises the same number to superset them.",
    },
  },
  required: ["exercise_template_id", "sets"],
  additionalProperties: false,
};

const PLAN_DAY_SCHEMA: Json = {
  type: "object",
  properties: {
    label: { type: "string", description: 'How the user refers to the day, e.g. "Week 2 Day B". Unique in the plan.' },
    title: { type: "string", description: "The routine name shown in Hevy when this day is loaded." },
    notes: { type: "string", description: "Routine-level notes." },
    exercises: { type: "array", items: EXERCISE_SCHEMA, minItems: 1 },
  },
  required: ["label", "title", "exercises"],
  additionalProperties: false,
};

const CONFIRM: Property = {
  type: "boolean",
  default: false,
  description: "false returns a preview and changes nothing. true performs it; only after the user agrees.",
};

const date = (description: string): Property => ({ type: "string", description });
const START = date("First day to include, YYYY-MM-DD.");
const END = date("Last day to include, YYYY-MM-DD.");

const str = (v: unknown) => (v === undefined ? undefined : (v as string | null));

export const TOOLS: ToolDef[] = [
  {
    name: "sync_workouts",
    description:
      "Fetch workouts from Hevy into the database. Runs automatically every hour; " +
      "call it when the user may have logged something since last_sync_at. Stops as " +
      "soon as it reaches already-stored workouts. Pass full=true to re-walk the whole " +
      "history (spread over several runs if needed). Reports how many workouts were " +
      "added or updated.",
    properties: { full: { type: "boolean", default: false, description: "Re-walk the entire history." } },
    readOnly: false,
    run: (ctx, a) => runSync(ctx.db, { full: Boolean(a.full), waitMs: HEVY_WAIT_MS }, ctx.fetchImpl),
  },
  {
    name: "get_workouts",
    description:
      "Workout summaries from the database, newest first. Dates are YYYY-MM-DD. One " +
      "compact row per workout: date, name, duration, exercise and set counts, " +
      "volume_kg (includes warmups, matches Hevy's own total) and working_volume_kg " +
      "(excludes warmups), calories, and any workout note. No per-set detail -- use " +
      "get_workout_detail for that. limit defaults to 50, capped at 200; the result " +
      "reports truncation.",
    properties: {
      start_date: START,
      end_date: END,
      limit: { type: "integer", default: DEFAULT_WORKOUTS, description: "Maximum workouts to return." },
    },
    readOnly: true,
    run: (ctx, a) =>
      queries.getWorkouts(ctx.db, { start_date: str(a.start_date), end_date: str(a.end_date), limit: a.limit as number }),
  },
  {
    name: "get_workout_detail",
    description:
      "One workout in full: every exercise with its muscle group, rest time and notes, " +
      "every set with weight in kg and lb, reps, RPE, and cardio measures, plus any " +
      "personal records. Takes the workout id returned by get_workouts.",
    properties: { workout_id: { type: "string", description: "Id from get_workouts." } },
    required: ["workout_id"],
    readOnly: true,
    run: (ctx, a) => queries.getWorkoutDetail(ctx.db, a.workout_id as string),
  },
  {
    name: "get_exercise_history",
    description:
      "Every set logged for one exercise over a date window. The exercise name is " +
      "fuzzy-matched, so approximate names work; the result reports what matched, the " +
      "score, and runner-up candidates. Sets carry weight (kg and lb) and reps for " +
      "lifts, or distance, duration and steps for cardio, depending on the exercise " +
      "type. Capped at 500 sets.",
    properties: {
      exercise_name: { type: "string", description: "Exercise name; approximate is fine." },
      start_date: START,
      end_date: END,
    },
    required: ["exercise_name"],
    readOnly: true,
    run: (ctx, a) =>
      queries.getExerciseHistory(ctx.db, a.exercise_name as string, {
        start_date: str(a.start_date),
        end_date: str(a.end_date),
      }),
  },
  {
    name: "get_volume_summary",
    description:
      "Aggregate sets, reps, and tonnage by week or month. period is 'week' or " +
      "'month'. group_by is optional: 'muscle_group', 'exercise', or 'equipment'. " +
      "Returns volume_kg (includes warmup sets, reconciles with Hevy) and " +
      "working_volume_kg (excludes warmups) side by side. Grouping by muscle_group " +
      "counts only the primary muscle, so buckets sum to real tonnage -- use " +
      "get_muscle_exposure to include secondary muscles. Capped at 200 buckets.",
    properties: {
      period: { type: "string", enum: ["week", "month"], default: "week" },
      start_date: START,
      end_date: END,
      group_by: { type: "string", enum: ["muscle_group", "exercise", "equipment"] },
    },
    readOnly: true,
    run: (ctx, a) =>
      queries.getVolumeSummary(ctx.db, {
        period: str(a.period) ?? undefined,
        start_date: str(a.start_date),
        end_date: str(a.end_date),
        group_by: str(a.group_by),
      }),
  },
  {
    name: "get_muscle_exposure",
    description:
      "Muscle exposure by week or month, crediting each set to its primary AND " +
      "secondary muscles. This deliberately double-counts and does NOT equal tonnage " +
      "-- use get_volume_summary for volume. Its purpose is spotting under-trained " +
      "muscles that rarely or never appear as a primary muscle. Optional role filter: " +
      "'primary' or 'secondary'.",
    properties: {
      period: { type: "string", enum: ["week", "month"], default: "month" },
      start_date: START,
      end_date: END,
      role: { type: "string", enum: ["primary", "secondary"] },
    },
    readOnly: true,
    run: (ctx, a) =>
      queries.getMuscleExposure(ctx.db, {
        period: str(a.period) ?? undefined,
        start_date: str(a.start_date),
        end_date: str(a.end_date),
        role: str(a.role),
      }),
  },
  {
    name: "get_personal_records",
    description:
      "Personal records, newest first. Optionally filter by exercise (fuzzy-matched) " +
      "and by pr_type: best_1rm, best_volume, best_weight, best_reps, best_distance, " +
      "or best_duration. Capped at 200.",
    properties: {
      exercise_name: { type: "string", description: "Exercise name; approximate is fine." },
      pr_type: {
        type: "string",
        enum: ["best_1rm", "best_volume", "best_weight", "best_reps", "best_distance", "best_duration"],
      },
      start_date: START,
      end_date: END,
    },
    readOnly: true,
    run: (ctx, a) =>
      queries.getPersonalRecords(ctx.db, {
        exercise_name: str(a.exercise_name),
        pr_type: str(a.pr_type),
        start_date: str(a.start_date),
        end_date: str(a.end_date),
      }),
  },
  {
    name: "list_exercises",
    description:
      "Distinct exercises in the history with muscle group, exercise type, equipment, " +
      "first seen, last seen, workout count, and total sets, ordered by total sets. " +
      "Capped at 300.",
    properties: {},
    readOnly: true,
    run: (ctx) => queries.listExercises(ctx.db),
  },

  // --- routines ------------------------------------------------------------

  {
    name: "list_routines",
    description:
      "The user's routines, read live from Hevy and grouped by folder in app order, each " +
      "with its exercises and set counts. Also reports the routine limit: free accounts " +
      "hold at most 4, so a new plan usually has to replace existing routines.",
    properties: {},
    readOnly: true,
    run: (ctx) => hevy(ctx, (client) => routines.listRoutines(client)),
  },
  {
    name: "get_routine",
    description:
      "One routine in full, read live from Hevy: every exercise with its template id, " +
      "rest timer, notes, superset, and each set's type and target weight (kg and lb), " +
      "reps, distance, or duration. Start from this before editing a routine.",
    properties: { routine_id: { type: "string", description: "Id from list_routines." } },
    required: ["routine_id"],
    readOnly: true,
    run: (ctx, a) => hevy(ctx, (client) => routines.getRoutine(client, a.routine_id as string)),
  },
  {
    name: "search_exercises",
    description:
      "Find exercises in Hevy's library (and the user's custom exercises) to put in a " +
      "routine. Returns exercise_template_id, which save_routine needs, plus each " +
      "exercise's type (which decides what a set records), muscles, equipment, and how " +
      "often the user has logged it. Query is fuzzy and understands common names " +
      "('rdl', 'humble row'). With no query, filters by muscle_group and equipment and " +
      "lists the user's most-used exercises first. limit defaults to 15, max 50.",
    properties: {
      query: { type: "string", description: "Exercise name; approximate is fine." },
      muscle_group: {
        type: "string",
        enum: [
          "abdominals", "abductors", "adductors", "biceps", "calves", "cardio", "chest", "forearms",
          "full_body", "glutes", "hamstrings", "lats", "lower_back", "neck", "other", "quadriceps",
          "shoulders", "traps", "triceps", "upper_back",
        ],
      },
      equipment: {
        type: "string",
        enum: ["barbell", "dumbbell", "kettlebell", "machine", "none", "other", "plate", "resistance_band", "suspension"],
      },
      limit: { type: "integer", default: 15 },
    },
    readOnly: true,
    run: async (ctx, a) => {
      // Pick up custom exercises made since the last refresh; the library itself is local.
      const refreshed = await hevy(ctx, async (client) => {
        await routines.refreshCustomTemplates(ctx.db, client);
        return {};
      });
      const result = await routines.searchExercises(ctx.db, {
        query: str(a.query),
        muscle_group: str(a.muscle_group),
        equipment: str(a.equipment),
        limit: a.limit as number | undefined,
      });
      return "error" in refreshed ? { ...result, custom_exercises_note: "custom exercises may be out of date" } : result;
    },
  },
  {
    name: "save_routine",
    description:
      "Create a routine, or replace an existing one's contents (pass routine_id). Without " +
      "confirm it only validates and returns a preview of exactly what would be saved, " +
      "plus what changes; show that to the user and call again with confirm=true once " +
      "they agree. exercises replaces the whole exercise list in the order given; omit it " +
      "to change only the title or notes. Each set records what its exercise type allows " +
      "(weight and reps for lifts, duration or distance for cardio); weights may be given " +
      "in lb or kg. folder_id puts the routine in a folder (null for My Routines). Free " +
      "accounts are limited to 4 routines, so creating fails when full.",
    properties: {
      routine_id: { type: "string", description: "Omit to create a new routine." },
      title: { type: "string" },
      notes: { type: "string", description: "Routine-level notes." },
      exercises: { type: "array", items: EXERCISE_SCHEMA },
      folder_id: { type: "integer", nullable: true, description: "From list_routines; null for My Routines." },
      confirm: CONFIRM,
    },
    readOnly: false,
    run: (ctx, a) =>
      hevy(ctx, (client) =>
        routines.saveRoutine(ctx.db, client, {
          routine_id: str(a.routine_id) ?? undefined,
          title: str(a.title) ?? undefined,
          notes: a.notes as string | undefined,
          exercises: a.exercises as routines.ExerciseInput[] | undefined,
          folder_id: a.folder_id as number | null | undefined,
          confirm: a.confirm === true,
        }),
      ),
  },
  {
    name: "delete_routine",
    description:
      "Delete one routine. Without confirm it returns the routine that would be deleted " +
      "and changes nothing. Cannot be undone, so confirm with the user first.",
    properties: { routine_id: { type: "string" }, confirm: CONFIRM },
    required: ["routine_id"],
    readOnly: false,
    destructive: true,
    run: (ctx, a) =>
      hevy(ctx, (client) => routines.deleteRoutine(client, { routine_id: a.routine_id as string, confirm: a.confirm === true })),
  },
  {
    name: "create_routine_folder",
    description: "Create an empty routine folder, e.g. for a new training block. Returns its folder_id.",
    properties: { title: { type: "string" } },
    required: ["title"],
    readOnly: false,
    run: (ctx, a) => hevy(ctx, (client) => routines.createFolder(client, { title: a.title as string })),
  },
  {
    name: "move_routine",
    description: "Move a routine into a folder (appended at the end), or to My Routines with folder_id null.",
    properties: {
      routine_id: { type: "string" },
      folder_id: { type: "integer", nullable: true, description: "From list_routines; null for My Routines." },
    },
    required: ["routine_id", "folder_id"],
    readOnly: false,
    run: (ctx, a) =>
      hevy(ctx, (client) =>
        routines.moveRoutine(client, { routine_id: a.routine_id as string, folder_id: a.folder_id as number | null }),
      ),
  },
  {
    name: "delete_routine_folder",
    description: "Delete an empty routine folder. Refuses while it still holds routines.",
    properties: { folder_id: { type: "integer" } },
    required: ["folder_id"],
    readOnly: false,
    destructive: true,
    run: (ctx, a) => hevy(ctx, (client) => routines.deleteFolder(client, { folder_id: a.folder_id as number })),
  },

  // --- plans ---------------------------------------------------------------

  {
    name: "save_plan",
    description:
      "Store a training plan on this connector (not in Hevy): any number of days, each " +
      "a routine in save_routine's exercise format with a label like 'Week 1 Day A'. " +
      "Use it for programs longer than Hevy's 4-routine limit, then put one day at a " +
      "time into Hevy with load_plan_day. Exercises are checked against Hevy's library. " +
      "Pass plan_id to replace an existing plan's contents. Changes nothing in Hevy.",
    properties: {
      plan_id: { type: "string", description: "Omit to create a new plan." },
      name: { type: "string" },
      notes: { type: "string", description: "Goals, progression rules, schedule." },
      days: { type: "array", items: PLAN_DAY_SCHEMA },
    },
    required: ["name", "days"],
    readOnly: false,
    run: (ctx, a) =>
      hevy(ctx, (client) =>
        plans.savePlan(ctx.db, client, {
          plan_id: str(a.plan_id) ?? undefined,
          name: a.name as string,
          notes: a.notes as string | undefined,
          days: a.days as plans.PlanDay[],
        }),
      ),
  },
  {
    name: "list_plans",
    description: "Every stored training plan with its days (number, label, routine title), newest first.",
    properties: {},
    readOnly: true,
    run: (ctx) => plans.listPlans(ctx.db),
  },
  {
    name: "get_plan",
    description:
      "One stored plan in full: every day's exercises (names and template ids), sets, " +
      "rest, and notes. Takes the plan's id or exact name.",
    properties: { plan_id: { type: "string", description: "Id or exact name, from list_plans." } },
    required: ["plan_id"],
    readOnly: true,
    run: (ctx, a) => plans.getPlan(ctx.db, a.plan_id as string),
  },
  {
    name: "load_plan_day",
    description:
      "Put one day of a stored plan into Hevy as a routine. day is the day's number or " +
      "label. Without routine_id it fills a free routine slot; when Hevy is full it " +
      "returns choose_routine, and you must ask the user which routine to replace and " +
      "call again with that routine_id. Like save_routine: without confirm it returns a " +
      "preview and changes nothing; show it, then call again with confirm=true.",
    properties: {
      plan_id: { type: "string", description: "Id or exact name, from list_plans." },
      day: { type: "string", description: 'Day number ("3") or label ("Week 1 Day C").' },
      routine_id: { type: "string", description: "The Hevy routine to replace, as chosen by the user." },
      confirm: CONFIRM,
    },
    required: ["plan_id", "day"],
    readOnly: false,
    run: (ctx, a) =>
      hevy(ctx, (client) =>
        plans.loadPlanDay(ctx.db, client, {
          plan_id: a.plan_id as string,
          day: a.day as string,
          routine_id: str(a.routine_id) ?? undefined,
          confirm: a.confirm === true,
        }),
      ),
  },
  {
    name: "save_routines_as_plan",
    description:
      "Copy Hevy routines into a plan exactly as Hevy stores them: every set, weight, rest " +
      "timer, note, and superset, plus each routine's folder and position. Pass folder_id " +
      "for a whole folder (null for My Routines) or routine_ids for a hand-picked set. Use " +
      "it before replacing routines the user wants back later; restore_plan returns them. " +
      "Changes nothing in Hevy.",
    properties: {
      name: { type: "string", description: 'e.g. "PPL (saved 2026-10-16)".' },
      folder_id: { type: "integer", nullable: true, description: "From list_routines; null for My Routines." },
      routine_ids: { type: "array", items: { type: "string" }, description: "In the order to keep them." },
      notes: { type: "string" },
      plan_id: { type: "string", description: "Replace this existing plan instead of creating one." },
    },
    required: ["name"],
    readOnly: false,
    run: (ctx, a) =>
      hevy(ctx, (client) =>
        plans.saveRoutinesAsPlan(ctx.db, client, {
          name: a.name as string,
          folder_id: a.folder_id as number | null | undefined,
          routine_ids: a.routine_ids as string[] | undefined,
          notes: a.notes as string | undefined,
          plan_id: str(a.plan_id) ?? undefined,
        }),
      ),
  },
  {
    name: "restore_plan",
    description:
      "Put a plan made by save_routines_as_plan back into Hevy: each routine is rewritten in " +
      "place if it still exists (keeping its folder and position) or recreated in its original " +
      "folder, which is recreated too if needed. When Hevy lacks room to recreate them it " +
      "returns choose_routine; ask the user what to free up. Without confirm it returns a " +
      "preview of every routine and changes nothing; show it, then call again with confirm=true.",
    properties: { plan_id: { type: "string", description: "Id or exact name, from list_plans." }, confirm: CONFIRM },
    required: ["plan_id"],
    readOnly: false,
    run: (ctx, a) =>
      hevy(ctx, (client) => plans.restorePlan(ctx.db, client, { plan_id: a.plan_id as string, confirm: a.confirm === true })),
  },
  {
    name: "delete_plan",
    description:
      "Delete a stored plan from this connector. Routines already loaded into Hevy stay. " +
      "Without confirm it shows the plan and changes nothing; confirm with the user first.",
    properties: { plan_id: { type: "string" }, confirm: CONFIRM },
    required: ["plan_id"],
    readOnly: false,
    destructive: true,
    run: (ctx, a) => plans.deletePlan(ctx.db, { plan_id: a.plan_id as string, confirm: a.confirm === true }),
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function propertySchema(prop: Property): Json {
  const { nullable, ...schema } = prop;
  return nullable ? { ...schema, type: [prop.type, "null"] } : schema;
}

function toolListing(tool: ToolDef): Json {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(Object.entries(tool.properties).map(([k, p]) => [k, propertySchema(p)])),
      ...(tool.required ? { required: tool.required } : {}),
      additionalProperties: false,
    },
    annotations: tool.readOnly
      ? { readOnlyHint: true }
      : { readOnlyHint: false, destructiveHint: Boolean(tool.destructive), openWorldHint: true },
  };
}

/**
 * Check top-level arguments against the declared schema. Returns an error
 * message or null. Nested routine contents are checked in routines.ts, which
 * can name the exact exercise and set at fault.
 */
export function validateArguments(tool: ToolDef, args: Json): string | null {
  for (const name of tool.required ?? []) {
    const missing = args[name] === undefined || (args[name] === null && !tool.properties[name]?.nullable);
    if (missing) return `missing required argument '${name}'`;
  }
  for (const [name, value] of Object.entries(args)) {
    const prop = tool.properties[name];
    if (!prop) return `unknown argument '${name}'`;
    if (value === null) continue;
    if (prop.type === "integer" && !(typeof value === "number" && Number.isInteger(value))) {
      return `'${name}' must be an integer`;
    }
    if (prop.type === "number" && !(typeof value === "number" && Number.isFinite(value))) {
      return `'${name}' must be a number`;
    }
    if (prop.type === "boolean" && typeof value !== "boolean") return `'${name}' must be true or false`;
    if (prop.type === "string" && typeof value !== "string") return `'${name}' must be a string`;
    if (prop.type === "array") {
      if (!Array.isArray(value)) return `'${name}' must be a list`;
      const itemType = (prop.items as Json | undefined)?.type;
      if (itemType === "string" && value.some((v) => typeof v !== "string")) {
        return `every entry in '${name}' must be a string`;
      }
      if (itemType !== "string" && value.some((v) => typeof v !== "object" || v === null || Array.isArray(v))) {
        return `every entry in '${name}' must be an object`;
      }
    }
    if (prop.enum && !prop.enum.includes(value as string)) {
      return `'${name}' must be one of: ${prop.enum.join(", ")}`;
    }
  }
  return null;
}

function textResult(payload: Json, isError = false): Json {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

async function callTool(ctx: ToolContext, params: Json): Promise<Json> {
  const tool = TOOLS_BY_NAME.get(params.name as string);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(params.name)}`);
  const args = (params.arguments ?? {}) as Json;
  if (typeof args !== "object" || Array.isArray(args)) throw new RpcError(-32602, "arguments must be an object");

  const problem = validateArguments(tool, args);
  if (problem) return textResult({ error: "invalid_argument", message: problem }, true);
  try {
    const result = await tool.run(ctx, args);
    return textResult(result, "error" in result);
  } catch (exc) {
    if (exc instanceof queries.InvalidArgument) {
      return textResult({ error: "invalid_argument", message: exc.message }, true);
    }
    throw exc;
  }
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function dispatch(ctx: ToolContext, method: string, params: Json): Promise<Json> {
  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion as string;
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "hevy", version: VERSION },
        instructions: INSTRUCTIONS,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS.map(toolListing) };
    case "tools/call":
      return callTool(ctx, params);
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

async function handleMessage(ctx: ToolContext, message: unknown): Promise<Json | null> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  }
  const { id, method, params } = message as Json;
  // Notifications (no id) and stray responses get no reply.
  if (id === undefined || typeof method !== "string") return null;
  try {
    const result = await dispatch(ctx, method, (params ?? {}) as Json);
    return { jsonrpc: "2.0", id, result };
  } catch (exc) {
    if (exc instanceof RpcError) return { jsonrpc: "2.0", id, error: { code: exc.code, message: exc.message } };
    console.error(`MCP ${method} failed:`, exc);
    return { jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } };
  }
}

/** Handle one request to the MCP endpoint. fetchImpl replaces fetch for Hevy calls in tests. */
export async function handleMcp(request: Request, db: D1Database, fetchImpl?: typeof fetch): Promise<Response> {
  const ctx: ToolContext = { db, fetchImpl };
  if (request.method !== "POST") {
    // No server-initiated stream and no sessions to delete.
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }

  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map((m) => handleMessage(ctx, m)))).filter(Boolean);
    return replies.length ? Response.json(replies) : new Response(null, { status: 202 });
  }
  const reply = await handleMessage(ctx, body);
  return reply ? Response.json(reply) : new Response(null, { status: 202 });
}
