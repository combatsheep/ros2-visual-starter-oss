#!/usr/bin/env python3
"""Wait for one managed service generation without racing Pixi activation."""

from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from collections import deque
from pathlib import Path


SESSION_TIMEOUT_SECONDS = 10.0
POLL_SECONDS = 0.05


def process_is_running(pid: int, timeout: float) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # kill(pid, 0) alone also accepts an exited child that has not been reaped.
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "stat="],
        capture_output=True, text=True, check=False, timeout=timeout,
    )
    state = result.stdout.strip()
    return bool(state) and not state.startswith("Z")


def read_record(logs: Path, service: str, suffix: str) -> str:
    try:
        return (logs / f"{service}.{suffix}").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""


def wait_for_session(logs: Path, service: str, pid: int, token: str) -> None:
    deadline = time.monotonic() + SESSION_TIMEOUT_SECONDS
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"{service}: 専用process groupの準備が10秒以内に完了しませんでした（Pixi activationを含む）。")
        try:
            running = process_is_running(pid, min(0.5, remaining))
        except subprocess.TimeoutExpired:
            # A slow process-table query must not be mistaken for a dead child.
            continue
        if not running:
            raise RuntimeError(f"{service}: session_readyの前にbootstrap processが終了しました。")
        if (
            read_record(logs, service, "pid") == str(pid)
            and read_record(logs, service, "pgid") == str(pid)
            and read_record(logs, service, "token") == token
            and read_record(logs, service, "session_ready") == str(pid)
            and os.getpgid(pid) == pid
        ):
            return
        time.sleep(min(POLL_SECONDS, max(0, deadline - time.monotonic())))


def main() -> int:
    if (
        len(sys.argv) != 4
        or sys.argv[1] not in {"frontend", "optional_llm"}
        or not sys.argv[2].isdigit()
        or int(sys.argv[2]) < 1
        or not re.fullmatch(r"[0-9a-f]{32}", sys.argv[3])
    ):
        raise SystemExit("usage: wait_service_session.py SERVICE BOOTSTRAP_PID TOKEN")
    service, pid, token = sys.argv[1:]
    logs = Path(__file__).resolve().parents[1] / ".logs"
    try:
        wait_for_session(logs, service, int(pid), token)
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(error, file=sys.stderr)
        print(f"--- .logs/{service}.log（末尾40行） ---", file=sys.stderr)
        try:
            with (logs / f"{service}.log").open(encoding="utf-8", errors="replace") as stream:
                sys.stderr.writelines(deque(stream, maxlen=40))
        except OSError:
            print("起動logを読み込めませんでした。", file=sys.stderr)
        return 1
    print(pid)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
