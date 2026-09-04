"""Run the pinned rosbridge server with a fail-closed browser Origin policy."""

from __future__ import annotations

import runpy
import sys
from pathlib import Path

from rosbridge_server import RosbridgeWebSocket
from tornado.web import HTTPError


ALLOWED_BROWSER_ORIGINS = frozenset(
    {
        "http://127.0.0.1:27182",
        "http://localhost:27182",
    }
)


def origin_is_allowed(origin: str | None) -> bool:
    """Permit only the two documented loopback UI origins."""
    return origin in ALLOWED_BROWSER_ORIGINS


def _secure_check_origin(_handler: RosbridgeWebSocket, origin: str) -> bool:
    return origin_is_allowed(origin)


_UPSTREAM_PREPARE = RosbridgeWebSocket.prepare


def _secure_prepare(handler: RosbridgeWebSocket) -> None:
    # Tornado calls check_origin only when an Origin header exists. Enforce the
    # same fail-closed rule in prepare() so a missing header cannot bypass it.
    if not origin_is_allowed(handler.request.headers.get("Origin")):
        raise HTTPError(403, reason="A documented loopback UI Origin is required.")
    _UPSTREAM_PREPARE(handler)


def _installed_entrypoint() -> Path:
    """Locate the rosbridge executable inside the active Pixi prefix."""
    executable_dir = Path(sys.prefix) / "lib" / "rosbridge_server"
    for name in ("rosbridge_websocket", "rosbridge_websocket.py"):
        candidate = executable_dir / name
        if candidate.is_file():
            return candidate
    raise RuntimeError("The pinned rosbridge_websocket entrypoint is missing.")


def main() -> None:
    # rosbridge_server 2.6.0 accepts every Origin by default. Patch the handler
    # before its pinned entrypoint builds the Tornado application so that a web
    # page from another Origin cannot bypass the Vite proxy and reach port 9090.
    RosbridgeWebSocket.check_origin = _secure_check_origin
    RosbridgeWebSocket.prepare = _secure_prepare
    runpy.run_path(str(_installed_entrypoint()), run_name="__main__")


if __name__ == "__main__":
    main()
