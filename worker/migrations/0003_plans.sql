-- Training plans kept outside Hevy. Free Hevy accounts hold 4 routines, so a
-- multi-week plan lives here and one day at a time is loaded into a Hevy
-- routine (load_plan_day). Hevy never holds more than its limit.
--
-- days is a JSON array of {label, title, notes?, exercises}, where exercises
-- uses save_routine's input format. Stored as given (weights are often empty
-- on purpose); validated against exercise_template when saved and again when
-- loaded.

CREATE TABLE IF NOT EXISTS plan (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  notes      TEXT,
  days       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
