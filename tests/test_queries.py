"""Query layer: filtering, aggregation, caps, and truncation reporting.

These seed the star schema directly rather than going through the normalizer, so
SQL and caps are tested in isolation. End-to-end normalization from a real
payload is covered in test_normalize.py.
"""

from __future__ import annotations

import pytest

from hevy_mcp import config, db, queries
from hevy_mcp.normalize import normalize_name

# template_id, title, muscle_group, equipment, type, secondary muscles
EXERCISES = [
    ("T-BENCH", "Bench Press (Barbell)", "chest", "barbell", "weight_reps",
     ["triceps", "shoulders"]),
    ("T-OHP", "Overhead Press (Barbell)", "shoulders", "barbell", "weight_reps", ["triceps"]),
    ("T-PULL", "Lat Pulldown (Cable)", "lats", "machine", "weight_reps", ["biceps"]),
    ("T-SQUAT", "Squat (Barbell)", "quadriceps", "barbell", "weight_reps", ["glutes"]),
    ("T-RUN", "Treadmill", "cardio", "machine", "distance_duration", []),
]

WORKOUTS = [
    ("w1", "Push A", "2026-08-03"),
    ("w2", "Pull A", "2026-08-05"),
    ("w3", "Legs A", "2026-08-12"),
    ("w4", "Push B", "2026-09-02"),
]

# workout, position, template_id, notes
WORKOUT_EXERCISES = [
    ("w1", 0, "T-BENCH", "felt strong"),
    ("w1", 1, "T-OHP", None),
    ("w2", 0, "T-PULL", None),
    ("w3", 0, "T-SQUAT", None),
    ("w3", 1, "T-RUN", None),
    ("w4", 0, "T-BENCH", None),
]

# workout, position, set_index, kg, reps, rpe, type, distance_m, duration_s
SETS = [
    ("w1", 0, 0, 60.0, 10, 7.0, "warmup", None, None),
    ("w1", 0, 1, 70.0, 8, 8.0, "normal", None, None),
    ("w1", 0, 2, 80.0, 5, 9.5, "normal", None, None),
    ("w1", 1, 0, 40.0, 10, 7.0, "normal", None, None),
    ("w2", 0, 0, 55.0, 12, None, "normal", None, None),
    ("w3", 0, 0, 100.0, 5, 8.0, "normal", None, None),
    ("w3", 0, 1, 100.0, 5, 8.5, "normal", None, None),
    ("w3", 1, 0, None, None, None, "normal", 5000.0, 1800),
    ("w4", 0, 0, 82.5, 6, 9.0, "normal", None, None),
]

PRS = [("w4", 0, 0, "best_1rm", 95.7), ("w1", 0, 2, "best_weight", 80.0)]


@pytest.fixture
def seeded(conn):
    for tid, title, muscle, equip, etype, others in EXERCISES:
        conn.execute(
            "INSERT INTO exercise (template_id, title, title_norm, muscle_group, "
            "equipment_category, exercise_type) VALUES (?, ?, ?, ?, ?, ?)",
            (tid, title, normalize_name(title), muscle, equip, etype),
        )
        conn.execute(
            "INSERT INTO exercise_muscle (template_id, muscle, role) VALUES (?, ?, 'primary')",
            (tid, muscle),
        )
        for other in others:
            conn.execute(
                "INSERT INTO exercise_muscle (template_id, muscle, role) "
                "VALUES (?, ?, 'secondary')",
                (tid, other),
            )

    volumes: dict[str, list[float]] = {w[0]: [0.0, 0.0] for w in WORKOUTS}
    for wid, _pos, _idx, kg, reps, _rpe, stype, _d, _dur in SETS:
        if kg is not None and reps is not None:
            volumes[wid][0] += kg * reps
            if stype != "warmup":
                volumes[wid][1] += kg * reps

    for wid, name, date in WORKOUTS:
        sets = [s for s in SETS if s[0] == wid]
        exercises = [e for e in WORKOUT_EXERCISES if e[0] == wid]
        conn.execute(
            "INSERT INTO workout (workout_id, name, start_time, start_date, "
            "  duration_seconds, exercise_count, set_count, volume_kg, "
            "  working_volume_kg, hevy_volume_kg, payload_hash) "
            "VALUES (?, ?, ?, ?, 3600, ?, ?, ?, ?, ?, 'h')",
            (wid, name, f"{date}T17:30:00+00:00", date, len(exercises), len(sets),
             volumes[wid][0], volumes[wid][1], volumes[wid][0]),
        )

    for wid, pos, tid, notes in WORKOUT_EXERCISES:
        title = next(e[1] for e in EXERCISES if e[0] == tid)
        conn.execute(
            "INSERT INTO workout_exercise (workout_id, position, template_id, title, "
            "notes, rest_seconds) VALUES (?, ?, ?, ?, ?, 120)",
            (wid, pos, tid, title, notes),
        )

    date_of = {w[0]: w[2] for w in WORKOUTS}
    tid_of = {(e[0], e[1]): e[2] for e in WORKOUT_EXERCISES}
    for wid, pos, idx, kg, reps, rpe, stype, dist, dur in SETS:
        vol = kg * reps if kg is not None and reps is not None else None
        conn.execute(
            "INSERT INTO workout_set (workout_id, position, set_index, start_date, "
            "  template_id, set_type, weight_kg, reps, rpe, distance_m, duration_s, "
            "  custom_metric, volume_kg) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
            (wid, pos, idx, date_of[wid], tid_of[(wid, pos)], stype, kg, reps, rpe,
             dist, dur, vol),
        )

    for wid, pos, idx, pr_type, value in PRS:
        conn.execute(
            "INSERT INTO personal_record (workout_id, position, set_index, pr_type, value) "
            "VALUES (?, ?, ?, ?, ?)",
            (wid, pos, idx, pr_type, value),
        )

    db.set_state(conn, "last_sync_at", "2026-09-07T10:00:00+00:00")
    return conn


