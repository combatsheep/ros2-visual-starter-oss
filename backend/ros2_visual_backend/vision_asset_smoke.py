"""Evaluate a local image with the real YOLOX-Nano weight and emit JSON evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from .yolox_runtime import Detection, YoloxRuntime, annotate


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL = ROOT / "public" / "vision" / "yolox_nano.onnx"
DEFAULT_IMAGE = ROOT / "public" / "vision" / "dog.jpg"
DEFAULT_OUTPUT_DIRECTORY = ROOT / ".logs" / "vision_asset_smoke"


@dataclass(frozen=True)
class TargetDetectionEvaluation:
    ok: bool
    reason: str | None
    target: Detection | None
    detected_classes: tuple[str, ...]
    bbox_area_ratio: float | None


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def evaluate_target_detection(
    detections: list[Detection],
    image_size: tuple[int, int],
    target_class: str,
    minimum_confidence: float = 0.50,
    minimum_area_ratio: float = 0.015,
    maximum_non_target_detections: int = 5,
) -> TargetDetectionEvaluation:
    width, height = image_size
    detected_classes = tuple(sorted({detection.class_id for detection in detections}))
    targets = sorted(
        (detection for detection in detections if detection.class_id == target_class),
        key=lambda detection: (
            -detection.score,
            -(max(0.0, detection.x2 - detection.x1) * max(0.0, detection.y2 - detection.y1)),
            detection.x1,
            detection.y1,
        ),
    )
    if not targets:
        return TargetDetectionEvaluation(False, "target-class-not-detected", None, detected_classes, None)

    confident = [detection for detection in targets if detection.score >= minimum_confidence]
    if not confident:
        return TargetDetectionEvaluation(False, "confidence-below-threshold", targets[0], detected_classes, None)

    image_area = max(1, width * height)
    with_area = [
        (detection, max(0.0, detection.x2 - detection.x1) * max(0.0, detection.y2 - detection.y1) / image_area)
        for detection in confident
    ]
    large_enough = [(detection, area_ratio) for detection, area_ratio in with_area if area_ratio >= minimum_area_ratio]
    if not large_enough:
        return TargetDetectionEvaluation(False, "bbox-too-small", with_area[0][0], detected_classes, with_area[0][1])

    centered = [
        (detection, area_ratio)
        for detection, area_ratio in large_enough
        if 0 <= (detection.x1 + detection.x2) / 2 < width
        and 0 <= (detection.y1 + detection.y2) / 2 < height
    ]
    if not centered:
        return TargetDetectionEvaluation(False, "bbox-center-outside-image", large_enough[0][0], detected_classes, large_enough[0][1])

    non_targets = sum(detection.class_id != target_class for detection in detections)
    target, area_ratio = centered[0]
    if non_targets > maximum_non_target_detections:
        return TargetDetectionEvaluation(False, "excessive-non-target-detections", target, detected_classes, area_ratio)
    return TargetDetectionEvaluation(True, None, target, detected_classes, area_ratio)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, default=DEFAULT_IMAGE)
    parser.add_argument("--class", dest="target_class", default="dog")
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--annotated", type=Path)
    parser.add_argument("--minimum-confidence", type=float, default=0.50)
    parser.add_argument("--minimum-area-ratio", type=float, default=0.015)
    return parser


def main() -> None:
    arguments = build_parser().parse_args()
    image_path = arguments.image.resolve()
    model_path = arguments.model.resolve()
    annotated_path = (arguments.annotated or DEFAULT_OUTPUT_DIRECTORY / f"{image_path.stem}_annotated.jpg").resolve()
    report: dict[str, object] = {
        "image_path": str(image_path),
        "sha256": None,
        "model": "YOLOX-Nano",
        "target_class": arguments.target_class,
        "latency_ms": None,
        "detected_classes": [],
        "target_confidence": None,
        f"{arguments.target_class}_confidence": None,
        "target_bbox": None,
        "bbox_area_ratio": None,
        "annotated_output_path": str(annotated_path),
        "pass": False,
        "fail_reason": None,
    }
    exit_code = 0
    try:
        if not image_path.is_file():
            raise FileNotFoundError(image_path)
        if not model_path.is_file():
            raise FileNotFoundError(model_path)
        report["sha256"] = sha256(image_path)
        with Image.open(image_path) as opened:
            image = opened.convert("RGB")
        runtime = YoloxRuntime(model_path, "cpu")
        inference = runtime.infer(image)
        evaluation = evaluate_target_detection(
            inference.detections,
            image.size,
            arguments.target_class,
            arguments.minimum_confidence,
            arguments.minimum_area_ratio,
        )
        annotated_path.parent.mkdir(parents=True, exist_ok=True)
        annotate(image, inference.detections).save(annotated_path, quality=88)
        target = evaluation.target
        confidence = target.score if target else None
        report.update({
            "device": runtime.device,
            "latency_ms": round(inference.latency_ms, 2),
            "detected_classes": list(evaluation.detected_classes),
            "detections": [detection.__dict__ for detection in inference.detections],
            "target_confidence": confidence,
            f"{arguments.target_class}_confidence": confidence,
            "target_bbox": None if target is None else [target.x1, target.y1, target.x2, target.y2],
            "bbox_area_ratio": evaluation.bbox_area_ratio,
            "pass": evaluation.ok,
            "fail_reason": evaluation.reason,
        })
        if not evaluation.ok:
            exit_code = 1
    except (FileNotFoundError, UnidentifiedImageError, OSError, ValueError) as error:
        report["fail_reason"] = f"{type(error).__name__}: {error}"
        exit_code = 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if exit_code:
        raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
