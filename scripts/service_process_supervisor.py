#!/usr/bin/env python3
"""Start a managed local service in its own recorded POSIX session."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from pixi_environment import activated_environment, prepend_python_path


ROOT = Path(__file__).resolve().parents[1]
LOGS = ROOT / ".logs"
PIXI_PREFIX = ROOT / ".pixi" / "envs" / "default"
SERVICES = {"frontend", "optional_llm"}
LLM_ENVIRONMENT = (
    "ROS2_VISUAL_LLM_TOKEN",
    "ROS2_VISUAL_LLM_BASE_URL",
    "ROS2_VISUAL_LLM_MODEL",
    "ROS2_VISUAL_LLM_ENABLED",
)
PROCESS_TOKEN_VARIABLE = "ROS2_VISUAL_PROCESS_TOKEN"


def atomic_write(path: Path, value: str) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(value, encoding="utf-8")
    os.replace(temporary, path)


def main() -> None:
    if (
        len(sys.argv) != 4
        or sys.argv[1] not in SERVICES
        or not re.fullmatch(r"[0-9a-f]{32}", sys.argv[2])
        or not sys.argv[3].isdigit()
        or int(sys.argv[3]) < 1
    ):
        raise SystemExit("usage: service_process_supervisor.py SERVICE BOOTSTRAP_TOKEN OWNER_PID")
    service, bootstrap_token, bootstrap_owner = sys.argv[1:]
    os.chdir(ROOT)
    LOGS.mkdir(exist_ok=True)
    atomic_write(LOGS / f"{service}.bootstrap.pid", f"{os.getpid()}\n")
    atomic_write(LOGS / f"{service}.bootstrap.owner", f"{bootstrap_owner}\n")
    atomic_write(LOGS / f"{service}.bootstrap.token", f"{bootstrap_token}\n")
    # Reuse the random bootstrap token as the durable generation token. This
    # supervisor stays as PID/PGID leader, so its argv is an independent
    # OS-visible identity anchor if the companion sentinel exits.
    process_token = bootstrap_token
    os.environ[PROCESS_TOKEN_VARIABLE] = process_token
    # Publish the intended group identity before detaching. Until setsid()
    # completes, the bootstrap tree still owns this process; afterwards the
    # same PID is the dedicated session and group leader.
    atomic_write(LOGS / f"{service}.pid", f"{os.getpid()}\n")
    atomic_write(LOGS / f"{service}.pgid", f"{os.getpid()}\n")
    atomic_write(LOGS / f"{service}.token", f"{process_token}\n")
    os.setsid()
    test_delay = os.environ.pop("ROS2_VISUAL_TEST_READY_DELAY_MS", "")
    if test_delay:
        if not test_delay.isdigit() or int(test_delay) > 5_000:
            raise SystemExit("invalid supervisor test delay")
        time.sleep(int(test_delay) / 1_000)
    try:
        environment = activated_environment(ROOT)
    except RuntimeError as error:
        raise SystemExit(str(error)) from error
    environment[PROCESS_TOKEN_VARIABLE] = process_token
    subprocess.Popen(
        [
            str(PIXI_PREFIX / "bin" / "python"),
            str(ROOT / "scripts" / "process_group_sentinel.py"),
            service,
            process_token,
        ],
        cwd=ROOT,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )
    atomic_write(LOGS / f"{service}.session_ready", f"{os.getpid()}\n")

    if service == "frontend":
        for name in LLM_ENVIRONMENT:
            environment.pop(name, None)
        npm = PIXI_PREFIX / "bin" / "npm"
        if not npm.is_file() or shutil.which("node", path=environment.get("PATH")) is None:
            raise SystemExit("Pixi environment does not provide npm")
        command = [str(npm), "run", "dev"]
    else:
        prepend_python_path(environment, ROOT / "backend")
        command = [
            str(PIXI_PREFIX / "bin" / "python"),
            "-m",
            "ros2_visual_backend.optional_llm_server",
        ]

    child = subprocess.Popen(
        command,
        cwd=ROOT,
        env=environment,
        close_fds=True,
    )
    return_code = child.wait()
    raise SystemExit(128 - return_code if return_code < 0 else return_code)


if __name__ == "__main__":
    main()
