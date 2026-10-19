"""Export the local cache as SQL that loads into the Worker's D1 database.

    uv run python worker/scripts/export_to_d1.py OUT.sql
    npx wrangler d1 execute hevy --remote --file OUT.sql

Copies the workout tables and sync state, so the Worker starts with the full
history instead of re-downloading it (a full walk is ~72 Hevy calls, more than
one Worker run may make). The Hevy login is not included; push-login.ps1 moves
that separately. The output holds personal data: delete it after loading.

Floats are written with repr(), which round-trips exactly. SQLite's quote()
would print REALs with 15 significant digits and lose the low bits.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

from hevy_mcp import config

TABLES = [
    "raw_workouts",
    "exercise",
    "exercise_muscle",
    "workout",
    "workout_exercise",
    "workout_set",
    "personal_record",
]

# Transient keys stay behind: a stale error or lease would mislead the Worker.
SKIP_STATE = {"last_sync_error", "sync_lease", "full_walk_offset"}


def literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def export(conn: sqlite3.Connection, out) -> int:
    rows = 0
    for table in [*TABLES, "sync_state"]:
        out.write(f"DELETE FROM {table};\n")
    for table in TABLES:
        cursor = conn.execute(f"SELECT * FROM {table}")
        columns = ", ".join(d[0] for d in cursor.description)
        for row in cursor:
            values = ", ".join(literal(v) for v in row)
            out.write(f"INSERT INTO {table} ({columns}) VALUES ({values});\n")
            rows += 1
    for key, value in conn.execute("SELECT key, value FROM sync_state"):
        if key not in SKIP_STATE:
            out.write(f"INSERT INTO sync_state (key, value) VALUES ({literal(key)}, {literal(value)});\n")
            rows += 1
    return rows


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    conn = sqlite3.connect(f"file:{config.db_path().as_posix()}?mode=ro", uri=True)
    with Path(sys.argv[1]).open("w", encoding="utf-8", newline="\n") as out:
        rows = export(conn, out)
    print(f"wrote {rows} rows to {sys.argv[1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
