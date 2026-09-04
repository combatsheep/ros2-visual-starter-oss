from __future__ import annotations

from ros2_visual_backend.vision_asset_smoke import evaluate_target_detection
from ros2_visual_backend.yolox_runtime import Detection


def detection(class_id: str, score: float, box: tuple[float, float, float, float]) -> Detection:
    return Detection(class_id=class_id, score=score, x1=box[0], y1=box[1], x2=box[2], y2=box[3])


def test_target_detection_requires_class_confidence_area_and_center() -> None:
    passed = evaluate_target_detection(
        [detection("apple", 0.81, (100, 80, 500, 430))],
        image_size=(640, 480),
        target_class="apple",
    )
    assert passed.ok is True
    assert passed.target is not None
    assert passed.target.class_id == "apple"

    assert evaluate_target_detection(
        [detection("apple", 0.49, (100, 80, 500, 430))],
        image_size=(640, 480),
        target_class="apple",
    ).reason == "confidence-below-threshold"
    assert evaluate_target_detection(
        [detection("apple", 0.9, (0, 0, 20, 20))],
        image_size=(640, 480),
        target_class="apple",
    ).reason == "bbox-too-small"
    assert evaluate_target_detection(
        [detection("apple", 0.9, (-100, -100, -20, -20))],
        image_size=(640, 480),
        target_class="apple",
    ).reason == "bbox-center-outside-image"


def test_target_detection_selects_the_best_match_deterministically() -> None:
    result = evaluate_target_detection(
        [
            detection("apple", 0.72, (90, 80, 410, 390)),
            detection("dog", 0.99, (10, 10, 200, 200)),
            detection("apple", 0.83, (120, 90, 480, 420)),
        ],
        image_size=(640, 480),
        target_class="apple",
    )
    assert result.ok is True
    assert result.target is not None
    assert result.target.score == 0.83
    assert result.detected_classes == ("apple", "dog")


def test_target_detection_reports_missing_class() -> None:
    result = evaluate_target_detection(
        [detection("dog", 0.9, (50, 50, 300, 300))],
        image_size=(640, 480),
        target_class="apple",
    )
    assert result.ok is False
    assert result.reason == "target-class-not-detected"
