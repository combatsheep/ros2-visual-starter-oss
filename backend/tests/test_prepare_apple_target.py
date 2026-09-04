from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]


def test_prepare_apple_target_is_deterministic_and_strips_metadata(tmp_path: Path) -> None:
    source = tmp_path / "source.png"
    first = tmp_path / "first.jpg"
    second = tmp_path / "second.jpg"
    Image.new("RGB", (1200, 900), (180, 20, 20)).save(source, pnginfo=None)

    command = [sys.executable, str(ROOT / "scripts" / "prepare_apple_target.py"), str(source)]
    subprocess.run([*command, str(first)], check=True)
    subprocess.run([*command, str(second)], check=True)

    assert first.read_bytes() == second.read_bytes()
    with Image.open(first) as prepared:
        assert prepared.size == (640, 480)
        assert prepared.mode == "RGB"
        assert prepared.getexif() == {}