# --- get_workouts ----------------------------------------------------------


def test_get_workouts_returns_newest_first(seeded):
    result = queries.get_workouts(seeded)
    assert [w["date"] for w in result["workouts"]] == [
        "2026-09-02", "2026-08-12", "2026-08-05", "2026-08-03"
    ]
    assert result["total"] == 4
    assert result["truncated"] is False


def test_get_workouts_filters_by_date_window(seeded):
    result = queries.get_workouts(seeded, start_date="2026-08-05", end_date="2026-08-31")
    assert [w["id"] for w in result["workouts"]] == ["w3", "w2"]


def test_get_workouts_reports_both_volume_metrics(seeded):
    workout = next(w for w in queries.get_workouts(seeded)["workouts"] if w["id"] == "w1")
    # 60*10 + 70*8 + 80*5 + 40*10 = 1960 total; the 600 warmup is excluded -> 1360
    assert workout["volume_kg"] == pytest.approx(1960.0)
    assert workout["working_volume_kg"] == pytest.approx(1360.0)


def test_get_workouts_respects_limit_and_reports_truncation(seeded):
    result = queries.get_workouts(seeded, limit=2)
    assert result["returned"] == 2
    assert result["total"] == 4
    assert result["truncated"] is True


def test_get_workouts_limit_is_capped(seeded):
    assert queries.get_workouts(seeded, limit=10_000)["limit"] == config.MAX_WORKOUTS


def test_get_workouts_limit_floor(seeded):
    assert queries.get_workouts(seeded, limit=0)["limit"] == 1


def test_get_workouts_omits_null_fields(seeded):
    assert "note" not in queries.get_workouts(seeded)["workouts"][0]


def test_results_carry_cache_metadata(seeded):
    result = queries.get_workouts(seeded)
    assert result["last_sync_at"] == "2026-09-07T10:00:00+00:00"


# --- get_workout_detail ----------------------------------------------------


def test_workout_detail_includes_exercises_notes_and_sets(seeded):
    result = queries.get_workout_detail(seeded, "w1")
    assert result["workout"]["name"] == "Push A"
    assert [e["exercise"] for e in result["exercises"]] == [
        "Bench Press (Barbell)", "Overhead Press (Barbell)"
    ]
    assert result["exercises"][0]["notes"] == "felt strong"
    assert len(result["exercises"][0]["sets"]) == 3


def test_workout_detail_includes_prs_and_lb(seeded):
    bench = queries.get_workout_detail(seeded, "w1")["exercises"][0]
    assert bench["prs"] == [{"type": "best_weight", "value": 80.0}]
    assert bench["sets"][0]["lb"] == pytest.approx(132.3, abs=0.2)


