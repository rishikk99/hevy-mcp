// Turn a raw workout payload into star-schema rows. A line-for-line port of
// src/hevy_mcp/normalize.py, whose docstrings explain the payload fields and
// the bodyweight volume rule. A test replays every cached workout through this
// and compares the tables with the ones Python wrote.

import { ASSISTED_EXERCISE_TYPE, BODYWEIGHT_KG, FULL_BODYWEIGHT_TEMPLATES, TIMEZONE } from "./config";

const WARMUP = "warmup";

type Json = Record<string, unknown>;
type Bindable = string | number | null;

/** Casefold, drop punctuation, collapse whitespace. Used as the match key. */
export function normalizeName(name: string | null | undefined): string {
  const cleaned = [...(name ?? "")].map((ch) => (/[\p{L}\p{N}\s]/u.test(ch) ? ch : " ")).join("");
  return cleaned.toLowerCase().split(/\s+/u).filter(Boolean).join(" ");
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = zoneFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "longOffset",
    });
    zoneFormatters.set(timeZone, f);
  }
  return f;
}

/**
 * Python's datetime.fromtimestamp(t, tz=ZoneInfo(zone)).isoformat(): local wall
 * time with its UTC offset, microseconds only when non-zero. Returns [iso, date].
 */
export function zonedIso(epochMicros: number, timeZone: string): [string, string] {
  const seconds = Math.floor(epochMicros / 1e6);
  const micros = epochMicros - seconds * 1e6;
  const parts = Object.fromEntries(
    zoneFormatter(timeZone)
      .formatToParts(new Date(seconds * 1000))
      .map((p) => [p.type, p.value]),
  );
  // "GMT-05:00", or bare "GMT" at offset zero.
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : parts.timeZoneName.slice(3);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const fraction = micros ? `.${String(micros).padStart(6, "0")}` : "";
  return [`${date}T${parts.hour}:${parts.minute}:${parts.second}${fraction}${offset}`, date];
}

const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?(?:(Z)|([+-])(\d{2}):?(\d{2}))?$/;

/**
 * Return [iso, YYYY-MM-DD] in the given time zone. Hevy sends epoch seconds;
 * ISO strings also work, and one without an offset is taken as UTC. The date is
 * the local one, so an evening workout keeps its own day.
 */
export function parseTimestamp(value: unknown, timeZone = TIMEZONE): [string | null, string | null] {
  if (value === null || value === undefined || typeof value === "boolean") return [null, null];

  if (typeof value === "number") {
    let seconds = value;
    // Values past ~year 2286 in seconds are really milliseconds.
    if (seconds > 1e11) seconds /= 1000;
    if (!Number.isFinite(seconds)) return [null, null];
    return zonedIso(Math.round(seconds * 1e6), timeZone);
  }

  const text = String(value).trim();
  if (!text) return [null, null];
  if (/^\d+$/.test(text)) return parseTimestamp(Number(text), timeZone);

  const m = ISO_PATTERN.exec(text);
  if (!m) return [text, null];
  const [, y, mo, d, h = "00", mi = "00", s = "00", frac = "", zulu, sign, oh, om] = m;
  const offsetMinutes = zulu || !sign ? 0 : (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om));
  const wallMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const micros = Number(frac.slice(0, 6).padEnd(6, "0") || "0");
  return zonedIso((wallMs - offsetMinutes * 60_000) * 1000 + micros, timeZone);
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null;
    return Number(text);
  }
  return null;
}

function toInteger(value: unknown): number | null {
  const n = toNumber(value);
  return n === null ? null : Math.trunc(n);
}

function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = (typeof value === "boolean" ? (value ? "True" : "False") : String(value)).trim();
  return text || null;
}

/** Volume for one set, matching how Hevy counts it. See normalize.set_volume. */
export function setVolume(
  exerciseType: string | null,
  templateId: string | null,
  weightKg: number | null,
  reps: number | null,
): number | null {
  if (reps === null) return null;
  if (exerciseType === ASSISTED_EXERCISE_TYPE) return (BODYWEIGHT_KG - (weightKg || 0)) * reps;
  if (templateId !== null && FULL_BODYWEIGHT_TEMPLATES.has(templateId)) {
    return (BODYWEIGHT_KG + (weightKg || 0)) * reps;
  }
  if (weightKg === null) return null;
  return weightKg * reps;
}

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export interface SqlStatement {
  sql: string;
  params: Bindable[];
}

/**
 * Every write for one workout, in the order normalize.write_workout issues
 * them: clear the children, write the children, then upsert the workout row.
 */
