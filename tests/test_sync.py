"""Sync: pagination, raw storage, and the incremental hash stop rule."""

from __future__ import annotations

import json

import httpx
import pytest

from hevy_mcp import config, db, sync
from hevy_mcp.tokens import AuthRequired
from tests.conftest import load_fixture, make_client

PAGE_1 = load_fixture("workouts_page_1.json")
PAGE_2 = load_fixture("workouts_page_2.json")
ACCOUNT = load_fixture("account.json")


def paged_handler(pages, account=ACCOUNT):
    """Serve fixture pages by offset; unknown offsets return an empty page."""

    def handler(request):
        if request.url.path == config.EP_ACCOUNT:
            return httpx.Response(200, json=account)
        if request.url.path == config.EP_WORKOUTS_PAGED:
            offset = int(request.url.params["offset"])
            return httpx.Response(200, json=pages.get(offset, {"workouts": []}))
        return httpx.Response(404, json={"error": "unexpected"})

    return handler


def test_full_backfill_walks_pages_until_short_page(conn, tokens):
    client, rec = make_client(paged_handler({0: PAGE_1, 10: PAGE_2}), tokens)
    report = sync.sync_workouts(conn, client, page_size=10)

    assert report.added == 14
    assert report.updated == 0
    assert report.pages_fetched == 2
    assert report.full_backfill is True
    assert conn.execute("SELECT COUNT(*) AS n FROM raw_workouts").fetchone()["n"] == 14

    offsets = [
        int(r.url.params["offset"])
        for r in rec.requests
        if r.url.path == config.EP_WORKOUTS_PAGED
    ]
    assert offsets == [0, 10]


def test_full_page_then_empty_page_stops(conn, tokens):
    client, _ = make_client(paged_handler({0: PAGE_1}), tokens)
    report = sync.sync_workouts(conn, client, page_size=10)

    assert report.added == 10
    # Page at offset 10 comes back empty, which ends the walk.
    assert report.pages_fetched == 2


def test_raw_payload_stored_verbatim(conn, tokens):
    client, _ = make_client(paged_handler({0: PAGE_1}), tokens)
    sync.sync_workouts(conn, client, page_size=10)

    row = conn.execute(
        "SELECT payload FROM raw_workouts WHERE workout_id = 'w000'"
    ).fetchone()
    stored = json.loads(row["payload"])
    assert stored == PAGE_1["workouts"][0]
    # The unmodelled part of the payload survives for later reprocessing.
    assert stored["opaque"]["note"].startswith("unmodelled")


def test_second_sync_is_incremental_and_stops_on_first_known_page(conn, tokens):
    client, _ = make_client(paged_handler({0: PAGE_1, 10: PAGE_2}), tokens)
    sync.sync_workouts(conn, client, page_size=10)

    client2, rec2 = make_client(paged_handler({0: PAGE_1, 10: PAGE_2}), tokens)
    report = sync.sync_workouts(conn, client2, page_size=10)

    assert report.added == 0
    assert report.updated == 0
    assert report.unchanged == 10
    assert report.stopped_early is True
    assert report.full_backfill is False
    # Only the first page was refetched, not the whole history.
    assert report.pages_fetched == 1


def test_changed_workout_counts_as_updated(conn, tokens):
    client, _ = make_client(paged_handler({0: PAGE_1}), tokens)
    sync.sync_workouts(conn, client, page_size=10)

    mutated = json.loads(json.dumps(PAGE_1))
    mutated["workouts"][0]["name"] = "Push A (edited)"

    client2, _ = make_client(paged_handler({0: mutated}), tokens)
    report = sync.sync_workouts(conn, client2, page_size=10)

    assert report.updated == 1
    assert report.added == 0
    assert report.unchanged == 9
    name = conn.execute(
        "SELECT name FROM workout WHERE workout_id = 'w000'"
    ).fetchone()["name"]
    assert name == "Push A (edited)"


def test_new_workout_on_first_page_does_not_stop_the_walk(conn, tokens):
    client, _ = make_client(paged_handler({0: PAGE_1, 10: PAGE_2}), tokens)
    sync.sync_workouts(conn, client, page_size=10)

    extended = json.loads(json.dumps(PAGE_1))
    extended["workouts"][0] = {
        "id": "w999",
        "name": "Brand New",
        "start_time": "2026-08-21T17:30:00.000Z",
    }

    client2, _ = make_client(paged_handler({0: extended, 10: PAGE_2}), tokens)
    report = sync.sync_workouts(conn, client2, page_size=10)

    assert report.added == 1
    assert report.stopped_early is True
    # Page 2 was reached because page 1 held something new.
    assert report.pages_fetched == 2


