"""Record what hevy.com's web app sends to api.hevyapp.com while you use it by hand.

    uv run python scripts/capture_routes.py OUT_DIR

Opens a headed Chrome on a brand-new, throwaway profile, so the stale login in
.hevy/chrome-profile is never replayed: Hevy rotates refresh tokens, and a
replayed old one could cost the deployed connector its login. Log in, do the
actions you want recorded, then close the window.

Writes OUT_DIR/calls.json (one entry per API call, in order) and the larger
response bodies as separate files. Authorization headers, cookies, and any
token-shaped JSON fields are redacted before anything is written; the
throwaway profile is deleted at the end. Bodies still hold personal data
(routines, account details), so keep OUT_DIR out of the repo.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

API_HOST = "api.hevyapp.com"
START_URL = "https://hevy.com/login"
MAX_SECONDS = 45 * 60
INLINE_BODY_LIMIT = 4000

SECRET_HEADERS = {"authorization", "cookie", "set-cookie"}
SECRET_FIELDS = {"access_token", "refresh_token", "id_token", "token", "password", "auth_token"}
# Login endpoints send one-time OAuth codes; spent by the time they are saved,
# but still nothing to keep.
SECRET_FIELDS |= {"code", "authorization_code", "credential"}


def redact(value):
    """Blank out token-shaped fields anywhere in a JSON value."""
    if isinstance(value, dict):
        return {
            k: ("<redacted>" if k.lower() in SECRET_FIELDS and v else redact(v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def parse_body(text: str | None):
    if not text:
        return None
    try:
        return redact(json.loads(text))
    except ValueError:
        return "<non-JSON body omitted>"


def main(out_dir: Path) -> int:
    from playwright.sync_api import sync_playwright

    out_dir.mkdir(parents=True, exist_ok=True)
    calls: list[dict] = []
    profile = Path(tempfile.mkdtemp(prefix="hevy-capture-"))

    def on_response(response) -> None:
        request = response.request
        if API_HOST not in request.url or request.method == "OPTIONS":
            return
        entry = {
            "n": len(calls) + 1,
            "t": round(time.time(), 1),
            "method": request.method,
            "url": request.url,
            "request_headers": {
                k: v for k, v in request.headers.items() if k.lower() not in SECRET_HEADERS
            },
            "request_body": parse_body(request.post_data),
            "status": response.status,
        }
        try:
            body = parse_body(response.text())
        except Exception as exc:  # streamed or already-disposed bodies
            body = f"<unreadable: {exc}>"
        text = json.dumps(body)
        if len(text) > INLINE_BODY_LIMIT:
            name = f"response_{entry['n']:03d}.json"
            (out_dir / name).write_text(json.dumps(body, indent=1), encoding="utf-8")
            entry["response_body_file"] = name
        else:
            entry["response_body"] = body
        calls.append(entry)
        # Write as we go, so closing the window abruptly loses nothing.
        (out_dir / "calls.json").write_text(json.dumps(calls, indent=1), encoding="utf-8")
        print(f"{entry['n']:3d} {request.method:6} {response.status} {request.url.split('?')[0]}", flush=True)

    try:
        with sync_playwright() as pw:
            try:
                context = pw.chromium.launch_persistent_context(
                    str(profile), headless=False, channel="chrome",
                    args=["--disable-blink-features=AutomationControlled"],
                )
            except Exception:
                context = pw.chromium.launch_persistent_context(
                    str(profile), headless=False,
                    args=["--disable-blink-features=AutomationControlled"],
                )
            context.on("response", on_response)
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(START_URL)
            print("Browser open. Log in, do the actions, then close the window.", flush=True)

            deadline = time.time() + MAX_SECONDS
            while time.time() < deadline:
                try:
                    if not context.pages:
                        break
                    context.pages[0].wait_for_timeout(1000)
                except Exception:
                    break
            try:
                context.close()
            except Exception:
                pass
    finally:
        shutil.rmtree(profile, ignore_errors=True)

    print(f"Recorded {len(calls)} API calls to {out_dir}", flush=True)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(Path(sys.argv[1])))
