#!/usr/bin/env python3
"""Generate the fallback map used when no saved map is configured."""

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from ros2_visual_backend.default_map import ensure_default_map  # noqa: E402


if __name__ == "__main__":
    print(ensure_default_map(ROOT))
