"""Turn a raw workout payload into star-schema rows.

Field names come from a real captured payload, not from guesswork:

* workout: ``id``, ``name``, ``start_time``/``end_time`` (epoch seconds),
  ``updated_at``, ``description``, ``routine_id``, ``nth_workout``,
  ``biometrics.total_calories``, ``exercises[]``
* exercise: ``title``, ``exercise_template_id``, ``muscle_group``,
  ``other_muscles[]``, ``equipment_category``, ``exercise_type``, ``notes``,
  ``rest_seconds``, ``sets[]``. There is no index field, so order is the array
  position.
* set: ``index``, ``weight_kg``, ``reps``, ``rpe``, ``distance_meters``,
  ``duration_seconds``, ``custom_metric``, ``prs[]``, and ``indicator`` -- which
  is the set type (``normal``/``warmup``/``dropset``), *not* ``set_type``.

``volume_kg`` covers every set including warmups; ``working_volume_kg`` excludes
warmups and is carried alongside it. Volume is usually ``weight_kg * reps``, but
bodyweight-loaded exercises follow Hevy's own rule -- see :func:`set_volume`.

Hevy's ``estimated_volume_kg`` is also stored verbatim as ``hevy_volume_kg``, and
the two now reconcile across the whole history, which is asserted by a test.
"""

from __future__ import annotations

import logging
import sqlite3
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from hevy_mcp import config

log = logging.getLogger(__name__)

WARMUP = "warmup"


def normalize_name(name: str) -> str:
    """Casefold, drop punctuation, collapse whitespace. Used as the match key."""
    cleaned = "".join(ch if ch.isalnum() or ch.isspace() else " " for ch in (name or ""))
    return " ".join(cleaned.casefold().split())


def parse_timestamp(value) -> tuple[str | None, str | None]:
    """Return ``(iso, YYYY-MM-DD)`` in the configured local time zone.

    Hevy sends epoch seconds; ISO strings also work, and a naive one is taken
    as UTC. The date is the local one, so an evening workout keeps its own day.
    """
    if value is None or isinstance(value, bool):
        return None, None
    local = ZoneInfo(config.timezone_name())

    if isinstance(value, (int, float)):
        seconds = float(value)
        # Values past ~year 2286 in seconds are really milliseconds.
        if seconds > 1e11:
            seconds /= 1000.0
        try:
            moment = datetime.fromtimestamp(seconds, tz=local)
        except (OverflowError, OSError, ValueError):
            return None, None
        return moment.isoformat(), moment.date().isoformat()

    text = str(value).strip()
    if not text:
        return None, None
    if text.isdigit():
        return parse_timestamp(int(text))

    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return text, None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    moment = moment.astimezone(local)
    return moment.isoformat(), moment.date().isoformat()


# Kept as an alias: the older name is used in a few call sites and tests.
parse_start_time = parse_timestamp


