"""MCP server exposing the local Hevy cache, over stdio.

Every tool is read-only with respect to Hevy. The query tools read SQLite only;
``sync_workouts`` and ``authenticate`` are the only tools that talk to Hevy at
all, and neither can write to your account. The hosted connector in
``worker/`` serves the same queries from Cloudflare.

Logging goes to stderr on purpose: stdout carries the MCP protocol.
"""

from __future__ import annotations

import logging
import sys
import threading
from datetime import datetime, timezone
from typing import Any

from mcp.server.mcpserver import MCPServer
from mcp_types import ToolAnnotations

from hevy_mcp import __version__, browser_auth, config, db, queries, sync
from hevy_mcp.client import HevyAPIError, HevyClient
from hevy_mcp.tokens import AuthRequired, TokenStore

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("hevy_mcp")

server = MCPServer(
    name="hevy",
    version=__version__,
    instructions=(
        "Read-only access to a local cache of the user's Hevy workout history. "
        "Call sync_workouts first if the cache looks stale. All query tools read "
        "the local SQLite cache, never Hevy directly."
    ),
)

READ_ONLY = ToolAnnotations(read_only_hint=True)

AUTH_HELP = (
    "Run the authenticate tool: it opens a browser window where you log in by "
    "hand, then captures and stores fresh tokens."
)

# Hevy rotates the refresh token on every refresh, so two syncs refreshing at
# once would leave one holding a revoked token. Tool calls run on worker
# threads, so every sync goes through this lock.
_sync_lock = threading.Lock()


def _auth_error(exc: Exception) -> dict[str, Any]:
    return {"error": "auth_required", "message": f"{exc}", "next_step": AUTH_HELP}


def _with_cache(fn):
    """Run a query against the cache, annotating results when auth is broken."""
    conn = db.connect()
    try:
        return fn(conn)
    finally:
        conn.close()


# --- tools that reach Hevy -------------------------------------------------


@server.tool(
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False),
    description=(
        "Open a headed Chromium window so you can log in to Hevy by hand "
        "(the web login is behind reCAPTCHA). Captures the access and refresh "
        "tokens from the authenticated session, stores them locally, and "
        "verifies them with one lightweight API call. Times out after 180 "
        "seconds. Use this when another tool reports auth_required."
    ),
)
def authenticate(timeout_seconds: float = config.BROWSER_AUTH_TIMEOUT_SECONDS) -> dict[str, Any]:
    """Launch the browser login flow and store the captured tokens."""
    timeout_seconds = max(10.0, min(float(timeout_seconds), config.BROWSER_AUTH_TIMEOUT_SECONDS))

    try:
        result = browser_auth.capture_tokens(timeout_seconds=timeout_seconds)
    except browser_auth.BrowserAuthError as exc:
        return {"ok": False, "error": "browser_failed", "message": str(exc)}

    if result.tokens is None:
        return {
            "ok": False,
            "error": "capture_failed",
            "message": (
                f"No complete token pair was captured within {timeout_seconds:.0f}s. "
                "The browser has been closed."
            ),
            "attempts": result.notes,
            "localstorage_fallback_used": result.localstorage_fallback_used,
        }

    store = TokenStore()
    store.save(result.tokens)

    # Verify before reporting success.
    try:
        with HevyClient(result.tokens, store=store) as client:
            account = client.get_account()
    except (AuthRequired, HevyAPIError) as exc:
        return {
            "ok": False,
            "error": "verification_failed",
            "message": f"Tokens were captured and stored but failed verification: {exc}",
            "attempts": result.notes,
        }

    username = account.get("username") if isinstance(account, dict) else None
    return _drop_none(
        {
            "ok": True,
            "username": username,
            "expires_at": result.tokens.expires_at,
            "access_token_source": result.access_source,
            "refresh_token_source": result.refresh_source,
            "localstorage_fallback_used": result.localstorage_fallback_used,
            "tokens_path": str(store.path),
        }
    )


@server.tool(
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False),
    description=(
        "Fetch workouts from Hevy into the local SQLite cache. First run does a "
        "full paginated backfill; later runs are incremental and stop as soon as "
        "they reach already-cached workouts. Pass full=true to force a complete "
        "re-walk. Reports how many workouts were added or updated."
    ),
)
def sync_workouts(full: bool = False) -> dict[str, Any]:
    """Pull new and changed workouts into the cache."""
    with _sync_lock:
        conn = db.connect()
        try:
            result = _sync(conn, full)
            if "error" in result:
                stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
                db.set_state(
                    conn,
                    "last_sync_error",
                    f"{stamp} {result['error']}: {result.get('next_step') or result['message']}",
                )
            else:
                db.delete_state(conn, "last_sync_error")
            return result
        finally:
            conn.close()


def _sync(conn, full: bool) -> dict[str, Any]:
    try:
        client = HevyClient.from_store()
    except AuthRequired as exc:
        return _auth_error(exc)

    with client:
        try:
            report = sync.sync_workouts(conn, client, full=full)
        except AuthRequired as exc:
            return _auth_error(exc)
        except HevyAPIError as exc:
            return {
                "error": "api_error",
                "status_code": exc.status_code,
                "message": str(exc),
            }

    return report.to_dict()


# --- cache-only tools ------------------------------------------------------


