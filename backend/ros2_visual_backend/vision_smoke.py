"""Reproducible YOLOX smoke using checksum-verified download-only inputs."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image

from .yolox_runtime import YoloxRuntime, annotate


ROOT = Path(__file__).resolve().parents[2]
VISION = ROOT / "public" / "vision"
EXPECTED = {
    "yolox_nano.onnx": "c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d",
    "dog.jpg": "5a9522051c3cec2bbd2f6323fccba32e8fbf3ddcc2b3e2fd46b04c720bc6f866",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    for name, expected in EXPECTED.items():
        path = VISION / name
        if not path.is_file():
            raise SystemExit("assetが未取得です。先に pixi run vision-assets を実行してください。")
        actual = sha256(path)
        if actual != expected:
            raise SystemExit(f"checksum不一致: {name} expected={expected} actual={actual}")
    runtime = YoloxRuntime(VISION / "yolox_nano.onnx", "cpu")
    image = Image.open(VISION / "dog.jpg").convert("RGB")
    result = runtime.infer(image)
    classes = sorted({detection.class_id for detection in result.detections})
    if len(classes) < 2:
        raise SystemExit(f"複数classを検出できませんでした: {classes}")
    output = ROOT / ".logs" / "vision_smoke.jpg"
    output.parent.mkdir(parents=True, exist_ok=True)
    annotate(image, result.detections).save(output, quality=88)
    print(json.dumps({
        "ok": True,
        "model": "YOLOX-Nano",
        "device": runtime.device,
        "latency_ms": round(result.latency_ms, 2),
        "classes": classes,
        "detections": [detection.__dict__ for detection in result.detections],
        "annotated": str(output),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
