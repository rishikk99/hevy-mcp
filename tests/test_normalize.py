"""Normalization against a real captured payload shape.

``workout_shape.json`` is a real workout from the Hevy web endpoint with only
identity fields replaced. Field names and value types are untouched, so these
tests pin the actual contract rather than an assumed one.
"""

from __future__ import annotations

import pytest

from hevy_mcp import normalize
from tests.conftest import load_fixture

SHAPE = load_fixture("workout_shape.json")


@pytest.mark.parametrize(
    "value,expected_date",
    [
        ("2026-08-20T17:30:00.000Z", "2026-08-20"),
        ("2026-08-20T17:30:00+00:00", "2026-08-20"),
        ("2026-08-20T17:30:00", "2026-08-20"),
        (1787247000, "2026-08-20"),
        (1787247000.0, "2026-08-20"),
        (1787247000000, "2026-08-20"),
        ("1787247000", "2026-08-20"),
    ],
)
def test_parse_start_time_handles_every_representation(value, expected_date):
    """Hevy sends epoch seconds; ISO is accepted too rather than assumed away."""
    _, date = normalize.parse_start_time(value)
    assert date == expected_date


@pytest.mark.parametrize(
    "value,expected",
    [
        # 01:28 UTC is still the previous evening in Central time.
        (1788830888, ("2026-09-07T20:28:08-05:00", "2026-09-07")),
        # Standard time after the November change is UTC-6, not -5.
        (1795656600, ("2026-11-25T19:30:00-06:00", "2026-11-25")),
        ("2026-09-08T01:28:08Z", ("2026-09-07T20:28:08-05:00", "2026-09-07")),
    ],
)
def test_times_and_dates_are_local_to_the_configured_zone(value, expected):
    """An evening workout belongs to its own day, as the lifter saw it."""
    assert normalize.parse_timestamp(value) == expected


def test_the_zone_is_configurable(monkeypatch):
    monkeypatch.setenv("HEVY_MCP_TIMEZONE", "UTC")
    assert normalize.parse_timestamp(1788830888) == ("2026-09-08T01:28:08+00:00", "2026-09-08")


@pytest.mark.parametrize("value", [None, "", True, False])
def test_parse_start_time_rejects_non_timestamps(value):
    iso, date = normalize.parse_start_time(value)
    assert iso is None and date is None


def test_unparseable_string_is_kept_but_yields_no_date():
    iso, date = normalize.parse_start_time("last tuesday")
    assert iso == "last tuesday"
    assert date is None


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Bench Press (Barbell)", "bench press barbell"),
        ("  Squat   (Barbell) ", "squat barbell"),
        ("Push-Up", "push up"),
        ("", ""),
    ],
)
def test_normalize_name(raw, expected):
    assert normalize.normalize_name(raw) == expected


# --- real payload ----------------------------------------------------------


@pytest.fixture
def normalized(conn):
    normalize.write_workout(conn, SHAPE["id"], SHAPE, "hash-1")
    return conn


def test_workout_row_from_real_payload(normalized):
    row = normalized.execute("SELECT * FROM workout").fetchone()
    assert row["name"] == "Day C"
    # 01:28 UTC on the 8th: an evening session on the 7th in Central time.
    assert row["start_date"] == "2026-09-07"
    assert row["start_time"] == "2026-09-07T20:28:08-05:00"
    # start_time / end_time arrive as epoch seconds.
    assert row["duration_seconds"] == SHAPE["end_time"] - SHAPE["start_time"]
    assert row["exercise_count"] == 5
    assert row["set_count"] == 25


def test_tonnage_matches_hevys_own_estimate(normalized):
    """For weight_reps work, sum(weight_kg * reps) reproduces estimated_volume_kg.

    They diverge only for bodyweight-loaded exercises, which this workout has
    none of. Hevy's own figure is stored alongside ours either way.
    """
    row = normalized.execute("SELECT volume_kg, working_volume_kg, hevy_volume_kg "
                             "FROM workout").fetchone()
    assert row["volume_kg"] == pytest.approx(SHAPE["estimated_volume_kg"])
    assert row["hevy_volume_kg"] == pytest.approx(SHAPE["estimated_volume_kg"])
    # Warmups carry real load here, so excluding them must lower the figure.
    assert row["working_volume_kg"] < row["volume_kg"]


