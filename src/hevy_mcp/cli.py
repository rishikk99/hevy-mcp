"""Command-line entrypoints.

``authenticate`` is normally an MCP tool, but it is useful before the server is
registered with a client. This calls the exact same function the tool calls, so
there is no second code path to keep in sync.
"""

from __future__ import annotations

import argparse
import json
import sys

from hevy_mcp import config


def authenticate_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="hevy-mcp-authenticate",
        description="Open a browser, log in to Hevy by hand, and store the tokens.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=config.BROWSER_AUTH_TIMEOUT_SECONDS,
        help=f"seconds to wait for login (default {config.BROWSER_AUTH_TIMEOUT_SECONDS:.0f})",
    )
    args = parser.parse_args(argv)

    from hevy_mcp.server import authenticate

    result = authenticate(timeout_seconds=args.timeout)
    print(json.dumps(result, indent=2))
    return 0 if result.get("ok") else 1


def sync_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="hevy-mcp-sync",
        description="Pull new workouts into the cache once and print the report.",
    )
    parser.add_argument("--full", action="store_true", help="re-walk the whole history")
    args = parser.parse_args(argv)

    from hevy_mcp.server import sync_workouts

    result = sync_workouts(full=args.full)
    print(json.dumps(result, indent=2))
    return 1 if "error" in result else 0


if __name__ == "__main__":
    sys.exit(authenticate_main())
