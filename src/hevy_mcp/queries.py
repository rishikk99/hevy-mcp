"""Read-only queries behind the MCP tools.

Every function reads SQLite and nothing else. Results are compact and capped,
and any capped result reports it.

Two volume metrics are carried side by side because they answer different
questions:

* ``volume_kg`` includes warmup sets. Summed over a workout it reproduces Hevy's
  own ``estimated_volume_kg`` exactly, so it is the number that reconciles.
* ``working_volume_kg`` excludes warmups. Roughly a third of logged sets are
  warmups, so trends can differ materially between the two.

Muscle *exposure* is deliberately a separate function from volume. It credits a
set to its primary muscle and to every secondary muscle, so it does not sum to
tonnage -- see :func:`get_muscle_exposure`.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from hevy_mcp import config, db
from hevy_mcp.matching import best_match


def _cache_meta(conn: sqlite3.Connection) -> dict[str, Any]:
    meta = {
        # Dates and workout times are in this zone; last_sync_at stays UTC.
        "timezone": config.timezone_name(),
        "last_sync_at": db.get_state(conn, "last_sync_at"),
        "cached_workouts": conn.execute(
            "SELECT COUNT(*) AS n FROM raw_workouts"
        ).fetchone()["n"],
    }
    # Set by a failed sync and cleared by the next good one. Surfacing it on
    # every result means a user learns the data is going stale from the
    # answer itself, not by noticing last_sync_at drift.
    sync_error = db.get_state(conn, "last_sync_error")
    if sync_error:
        meta["sync_error"] = sync_error
    return meta


def _date_clause(start_date: str | None, end_date: str | None, column: str = "date"):
    clauses, params = [], []
    if start_date:
        clauses.append(f"{column} >= ?")
        params.append(start_date)
    if end_date:
        clauses.append(f"{column} <= ?")
        params.append(end_date)
    return " AND ".join(clauses), params


def _round(value: Any, places: int) -> Any:
    """Trim float noise. Weights are lb->kg conversions carrying 15 digits."""
    return round(value, places) if isinstance(value, float) else value


def _compact(row: dict[str, Any]) -> dict[str, Any]:
    """Drop nulls so tool output stays small in a context window."""
    return {k: v for k, v in row.items() if v is not None}


# --- workouts --------------------------------------------------------------


def get_workouts(
    conn: sqlite3.Connection,
    *,
    start_date: str | None = None,
    end_date: str | None = None,
    limit: int = config.DEFAULT_WORKOUTS,
) -> dict[str, Any]:
    """Workout summaries, newest first. No set detail."""
    limit = max(1, min(int(limit), config.MAX_WORKOUTS))
    where, params = _date_clause(start_date, end_date)
    where_sql = f"WHERE {where}" if where else ""

    total = conn.execute(
        f"SELECT COUNT(*) AS n FROM v_workout {where_sql}", params
    ).fetchone()["n"]

    rows = conn.execute(
        f"SELECT * FROM v_workout {where_sql} ORDER BY date DESC, start_time DESC LIMIT ?",
        [*params, limit],
    ).fetchall()

    workouts = [
        _compact(
            {
                "id": r["workout_id"],
                "date": r["date"],
                "start": r["start_time"],
                "end": r["end_time"],
                "name": r["name"],
                "duration_s": r["duration_seconds"],
                "exercises": r["exercise_count"],
                "sets": r["set_count"],
                "volume_kg": _round(r["volume_kg"], 1),
                "working_volume_kg": _round(r["working_volume_kg"], 1),
                "calories": r["calories"],
                "note": r["description"],
                "nth": r["nth_workout"],
            }
        )
        for r in rows
    ]

    return {
        "workouts": workouts,
        "returned": len(workouts),
        "total": total,
        "truncated": total > len(workouts),
        "limit": limit,
        **_cache_meta(conn),
    }


def get_workout_detail(conn: sqlite3.Connection, workout_id: str) -> dict[str, Any]:
    """One workout in full: every exercise, its notes, and every set."""
    workout = conn.execute(
        "SELECT * FROM v_workout WHERE workout_id = ?", (workout_id,)
    ).fetchone()
    if workout is None:
        return {"error": "not_found", "workout_id": workout_id, **_cache_meta(conn)}

    exercises: list[dict[str, Any]] = []
    for row in conn.execute(
        "SELECT we.position, we.title, we.notes, we.rest_seconds, "
        "       e.muscle_group, e.exercise_type, e.equipment_category "
        "FROM workout_exercise we LEFT JOIN exercise e ON e.template_id = we.template_id "
        "WHERE we.workout_id = ? ORDER BY we.position",
        (workout_id,),
    ):
        sets = [
            _compact(
                {
                    "set": s["set_index"],
                    "type": s["set_type"],
                    "kg": _round(s["weight_kg"], 2),
                    "lb": s["weight_lb"],
                    "reps": s["reps"],
                    "rpe": s["rpe"],
                    "distance_m": s["distance_m"],
                    "duration_s": s["duration_s"],
                    "steps": s["custom_metric"],
                }
            )
            for s in conn.execute(
                "SELECT * FROM v_set WHERE workout_id = ? AND position = ? ORDER BY set_index",
                (workout_id, row["position"]),
            )
        ]
        prs = [
            {"type": p["pr_type"], "value": _round(p["value"], 2)}
            for p in conn.execute(
                "SELECT pr_type, value FROM personal_record "
                "WHERE workout_id = ? AND position = ? ORDER BY pr_type",
                (workout_id, row["position"]),
            )
        ]
        exercises.append(
            _compact(
                {
                    "position": row["position"],
                    "exercise": row["title"],
                    "muscle_group": row["muscle_group"],
                    "type": row["exercise_type"],
                    "equipment": row["equipment_category"],
                    "rest_s": row["rest_seconds"],
                    "notes": row["notes"],
                    "sets": sets,
                    "prs": prs or None,
                }
            )
        )

    return {
        "workout": _compact(
            {
                "id": workout["workout_id"],
                "date": workout["date"],
                "start": workout["start_time"],
                "end": workout["end_time"],
                "name": workout["name"],
                "duration_s": workout["duration_seconds"],
                "volume_kg": _round(workout["volume_kg"], 1),
                "working_volume_kg": _round(workout["working_volume_kg"], 1),
                "calories": workout["calories"],
                "note": workout["description"],
                "nth": workout["nth_workout"],
            }
        ),
        "exercises": exercises,
        **_cache_meta(conn),
    }


# --- exercises -------------------------------------------------------------


def _known_exercise_names(conn: sqlite3.Connection) -> list[str]:
    return [r["title"] for r in conn.execute("SELECT title FROM exercise ORDER BY title")]


def get_exercise_history(
    conn: sqlite3.Connection,
    exercise_name: str,
    *,
    start_date: str | None = None,
    end_date: str | None = None,
    limit: int = config.MAX_EXERCISE_HISTORY_SETS,
) -> dict[str, Any]:
    """Every set logged for a fuzzy-matched exercise over the window."""
    limit = max(1, min(int(limit), config.MAX_EXERCISE_HISTORY_SETS))
    names = _known_exercise_names(conn)

    if not names:
        return {
            "query": exercise_name,
            "matched": None,
            "sets": [],
            "returned": 0,
            "total": 0,
            "truncated": False,
            **_cache_meta(conn),
        }

    match, alternatives = best_match(exercise_name, names)
    if match is None:
        return {
            "query": exercise_name,
            "matched": None,
            "message": f"No exercise in your history matched {exercise_name!r}.",
            "known_exercise_count": len(names),
            "sets": [],
            "returned": 0,
            "total": 0,
            "truncated": False,
            **_cache_meta(conn),
        }

    where, params = _date_clause(start_date, end_date)
    where_sql = f"AND {where}" if where else ""

    total = conn.execute(
        f"SELECT COUNT(*) AS n FROM v_set WHERE exercise = ? {where_sql}",
        [match.name, *params],
    ).fetchone()["n"]

    rows = conn.execute(
        f"SELECT * FROM v_set WHERE exercise = ? {where_sql} "
        f"ORDER BY date DESC, workout_id, set_index LIMIT ?",
        [match.name, *params, limit],
    ).fetchall()

    meta = conn.execute(
        "SELECT muscle_group, exercise_type, equipment_category FROM exercise WHERE title = ?",
        (match.name,),
    ).fetchone()

    sets = [
        _compact(
            {
                "date": r["date"],
                "set": r["set_index"],
                "type": r["set_type"],
                "kg": _round(r["weight_kg"], 2),
                "lb": r["weight_lb"],
                "reps": r["reps"],
                "rpe": r["rpe"],
                "distance_m": r["distance_m"],
                "duration_s": r["duration_s"],
                "steps": r["custom_metric"],
            }
        )
        for r in rows
    ]

    return _compact(
        {
            "query": exercise_name,
            "matched": match.name,
            "match_score": match.score,
            "match_how": match.how,
            "alternatives": [m.name for m in alternatives],
            "muscle_group": meta["muscle_group"] if meta else None,
            "exercise_type": meta["exercise_type"] if meta else None,
            "equipment": meta["equipment_category"] if meta else None,
            "sets": sets,
            "returned": len(sets),
            "total": total,
            "truncated": total > len(sets),
            **_cache_meta(conn),
        }
    )


def list_exercises(conn: sqlite3.Connection) -> dict[str, Any]:
    """Distinct exercises with coverage stats, most-trained first."""
    rows = conn.execute(
        "SELECT e.title AS name, e.muscle_group, e.exercise_type, e.equipment_category, "
        "       MIN(s.start_date) AS first_seen, MAX(s.start_date) AS last_seen, "
        "       COUNT(*) AS total_sets, COUNT(DISTINCT s.workout_id) AS workouts "
        "FROM workout_set s JOIN exercise e ON e.template_id = s.template_id "
        "GROUP BY e.template_id ORDER BY total_sets DESC, name LIMIT ?",
        (config.MAX_EXERCISES + 1,),
    ).fetchall()

    truncated = len(rows) > config.MAX_EXERCISES
    rows = rows[: config.MAX_EXERCISES]

    return {
        "exercises": [
            {
                "name": r["name"],
                "muscle_group": r["muscle_group"],
                "type": r["exercise_type"],
                "equipment": r["equipment_category"],
                "first_seen": r["first_seen"],
                "last_seen": r["last_seen"],
                "workouts": r["workouts"],
                "total_sets": r["total_sets"],
            }
            for r in rows
        ],
        "returned": len(rows),
        "truncated": truncated,
        "max_exercises": config.MAX_EXERCISES,
        **_cache_meta(conn),
    }


# --- aggregates ------------------------------------------------------------


def _bucket_expr(period: str, column: str = "date") -> str:
    if period == "week":
        return f"strftime('%Y-W%W', {column})"
    return f"strftime('%Y-%m', {column})"


def get_volume_summary(
    conn: sqlite3.Connection,
    *,
    period: str = "week",
    start_date: str | None = None,
    end_date: str | None = None,
    group_by: str | None = None,
) -> dict[str, Any]:
    """Sets, reps, and tonnage by week or month.

    ``volume_kg`` includes warmups and reconciles with Hevy; ``working_volume_kg``
    excludes them. Grouping by muscle_group credits only the primary muscle, so
    buckets still sum to real tonnage -- use :func:`get_muscle_exposure` to
    include secondary muscles.
    """
    if period not in ("week", "month"):
        raise ValueError("period must be 'week' or 'month'")
    if group_by not in (None, "muscle_group", "exercise", "equipment"):
        raise ValueError("group_by must be None, 'muscle_group', 'exercise', or 'equipment'")

    where, params = _date_clause(start_date, end_date)
    where_sql = f"WHERE {where}" if where else ""

    group_expr = {
        "muscle_group": "COALESCE(muscle_group, 'unknown')",
        "exercise": "exercise",
        "equipment": "COALESCE(equipment_category, 'unknown')",
        None: "NULL",
    }[group_by]

    rows = conn.execute(
        f"SELECT {_bucket_expr(period)} AS bucket, {group_expr} AS grp, "
        f"       COUNT(*) AS sets, "
        f"       COALESCE(SUM(reps), 0) AS reps, "
        f"       COALESCE(SUM(volume_kg), 0.0) AS volume_kg, "
        f"       COALESCE(SUM(working_volume_kg), 0.0) AS working_volume_kg, "
        f"       COUNT(DISTINCT workout_id) AS workouts "
        f"FROM v_set {where_sql} "
        f"GROUP BY bucket, grp ORDER BY bucket DESC, volume_kg DESC LIMIT ?",
        [*params, config.MAX_VOLUME_BUCKETS + 1],
    ).fetchall()

    truncated = len(rows) > config.MAX_VOLUME_BUCKETS
    rows = rows[: config.MAX_VOLUME_BUCKETS]

    buckets = []
    for r in rows:
        entry = {
            "period": r["bucket"],
            "workouts": r["workouts"],
            "sets": r["sets"],
            "reps": r["reps"],
            "volume_kg": round(r["volume_kg"], 1),
            "working_volume_kg": round(r["working_volume_kg"], 1),
        }
        if group_by:
            entry["group"] = r["grp"]
        buckets.append(entry)

    return {
        "period": period,
        "group_by": group_by,
        "metric_note": (
            "volume_kg includes warmup sets and matches Hevy's own total; "
            "working_volume_kg excludes them."
        ),
        "buckets": buckets,
        "returned": len(buckets),
        "truncated": truncated,
        "max_buckets": config.MAX_VOLUME_BUCKETS,
        **_cache_meta(conn),
    }


def get_muscle_exposure(
    conn: sqlite3.Connection,
    *,
    period: str = "month",
    start_date: str | None = None,
    end_date: str | None = None,
    role: str | None = None,
) -> dict[str, Any]:
    """Muscle exposure, crediting primary *and* secondary muscles.

    This intentionally does not sum to tonnage -- a set worked by three muscles
    is counted three times, so the total runs roughly 2.4x real volume. It exists
    to surface under-trained muscles that never appear as a primary muscle at all
    (glutes and forearms, in this history). For tonnage use
    :func:`get_volume_summary`.
    """
    if period not in ("week", "month"):
        raise ValueError("period must be 'week' or 'month'")
    if role not in (None, "primary", "secondary"):
        raise ValueError("role must be None, 'primary', or 'secondary'")

    where, params = _date_clause(start_date, end_date)
    clauses = [where] if where else []
    if role:
        clauses.append("role = ?")
        params.append(role)
    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    rows = conn.execute(
        f"SELECT {_bucket_expr(period)} AS bucket, muscle, role, "
        f"       COUNT(*) AS sets, "
        f"       COALESCE(SUM(volume_kg), 0.0) AS exposure_kg, "
        f"       COALESCE(SUM(working_volume_kg), 0.0) AS working_exposure_kg "
        f"FROM v_muscle_exposure {where_sql} "
        f"GROUP BY bucket, muscle, role ORDER BY bucket DESC, exposure_kg DESC LIMIT ?",
        [*params, config.MAX_VOLUME_BUCKETS + 1],
    ).fetchall()

    truncated = len(rows) > config.MAX_VOLUME_BUCKETS
    rows = rows[: config.MAX_VOLUME_BUCKETS]

    return {
        "period": period,
        "role": role,
        "metric_note": (
            "Exposure credits each set to its primary and secondary muscles, so it "
            "double-counts and does NOT equal tonnage. Use get_volume_summary for volume."
        ),
        "buckets": [
            {
                "period": r["bucket"],
                "muscle": r["muscle"],
                "role": r["role"],
                "sets": r["sets"],
                "exposure_kg": round(r["exposure_kg"], 1),
                "working_exposure_kg": round(r["working_exposure_kg"], 1),
            }
            for r in rows
        ],
        "returned": len(rows),
        "truncated": truncated,
        **_cache_meta(conn),
    }


def get_personal_records(
    conn: sqlite3.Connection,
    *,
    exercise_name: str | None = None,
    pr_type: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    limit: int = config.MAX_PRS,
) -> dict[str, Any]:
    """Personal records, newest first.

    ``pr_type`` is one of best_1rm, best_volume, best_weight, best_reps,
    best_distance, best_duration.
    """
    limit = max(1, min(int(limit), config.MAX_PRS))
    where, params = _date_clause(start_date, end_date)
    clauses = [where] if where else []

    matched = None
    if exercise_name:
        match, _ = best_match(exercise_name, _known_exercise_names(conn))
        if match is None:
            return {
                "query": exercise_name,
                "matched": None,
                "message": f"No exercise in your history matched {exercise_name!r}.",
                "records": [],
                "returned": 0,
                "truncated": False,
                **_cache_meta(conn),
            }
        matched = match.name
        clauses.append("exercise = ?")
        params.append(matched)

    if pr_type:
        clauses.append("pr_type = ?")
        params.append(pr_type)

    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    rows = conn.execute(
        f"SELECT date, exercise, muscle_group, pr_type, value FROM v_pr {where_sql} "
        f"ORDER BY date DESC, exercise, pr_type LIMIT ?",
        [*params, limit + 1],
    ).fetchall()

    truncated = len(rows) > limit
    rows = rows[:limit]

    return _compact(
        {
            "query": exercise_name,
            "matched": matched,
            "pr_type": pr_type,
            "records": [
                {
                    "date": r["date"],
                    "exercise": r["exercise"],
                    "muscle_group": r["muscle_group"],
                    "type": r["pr_type"],
                    "value": _round(r["value"], 2),
                }
                for r in rows
            ],
            "returned": len(rows),
            "truncated": truncated,
            **_cache_meta(conn),
        }
    )
