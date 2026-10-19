"""SQLite cache: connection setup, star schema, and analysis views.

``raw_workouts`` is the source of truth -- every payload is stored verbatim, so a
schema change is a local rebuild (:func:`hevy_mcp.sync.renormalize`) rather than
a refetch.

Shape of the model:

* ``exercise`` is a dimension keyed by Hevy's ``exercise_template_id``. Across
  the full history each template maps to exactly one title and muscle group, so
  the 1,697 exercise rows collapse to 79 dimension rows.
* ``exercise_muscle`` carries primary and secondary muscles separately, which
  keeps tonnage and muscle *exposure* from being conflated. See the note on
  ``v_muscle_exposure`` below.
* ``workout`` carries two volume figures. ``volume_kg`` is ours, literally
  ``sum(weight_kg * reps)``. ``hevy_volume_kg`` is Hevy's own
  ``estimated_volume_kg`` copied verbatim. They agree on 322 of 345 workouts;
  they diverge only where an exercise is loaded by bodyweight (assisted pull-ups,
  unweighted pull-ups), because Hevy folds the user's bodyweight into volume and
  that figure is not present in the workout payload. Both are kept so the gap is
  visible instead of silently resolved one way.
* ``workout_set`` holds one row per set with typed measures, because Hevy's
  ``exercise_type`` decides which measure is meaningful: ``weight_reps`` uses
  weight and reps, ``distance_duration`` uses distance and duration, ``duration``
  uses duration alone, ``steps_duration`` uses duration plus a step count.
  A NULL weight on a treadmill set is correct, not missing.

``set`` is a SQL keyword, so the table is ``workout_set``.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from hevy_mcp import config

SCHEMA_VERSION = 4

KG_TO_LB = 2.20462262

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS raw_workouts (
  workout_id   TEXT PRIMARY KEY,
  payload      TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  fetched_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exercise (
  template_id        TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  title_norm         TEXT NOT NULL,
  muscle_group       TEXT,
  equipment_category TEXT,
  exercise_type      TEXT
);
CREATE INDEX IF NOT EXISTS idx_exercise_norm ON exercise(title_norm);

CREATE TABLE IF NOT EXISTS exercise_muscle (
  template_id TEXT NOT NULL,
  muscle      TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('primary', 'secondary')),
  PRIMARY KEY (template_id, muscle, role)
);
CREATE INDEX IF NOT EXISTS idx_exercise_muscle ON exercise_muscle(muscle, role);

CREATE TABLE IF NOT EXISTS workout (
  workout_id        TEXT PRIMARY KEY,
  name              TEXT,
  start_time        TEXT,
  end_time          TEXT,
  start_date        TEXT,
  duration_seconds  INTEGER,
  nth_workout       INTEGER,
  routine_id        TEXT,
  description       TEXT,
  calories          INTEGER,
  exercise_count    INTEGER,
  set_count         INTEGER,
  volume_kg         REAL,
  working_volume_kg REAL,
  hevy_volume_kg    REAL,
  updated_at        TEXT,
  payload_hash      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workout_date ON workout(start_date);

CREATE TABLE IF NOT EXISTS workout_exercise (
  workout_id   TEXT NOT NULL,
  position     INTEGER NOT NULL,
  template_id  TEXT,
  title        TEXT NOT NULL,
  notes        TEXT,
  rest_seconds INTEGER,
  PRIMARY KEY (workout_id, position)
);
CREATE INDEX IF NOT EXISTS idx_we_template ON workout_exercise(template_id);

CREATE TABLE IF NOT EXISTS workout_set (
  workout_id    TEXT NOT NULL,
  position      INTEGER NOT NULL,
  set_index     INTEGER NOT NULL,
  start_date    TEXT NOT NULL,
  template_id   TEXT,
  set_type      TEXT,
  weight_kg     REAL,
  reps          INTEGER,
  rpe           REAL,
  distance_m    REAL,
  duration_s    INTEGER,
  custom_metric REAL,
  volume_kg     REAL,
  PRIMARY KEY (workout_id, position, set_index)
);
CREATE INDEX IF NOT EXISTS idx_set_date ON workout_set(start_date);
CREATE INDEX IF NOT EXISTS idx_set_template ON workout_set(template_id, start_date);

CREATE TABLE IF NOT EXISTS personal_record (
  workout_id TEXT NOT NULL,
  position   INTEGER NOT NULL,
  set_index  INTEGER NOT NULL,
  pr_type    TEXT NOT NULL,
  value      REAL,
  PRIMARY KEY (workout_id, position, set_index, pr_type)
);
CREATE INDEX IF NOT EXISTS idx_pr_type ON personal_record(pr_type);

CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- One flat row per set: the workhorse for analysis. Weight is exposed in both
-- kg (as stored) and lb, since every logged weight is a round lb number.
CREATE VIEW IF NOT EXISTS v_set AS
SELECT
  w.start_date                          AS date,
  s.workout_id,
  w.name                                AS workout_name,
  s.position,
  s.set_index,
  COALESCE(e.title, we.title)           AS exercise,
  s.template_id,
  e.muscle_group,
  e.equipment_category,
  e.exercise_type,
  s.set_type,
  s.weight_kg,
  ROUND(s.weight_kg * {KG_TO_LB}, 1)    AS weight_lb,
  s.reps,
  s.rpe,
  s.distance_m,
  s.duration_s,
  s.custom_metric,
  s.volume_kg,
  CASE WHEN s.set_type = 'warmup' THEN 0.0 ELSE s.volume_kg END AS working_volume_kg,
  we.notes                              AS exercise_notes,
  we.rest_seconds
FROM workout_set s
JOIN workout w           ON w.workout_id = s.workout_id
JOIN workout_exercise we ON we.workout_id = s.workout_id AND we.position = s.position
LEFT JOIN exercise e     ON e.template_id = s.template_id;

-- One row per session.
CREATE VIEW IF NOT EXISTS v_workout AS
SELECT
  workout_id, start_date AS date, name, start_time, end_time,
  duration_seconds, nth_workout, routine_id, description, calories,
  exercise_count, set_count, volume_kg, working_volume_kg, hevy_volume_kg,
  updated_at
FROM workout;

-- Every personal record with its date and exercise.
CREATE VIEW IF NOT EXISTS v_pr AS
SELECT
  w.start_date                   AS date,
  p.pr_type,
  p.value,
  COALESCE(e.title, we.title)    AS exercise,
  e.muscle_group,
  p.workout_id, p.position, p.set_index
FROM personal_record p
JOIN workout w           ON w.workout_id = p.workout_id
JOIN workout_exercise we ON we.workout_id = p.workout_id AND we.position = p.position
LEFT JOIN exercise e     ON e.template_id = we.template_id;

-- Muscle EXPOSURE, not volume. A set is credited to its primary muscle and to
-- every secondary muscle, so the column deliberately does NOT sum to tonnage
-- (it roughly doubles it). Use it to spot under-trained muscles -- glutes and
-- forearms never appear as a primary muscle at all -- and use v_set.volume_kg
-- when you want real tonnage.
CREATE VIEW IF NOT EXISTS v_muscle_exposure AS
SELECT
  w.start_date        AS date,
  em.muscle,
  em.role,
  s.workout_id, s.position, s.set_index,
  s.volume_kg,
  CASE WHEN s.set_type = 'warmup' THEN 0.0 ELSE s.volume_kg END AS working_volume_kg
FROM workout_set s
JOIN workout w          ON w.workout_id = s.workout_id
JOIN exercise_muscle em ON em.template_id = s.template_id;
"""

# Dropped in schema v3: superseded by the star schema above.
LEGACY_TABLES = ("workouts", "workout_exercises", "sets", "exercise_catalog")


def connect(path: Path | str | None = None) -> sqlite3.Connection:
    """Open the cache, creating the file, schema, and views if needed."""
    target = Path(path) if path is not None else config.db_path()
    if str(target) != ":memory:":
        target.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(target, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    set_state(conn, "schema_version", str(SCHEMA_VERSION))
    return conn


def drop_legacy_tables(conn: sqlite3.Connection) -> list[str]:
    """Remove pre-v3 tables. Raw payloads are untouched, so this is reversible."""
    dropped = []
    for table in LEGACY_TABLES:
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        if exists:
            conn.execute(f"DROP TABLE {table}")
            dropped.append(table)
    return dropped


def get_state(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM sync_state WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_state(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO sync_state (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def delete_state(conn: sqlite3.Connection, key: str) -> None:
    conn.execute("DELETE FROM sync_state WHERE key = ?", (key,))
