"""Browser auth: cookie parsing and result reporting. No browser is launched."""

from __future__ import annotations

import json
from urllib.parse import quote

from hevy_mcp import config
from hevy_mcp.browser_auth import CaptureResult, parse_auth_cookie, tokens_from_cookies

COOKIE_PAYLOAD = {
    "access_token": "acc-123",
    "refresh_token": "ref-456",
    "expires_at": "2026-09-07T18:41:58.561Z",
}


def encoded_cookie(payload=None) -> str:
    return quote(json.dumps(payload if payload is not None else COOKIE_PAYLOAD))


def test_parses_url_encoded_cookie_json():
    parsed = parse_auth_cookie(encoded_cookie())
    assert parsed["access_token"] == "acc-123"
    assert parsed["refresh_token"] == "ref-456"
    assert parsed["expires_at"] == "2026-09-07T18:41:58.561Z"


def test_parses_unencoded_cookie_json():
    assert parse_auth_cookie(json.dumps(COOKIE_PAYLOAD))["access_token"] == "acc-123"


def test_malformed_cookie_yields_empty_dict():
    assert parse_auth_cookie("not-json") == {}
    assert parse_auth_cookie("") == {}
    assert parse_auth_cookie("   ") == {}


def test_non_object_cookie_yields_empty_dict():
    assert parse_auth_cookie(quote(json.dumps(["a", "b"]))) == {}


def test_finds_the_auth_cookie_among_others():
    cookies = [
        {"name": "_ga", "value": "GA1.1.x"},
        {"name": config.AUTH_COOKIE_NAME, "value": encoded_cookie()},
        {"name": "session", "value": "zzz"},
    ]
    assert tokens_from_cookies(cookies)["refresh_token"] == "ref-456"


def test_missing_auth_cookie_yields_empty_dict():
    assert tokens_from_cookies([{"name": "_ga", "value": "x"}]) == {}


def test_empty_auth_cookie_value_is_ignored():
    assert tokens_from_cookies([{"name": config.AUTH_COOKIE_NAME, "value": ""}]) == {}


def test_cookie_name_matches_the_reference_package():
    """Taken from hevy-unofficial browser_auth.AUTH20_COOKIE_NAME, not guessed."""
    assert config.AUTH_COOKIE_NAME == "auth2.0-token"


def test_capture_result_notes_accumulate():
    result = CaptureResult()
    result.note("first")
    result.note("second")
    assert result.notes == ["first", "second"]


def test_capture_result_defaults_are_a_clean_failure():
    result = CaptureResult()
    assert result.tokens is None
    assert result.localstorage_fallback_used is False
    assert result.notes == []


def test_localstorage_probe_never_names_a_key():
    """The fallback discovers tokens by value shape, not by a guessed key name."""
    from hevy_mcp.browser_auth import _LOCALSTORAGE_PROBE

    # It enumerates keys generically...
    assert "localStorage.key(i)" in _LOCALSTORAGE_PROBE
    assert "localStorage.length" in _LOCALSTORAGE_PROBE
    # ...and only ever tests for the token fields themselves.
    assert "node.access_token" in _LOCALSTORAGE_PROBE
    assert "node.refresh_token" in _LOCALSTORAGE_PROBE
    assert "getItem('" not in _LOCALSTORAGE_PROBE
    assert 'getItem("' not in _LOCALSTORAGE_PROBE


def test_auth_timeout_is_bounded_at_180_seconds():
    assert config.BROWSER_AUTH_TIMEOUT_SECONDS == 180.0
