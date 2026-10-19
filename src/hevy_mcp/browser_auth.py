"""Headed-browser token capture.

Hevy's web login is behind reCAPTCHA, so login is done by hand in a real browser
window. The profile is persistent, so the session survives restarts and later
runs usually capture tokens without a fresh login.

Capture is layered, because the ``Authorization`` header alone cannot yield a
refresh token:

1. A request interceptor reads the bearer access token off the first
   authenticated call the web app makes to api.hevyapp.com. This is the primary
   source and also proves the session is live.
2. The refresh token comes from the ``auth2.0-token`` cookie, a URL-encoded JSON
   blob. That cookie name is taken from the ``hevy-unofficial`` reference
   package, not assumed.
3. localStorage is a last resort, used only when 1 and 2 both come up empty at
   the deadline. It enumerates every key and looks for a value whose *shape*
   contains both ``access_token`` and ``refresh_token`` -- it never looks up a
   guessed key name -- and logs loudly that it was used.

This module runs Playwright's sync API. MCP tool functions that are not
coroutines are dispatched on a worker thread by the SDK, so this never blocks
the stdio loop.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote

from hevy_mcp import config
from hevy_mcp.tokens import Tokens

log = logging.getLogger(__name__)

LOGIN_URL = f"{config.WEB_ORIGIN}/login"
POLL_INTERVAL_MS = 500

# Walks nested JSON in localStorage looking for an object that *has* both token
# fields. Shape discovery: no key name is assumed anywhere in here.
_LOCALSTORAGE_PROBE = """
() => {
  const found = [];
  const visit = (node, path, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, path + '[' + i + ']', depth + 1));
      return;
    }
    if (typeof node.access_token === 'string' && typeof node.refresh_token === 'string') {
      found.push({ path: path, value: node });
      return;
    }
    for (const key of Object.keys(node)) visit(node[key], path + '.' + key, depth + 1);
  };
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  for (const key of keys) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    for (const candidate of [raw, decodeURIComponent(raw)]) {
      let parsed;
      try { parsed = JSON.parse(candidate); } catch (e) { continue; }
      visit(parsed, key, 0);
      break;
    }
  }
  return { inspectedKeys: keys.length, matches: found };
}
"""


class BrowserAuthError(Exception):
    """The browser flow could not produce a usable token pair."""


@dataclass
class CaptureResult:
    tokens: Tokens | None = None
    access_source: str | None = None
    refresh_source: str | None = None
    localstorage_fallback_used: bool = False
    notes: list[str] = field(default_factory=list)

    def note(self, message: str) -> None:
        self.notes.append(message)
        log.info("%s", message)


def parse_auth_cookie(raw: str) -> dict:
    """Parse the ``auth2.0-token`` cookie: URL-encoded JSON."""
    decoded = unquote((raw or "").strip())
    if not decoded:
        return {}
    try:
        data = json.loads(decoded)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def tokens_from_cookies(cookies: list[dict]) -> dict:
    for cookie in cookies:
        if cookie.get("name") == config.AUTH_COOKIE_NAME and cookie.get("value"):
            return parse_auth_cookie(cookie["value"])
    return {}


def capture_tokens(
    *,
    timeout_seconds: float = config.BROWSER_AUTH_TIMEOUT_SECONDS,
    profile_dir: Path | None = None,
    headless: bool = False,
) -> CaptureResult:
    """Open a headed browser and capture a token pair, or fail within the deadline."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise BrowserAuthError(
            "Playwright is not installed. Run: uv sync && uv run playwright install chromium"
        ) from exc

    profile_dir = profile_dir or config.browser_profile_dir()
    profile_dir.mkdir(parents=True, exist_ok=True)

    result = CaptureResult()
    deadline = time.monotonic() + timeout_seconds
    intercepted: dict[str, str] = {}

    def on_request(request) -> None:
        if intercepted:
            return
        if not request.url.startswith(config.BASE_URL):
            return
        header = request.headers.get("authorization") or ""
        if header.lower().startswith("bearer ") and len(header) > 10:
            intercepted["access_token"] = header.split(" ", 1)[1].strip()
            intercepted["url"] = request.url
            log.info("Intercepted bearer token from %s %s", request.method, request.url)

    with sync_playwright() as playwright:
        context = _launch(playwright, profile_dir, headless, result)

        try:
            context.on("request", on_request)
            page = context.pages[0] if context.pages else context.new_page()

            try:
                page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=30_000)
            except Exception as exc:
                result.note(f"Navigation to {LOGIN_URL} failed: {exc}")

            result.note(
                f"Browser open. Log in and complete the reCAPTCHA by hand. "
                f"Waiting up to {timeout_seconds:.0f}s."
            )

            cookie_data: dict = {}
            while time.monotonic() < deadline:
                cookie_data = tokens_from_cookies(context.cookies())
                have_refresh = bool(cookie_data.get("refresh_token"))
                have_access = bool(
                    intercepted.get("access_token") or cookie_data.get("access_token")
                )
                if have_refresh and have_access:
                    break
                time.sleep(POLL_INTERVAL_MS / 1000)

            remaining = deadline - time.monotonic()

            if intercepted.get("access_token"):
                result.note(f"Access token captured by interceptor from {intercepted['url']}")
            else:
                result.note("Interceptor saw no authenticated request to api.hevyapp.com.")

            if cookie_data.get("refresh_token"):
                result.note(f"Refresh token read from the {config.AUTH_COOKIE_NAME} cookie.")
            else:
                result.note(f"No usable {config.AUTH_COOKIE_NAME} cookie found.")

            access = intercepted.get("access_token") or cookie_data.get("access_token")
            refresh = cookie_data.get("refresh_token")
            expires_at = cookie_data.get("expires_at")
            user_id = cookie_data.get("user_id")

            if access:
                result.access_source = (
                    "interceptor" if intercepted.get("access_token") else "cookie"
                )
            if refresh:
                result.refresh_source = "cookie"

            # Fallback: only when interception and the cookie both yielded nothing.
            if not (access and refresh):
                log.warning(
                    "Interception and cookie read produced no usable pair; "
                    "falling back to localStorage shape discovery."
                )
                result.localstorage_fallback_used = True
                result.note(
                    "FALLBACK: interception yielded no usable token pair, so "
                    "localStorage was scanned by value shape."
                )
                probe = _probe_localstorage(_live_page(context, page))
                result.note(
                    f"localStorage scan inspected {probe.get('inspectedKeys', 0)} keys, "
                    f"found {len(probe.get('matches', []))} shape match(es)."
                )
                for match in probe.get("matches", []):
                    value = match.get("value") or {}
                    if value.get("access_token") and value.get("refresh_token"):
                        access = value["access_token"]
                        refresh = value["refresh_token"]
                        expires_at = expires_at or value.get("expires_at")
                        user_id = user_id or value.get("user_id")
                        result.access_source = "localstorage"
                        result.refresh_source = "localstorage"
                        result.note(f"Token pair recovered from localStorage at {match.get('path')}")
                        break

            if access and refresh:
                result.tokens = Tokens(
                    access_token=str(access),
                    refresh_token=str(refresh),
                    user_id=str(user_id) if user_id else None,
                    expires_at=str(expires_at) if expires_at else None,
                )
            elif remaining <= 0:
                result.note(
                    f"Hard timeout of {timeout_seconds:.0f}s reached before a "
                    "complete token pair was available."
                )

            return result
        finally:
            # Always close, including on the timeout path.
            try:
                context.close()
            except Exception as exc:  # pragma: no cover - teardown best effort
                log.warning("Closing browser context failed: %s", exc)