@server.tool(
    annotations=READ_ONLY,
    description=(
        "Workout summaries from the local cache, newest first. Dates are "
        "YYYY-MM-DD. One compact row per workout: date, name, duration, exercise "
        "and set counts, volume_kg (includes warmups, matches Hevy's own total) "
        "and working_volume_kg (excludes warmups), calories, and any workout "
        "note. No per-set detail -- use get_workout_detail for that. "
        "limit defaults to 50, capped at 200; the result reports truncation."
    ),
)
def get_workouts(
    start_date: str | None = None,
    end_date: str | None = None,
    limit: int = config.DEFAULT_WORKOUTS,
) -> dict[str, Any]:
    """Summaries for workouts in a date window."""
    return _with_cache(
        lambda conn: queries.get_workouts(
            conn, start_date=start_date, end_date=end_date, limit=limit
        )
    )


@server.tool(
    annotations=READ_ONLY,
    description=(
        "One workout in full from the local cache: every exercise with its "
        "muscle group, rest time and notes, every set with weight in kg and lb, "
        "reps, RPE, and cardio measures, plus any personal records. Takes the "
        "workout id returned by get_workouts."
    ),
)
def get_workout_detail(workout_id: str) -> dict[str, Any]:
    """Full detail for a single workout, including notes and PRs."""
    return _with_cache(lambda conn: queries.get_workout_detail(conn, workout_id))


@server.tool(
    annotations=READ_ONLY,
    description=(
        "Every set logged for one exercise over a date window, from the local "
        "cache. The exercise name is fuzzy-matched, so approximate names work; "
        "the result reports what matched, the score, and runner-up candidates. "
        "Sets carry weight (kg and lb) and reps for lifts, or distance, duration "
        "and steps for cardio, depending on the exercise type. Capped at 500 sets."
    ),
)
def get_exercise_history(
    exercise_name: str,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict[str, Any]:
    """Set-by-set history for a fuzzy-matched exercise."""
    return _with_cache(
        lambda conn: queries.get_exercise_history(
            conn, exercise_name, start_date=start_date, end_date=end_date
        )
    )


@server.tool(
    annotations=READ_ONLY,
    description=(
        "Aggregate sets, reps, and tonnage by week or month from the local "
        "cache. period is 'week' or 'month'. group_by is optional: "
        "'muscle_group', 'exercise', or 'equipment'. Returns volume_kg "
        "(includes warmup sets, reconciles with Hevy) and working_volume_kg "
        "(excludes warmups) side by side. Grouping by muscle_group counts only "
        "the primary muscle, so buckets sum to real tonnage -- use "
        "get_muscle_exposure to include secondary muscles. Capped at 200 buckets."
    ),
)
def get_volume_summary(
    period: str = "week",
    start_date: str | None = None,
    end_date: str | None = None,
    group_by: str | None = None,
) -> dict[str, Any]:
    """Volume aggregated into week or month buckets."""
    try:
        return _with_cache(
            lambda conn: queries.get_volume_summary(
                conn,
                period=period,
                start_date=start_date,
                end_date=end_date,
                group_by=group_by,
            )
        )
    except ValueError as exc:
        return {"error": "invalid_argument", "message": str(exc)}


@server.tool(
    annotations=READ_ONLY,
    description=(
        "Muscle exposure by week or month, crediting each set to its primary AND "
        "secondary muscles. This deliberately double-counts and does NOT equal "
        "tonnage -- use get_volume_summary for volume. Its purpose is spotting "
        "under-trained muscles that rarely or never appear as a primary muscle. "
        "Optional role filter: 'primary' or 'secondary'."
    ),
)
def get_muscle_exposure(
    period: str = "month",
    start_date: str | None = None,
    end_date: str | None = None,
    role: str | None = None,
) -> dict[str, Any]:
    """Primary + secondary muscle exposure. Not a tonnage metric."""
    try:
        return _with_cache(
            lambda conn: queries.get_muscle_exposure(
                conn, period=period, start_date=start_date, end_date=end_date, role=role
            )
        )
    except ValueError as exc:
        return {"error": "invalid_argument", "message": str(exc)}


@server.tool(
    annotations=READ_ONLY,
    description=(
        "Personal records from the local cache, newest first. Optionally filter "
        "by exercise (fuzzy-matched) and by pr_type: best_1rm, best_volume, "
        "best_weight, best_reps, best_distance, or best_duration. Capped at 200."
    ),
)
def get_personal_records(
    exercise_name: str | None = None,
    pr_type: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict[str, Any]:
    """Personal records, optionally filtered by exercise and type."""
    return _with_cache(
        lambda conn: queries.get_personal_records(
            conn,
            exercise_name=exercise_name,
            pr_type=pr_type,
            start_date=start_date,
            end_date=end_date,
        )
    )


@server.tool(
    annotations=READ_ONLY,
    description=(
        "Distinct exercises in the cached history with muscle group, exercise "
        "type, equipment, first seen, last seen, workout count, and total sets, "
        "ordered by total sets. Capped at 300."
    ),
)
def list_exercises() -> dict[str, Any]:
    """Everything the user has logged, with coverage stats."""
    return _with_cache(queries.list_exercises)


def _drop_none(data: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in data.items() if v is not None}


def main() -> None:
    """stdio entrypoint."""
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