def test_workout_detail_unknown_id(seeded):
    assert queries.get_workout_detail(seeded, "nope")["error"] == "not_found"


# --- get_exercise_history --------------------------------------------------


def test_exercise_history_fuzzy_matches_and_reports_the_match(seeded):
    result = queries.get_exercise_history(seeded, "bench press")
    assert result["matched"] == "Bench Press (Barbell)"
    assert result["match_score"] >= 0.9
    assert result["total"] == 4
    assert result["muscle_group"] == "chest"


def test_exercise_history_is_newest_first(seeded):
    first = queries.get_exercise_history(seeded, "bench press")["sets"][0]
    assert first["date"] == "2026-09-02"
    assert first["kg"] == 82.5
    assert first["reps"] == 6


def test_exercise_history_carries_cardio_measures(seeded):
    """Cardio sets have distance and duration and no weight -- that is correct."""
    result = queries.get_exercise_history(seeded, "treadmill")
    entry = result["sets"][0]
    assert entry["distance_m"] == 5000.0
    assert entry["duration_s"] == 1800
    assert "kg" not in entry
    assert result["exercise_type"] == "distance_duration"


def test_exercise_history_drops_null_rpe(seeded):
    assert "rpe" not in queries.get_exercise_history(seeded, "lat pulldown")["sets"][0]


def test_exercise_history_respects_date_window(seeded):
    result = queries.get_exercise_history(
        seeded, "bench press", start_date="2026-08-01", end_date="2026-08-31"
    )
    assert result["total"] == 3


def test_exercise_history_no_match_is_explicit(seeded):
    result = queries.get_exercise_history(seeded, "kayaking")
    assert result["matched"] is None
    assert result["known_exercise_count"] == 5
    assert result["sets"] == []


def test_exercise_history_on_empty_cache(conn):
    assert queries.get_exercise_history(conn, "bench press")["matched"] is None


# --- get_volume_summary ----------------------------------------------------


def test_volume_summary_by_month(seeded):
    buckets = {
        b["period"]: b
        for b in queries.get_volume_summary(seeded, period="month")["buckets"]
    }
    assert set(buckets) == {"2026-08", "2026-09"}
    august = buckets["2026-08"]
    assert august["sets"] == 8
    # 1960 (w1) + 660 (w2) + 1000 (w3) = 3620
    assert august["volume_kg"] == pytest.approx(3620.0)
    assert august["working_volume_kg"] == pytest.approx(3020.0)
    assert august["workouts"] == 3


def test_volume_summary_by_week_splits_august(seeded):
    result = queries.get_volume_summary(seeded, period="week")
    assert len({b["period"] for b in result["buckets"]}) >= 3


def test_volume_summary_grouped_by_muscle_group_sums_to_tonnage(seeded):
    """Primary-only grouping must still reconcile with total volume."""
    grouped = queries.get_volume_summary(seeded, period="month", group_by="muscle_group")
    total = queries.get_volume_summary(seeded, period="month")
    assert sum(b["volume_kg"] for b in grouped["buckets"]) == pytest.approx(
        sum(b["volume_kg"] for b in total["buckets"])
    )


def test_volume_summary_grouped_by_exercise(seeded):
    names = {
        b["group"]
        for b in queries.get_volume_summary(
            seeded, period="month", group_by="exercise"
        )["buckets"]
    }
    assert "Bench Press (Barbell)" in names


def test_volume_summary_grouped_by_equipment(seeded):
    groups = {
        b["group"]
        for b in queries.get_volume_summary(
            seeded, period="month", group_by="equipment"
        )["buckets"]
    }
    assert groups == {"barbell", "machine"}


def test_volume_summary_respects_date_window(seeded):
    result = queries.get_volume_summary(seeded, period="month", start_date="2026-09-01")
    assert [b["period"] for b in result["buckets"]] == ["2026-09"]


def test_volume_summary_ungrouped_has_no_group_key(seeded):
    assert "group" not in queries.get_volume_summary(seeded, period="month")["buckets"][0]


@pytest.mark.parametrize("period", ["day", "year", ""])
def test_volume_summary_rejects_bad_period(seeded, period):
    with pytest.raises(ValueError, match="period must be"):
        queries.get_volume_summary(seeded, period=period)


def test_volume_summary_rejects_bad_group_by(seeded):
    with pytest.raises(ValueError, match="group_by must be"):
        queries.get_volume_summary(seeded, period="week", group_by="bodypart")


