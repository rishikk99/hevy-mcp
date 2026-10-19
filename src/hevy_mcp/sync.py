"""Pull workouts from Hevy into the local SQLite cache.

Raw JSON is stored verbatim for every workout alongside the normalized rows, so
changing the analysis schema means re-running :func:`renormalize` over what is
already stored rather than refetching.

Change detection is by sha256 of the raw payload rather than the payload's own
``updated_at``: hashing catches any edit, and it does not depend on the ordering
of ``/user_workouts_paged``, which is undocumented. Walk from offset 0 and stop
at the first page in which every workout is already stored with an identical
hash.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
from dataclasses import asdict, dataclass
from datetime import datetime, timezone

from hevy_mcp import config, db, normalize
from hevy_mcp.client import HevyClient

log = logging.getLogger(__name__)


@dataclass
class SyncReport:
    added: int = 0
    updated: int = 0
    unchanged: int = 0
    pages_fetched: int = 0
    workouts_seen: int = 0
    full_backfill: bool = False
    stopped_early: bool = False
    last_sync_at: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def payload_hash(payload: dict) -> str:
    """Stable hash of a workout payload, insensitive to key ordering."""
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def resolve_username(conn: sqlite3.Connection, client: HevyClient) -> str:
    """Username is needed for paging; cache it so sync costs one call less."""
    cached = db.get_state(conn, "username")
    if cached:
        return cached

    account = client.get_account()
    username = account.get("username") if isinstance(account, dict) else None
    if not username:
        raise ValueError(
            f"{config.EP_ACCOUNT} did not return a username "
            f"(keys: {sorted(account) if isinstance(account, dict) else type(account).__name__})"
        )
    db.set_state(conn, "username", username)
    return username


def sync_workouts(
    conn: sqlite3.Connection,
    client: HevyClient,
    *,
    full: bool = False,
    page_size: int = config.PAGE_SIZE,
    max_pages: int | None = None,
) -> SyncReport:
    """Fetch workouts into the cache. Full backfill on first run, incremental after."""
    backfill_done = db.get_state(conn, "backfill_complete") == "1"
    do_full = full or not backfill_done

    report = SyncReport(full_backfill=do_full)
    username = resolve_username(conn, client)

    known = {
        row["workout_id"]: row["payload_hash"]
        for row in conn.execute("SELECT workout_id, payload_hash FROM raw_workouts")
    }

    offset = 0
    while max_pages is None or report.pages_fetched < max_pages:
        page = client.get_workouts_page(username, limit=page_size, offset=offset)
        workouts = _page_workouts(page)
        report.pages_fetched += 1

        if not workouts:
            break

        page_all_known = True
        for workout in workouts:
            workout_id = workout.get("id")
            if not workout_id:
                log.warning("Skipping a workout with no id at offset %s", offset)
                continue
            workout_id = str(workout_id)
            report.workouts_seen += 1

            new_hash = payload_hash(workout)
            existing = known.get(workout_id)

            if existing == new_hash:
                report.unchanged += 1
                continue

            page_all_known = False
            _store(conn, workout_id, workout, new_hash)
            known[workout_id] = new_hash
            if existing is None:
                report.added += 1
            else:
                report.updated += 1

        # Incremental stop: an entire page already cached unchanged means we have
        # caught up. Skipped during a full backfill.
        if not do_full and page_all_known:
            report.stopped_early = True
            break

        if len(workouts) < page_size:
            break
        offset += page_size

    now = datetime.now(timezone.utc).isoformat()
    db.set_state(conn, "last_sync_at", now)
    if do_full and max_pages is None:
        db.set_state(conn, "backfill_complete", "1")
    report.last_sync_at = now
    return report


def _page_workouts(page) -> list[dict]:
    """Unwrap ``{"workouts": [...]}`` as documented in the reference package."""
    if isinstance(page, dict):
        workouts = page.get("workouts")
        if isinstance(workouts, list):
            return [w for w in workouts if isinstance(w, dict)]
        return []
    if isinstance(page, list):
        return [w for w in page if isinstance(w, dict)]
    return []


def _store(conn: sqlite3.Connection, workout_id: str, payload: dict, digest: str) -> None:
    conn.execute(
        "INSERT INTO raw_workouts (workout_id, payload, payload_hash, fetched_at) "
        "VALUES (?, ?, ?, ?) "
        "ON CONFLICT(workout_id) DO UPDATE SET "
        "  payload = excluded.payload, "
        "  payload_hash = excluded.payload_hash, "
        "  fetched_at = excluded.fetched_at",
        (
            workout_id,
            json.dumps(payload, separators=(",", ":")),
            digest,
            datetime.now(timezone.utc).isoformat(),
        ),
    )
    normalize.write_workout(conn, workout_id, payload, digest)


def renormalize(conn: sqlite3.Connection) -> int:
    """Rebuild every normalized row from stored raw payloads. No network."""
    for table in ("personal_record", "workout_set", "workout_exercise",
                  "workout", "exercise_muscle", "exercise"):
        conn.execute(f"DELETE FROM {table}")

    rows = conn.execute(
        "SELECT workout_id, payload, payload_hash FROM raw_workouts"
    ).fetchall()
    for row in rows:
        normalize.write_workout(
            conn, row["workout_id"], json.loads(row["payload"]), row["payload_hash"]
        )
    return len(rows)
