#!/usr/bin/env python3
"""Run one command with a hard process-group timeout.

ROS CLI commands can occasionally keep a DDS child alive after their nominal
spin timeout. Keeping the timeout here, outside the shell, lets callers
terminate the whole command group instead of leaving a hidden child holding
the startup lock.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
from typing import Sequence


def descendants(root_pid: int) -> list[int]:
    parent_to_children: dict[int, list[int]] = {}
    result = subprocess.run(
        ["ps", "-axo", "pid=,ppid="],
        capture_output=True,
        text=True,
        check=False,
    )
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) != 2:
            continue
        try:
            child_pid, parent_pid = (int(field) for field in fields)
        except ValueError:
            continue
        parent_to_children.setdefault(parent_pid, []).append(child_pid)

    found: list[int] = []
    pending = list(parent_to_children.get(root_pid, []))
    while pending:
        child_pid = pending.pop()
        found.append(child_pid)
        pending.extend(parent_to_children.get(child_pid, []))
    return found


def signal_processes(process_ids: Sequence[int], signum: signal.Signals) -> None:
    for process_id in process_ids:
        try:
            os.kill(process_id, signum)
        except ProcessLookupError:
            pass


def terminate_group(process: subprocess.Popen[str]) -> None:
    child_processes = descendants(process.pid)
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    signal_processes(reversed(child_processes), signal.SIGTERM)
    try:
        process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        pass
    remaining_children = descendants(process.pid)
    signal_processes(reversed(remaining_children), signal.SIGKILL)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=1.0)
    except subprocess.TimeoutExpired:
        signal_processes(reversed(descendants(process.pid)), signal.SIGKILL)
        process.wait(timeout=1.0)


def run(command: Sequence[str], timeout_seconds: float) -> int:
    process = subprocess.Popen(
        list(command),
        start_new_session=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        terminate_group(process)
        stdout, stderr = process.communicate()
        if stderr:
            sys.stderr.write(stderr)
        sys.stderr.write(f"bounded command timeout after {timeout_seconds:.1f}s\n")
        return 124
    if stdout:
        sys.stdout.write(stdout)
    if stderr:
        sys.stderr.write(stderr)
    return process.returncode


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: run_bounded.py TIMEOUT_SECONDS COMMAND [ARG ...]", file=sys.stderr)
        return 2
    try:
        timeout_seconds = float(sys.argv[1])
    except ValueError:
        print("TIMEOUT_SECONDS must be a positive number", file=sys.stderr)
        return 2
    if timeout_seconds <= 0:
        print("TIMEOUT_SECONDS must be a positive number", file=sys.stderr)
        return 2
    return run(sys.argv[2:], timeout_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