def test_volume_summary_bucket_cap_is_reported(seeded, monkeypatch):
    monkeypatch.setattr(config, "MAX_VOLUME_BUCKETS", 1)
    result = queries.get_volume_summary(seeded, period="month")
    assert result["returned"] == 1
    assert result["truncated"] is True


# --- get_muscle_exposure ---------------------------------------------------


def test_muscle_exposure_includes_secondary_muscles(seeded):
    """Glutes are only ever a secondary muscle, so volume alone cannot see them."""
    result = queries.get_muscle_exposure(seeded, period="month")
    muscles = {b["muscle"] for b in result["buckets"]}
    assert "glutes" in muscles
    assert "triceps" in muscles

    volume_groups = {
        b["group"]
        for b in queries.get_volume_summary(
            seeded, period="month", group_by="muscle_group"
        )["buckets"]
    }
    assert "glutes" not in volume_groups


def test_muscle_exposure_exceeds_tonnage_by_design(seeded):
    exposure = sum(
        b["exposure_kg"]
        for b in queries.get_muscle_exposure(seeded, period="month")["buckets"]
    )
    volume = sum(
        b["volume_kg"] for b in queries.get_volume_summary(seeded, period="month")["buckets"]
    )
    assert exposure > volume


def test_muscle_exposure_warns_it_is_not_volume(seeded):
    note = queries.get_muscle_exposure(seeded, period="month")["metric_note"]
    assert "does NOT equal tonnage" in note


def test_muscle_exposure_role_filter(seeded):
    result = queries.get_muscle_exposure(seeded, period="month", role="secondary")
    assert {b["role"] for b in result["buckets"]} == {"secondary"}


def test_muscle_exposure_rejects_bad_role(seeded):
    with pytest.raises(ValueError, match="role must be"):
        queries.get_muscle_exposure(seeded, period="month", role="tertiary")


# --- get_personal_records --------------------------------------------------


def test_personal_records_newest_first(seeded):
    records = queries.get_personal_records(seeded)["records"]
    assert [r["date"] for r in records] == ["2026-09-02", "2026-08-03"]
    assert records[0]["exercise"] == "Bench Press (Barbell)"
    assert records[0]["type"] == "best_1rm"


def test_personal_records_filter_by_type(seeded):
    result = queries.get_personal_records(seeded, pr_type="best_weight")
    assert len(result["records"]) == 1
    assert result["records"][0]["value"] == 80.0


def test_personal_records_filter_by_fuzzy_exercise(seeded):
    result = queries.get_personal_records(seeded, exercise_name="bench")
    assert result["matched"] == "Bench Press (Barbell)"
    assert len(result["records"]) == 2


def test_personal_records_unknown_exercise(seeded):
    result = queries.get_personal_records(seeded, exercise_name="kayaking")
    assert result["matched"] is None
    assert result["records"] == []


# --- list_exercises --------------------------------------------------------


def test_list_exercises_orders_by_total_sets(seeded):
    entries = queries.list_exercises(seeded)["exercises"]
    assert entries[0]["name"] == "Bench Press (Barbell)"
    assert entries[0]["total_sets"] == 4
    assert entries[0]["muscle_group"] == "chest"
    assert entries[0]["equipment"] == "barbell"


def test_list_exercises_first_and_last_seen(seeded):
    entry = next(
        e for e in queries.list_exercises(seeded)["exercises"]
        if e["name"] == "Bench Press (Barbell)"
    )
    assert entry["first_seen"] == "2026-08-03"
    assert entry["last_seen"] == "2026-09-02"
    assert entry["workouts"] == 2


def test_list_exercises_cap_is_reported(seeded, monkeypatch):
    monkeypatch.setattr(config, "MAX_EXERCISES", 2)
    result = queries.list_exercises(seeded)
    assert result["returned"] == 2
    assert result["truncated"] is True


def test_list_exercises_on_empty_cache(conn):
    assert queries.list_exercises(conn)["exercises"] == []


def test_weights_are_rounded_for_compactness(seeded):
    """lb->kg conversion yields 15-digit floats; output trims them."""
    seeded.execute("UPDATE workout_set SET weight_kg = 18.14371637742559 WHERE workout_id='w2'")
    result = queries.get_exercise_history(seeded, "lat pulldown")
    assert result["sets"][0]["kg"] == 18.14
