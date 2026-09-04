#!/usr/bin/env python3
"""Resolve the project Pixi binary and reproduce its complete activation."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Mapping


def resolve_pixi() -> Path:
    candidates = []
    configured = os.environ.get("PIXI_EXE")
    if configured:
        candidates.append(Path(configured).expanduser())
    discovered = shutil.which("pixi")
    if discovered:
        candidates.append(Path(discovered))
    candidates.append(Path.home() / ".pixi" / "bin" / "pixi")
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate.resolve()
    raise RuntimeError("Pixiが見つかりません。./setup.sh を先に実行してください。")


def activated_environment(root: Path) -> dict[str, str]:
    """Return the current environment with Pixi's full activation applied."""

    pixi = resolve_pixi()
    completed = subprocess.run(
        [
            str(pixi),
            "shell-hook",
            "--json",
            "--as-is",
            "--no-config",
            "--change-ps1",
            "false",
        ],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip().splitlines()
        suffix = f": {detail[-1]}" if detail else ""
        raise RuntimeError(f"Pixi環境をactivateできませんでした{suffix}")
    try:
        payload = json.loads(completed.stdout)
        variables: Mapping[str, object] = payload["environment_variables"]
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise RuntimeError("Pixi activation情報を解釈できませんでした。") from error

    environment = os.environ.copy()
    for name, value in variables.items():
        if not isinstance(name, str) or not isinstance(value, str):
            raise RuntimeError("Pixi activation情報に不正な値があります。")
        environment[name] = value
    expected_prefix = (root / ".pixi" / "envs" / "default").resolve()
    actual_prefix = Path(environment.get("CONDA_PREFIX", "")).resolve()
    if actual_prefix != expected_prefix:
        raise RuntimeError("別workspaceのPixi環境を拒否しました。")
    return environment


def prepend_python_path(environment: dict[str, str], entry: Path) -> None:
    current = environment.get("PYTHONPATH", "")
    environment["PYTHONPATH"] = os.pathsep.join(
        part for part in (str(entry), current) if part
    )
