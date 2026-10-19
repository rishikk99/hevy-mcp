"""Shared fixtures. Nothing here touches the network.

The Hevy client is exercised through an httpx MockTransport so no test can
reach api.hevyapp.com even accidentally.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from hevy_mcp import config, db
from hevy_mcp.client import HevyClient
from hevy_mcp.tokens import TokenStore, Tokens

FIXTURES = Path(__file__).parent / "fixtures"


def load_fixture(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


@pytest.fixture
def conn():
    connection = db.connect(":memory:")
    yield connection
    connection.close()


@pytest.fixture
def store(tmp_path) -> TokenStore:
    return TokenStore(tmp_path / "tokens.json")


@pytest.fixture
def tokens() -> Tokens:
    return Tokens(access_token="access-1", refresh_token="refresh-1", user_id="u1")


class RecordingTransport:
    """MockTransport wrapper that records every request for assertions."""

    def __init__(self, handler):
        self.requests: list[httpx.Request] = []
        self._handler = handler
        self.transport = httpx.MockTransport(self._record)

    def _record(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self._handler(request)


def make_client(handler, tokens: Tokens, store: TokenStore | None = None):
    """Build a HevyClient whose HTTP layer is a MockTransport."""
    recorder = RecordingTransport(handler)
    http = httpx.Client(
        base_url=config.BASE_URL,
        transport=recorder.transport,
        headers=HevyClient._static_headers(),
    )
    client = HevyClient(tokens, store=store, http=http)
    return client, recorder
