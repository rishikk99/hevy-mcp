"""Auth and transport behaviour: headers, refresh-once, rotation, read-only."""

from __future__ import annotations

import httpx
import pytest

from hevy_mcp import config
from hevy_mcp.client import HevyAPIError, HevyClient
from hevy_mcp.tokens import AuthRequired, Tokens
from tests.conftest import make_client


def test_sends_web_client_headers(tokens):
    def handler(request):
        return httpx.Response(200, json={"username": "lifter"})

    client, rec = make_client(handler, tokens)
    client.get_account()

    sent = rec.requests[0]
    assert sent.headers["x-api-key"] == config.API_KEY
    assert sent.headers["hevy-platform"] == config.PLATFORM
    assert sent.headers["Origin"] == config.WEB_ORIGIN
    assert sent.headers["Authorization"] == "Bearer access-1"
    assert "x-client-time" in sent.headers


def test_refreshes_once_then_retries_and_persists_rotation(tokens, store):
    store.save(tokens)
    calls = {"account": 0}

    def handler(request):
        if request.url.path == config.EP_REFRESH:
            return httpx.Response(
                200,
                json={
                    "access_token": "access-2",
                    "refresh_token": "refresh-2",
                    "user_id": "u1",
                    "expires_at": "2026-09-08T00:00:00.000Z",
                },
            )
        calls["account"] += 1
        if calls["account"] == 1:
            return httpx.Response(401, json={"error": "AccessTokenExpired"})
        return httpx.Response(200, json={"username": "lifter"})

    client, rec = make_client(handler, tokens, store)
    assert client.get_account() == {"username": "lifter"}

    paths = [r.url.path for r in rec.requests]
    assert paths == [config.EP_ACCOUNT, config.EP_REFRESH, config.EP_ACCOUNT]
    # Retry carried the new access token.
    assert rec.requests[2].headers["Authorization"] == "Bearer access-2"
    # Rotated pair was written straight through to disk.
    assert store.load().refresh_token == "refresh-2"
    assert store.load().access_token == "access-2"


def test_refresh_sends_refresh_token_in_body_with_bearer_header(tokens):
    def handler(request):
        if request.url.path == config.EP_REFRESH:
            body = httpx.Request("POST", "http://x", content=request.content).content
            assert b"refresh-1" in body
            assert request.headers["Authorization"] == "Bearer access-1"
            return httpx.Response(
                200, json={"access_token": "a2", "refresh_token": "r2"}
            )
        if request.headers["Authorization"] == "Bearer a2":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(401, json={"error": "AccessTokenExpired"})

    client, _ = make_client(handler, tokens)
    assert client.get_account() == {"ok": True}


def test_retries_only_once_then_raises_auth_required(tokens):
    def handler(request):
        if request.url.path == config.EP_REFRESH:
            return httpx.Response(200, json={"access_token": "a2", "refresh_token": "r2"})
        return httpx.Response(401, json={"error": "AccessTokenExpired"})

    client, rec = make_client(handler, tokens)
    with pytest.raises(AuthRequired, match="authenticate"):
        client.get_account()

    # One original call, one refresh, one retry. No loop.
    assert len(rec.requests) == 3


def test_failed_refresh_raises_auth_required_not_silent_retry(tokens):
    def handler(request):
        if request.url.path == config.EP_REFRESH:
            return httpx.Response(401, json={"error": "RefreshTokenExpired"})
        return httpx.Response(401, json={"error": "AccessTokenExpired"})

    client, rec = make_client(handler, tokens)
    with pytest.raises(AuthRequired, match="authenticate tool"):
        client.get_account()

    assert [r.url.path for r in rec.requests] == [config.EP_ACCOUNT, config.EP_REFRESH]


def test_non_refreshable_401_does_not_refresh(tokens):
    def handler(request):
        return httpx.Response(401, json={"error": "AccountDisabled"})

    client, rec = make_client(handler, tokens)
    with pytest.raises(AuthRequired):
        client.get_account()

    assert config.EP_REFRESH not in [r.url.path for r in rec.requests]


def test_refresh_body_without_access_token_is_auth_required(tokens):
    def handler(request):
        if request.url.path == config.EP_REFRESH:
            return httpx.Response(200, json={"detail": "nope"})
        return httpx.Response(401, json={})

    client, _ = make_client(handler, tokens)
    with pytest.raises(AuthRequired, match="unexpected body"):
        client.get_account()


def test_http_error_surfaces_as_api_error(tokens):
    def handler(request):
        return httpx.Response(500, json={"error": "boom"})

    client, _ = make_client(handler, tokens)
    with pytest.raises(HevyAPIError) as exc:
        client.get_account()
    assert exc.value.status_code == 500


def test_workouts_page_sends_pagination_params(tokens):
    def handler(request):
        return httpx.Response(200, json={"workouts": []})

    client, rec = make_client(handler, tokens)
    client.get_workouts_page("lifter", limit=10, offset=20)

    params = rec.requests[0].url.params
    assert params["username"] == "lifter"
    assert params["limit"] == "10"
    assert params["offset"] == "20"


def test_client_never_issues_a_write_to_a_data_endpoint(tokens):
    """Read-only guarantee: the only non-GET the client can make is the refresh."""

    def handler(request):
        if request.url.path == config.EP_REFRESH:
            return httpx.Response(200, json={"access_token": "a2", "refresh_token": "r2"})
        if request.headers["Authorization"] == "Bearer a2":
            return httpx.Response(200, json={"workouts": []})
        return httpx.Response(401, json={"error": "AccessTokenExpired"})

    client, rec = make_client(handler, tokens)
    client.get_account()
    client.get_workout_count()
    client.get_workouts_page("lifter", limit=10, offset=0)
    client.get_workout("w1")

    for request in rec.requests:
        if request.method != "GET":
            assert request.method == "POST"
            assert request.url.path == config.EP_REFRESH


def test_from_store_loads_tokens(store, tokens):
    store.save(tokens)
    client = HevyClient.from_store(store, http=httpx.Client(transport=httpx.MockTransport(
        lambda r: httpx.Response(200, json={}))))
    assert client.tokens.access_token == "access-1"
    client.close()


def test_from_store_without_file_raises_auth_required(tmp_path):
    from hevy_mcp.tokens import TokenStore

    with pytest.raises(AuthRequired, match="No tokens stored"):
        HevyClient.from_store(TokenStore(tmp_path / "missing.json"))
