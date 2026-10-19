"""Token storage.

Tokens live in the gitignored state directory, never in the repo or in code.
Hevy rotates the refresh token on every refresh, so the store is rewritten
immediately after each rotation.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from hevy_mcp import config


class AuthRequired(Exception):
    """Stored tokens are missing or unusable; the user must run ``authenticate``."""


@dataclass
class Tokens:
    access_token: str
    refresh_token: str
    user_id: str | None = None
    expires_at: str | None = None

    def to_dict(self) -> dict[str, str | None]:
        return {
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "user_id": self.user_id,
            "expires_at": self.expires_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> Tokens:
        access = data.get("access_token")
        refresh = data.get("refresh_token")
        if not access or not refresh:
            raise AuthRequired(
                "Stored token file is missing access_token or refresh_token. "
                "Run the authenticate tool."
            )
        return cls(
            access_token=str(access),
            refresh_token=str(refresh),
            user_id=data.get("user_id"),
            expires_at=data.get("expires_at"),
        )


class TokenStore:
    def __init__(self, path: Path | str | None = None) -> None:
        self.path = Path(path) if path is not None else config.tokens_path()

    def exists(self) -> bool:
        return self.path.is_file()

    def load(self) -> Tokens:
        if not self.path.is_file():
            raise AuthRequired(
                f"No tokens stored at {self.path}. Run the authenticate tool."
            )
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise AuthRequired(f"Token file {self.path} is not valid JSON: {exc}") from exc
        if not isinstance(data, dict):
            raise AuthRequired(f"Token file {self.path} must contain a JSON object.")
        return Tokens.from_dict(data)

    def save(self, tokens: Tokens) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = dict(tokens.to_dict())
        payload["updated_at"] = datetime.now(timezone.utc).isoformat()
        self.path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        # Best effort; a no-op on filesystems without POSIX modes.
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass
