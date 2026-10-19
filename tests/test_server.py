"""Server wiring: tool registration, read-only annotations, and auth failures."""

from __future__ import annotations

import asyncio

import pytest


@pytest.fixture
def isolated_server(tmp_path, monkeypatch):
    """Point state at a temp dir so tools never touch the real cache."""
    monkeypatch.setenv("HEVY_MCP_STATE_DIR", str(tmp_path))
    from hevy_mcp import server as server_module

    return server_module


EXPECTED_TOOLS = {
    "authenticate",
    "sync_workouts",
    "get_workouts",
    "get_workout_detail",
    "get_exercise_history",
    "get_volume_summary",
    "get_muscle_exposure",
    "get_personal_records",
    "list_exercises",
}

CACHE_ONLY_TOOLS = {
    "get_workouts",
    "get_workout_detail",
    "get_exercise_history",
    "get_volume_summary",
    "get_muscle_exposure",
    "get_personal_records",
    "list_exercises",
}


def list_tools(server_module):
    return asyncio.run(server_module.server.list_tools())


def test_exactly_the_expected_tools_are_registered(isolated_server):
    names = {t.name for t in list_tools(isolated_server)}
    assert names == EXPECTED_TOOLS


def test_no_write_tools_exist(isolated_server):
    """Read-only contract: nothing that creates, updates, or deletes."""
    names = {t.name for t in list_tools(isolated_server)}
    forbidden = ("create", "update", "delete", "post", "put", "log_", "add_")
    assert not [n for n in names if n.startswith(forbidden)]


def test_cache_only_tools_are_annotated_read_only(isolated_server):
    for tool in list_tools(isolated_server):
        if tool.name in CACHE_ONLY_TOOLS:
            assert tool.annotations is not None, tool.name
            assert tool.annotations.read_only_hint is True, tool.name


def test_network_tools_are_marked_non_destructive(isolated_server):
    for tool in list_tools(isolated_server):
        if tool.name in ("authenticate", "sync_workouts"):
            assert tool.annotations.read_only_hint is False
            assert tool.annotations.destructive_hint is False


def test_every_tool_documents_itself(isolated_server):
    for tool in list_tools(isolated_server):
        assert tool.description and len(tool.description) > 40, tool.name


def test_capped_tools_document_their_limit(isolated_server):
    by_name = {t.name: t.description for t in list_tools(isolated_server)}
    assert "200" in by_name["get_workouts"]
    assert "500" in by_name["get_exercise_history"]
    assert "200" in by_name["get_volume_summary"]
    assert "300" in by_name["list_exercises"]


def test_query_tools_work_against_an_empty_cache(isolated_server):
    """Cache-only tools must answer without tokens and without the network."""
    assert isolated_server.get_workouts()["workouts"] == []
    assert isolated_server.list_exercises()["exercises"] == []
    assert isolated_server.get_volume_summary(period="month")["buckets"] == []
    assert isolated_server.get_exercise_history("bench")["matched"] is None
    assert isolated_server.get_personal_records()["records"] == []
    assert isolated_server.get_muscle_exposure(period="month")["buckets"] == []


def test_sync_without_tokens_returns_auth_required_not_an_exception(isolated_server):
    result = isolated_server.sync_workouts()
    assert result["error"] == "auth_required"
    assert "authenticate" in result["next_step"]


def test_cli_sync_exits_nonzero_on_auth_failure(isolated_server, capsys):
    from hevy_mcp import cli

    assert cli.sync_main([]) == 1
    assert '"auth_required"' in capsys.readouterr().out


def test_bad_period_is_a_clean_error_not_a_crash(isolated_server):
    result = isolated_server.get_volume_summary(period="fortnight")
    assert result["error"] == "invalid_argument"


def test_sync_tool_is_the_only_path_to_the_network(isolated_server):
    """The cache-only tools import no HTTP client at call time."""
    import inspect

    for name in CACHE_ONLY_TOOLS:
        source = inspect.getsource(getattr(isolated_server, name))
        assert "HevyClient" not in source
        assert "httpx" not in source
