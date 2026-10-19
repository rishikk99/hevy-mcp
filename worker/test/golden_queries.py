"""Record the Python server's query output on the local cache, for the Worker to match.

    uv run python worker/test/golden_queries.py

Writes worker/test/.golden.json, which holds personal training data and is
gitignored. equivalence.test.ts replays every case through the Worker's queries
and expects identical results.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from hevy_mcp import config, queries

HERE = Path(__file__).resolve().parent
OUT = HERE / ".golden.json"


def main() -> None:
    conn = sqlite3.connect(f"file:{config.db_path().as_posix()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    ids = [r["workout_id"] for r in conn.execute(
        "SELECT workout_id FROM workout ORDER BY start_date DESC LIMIT 3"
    )]
    ids += [r["workout_id"] for r in conn.execute(
        "SELECT workout_id FROM workout ORDER BY start_date ASC LIMIT 1"
    )]
    ids += [r["workout_id"] for r in conn.execute(
        "SELECT DISTINCT workout_id FROM personal_record LIMIT 2"
    )]

    cases: list[tuple[str, dict]] = [
        ("get_workouts", {}),
        ("get_workouts", {"limit": 5}),
        ("get_workouts", {"start_date": "2026-01-01", "end_date": "2026-03-31", "limit": 200}),
        *[("get_workout_detail", {"workout_id": i}) for i in ids],
        ("get_workout_detail", {"workout_id": "does-not-exist"}),
        ("get_exercise_history", {"exercise_name": "bench press"}),
        ("get_exercise_history", {"exercise_name": "squat", "start_date": "2026-06-01"}),
        ("get_exercise_history", {"exercise_name": "lat pulldown"}),
        ("get_exercise_history", {"exercise_name": "rdl barbell"}),
        ("get_exercise_history", {"exercise_name": "treadmill"}),
        ("get_exercise_history", {"exercise_name": "bench pres barbell"}),
        ("list_exercises", {}),
        ("get_volume_summary", {"period": "week"}),
        ("get_volume_summary", {"period": "month", "group_by": "muscle_group"}),
        ("get_volume_summary", {"period": "month", "group_by": "exercise", "start_date": "2026-05-01"}),
        ("get_volume_summary", {"period": "week", "group_by": "equipment", "end_date": "2026-04-30"}),
        ("get_muscle_exposure", {"period": "month"}),
        ("get_muscle_exposure", {"period": "week", "role": "secondary", "start_date": "2026-08-01"}),
        ("get_muscle_exposure", {"period": "month", "role": "primary"}),
        ("get_personal_records", {}),
        ("get_personal_records", {"exercise_name": "bench"}),
        ("get_personal_records", {"pr_type": "best_1rm", "start_date": "2026-03-01"}),
        ("get_personal_records", {"exercise_name": "kayaking"}),
    ]

    golden = []
    for name, args in cases:
        fn = getattr(queries, name)
        if name == "get_workout_detail":
            result = fn(conn, args["workout_id"])
        elif name == "get_exercise_history":
            rest = {k: v for k, v in args.items() if k != "exercise_name"}
            result = fn(conn, args["exercise_name"], **rest)
        elif name == "list_exercises":
            result = fn(conn)
        else:
            result = fn(conn, **args)
        golden.append({"tool": name, "args": args, "result": result})

    OUT.write_text(json.dumps(golden, indent=1), encoding="utf-8")
    print(f"wrote {len(golden)} cases to {OUT}")


if __name__ == "__main__":
    main()
