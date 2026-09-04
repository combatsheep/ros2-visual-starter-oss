#!/usr/bin/env python3
"""Prepare a local 640x480 JPEG candidate for provenance review."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "public" / "vision" / "apple_search_target.jpg"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="4:3 PNG selected after real YOLOX evaluation")
    parser.add_argument("output", type=Path, nargs="?", default=DEFAULT_OUTPUT)
    arguments = parser.parse_args()

    source = arguments.source.resolve()
    output = arguments.output.resolve()
    if not source.is_file():
        raise SystemExit(f"入力画像がありません: {source}")
    with Image.open(source) as opened:
        source_dimensions = (opened.width, opened.height)
        if opened.width * 3 != opened.height * 4:
            raise SystemExit(f"入力画像は4:3にしてください: {opened.width}x{opened.height}")
        prepared = opened.convert("RGB").resize((640, 480), Image.Resampling.LANCZOS)
    output.parent.mkdir(parents=True, exist_ok=True)
    prepared.save(output, format="JPEG", quality=88, optimize=True, progressive=False, subsampling=2)
    print(json.dumps({
        "source": str(source),
        "source_dimensions": list(source_dimensions),
        "output": str(output),
        "output_dimensions": [640, 480],
        "quality": 88,
        "sha256": sha256(output),
        "bytes": output.stat().st_size,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