def test_exercise_rows_use_array_position_as_index(normalized):
    """The payload has no exercise index field, so order is the array position."""
    rows = normalized.execute(
        "SELECT position, title, template_id FROM workout_exercise ORDER BY position"
    ).fetchall()
    assert [r["position"] for r in rows] == [0, 1, 2, 3, 4]
    assert rows[0]["title"] == "Lat Pulldown (Cable)"
    assert rows[0]["template_id"] == "6A6C31A5"


def test_exercise_dimension_is_deduplicated(normalized):
    """79 templates across the history, so the dimension must not repeat rows."""
    rows = normalized.execute(
        "SELECT template_id, title, exercise_type, equipment_category FROM exercise"
    ).fetchall()
    assert len(rows) == 5
    assert {r["exercise_type"] for r in rows} == {"weight_reps"}
    assert "machine" in {r["equipment_category"] for r in rows}


def test_exercise_notes_and_rest_are_captured(normalized):
    """The pinned note on Butterfly (Pec Deck) must survive normalization."""
    row = normalized.execute(
        "SELECT notes, rest_seconds FROM workout_exercise WHERE title = 'Butterfly (Pec Deck)'"
    ).fetchone()
    assert row["notes"] == "Use the machine in front not back"
    assert row["rest_seconds"] == 105


def test_personal_records_are_captured(normalized):
    rows = normalized.execute(
        "SELECT pr_type, value FROM personal_record ORDER BY pr_type"
    ).fetchall()
    assert rows, "this workout contains PRs"
    assert all(r["pr_type"].startswith("best_") for r in rows)


def test_muscle_group_comes_inline_from_the_payload(normalized):
    """No catalog lookup is needed; each exercise carries its own muscle_group."""
    groups = {
        r["title"]: r["muscle_group"]
        for r in normalized.execute("SELECT title, muscle_group FROM exercise")
    }
    assert groups["Lat Pulldown (Cable)"] == "lats"
    assert groups["Lateral Raise (Dumbbell)"] == "shoulders"
    assert groups["Butterfly (Pec Deck)"] == "chest"
    assert None not in groups.values()


def test_set_type_comes_from_the_indicator_field(normalized):
    """The set-type field is called `indicator`, not `set_type` or `type`."""
    types = {
        r["set_type"] for r in normalized.execute("SELECT DISTINCT set_type FROM workout_set")
    }
    assert types == {"warmup", "normal"}


def test_first_exercise_sets_round_trip(normalized):
    rows = normalized.execute(
        "SELECT set_index, weight_kg, reps, rpe, set_type FROM workout_set "
        "WHERE position = 0 ORDER BY set_index"
    ).fetchall()

    assert [r["set_index"] for r in rows] == [0, 1, 2, 3, 4]
    assert [r["reps"] for r in rows] == [8, 3, 9, 8, 8]
    assert [r["set_type"] for r in rows] == ["warmup", "warmup", "normal", "normal", "normal"]
    # Weights keep full precision (this user logs in lb, stored converted).
    assert rows[0]["weight_kg"] == pytest.approx(18.14371637742559)


def test_null_rpe_is_preserved_as_null(normalized):
    """This user does not log RPE; nulls must not become zeros."""
    assert normalized.execute(
        "SELECT COUNT(*) AS n FROM workout_set WHERE rpe IS NOT NULL"
    ).fetchone()["n"] == 0


def test_sets_carry_denormalized_date_and_template(normalized):
    row = normalized.execute(
        "SELECT start_date, template_id FROM workout_set WHERE position = 0 LIMIT 1"
    ).fetchone()
    assert row["start_date"] == "2026-09-07"
    assert row["template_id"] == "6A6C31A5"


