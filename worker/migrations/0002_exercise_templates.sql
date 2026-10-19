-- Every exercise a routine can use: Hevy's built-in library plus the user's
-- custom exercises. Routines reference exercises only by template id, so
-- search_exercises needs this to turn "incline dumbbell press" into one.
--
-- Built-ins are loaded by scripts/update_exercise_library.py (Hevy ships them
-- inside its web app, not through the API). Custom exercises are refreshed
-- from /custom_exercise_templates when a routine tool needs them.

CREATE TABLE IF NOT EXISTS exercise_template (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  title_norm         TEXT NOT NULL,
  muscle_group       TEXT,
  other_muscles      TEXT,             -- JSON array
  exercise_type      TEXT NOT NULL,
  equipment_category TEXT,
  aka                TEXT,             -- an alternative name, e.g. "Humble Row"
  tags               TEXT,             -- Hevy's search keywords, e.g. "db chest supported"
  priority           INTEGER NOT NULL DEFAULT 0,
  is_custom          INTEGER NOT NULL DEFAULT 0,
  is_archived        INTEGER NOT NULL DEFAULT 0,
  full_bodyweight    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_template_norm ON exercise_template(title_norm);
