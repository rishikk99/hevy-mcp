"""Token store round-trip and failure modes."""

from __future__ import annotations

import json
import os
import stat

import pytest

from hevy_mcp.tokens import AuthRequired, TokenStore, Tokens


def test_round_trip(store):
    store.save(Tokens("a", "r", user_id="u1", expires_at="2026-09-08T00:00:00Z"))
    loaded = store.load()
    assert loaded.access_token == "a"
    assert loaded.refresh_token == "r"
    assert loaded.user_id == "u1"
    assert loaded.expires_at == "2026-09-08T00:00:00Z"


def test_save_stamps_updated_at(store):
    store.save(Tokens("a", "r"))
    data = json.loads(store.path.read_text(encoding="utf-8"))
    assert "updated_at" in data


def test_save_creates_parent_directory(tmp_path):
    target = tmp_path / "nested" / "deeper" / "tokens.json"
    TokenStore(target).save(Tokens("a", "r"))
    assert target.is_file()


@pytest.mark.skipif(os.name == "nt", reason="POSIX file modes only")
def test_saved_file_is_owner_only(store):
    store.save(Tokens("a", "r"))
    assert stat.S_IMODE(store.path.stat().st_mode) == 0o600


def test_missing_file_raises_auth_required(store):
    with pytest.raises(AuthRequired, match="No tokens stored"):
        store.load()


def test_malformed_json_raises_auth_required(store):
    store.path.parent.mkdir(parents=True, exist_ok=True)
    store.path.write_text("{not json", encoding="utf-8")
    with pytest.raises(AuthRequired, match="not valid JSON"):
        store.load()


def test_partial_tokens_raise_auth_required(store):
    store.path.parent.mkdir(parents=True, exist_ok=True)
    store.path.write_text(json.dumps({"access_token": "a"}), encoding="utf-8")
    with pytest.raises(AuthRequired, match="missing access_token or refresh_token"):
        store.load()


def test_exists(store):
    assert not store.exists()
    store.save(Tokens("a", "r"))
    assert store.exists()