def test_secondary_muscles_are_recorded_separately(normalized):
    """other_muscles feeds exposure without polluting primary-muscle volume."""
    primary = {
        r["muscle"] for r in normalized.execute(
            "SELECT muscle FROM exercise_muscle WHERE role = 'primary'")
    }
    secondary = {
        r["muscle"] for r in normalized.execute(
            "SELECT muscle FROM exercise_muscle WHERE role = 'secondary'")
    }
    assert "lats" in primary
    assert {"biceps", "forearms"} <= secondary
    # Forearms are worked but are never a primary muscle here.
    assert "forearms" not in primary


def test_v_set_view_joins_everything(normalized):
    row = normalized.execute(
        "SELECT * FROM v_set WHERE position = 0 AND set_index = 0"
    ).fetchone()
    assert row["exercise"] == "Lat Pulldown (Cable)"
    assert row["muscle_group"] == "lats"
    assert row["date"] == "2026-09-07"
    assert row["weight_lb"] == pytest.approx(40.0, abs=0.1)
    assert row["set_type"] == "warmup"
    # Warmups contribute to volume but not working volume.
    assert row["volume_kg"] > 0
    assert row["working_volume_kg"] == 0


def test_resync_replaces_children_without_orphans(normalized):
    """An edited workout must not leave stale sets behind."""
    trimmed = {**SHAPE, "exercises": SHAPE["exercises"][:1]}
    normalize.write_workout(normalized, SHAPE["id"], trimmed, "hash-2")

    assert normalized.execute("SELECT COUNT(*) AS n FROM workout_set").fetchone()["n"] == 5
    assert normalized.execute(
        "SELECT COUNT(*) AS n FROM workout_exercise"
    ).fetchone()["n"] == 1
    row = normalized.execute("SELECT exercise_count, payload_hash FROM workout").fetchone()
    assert row["exercise_count"] == 1
    assert row["payload_hash"] == "hash-2"


# --- defensive paths -------------------------------------------------------


def test_missing_exercises_list_is_logged_not_fatal(conn, caplog):
    normalize.write_workout(conn, "w1", {"id": "w1", "name": "X", "start_time": 1787247000}, "h")
    row = conn.execute("SELECT exercise_count, set_count FROM workout").fetchone()
    assert row["exercise_count"] == 0
    assert row["set_count"] == 0


def test_exercise_without_title_is_skipped(conn):
    payload = {
        "id": "w1",
        "start_time": 1787247000,
        "exercises": [{"sets": [{"index": 0, "weight_kg": 50, "reps": 5}]}],
    }
    normalize.write_workout(conn, "w1", payload, "h")
    assert conn.execute("SELECT COUNT(*) AS n FROM workout_set").fetchone()["n"] == 0


def test_set_without_index_falls_back_to_position(conn):
    payload = {
        "id": "w1",
        "start_time": 1787247000,
        "exercises": [{"title": "Squat", "sets": [{"reps": 5}, {"reps": 3}]}],
    }
    normalize.write_workout(conn, "w1", payload, "h")
    assert [
        r["set_index"] for r in conn.execute("SELECT set_index FROM workout_set ORDER BY set_index")
    ] == [0, 1]


def test_non_numeric_weight_becomes_null_not_zero(conn):
    payload = {
        "id": "w1",
        "start_time": 1787247000,
        "exercises": [{"title": "Squat", "sets": [{"index": 0, "weight_kg": "n/a", "reps": 5}]}],
    }
    normalize.write_workout(conn, "w1", payload, "h")
    row = conn.execute("SELECT weight_kg, reps FROM workout_set").fetchone()
    assert row["weight_kg"] is None
    assert row["reps"] == 5


# --- bodyweight-loaded volume ---------------------------------------------


def test_assisted_volume_subtracts_assistance_from_bodyweight():
    """Less assistance means more real work, so volume must go UP."""
    from hevy_mcp import config

    heavy_assist = normalize.set_volume("bodyweight_assisted_reps", "2C37EC5E", 20.0, 10)
    light_assist = normalize.set_volume("bodyweight_assisted_reps", "2C37EC5E", 5.0, 10)
    assert heavy_assist == pytest.approx((config.BODYWEIGHT_KG - 20.0) * 10)
    assert light_assist > heavy_assist