def _launch(playwright, profile_dir: Path, headless: bool, result: CaptureResult):
    """Launch a persistent context, preferring real Chrome.

    Google's OAuth flow rejects browsers it detects as automated, and installed
    Chrome fares better than Playwright's bundled Chromium. The automation blink
    feature is disabled for the same reason. Falls back to bundled Chromium when
    Chrome is not installed.
    """
    args = ["--disable-blink-features=AutomationControlled"]
    attempts = [("chrome", {"channel": "chrome"}), ("bundled chromium", {})]
    errors = []

    for label, kwargs in attempts:
        try:
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=str(profile_dir),
                headless=headless,
                args=args,
                **kwargs,
            )
        except Exception as exc:
            errors.append(f"{label}: {exc}")
            continue
        result.note(f"Launched {label}.")
        return context

    raise BrowserAuthError(
        "Could not launch a browser. Tried "
        + "; ".join(errors)
        + ". Run: uv run playwright install chromium"
    )


def _live_page(context, page):
    """Return a usable page on the hevy.com origin, reopening one if needed."""
    try:
        if not page.is_closed():
            return page
    except Exception:
        pass
    for candidate in context.pages:
        try:
            if not candidate.is_closed() and config.WEB_ORIGIN in candidate.url:
                return candidate
        except Exception:
            continue
    fresh = context.new_page()
    fresh.goto(config.WEB_ORIGIN, wait_until="domcontentloaded", timeout=30_000)
    return fresh


def _probe_localstorage(page) -> dict:
    try:
        probe = page.evaluate(_LOCALSTORAGE_PROBE)
    except Exception as exc:
        log.warning("localStorage probe failed: %s", exc)
        return {"inspectedKeys": 0, "matches": []}
    return probe if isinstance(probe, dict) else {"inspectedKeys": 0, "matches": []}
