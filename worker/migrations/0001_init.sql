-- Same star schema as the Python cache (src/hevy_mcp/db.py, SCHEMA_VERSION 4),
-- so the existing local database imports as-is. See that module for the
-- reasoning behind each table and view.

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

-- The Hevy login. One row; Hevy rotates the refresh token on every refresh, so
-- it is rewritten immediately after each rotation.
CREATE TABLE IF NOT EXISTS hevy_auth (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  user_id       TEXT,
  expires_at    TEXT,
  updated_at    TEXT NOT NULL
);

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
  ROUND(s.weight_kg * 2.20462262, 1)    AS weight_lb,
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

CREATE VIEW IF NOT EXISTS v_workout AS
SELECT
  workout_id, start_date AS date, name, start_time, end_time,
  duration_seconds, nth_workout, routine_id, description, calories,
  exercise_count, set_count, volume_kg, working_volume_kg, hevy_volume_kg,
  updated_at
FROM workout;

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

-- Muscle EXPOSURE, not volume: deliberately double-counts. See db.py.
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
