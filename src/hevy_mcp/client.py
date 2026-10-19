"""HTTP client for the undocumented Hevy web endpoints.

Header set, refresh semantics, and 401 handling follow the ``hevy-unofficial``
reference package. Data access is GET-only by construction: :meth:`HevyClient.get`
is the only public request method, and the sole POST is the token refresh.
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from hevy_mcp import config
from hevy_mcp.tokens import AuthRequired, TokenStore, Tokens

# 401 bodies carrying these codes (or no code at all) mean "access token stale",
# which is the case a refresh can fix. Anything else is a real auth failure.
REFRESHABLE_ERRORS = {None, "AccessTokenExpired", "AccessTokenInvalid"}


class HevyAPIError(Exception):
    def __init__(self, message: str, *, status_code: int | None = None, body: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class HevyClient:
    def __init__(
        self,
        tokens: Tokens,
        *,
        store: TokenStore | None = None,
        http: httpx.Client | None = None,
    ) -> None:
        self.tokens = tokens
        self.store = store
        self._owns_http = http is None
        self._http = http or httpx.Client(
            base_url=config.BASE_URL,
            timeout=config.HTTP_TIMEOUT,
            headers=self._static_headers(),
        )
        self._last_refresh: float | None = None

    @classmethod
    def from_store(cls, store: TokenStore | None = None, **kwargs: Any) -> HevyClient:
        store = store or TokenStore()
        return cls(store.load(), store=store, **kwargs)

    @staticmethod
    def _static_headers() -> dict[str, str]:
        return {
            "Accept": config.ACCEPT,
            "Accept-Language": config.ACCEPT_LANGUAGE,
            "User-Agent": config.USER_AGENT,
            "x-api-key": config.API_KEY,
            "hevy-platform": config.PLATFORM,
            "Origin": config.WEB_ORIGIN,
            "Referer": f"{config.WEB_ORIGIN}/",
        }

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def __enter__(self) -> HevyClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        """GET an authenticated endpoint, refreshing once on a stale token."""
        response = self._send(path, params)

        if response.status_code == 401 and self._is_refreshable(response):
            self._refresh()
            response = self._send(path, params)

        return self._parse(response, path)

    def _send(self, path: str, params: dict[str, Any] | None) -> httpx.Response:
        return self._http.get(
            path,
            params=params,
            headers={
                "Authorization": f"Bearer {self.tokens.access_token}",
                "x-client-time": str(time.time()),
            },
        )

    @staticmethod
    def _is_refreshable(response: httpx.Response) -> bool:
        body = _safe_json(response)
        code = body.get("error") if isinstance(body, dict) else None
        return code in REFRESHABLE_ERRORS

    def _refresh(self) -> None:
        """Exchange the refresh token for a new pair and persist it immediately."""
        now = time.time()
        if (
            self._last_refresh is not None
            and now - self._last_refresh < config.REFRESH_THROTTLE_SECONDS
        ):
            # A refresh just happened on another call; reuse its result rather
            # than stampeding the endpoint.
            return

        response = self._http.post(
            config.EP_REFRESH,
            json={"refresh_token": self.tokens.refresh_token},
            headers={
                "Authorization": f"Bearer {self.tokens.access_token}",
                "x-client-time": str(now),
            },
        )

        if response.status_code >= 400:
            raise AuthRequired(
                f"Token refresh failed with HTTP {response.status_code}. "
                "The refresh token is expired or revoked. "
                "Run the authenticate tool to log in again."
            )

        data = _safe_json(response)
        if not isinstance(data, dict) or not data.get("access_token"):
            raise AuthRequired(
                "Token refresh returned an unexpected body without an access_token. "
                "Run the authenticate tool to log in again."
            )

        self.tokens = Tokens(
            access_token=str(data["access_token"]),
            # Hevy rotates the refresh token; keep the old one only if absent.
            refresh_token=str(data.get("refresh_token") or self.tokens.refresh_token),
            user_id=data.get("user_id") or self.tokens.user_id,
            expires_at=data.get("expires_at"),
        )
        self._last_refresh = now
        if self.store is not None:
            self.store.save(self.tokens)

    @staticmethod
    def _parse(response: httpx.Response, path: str) -> Any:
        if response.status_code == 401:
            raise AuthRequired(
                f"Still unauthorized after refreshing for GET {path}. "
                "Run the authenticate tool to log in again."
            )
        if response.status_code >= 400:
            raise HevyAPIError(
                f"HTTP {response.status_code} for GET {path}",
                status_code=response.status_code,
                body=_safe_json(response),
            )
        if response.status_code == 204 or not response.content:
            return None
        return _safe_json(response)

    # --- endpoint wrappers -------------------------------------------------

    def get_account(self) -> Any:
        return self.get(config.EP_ACCOUNT)

    def get_workout_count(self) -> Any:
        return self.get(config.EP_WORKOUT_COUNT)

    def get_workouts_page(self, username: str, *, limit: int, offset: int) -> Any:
        return self.get(
            config.EP_WORKOUTS_PAGED,
            {"username": username, "limit": limit, "offset": offset},
        )

    def get_workout(self, workout_id: str) -> Any:
        return self.get(config.EP_WORKOUT.format(workout_id=workout_id))


def _safe_json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except Exception:
        return response.text