def test_full_flag_forces_complete_rewalk(conn, tokens):
    client, _ = make_client(paged_handler({0: PAGE_1, 10: PAGE_2}), tokens)
    sync.sync_workouts(conn, client, page_size=10)

    client2, _ = make_client(paged_handler({0: PAGE_1, 10: PAGE_2}), tokens)
    report = sync.sync_workouts(conn, client2, page_size=10, full=True)

    assert report.stopped_early is False
    assert report.pages_fetched == 2
    assert report.unchanged == 14


def test_username_is_cached_after_first_resolve(conn, tokens):
    client, rec = make_client(paged_handler({0: PAGE_1}), tokens)
    sync.sync_workouts(conn, client, page_size=10)
    assert db.get_state(conn, "username") == "lifter"

    client2, rec2 = make_client(paged_handler({0: PAGE_1}), tokens)
    sync.sync_workouts(conn, client2, page_size=10)
    assert config.EP_ACCOUNT not in [r.url.path for r in rec2.requests]


def test_account_without_username_is_a_clear_error(conn, tokens):
    client, _ = make_client(paged_handler({0: PAGE_1}, account={"id": "u1"}), tokens)
    with pytest.raises(ValueError, match="did not return a username"):
        sync.sync_workouts(conn, client, page_size=10)


def test_workout_without_id_is_skipped_not_crashed(conn, tokens):
    page = {"workouts": [{"name": "no id here"}, PAGE_1["workouts"][0]]}
    client, _ = make_client(paged_handler({0: page}), tokens)
    report = sync.sync_workouts(conn, client, page_size=10)

    assert report.added == 1
    assert report.workouts_seen == 1


def test_last_sync_at_is_recorded(conn, tokens):
    client, _ = make_client(paged_handler({0: PAGE_1}), tokens)
    report = sync.sync_workouts(conn, client, page_size=10)
    assert report.last_sync_at
    assert db.get_state(conn, "last_sync_at") == report.last_sync_at


def test_auth_failure_during_sync_propagates(conn, tokens):
    def handler(request):
        if request.url.path == config.EP_REFRESH:
            return httpx.Response(401, json={"error": "RefreshTokenExpired"})
        return httpx.Response(401, json={"error": "AccessTokenExpired"})

    client, _ = make_client(handler, tokens)
    with pytest.raises(AuthRequired):
        sync.sync_workouts(conn, client, page_size=10)


def test_renormalize_rebuilds_from_raw_without_network(conn, tokens):
    client, _ = make_client(paged_handler({0: PAGE_1}), tokens)
    sync.sync_workouts(conn, client, page_size=10)

    conn.execute("DELETE FROM workout")
    assert conn.execute("SELECT COUNT(*) AS n FROM workout").fetchone()["n"] == 0

    # No client is passed: reprocessing reads only what is already cached.
    count = sync.renormalize(conn)
    assert count == 10
    assert conn.execute("SELECT COUNT(*) AS n FROM workout").fetchone()["n"] == 10


def test_payload_hash_is_key_order_insensitive():
    a = {"id": "w1", "name": "Push", "start_time": "2026-08-20T17:30:00Z"}
    b = {"start_time": "2026-08-20T17:30:00Z", "name": "Push", "id": "w1"}
    assert sync.payload_hash(a) == sync.payload_hash(b)


def test_page_size_stays_within_the_endpoint_limit():
    """/user_workouts_paged returns HTTP 400 for limit > 5 on the live API."""
    assert config.PAGE_SIZE <= config.MAX_PAGE_SIZE
    assert config.MAX_PAGE_SIZE == 5


def test_sync_never_requests_more_than_the_endpoint_allows(conn, tokens):
    client, rec = make_client(paged_handler({0: PAGE_1, 10: PAGE_2}), tokens)
    sync.sync_workouts(conn, client)

    limits = [
        int(r.url.params["limit"])
        for r in rec.requests
        if r.url.path == config.EP_WORKOUTS_PAGED
    ]
    assert limits, "no paged requests were made"
    assert max(limits) <= config.MAX_PAGE_SIZE
