// The one unauthenticated endpoint: a summary of the most recent workout, for
// the "live from the connector" card on the owner's website.
//
// It publishes only what the owner chose: a label, how many days ago, the set
// count and the duration in minutes. Never the free-text workout name, the
// exact time, exercises, weights or notes. The label is a fixed word picked
// from a list, or the muscle groups worked, so nothing typed into Hevy can leak.

import { TIMEZONE } from "./config";
import { zonedIso } from "./normalize";

export const LAST_WORKOUT_PATH = "/public/last-workout";
const CACHE_SECONDS = 300;

// Split names recognised inside a workout's title, in priority order. Only the
// canonical word on the right is ever published.
const SPLITS: [RegExp, string][] = [
  [/\bfull[\s-]?body\b/i, "Full body"],
  [/\bpush\b/i, "Push"],
  [/\bpull\b/i, "Pull"],
  [/\blegs?\b/i, "Legs"],
  [/\bupper\b/i, "Upper"],
  [/\blower\b/i, "Lower"],
  [/\barms?\b/i, "Arms"],
  [/\bchest\b/i, "Chest"],
  [/\bback\b/i, "Back"],
  [/\bshoulders?\b/i, "Shoulders"],
  [/\bcardio\b/i, "Cardio"],
];

const MUSCLES: Record<string, string> = {
  abdominals: "abs",
  abductors: "abductors",
  adductors: "adductors",
  biceps: "biceps",
  calves: "calves",
  cardio: "cardio",
  chest: "chest",
  forearms: "forearms",
  full_body: "full body",
  glutes: "glutes",
  hamstrings: "hamstrings",
  lats: "lats",
  lower_back: "lower back",
  neck: "neck",
  quadriceps: "quads",
  shoulders: "shoulders",
  traps: "traps",
  triceps: "triceps",
  upper_back: "upper back",
};

/** A safe public label: a known split name, else the top two muscle groups. */
export function publicLabel(name: string | null, muscleGroups: string[]): string {
  for (const [pattern, label] of SPLITS) if (pattern.test(name ?? "")) return label;
  const known = muscleGroups.map((m) => MUSCLES[m]).filter((m): m is string => Boolean(m));
  if (known.length === 0) return "Workout";
  const words = known.slice(0, 2).join(" & ");
  return words[0].toUpperCase() + words.slice(1);
}

function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(toDate) - Date.parse(fromDate)) / 86_400_000);
}

export async function lastWorkout(db: D1Database, now = Date.now()): Promise<Response> {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
    "X-Robots-Tag": "noindex",
  };
  const workout = await db
    .prepare(
      "SELECT workout_id, name, start_date, duration_seconds, set_count FROM workout " +
        "ORDER BY start_date DESC, start_time DESC LIMIT 1",
    )
    .first<{ workout_id: string; name: string | null; start_date: string; duration_seconds: number | null; set_count: number | null }>();
  if (!workout) return Response.json({ error: "no workouts" }, { status: 404, headers });

  const { results } = await db
    .prepare(
      "SELECT e.muscle_group AS muscle, COUNT(*) AS sets FROM workout_set s " +
        "JOIN exercise e ON e.template_id = s.template_id " +
        "WHERE s.workout_id = ? AND e.muscle_group IS NOT NULL " +
        "GROUP BY e.muscle_group ORDER BY sets DESC, muscle",
    )
    .bind(workout.workout_id)
    .all<{ muscle: string }>();

  const today = zonedIso(now * 1000, TIMEZONE)[1];
  return Response.json(
    {
      label: publicLabel(workout.name, results.map((r) => r.muscle)),
      days_ago: Math.max(0, daysBetween(workout.start_date, today)),
      sets: workout.set_count ?? 0,
      minutes: Math.round((workout.duration_seconds ?? 0) / 60),
    },
    { headers },
  );
}