def _number(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _integer(value) -> int | None:
    number = _number(value)
    return int(number) if number is not None else None


def _text(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def set_volume(
    exercise_type: str | None,
    template_id: str | None,
    weight_kg: float | None,
    reps: int | None,
) -> float | None:
    """Volume for one set, matching how Hevy counts it.

    Usually ``weight_kg * reps``, but bodyweight-loaded exercises differ:

    * assisted work subtracts the assistance from bodyweight, so a *lighter*
      assist means more volume;
    * Pull Up and Triceps Dip carry the full bodyweight and log no weight at all.

    Returns None when the set has no volume concept (cardio, timed holds).
    """
    if reps is None:
        return None

    if exercise_type == config.ASSISTED_EXERCISE_TYPE:
        return (config.BODYWEIGHT_KG - (weight_kg or 0.0)) * reps

    if template_id in config.FULL_BODYWEIGHT_TEMPLATES:
        return (config.BODYWEIGHT_KG + (weight_kg or 0.0)) * reps

    if weight_kg is None:
        return None
    return weight_kg * reps


def write_workout(
    conn: sqlite3.Connection,
    workout_id: str,
    payload: dict,
    digest: str,
) -> None:
    """Write one workout and all of its exercise, set, and PR rows."""
    start_time, start_date = parse_timestamp(payload.get("start_time"))
    end_time, _ = parse_timestamp(payload.get("end_time"))

    duration = None
    raw_start, raw_end = _number(payload.get("start_time")), _number(payload.get("end_time"))
    if raw_start is not None and raw_end is not None and raw_end >= raw_start:
        duration = int(raw_end - raw_start)

    biometrics = payload.get("biometrics")
    calories = _integer(biometrics.get("total_calories")) if isinstance(biometrics, dict) else None

    # Replace children first so re-syncing an edited workout leaves no orphans.
    _delete_children(conn, workout_id)
    stats = _write_children(conn, workout_id, payload, start_date)

    conn.execute(
        "INSERT INTO workout ("
        "  workout_id, name, start_time, end_time, start_date, duration_seconds,"
        "  nth_workout, routine_id, description, calories, exercise_count,"
        "  set_count, volume_kg, working_volume_kg, hevy_volume_kg, updated_at,"
        "  payload_hash"
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(workout_id) DO UPDATE SET "
        "  name = excluded.name, start_time = excluded.start_time,"
        "  end_time = excluded.end_time, start_date = excluded.start_date,"
        "  duration_seconds = excluded.duration_seconds,"
        "  nth_workout = excluded.nth_workout, routine_id = excluded.routine_id,"
        "  description = excluded.description, calories = excluded.calories,"
        "  exercise_count = excluded.exercise_count, set_count = excluded.set_count,"
        "  volume_kg = excluded.volume_kg,"
        "  working_volume_kg = excluded.working_volume_kg,"
        "  hevy_volume_kg = excluded.hevy_volume_kg,"
        "  updated_at = excluded.updated_at, payload_hash = excluded.payload_hash",
        (
            workout_id,
            _text(payload.get("name")),
            start_time,
            end_time,
            start_date,
            duration,
            _integer(payload.get("nth_workout")),
            _text(payload.get("routine_id")),
            _text(payload.get("description")),
            calories,
            stats["exercises"],
            stats["sets"],
            stats["volume"],
            stats["working_volume"],
            _number(payload.get("estimated_volume_kg")),
            _text(payload.get("updated_at")),
            digest,
        ),
    )


def _delete_children(conn: sqlite3.Connection, workout_id: str) -> None:
    for table in ("personal_record", "workout_set", "workout_exercise"):
        conn.execute(f"DELETE FROM {table} WHERE workout_id = ?", (workout_id,))


def _write_children(
    conn: sqlite3.Connection,
    workout_id: str,
    payload: dict,
    start_date: str | None,
) -> dict:
    exercises = payload.get("exercises")
    if not isinstance(exercises, list):
        log.warning(
            "Workout %s has no exercises list (got %s); the endpoint shape may have changed.",
            workout_id,
            type(exercises).__name__,
        )
        return {"exercises": 0, "sets": 0, "volume": 0.0, "working_volume": 0.0}

    counts = {"exercises": 0, "sets": 0, "volume": 0.0, "working_volume": 0.0}

    for position, exercise in enumerate(exercises):
        if not isinstance(exercise, dict):
            continue

        title = _text(exercise.get("title"))
        if not title:
            log.warning("Workout %s exercise %s has no title; skipping.", workout_id, position)
            continue

        template_id = _text(exercise.get("exercise_template_id"))
        _upsert_exercise(conn, template_id, title, exercise)

        conn.execute(
            "INSERT INTO workout_exercise "
            "  (workout_id, position, template_id, title, notes, rest_seconds) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                workout_id,
                position,
                template_id,
                title,
                _text(exercise.get("notes")),
                _integer(exercise.get("rest_seconds")),
            ),
        )
        counts["exercises"] += 1

        sets = exercise.get("sets")
        if not isinstance(sets, list):
            continue

        for order, entry in enumerate(sets):
            if not isinstance(entry, dict):
                continue

            set_index = _integer(entry.get("index"))
            if set_index is None:
                set_index = order

            weight = _number(entry.get("weight_kg"))
            reps = _integer(entry.get("reps"))
            set_type = _text(entry.get("indicator"))
            volume = set_volume(
                _text(exercise.get("exercise_type")), template_id, weight, reps
            )

            conn.execute(
                "INSERT INTO workout_set "
                "  (workout_id, position, set_index, start_date, template_id, set_type,"
                "   weight_kg, reps, rpe, distance_m, duration_s, custom_metric, volume_kg) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(workout_id, position, set_index) DO UPDATE SET "
                "  set_type = excluded.set_type, weight_kg = excluded.weight_kg,"
                "  reps = excluded.reps, rpe = excluded.rpe,"
                "  distance_m = excluded.distance_m, duration_s = excluded.duration_s,"
                "  custom_metric = excluded.custom_metric, volume_kg = excluded.volume_kg",
                (
                    workout_id,
                    position,
                    set_index,
                    start_date or "",
                    template_id,
                    set_type,
                    weight,
                    reps,
                    _number(entry.get("rpe")),
                    _number(entry.get("distance_meters")),
                    _integer(entry.get("duration_seconds")),
                    _number(entry.get("custom_metric")),
                    volume,
                ),
            )
            counts["sets"] += 1
            if volume is not None:
                counts["volume"] += volume
                if set_type != WARMUP:
                    counts["working_volume"] += volume

            _write_prs(conn, workout_id, position, set_index, entry)

    return counts


def _upsert_exercise(
    conn: sqlite3.Connection,
    template_id: str | None,
    title: str,
    exercise: dict,
) -> None:
    """Maintain the exercise dimension and its muscle rows."""
    if not template_id:
        return

    conn.execute(
        "INSERT INTO exercise "
        "  (template_id, title, title_norm, muscle_group, equipment_category, exercise_type) "
        "VALUES (?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(template_id) DO UPDATE SET "
        "  title = excluded.title, title_norm = excluded.title_norm,"
        "  muscle_group = excluded.muscle_group,"
        "  equipment_category = excluded.equipment_category,"
        "  exercise_type = excluded.exercise_type",
        (
            template_id,
            title,
            normalize_name(title),
            _text(exercise.get("muscle_group")),
            _text(exercise.get("equipment_category")),
            _text(exercise.get("exercise_type")),
        ),
    )

    primary = _text(exercise.get("muscle_group"))
    if primary:
        conn.execute(
            "INSERT OR IGNORE INTO exercise_muscle (template_id, muscle, role) "
            "VALUES (?, ?, 'primary')",
            (template_id, primary),
        )

    for muscle in exercise.get("other_muscles") or []:
        name = _text(muscle)
        if name and name != primary:
            conn.execute(
                "INSERT OR IGNORE INTO exercise_muscle (template_id, muscle, role) "
                "VALUES (?, ?, 'secondary')",
                (template_id, name),
            )


def _write_prs(
    conn: sqlite3.Connection,
    workout_id: str,
    position: int,
    set_index: int,
    entry: dict,
) -> None:
    """Store personal records. ``prs`` entries are ``{type, value}``."""
    for record in entry.get("prs") or []:
        if not isinstance(record, dict):
            continue
        pr_type = _text(record.get("type"))
        if not pr_type:
            continue
        conn.execute(
            "INSERT INTO personal_record (workout_id, position, set_index, pr_type, value) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(workout_id, position, set_index, pr_type) DO UPDATE SET "
            "  value = excluded.value",
            (workout_id, position, set_index, pr_type, _number(record.get("value"))),
        )