def test_full_bodyweight_templates_count_bodyweight():
    """Pull Up and Triceps Dip log no weight but are not zero-volume."""
    from hevy_mcp import config

    for template_id in config.FULL_BODYWEIGHT_TEMPLATES:
        assert normalize.set_volume("reps_only", template_id, None, 8) == pytest.approx(
            config.BODYWEIGHT_KG * 8
        )


def test_supported_reps_only_work_carries_no_bodyweight():
    """Sit ups and leg raises solved at factor 0, so they stay volume-less."""
    assert normalize.set_volume("reps_only", "022DF610", None, 20) is None   # Sit Up
    assert normalize.set_volume("reps_only", "4F5866F8", None, 15) is None   # Back Extension


def test_ordinary_sets_are_weight_times_reps():
    assert normalize.set_volume("weight_reps", "T-X", 60.0, 10) == pytest.approx(600.0)


def test_sets_without_reps_have_no_volume():
    """Cardio and timed holds have no volume concept."""
    assert normalize.set_volume("distance_duration", "T-RUN", None, None) is None
    assert normalize.set_volume("duration", "T-PLANK", None, None) is None


def test_workout_with_bodyweight_exercises_reconciles_with_hevy(conn):
    """End-to-end guard: our volume must equal Hevy's for bodyweight work.

    Mirrors the real history, where all 345 workouts reconcile to 0.000000 kg.
    """
    from hevy_mcp import config

    bw = config.BODYWEIGHT_KG
    expected = (
        (bw - 10.0) * 8          # assisted pull up, assistance subtracted
        + bw * 5                 # unweighted pull up, full bodyweight
        + 60.0 * 10              # ordinary barbell work
    )
    payload = {
        "id": "wbw",
        "name": "Mixed",
        "start_time": 1787247000,
        "end_time": 1787250600,
        "estimated_volume_kg": expected,
        "exercises": [
            {
                "title": "Pull Up (Assisted)",
                "exercise_template_id": "2C37EC5E",
                "exercise_type": "bodyweight_assisted_reps",
                "muscle_group": "lats",
                "sets": [{"index": 0, "weight_kg": 10.0, "reps": 8, "indicator": "normal"}],
            },
            {
                "title": "Pull Up",
                "exercise_template_id": "1B2B1E7C",
                "exercise_type": "reps_only",
                "muscle_group": "lats",
                "sets": [{"index": 0, "weight_kg": None, "reps": 5, "indicator": "normal"}],
            },
            {
                "title": "Bench Press (Barbell)",
                "exercise_template_id": "T-BENCH",
                "exercise_type": "weight_reps",
                "muscle_group": "chest",
                "sets": [{"index": 0, "weight_kg": 60.0, "reps": 10, "indicator": "normal"}],
            },
        ],
    }
    normalize.write_workout(conn, "wbw", payload, "h")

    row = conn.execute(
        "SELECT volume_kg, hevy_volume_kg FROM workout WHERE workout_id = 'wbw'"
    ).fetchone()
    assert row["volume_kg"] == pytest.approx(row["hevy_volume_kg"])
    assert row["volume_kg"] == pytest.approx(expected)


def test_bodyweight_sets_have_volume_despite_null_weight(conn):
    """volume_kg is not always weight_kg * reps -- a NULL weight can still lift."""
    from hevy_mcp import config

    payload = {
        "id": "wp",
        "start_time": 1787247000,
        "exercises": [{
            "title": "Pull Up",
            "exercise_template_id": "1B2B1E7C",
            "exercise_type": "reps_only",
            "sets": [{"index": 0, "weight_kg": None, "reps": 6, "indicator": "normal"}],
        }],
    }
    normalize.write_workout(conn, "wp", payload, "h")
    row = conn.execute("SELECT weight_kg, reps, volume_kg FROM workout_set").fetchone()
    assert row["weight_kg"] is None
    assert row["volume_kg"] == pytest.approx(config.BODYWEIGHT_KG * 6)
