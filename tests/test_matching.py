"""Fuzzy exercise-name matching against realistic Hevy-style names."""

from __future__ import annotations

import pytest

from hevy_mcp.matching import best_match, find_matches
from hevy_mcp.normalize import normalize_name

NAMES = [
    "Bench Press (Barbell)",
    "Bench Press (Dumbbell)",
    "Incline Bench Press (Barbell)",
    "Squat (Barbell)",
    "Bulgarian Split Squat",
    "Romanian Deadlift (Barbell)",
    "Deadlift (Barbell)",
    "Lat Pulldown (Cable)",
    "Seated Row (Cable)",
    "Overhead Press (Barbell)",
]


@pytest.mark.parametrize(
    "query,expected",
    [
        ("Bench Press (Barbell)", "Bench Press (Barbell)"),
        ("bench press barbell", "Bench Press (Barbell)"),
        ("BENCH PRESS (BARBELL)", "Bench Press (Barbell)"),
        ("squat", "Squat (Barbell)"),
        ("lat pulldown", "Lat Pulldown (Cable)"),
        ("incline bench", "Incline Bench Press (Barbell)"),
        ("deadlift barbel", "Deadlift (Barbell)"),
        ("romanian deadlift", "Romanian Deadlift (Barbell)"),
        ("seated row", "Seated Row (Cable)"),
    ],
)
def test_matches_loose_queries(query, expected):
    match, _ = best_match(query, NAMES)
    assert match is not None, f"{query!r} matched nothing"
    assert match.name == expected


def test_exact_match_scores_one():
    match, _ = best_match("Squat (Barbell)", NAMES)
    assert match.score == 1.0
    assert match.how == "exact"


def test_prefers_tersest_candidate_containing_all_terms():
    # "bench press" appears in three names; the shortest wins.
    match, alternatives = best_match("bench press", NAMES)
    assert match.name == "Bench Press (Barbell)"
    assert "Incline Bench Press (Barbell)" in [m.name for m in alternatives]


def test_returns_alternatives_so_a_wrong_pick_is_visible():
    match, alternatives = best_match("squat", NAMES)
    assert match.name == "Squat (Barbell)"
    assert "Bulgarian Split Squat" in [m.name for m in alternatives]


def test_nonsense_query_matches_nothing():
    match, alternatives = best_match("kayaking", NAMES)
    assert match is None
    assert alternatives == []


def test_empty_query_matches_nothing():
    match, _ = best_match("", NAMES)
    assert match is None


def test_no_candidates_matches_nothing():
    match, _ = best_match("squat", [])
    assert match is None


def test_result_limit_is_respected():
    assert len(find_matches("bench", NAMES, limit=2)) == 2


def test_threshold_filters_weak_matches():
    strict = find_matches("benc", NAMES, threshold=0.99)
    assert strict == []


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
    assert normalize_name(raw) == expected


@pytest.mark.parametrize("query", ["rdl barbell", "ohp barbell", "bss"])
def test_acronyms_return_no_match_rather_than_a_wrong_one(query):
    """Gym acronyms aren't expanded. Returning nothing beats a confident miss.

    Before the per-token gate, "ohp barbell" matched "Squat (Barbell)" on the
    shared equipment word alone.
    """
    match, _ = best_match(query, NAMES)
    assert match is None


def test_typos_still_match_through_the_ratio_tier():
    match, _ = best_match("bench pres barbell", NAMES)
    assert match is not None
    assert match.name == "Bench Press (Barbell)"


def test_shared_equipment_word_alone_is_not_a_match():
    match, _ = best_match("kayak barbell", NAMES)
    assert match is None
