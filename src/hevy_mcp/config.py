"""Paths, transport constants, and result caps.

Endpoint paths and header values here are taken from the ``hevy-unofficial``
reference package (Sahil624/hevy-unofficial v0.0.2a0), specifically its
``config.py``, ``client.py``, and ``spec/routes.md``. They are not guesses.
"""

from __future__ import annotations

import os
from pathlib import Path

BASE_URL = "https://api.hevyapp.com"
WEB_ORIGIN = "https://hevy.com"

# Static headers the Hevy web client sends on every call.
API_KEY = "shelobs_hevy_web"
PLATFORM = "web"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
)
ACCEPT = "application/json, text/plain, */*"
ACCEPT_LANGUAGE = "en-US,en;q=0.8"

# Endpoints. Every data route is GET; the only POST is the token refresh.
EP_ACCOUNT = "/user/account"
EP_WORKOUTS_PAGED = "/user_workouts_paged"
EP_WORKOUT_COUNT = "/workout_count"
EP_WORKOUT = "/workout/{workout_id}"
EP_REFRESH = "/auth/refresh_token"

# Name of the cookie hevy.com stores its token blob in. Confirmed in the
# reference package as browser_auth.AUTH20_COOKIE_NAME.
AUTH_COOKIE_NAME = "auth2.0-token"

HTTP_TIMEOUT = 30.0
# /user_workouts_paged rejects limit > 5 with HTTP 400. The reference package
# defaults to 10, which the live endpoint does not accept; 5 was found by
# probing 1,2,5,6,7,8,9,10 against the real API.
MAX_PAGE_SIZE = 5
PAGE_SIZE = 5
REFRESH_THROTTLE_SECONDS = 5.0
BROWSER_AUTH_TIMEOUT_SECONDS = 180.0

# Result caps. Tool output lands in a context window, so every list-returning
# tool is bounded and reports truncation rather than silently trimming.
MAX_WORKOUTS = 200
DEFAULT_WORKOUTS = 50
MAX_EXERCISE_HISTORY_SETS = 500
MAX_VOLUME_BUCKETS = 200
MAX_EXERCISES = 300
MAX_PRS = 200

# Bodyweight handling. YOUR SETTING: set it to the bodyweight in your Hevy
# profile, and keep it in step with worker/src/config.ts.
#
# Hevy folds the user's bodyweight into volume for exercises where the body is
# the load. That figure lives on the user profile, not in the workout payload,
# so it was solved from the history: every affected workout implied one exact
# value with zero spread across all of them, which suggests Hevy recomputes
# historical volume from the current profile weight.
BODYWEIGHT_KG = 63.5

# Templates where Hevy credits the full bodyweight, solved per template at
# factor 1.0: Pull Up and Triceps Dip, where the whole body hangs. Supported
# reps_only work (sit ups, leg raises, back extensions, push ups) solved at 0
# and is therefore absent here.
FULL_BODYWEIGHT_TEMPLATES = frozenset({"1B2B1E7C", "28BB4A95"})

# Assistance is subtracted from bodyweight: volume = (bodyweight - assist) * reps.
ASSISTED_EXERCISE_TYPE = "bodyweight_assisted_reps"

# Minimum difflib ratio before a fuzzy exercise-name match is accepted.
FUZZY_THRESHOLD = 0.6

# YOUR SETTING: your time zone. Workout times are stored and shown in it, and a
# workout's date is its local start date. In UTC an evening session lands on
# the next day. Hevy's payload carries no zone, so it is configured here; the
# Worker's src/config.ts holds the same value. Override with HEVY_MCP_TIMEZONE.
DEFAULT_TIMEZONE = "America/Chicago"


def timezone_name() -> str:
    return os.environ.get("HEVY_MCP_TIMEZONE") or DEFAULT_TIMEZONE


def state_dir() -> Path:
    """Directory holding tokens, the SQLite cache, and the browser profile.

    Defaults to ``.hevy/`` beside the project root and is gitignored. Override
    with ``HEVY_MCP_STATE_DIR`` (used by the tests).
    """
    override = os.environ.get("HEVY_MCP_STATE_DIR")
    if override:
        return Path(override)
    return Path(__file__).resolve().parents[2] / ".hevy"


def tokens_path() -> Path:
    return state_dir() / "tokens.json"


def db_path() -> Path:
    return state_dir() / "hevy.sqlite3"


def browser_profile_dir() -> Path:
    return state_dir() / "chrome-profile"
