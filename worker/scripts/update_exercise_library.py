"""Load Hevy's built-in exercise library into the Worker's D1 database.

    uv run python worker/scripts/update_exercise_library.py OUT.sql
    npx wrangler d1 execute hevy --remote --file OUT.sql      (from worker/)

Hevy's API does not list the built-in exercises; the web app ships them inside
its main script as JSON.parse('[{"id":...}]'). This finds that script from
hevy.com's HTML, decodes the literal, and writes SQL that replaces every
built-in row (custom exercises are left alone). Re-run it when Hevy adds
exercises. The data is Hevy's, so it lives only in your database, never in
the repo.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path

PAGE = "https://hevy.com/routines"
MARKER = "JSON.parse('[{\"id\":\""
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)"

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
from hevy_mcp.normalize import normalize_name  # noqa: E402


def fetch(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode("utf-8")


def read_js_single_quoted(src: str, i: int) -> str:
    """Decode a JS '...' literal whose opening quote is at src[i - 1]."""
    out = []
    simple = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}
    while True:
        ch = src[i]
        if ch == "'":
            return "".join(out)
        if ch != "\\":
            out.append(ch)
            i += 1
            continue
        nxt = src[i + 1]
        if nxt == "x":
            out.append(chr(int(src[i + 2:i + 4], 16)))
            i += 4
        elif nxt == "u":
            out.append(chr(int(src[i + 2:i + 6], 16)))
            i += 6
        elif nxt in simple:
            out.append(simple[nxt])
            i += 2
        else:
            out.append(nxt)
            i += 2


def find_library() -> list[dict]:
    html = fetch(PAGE)
    scripts = sorted(set(re.findall(r'src="([^"]+\.js)"', html)))
    for src in scripts:
        url = src if src.startswith("http") else f"https://hevy.com{src}"
        text = fetch(url)
        for match in re.finditer(re.escape(MARKER), text):
            start = match.start() + len("JSON.parse('")
            candidates = json.loads(read_js_single_quoted(text, start))
            # The library is the big list whose entries carry an exercise_type.
            if len(candidates) > 100 and all("exercise_type" in c for c in candidates[:20]):
                return candidates
    raise SystemExit("Could not find the exercise library in hevy.com's scripts; the site has changed.")


def literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    library = find_library()
    columns = ("id, title, title_norm, muscle_group, other_muscles, exercise_type, equipment_category, "
               "aka, tags, priority, is_custom, is_archived, full_bodyweight")
    lines = ["DELETE FROM exercise_template WHERE is_custom = 0;"]
    for t in library:
        values = [
            t["id"], t["title"], normalize_name(t["title"]), t.get("muscle_group"),
            json.dumps(t.get("other_muscles") or []), t["exercise_type"], t.get("equipment_category"),
            t.get("aka") or None, t.get("manual_tag") or None, int(t.get("priority") or 0),
            False, bool(t.get("is_archived")), bool(t.get("hundred_percent_bodyweight_exercise")),
        ]
        lines.append(f"INSERT INTO exercise_template ({columns}) VALUES ({', '.join(map(literal, values))});")
    Path(sys.argv[1]).write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {len(library)} built-in exercises to {sys.argv[1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
