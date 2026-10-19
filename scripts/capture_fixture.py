"""Record one real workout payload so the set normalizer can be written.

The hevy-unofficial reference package does not model the nested
exercises[]/sets[] shape, so those field names were never guessed. Run this
once, after `authenticate`, to capture a real payload; the normalizer is then
written against it.

    uv run python scripts/capture_fixture.py

Writes tests/fixtures/workout_sample.json (one workout, verbatim) and prints a
field-name outline. The JSON holds real workout data -- review it before
committing.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from hevy_mcp import config  # noqa: E402
from hevy_mcp.client import HevyClient  # noqa: E402
from hevy_mcp.tokens import AuthRequired  # noqa: E402

OUT = ROOT / "tests" / "fixtures" / "workout_sample.json"
PAGE_OUT = ROOT / "tests" / "fixtures" / "workouts_page_sample.json"


def outline(value, indent: int = 0, path: str = "") -> list[str]:
    """Describe structure and value types without dumping every value."""
    pad = "  " * indent
    lines: list[str] = []

    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else key
            if isinstance(child, (dict, list)):
                lines.append(f"{pad}{key}: {type(child).__name__}")
                lines.extend(outline(child, indent + 1, child_path))
            else:
                sample = repr(child)
                if len(sample) > 60:
                    sample = sample[:57] + "..."
                lines.append(f"{pad}{key}: {type(child).__name__} = {sample}")
    elif isinstance(value, list):
        lines.append(f"{pad}[{len(value)} item(s)]")
        if value:
            lines.extend(outline(value[0], indent + 1, f"{path}[0]"))
    return lines


def main() -> int:
    try:
        client = HevyClient.from_store()
    except AuthRequired as exc:
        print(f"{exc}", file=sys.stderr)
        return 1

    with client:
        account = client.get_account()
        username = account.get("username") if isinstance(account, dict) else None
        if not username:
            print(
                f"{config.EP_ACCOUNT} returned no username; keys: "
                f"{sorted(account) if isinstance(account, dict) else type(account).__name__}",
                file=sys.stderr,
            )
            return 1

        print(f"Account: {username}")
        page = client.get_workouts_page(username, limit=1, offset=0)

    if not isinstance(page, dict):
        print(f"Unexpected page type: {type(page).__name__}", file=sys.stderr)
        return 1

    print(f"Page top-level keys: {sorted(page)}")
    workouts = page.get("workouts")
    if not isinstance(workouts, list) or not workouts:
        print(f"No workouts in the page. Raw page: {json.dumps(page)[:400]}", file=sys.stderr)
        return 1

    workout = workouts[0]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(workout, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    PAGE_OUT.write_text(
        json.dumps({"workouts": [workout]}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    print(f"\nWrote {OUT.relative_to(ROOT)}")
    print(f"Wrote {PAGE_OUT.relative_to(ROOT)}")
    print("\nStructure of one workout:\n")
    print("\n".join(outline(workout)))
    print(
        "\nThese files contain real workout data. Review before committing.\n"
        "Next: the set normalizer is written against this shape, then\n"
        "  sync.renormalize() rebuilds rows from the cache with no refetch."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
