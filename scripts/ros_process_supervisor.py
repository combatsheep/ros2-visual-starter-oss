#!/usr/bin/env python3
"""Start one ROS launch graph in its own recorded POSIX session."""

from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from pathlib import Path

from pixi_environment import isolated_ros_environment, prepend_python_path


ROOT = Path(__file__).resolve().parents[1]
LOGS = ROOT / ".logs"
PIXI_PREFIX = ROOT / ".pixi" / "envs" / "default"
ALLOWED_MODES = {"base", "mapping", "navigation", "exploration"}
PROCESS_TOKEN_VARIABLE = "ROS2_VISUAL_PROCESS_TOKEN"


def atomic_write(path: Path, value: str) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(value, encoding="utf-8")
    os.replace(temporary, path)


def main() -> None:
    if (
        len(sys.argv) != 4
        or sys.argv[1] not in ALLOWED_MODES
        or not re.fullmatch(r"[0-9a-f]{32}", sys.argv[2])
        or not sys.argv[3].isdigit()
        or int(sys.argv[3]) < 1
    ):
        raise SystemExit("usage: ros_process_supervisor.py MODE BOOTSTRAP_TOKEN OWNER_PID")
    mode, bootstrap_token, bootstrap_owner = sys.argv[1:]
    os.chdir(ROOT)
    LOGS.mkdir(exist_ok=True)
    atomic_write(LOGS / "ros_bootstrap.pid", f"{os.getpid()}\n")
    atomic_write(LOGS / "ros_bootstrap.owner", f"{bootstrap_owner}\n")
    atomic_write(LOGS / "ros_bootstrap.token", f"{bootstrap_token}\n")

    # Keep the random token in this long-lived group leader's argv as well as
    # in the companion sentinel, avoiding a single identity-anchor failure.
    process_token = bootstrap_token
    os.environ[PROCESS_TOKEN_VARIABLE] = process_token
    # Publish the intended identity before detaching. Before setsid(), the
    # bootstrap tree owns this process; afterwards this PID is the group leader.
    atomic_write(LOGS / "ros_backend.pid", f"{os.getpid()}\n")
    atomic_write(LOGS / "ros_backend.pgid", f"{os.getpid()}\n")
    atomic_write(LOGS / "ros_backend.token", f"{process_token}\n")
    os.setsid()
    test_delay = os.environ.pop("ROS2_VISUAL_TEST_READY_DELAY_MS", "")
    if test_delay:
        if not test_delay.isdigit() or int(test_delay) > 5_000:
            raise SystemExit("invalid supervisor test delay")
        time.sleep(int(test_delay) / 1_000)
    try:
        environment = isolated_ros_environment(ROOT)
    except RuntimeError as error:
        raise SystemExit(str(error)) from error
    environment[PROCESS_TOKEN_VARIABLE] = process_token
    subprocess.Popen(
        [
            str(PIXI_PREFIX / "bin" / "python"),
            str(ROOT / "scripts" / "process_group_sentinel.py"),
            "ros_backend",
            process_token,
        ],
        cwd=ROOT,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )
    atomic_write(LOGS / "ros_backend.session_ready", f"{os.getpid()}\n")

    for name in (
        "ROS2_VISUAL_LLM_TOKEN",
        "ROS2_VISUAL_LLM_BASE_URL",
        "ROS2_VISUAL_LLM_MODEL",
        "ROS2_VISUAL_LLM_ENABLED",
    ):
        environment.pop(name, None)
    prepend_python_path(environment, ROOT / "backend")
    environment.update({
        "ROS_AUTOMATIC_DISCOVERY_RANGE": "LOCALHOST",
    })
    child = subprocess.Popen(
        [str(PIXI_PREFIX / "bin" / "python"), "-m", "ros2_visual_backend.launcher", mode],
        cwd=ROOT,
        env=environment,
        stdin=subprocess.DEVNULL,
        close_fds=True,
    )
    return_code = child.wait()
    raise SystemExit(128 - return_code if return_code < 0 else return_code)


if __name__ == "__main__":
    main()