export function workoutStatements(workoutId: string, payload: Json, digest: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  const add = (sql: string, ...params: Bindable[]) => out.push({ sql, params });

  const [startTime, startDate] = parseTimestamp(payload.start_time);
  const [endTime] = parseTimestamp(payload.end_time);

  let duration: number | null = null;
  const rawStart = toNumber(payload.start_time);
  const rawEnd = toNumber(payload.end_time);
  if (rawStart !== null && rawEnd !== null && rawEnd >= rawStart) duration = Math.trunc(rawEnd - rawStart);

  const calories = isObject(payload.biometrics) ? toInteger(payload.biometrics.total_calories) : null;

  // Replace children first so re-syncing an edited workout leaves no orphans.
  for (const table of ["personal_record", "workout_set", "workout_exercise"]) {
    add(`DELETE FROM ${table} WHERE workout_id = ?`, workoutId);
  }

  const counts = { exercises: 0, sets: 0, volume: 0, workingVolume: 0 };
  const exercises = Array.isArray(payload.exercises) ? payload.exercises : null;
  if (exercises === null) {
    console.warn(`Workout ${workoutId} has no exercises list; the endpoint shape may have changed.`);
  }

  (exercises ?? []).forEach((exercise, position) => {
    if (!isObject(exercise)) return;
    const title = toText(exercise.title);
    if (!title) {
      console.warn(`Workout ${workoutId} exercise ${position} has no title; skipping.`);
      return;
    }

    const templateId = toText(exercise.exercise_template_id);
    const exerciseType = toText(exercise.exercise_type);
    if (templateId) {
      const primary = toText(exercise.muscle_group);
      add(
        "INSERT INTO exercise " +
          "  (template_id, title, title_norm, muscle_group, equipment_category, exercise_type) " +
          "VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(template_id) DO UPDATE SET " +
          "  title = excluded.title, title_norm = excluded.title_norm," +
          "  muscle_group = excluded.muscle_group," +
          "  equipment_category = excluded.equipment_category," +
          "  exercise_type = excluded.exercise_type",
        templateId,
        title,
        normalizeName(title),
        primary,
        toText(exercise.equipment_category),
        exerciseType,
      );
      if (primary) {
        add(
          "INSERT OR IGNORE INTO exercise_muscle (template_id, muscle, role) VALUES (?, ?, 'primary')",
          templateId,
          primary,
        );
      }
      const others = Array.isArray(exercise.other_muscles) ? exercise.other_muscles : [];
      for (const muscle of others) {
        const name = toText(muscle);
        if (name && name !== primary) {
          add(
            "INSERT OR IGNORE INTO exercise_muscle (template_id, muscle, role) VALUES (?, ?, 'secondary')",
            templateId,
            name,
          );
        }
      }
    }

    add(
      "INSERT INTO workout_exercise (workout_id, position, template_id, title, notes, rest_seconds) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
      workoutId,
      position,
      templateId,
      title,
      toText(exercise.notes),
      toInteger(exercise.rest_seconds),
    );
    counts.exercises += 1;

    if (!Array.isArray(exercise.sets)) return;
    exercise.sets.forEach((entry, order) => {
      if (!isObject(entry)) return;
      const setIndex = toInteger(entry.index) ?? order;
      const weight = toNumber(entry.weight_kg);
      const reps = toInteger(entry.reps);
      const setType = toText(entry.indicator);
      const volume = setVolume(exerciseType, templateId, weight, reps);

      add(
        "INSERT INTO workout_set " +
          "  (workout_id, position, set_index, start_date, template_id, set_type," +
          "   weight_kg, reps, rpe, distance_m, duration_s, custom_metric, volume_kg) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(workout_id, position, set_index) DO UPDATE SET " +
          "  set_type = excluded.set_type, weight_kg = excluded.weight_kg," +
          "  reps = excluded.reps, rpe = excluded.rpe," +
          "  distance_m = excluded.distance_m, duration_s = excluded.duration_s," +
          "  custom_metric = excluded.custom_metric, volume_kg = excluded.volume_kg",
        workoutId,
        position,
        setIndex,
        startDate ?? "",
        templateId,
        setType,
        weight,
        reps,
        toNumber(entry.rpe),
        toNumber(entry.distance_meters),
        toInteger(entry.duration_seconds),
        toNumber(entry.custom_metric),
        volume,
      );
      counts.sets += 1;
      if (volume !== null) {
        counts.volume += volume;
        if (setType !== WARMUP) counts.workingVolume += volume;
      }

      const prs = Array.isArray(entry.prs) ? entry.prs : [];
      for (const record of prs) {
        if (!isObject(record)) continue;
        const prType = toText(record.type);
        if (!prType) continue;
        add(
          "INSERT INTO personal_record (workout_id, position, set_index, pr_type, value) " +
            "VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(workout_id, position, set_index, pr_type) DO UPDATE SET value = excluded.value",
          workoutId,
          position,
          setIndex,
          prType,
          toNumber(record.value),
        );
      }
    });
  });

  add(
    "INSERT INTO workout (" +
      "  workout_id, name, start_time, end_time, start_date, duration_seconds," +
      "  nth_workout, routine_id, description, calories, exercise_count," +
      "  set_count, volume_kg, working_volume_kg, hevy_volume_kg, updated_at," +
      "  payload_hash" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(workout_id) DO UPDATE SET " +
      "  name = excluded.name, start_time = excluded.start_time," +
      "  end_time = excluded.end_time, start_date = excluded.start_date," +
      "  duration_seconds = excluded.duration_seconds," +
      "  nth_workout = excluded.nth_workout, routine_id = excluded.routine_id," +
      "  description = excluded.description, calories = excluded.calories," +
      "  exercise_count = excluded.exercise_count, set_count = excluded.set_count," +
      "  volume_kg = excluded.volume_kg," +
      "  working_volume_kg = excluded.working_volume_kg," +
      "  hevy_volume_kg = excluded.hevy_volume_kg," +
      "  updated_at = excluded.updated_at, payload_hash = excluded.payload_hash",
    workoutId,
    toText(payload.name),
    startTime,
    endTime,
    startDate,
    duration,
    toInteger(payload.nth_workout),
    toText(payload.routine_id),
    toText(payload.description),
    calories,
    counts.exercises,
    counts.sets,
    counts.volume,
    counts.workingVolume,
    toNumber(payload.estimated_volume_kg),
    toText(payload.updated_at),
    digest,
  );

  return out;
}
