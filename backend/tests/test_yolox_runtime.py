from __future__ import annotations

import numpy as np
from PIL import Image

from ros2_visual_backend.yolox_runtime import multiclass_non_maximum_suppression, non_maximum_suppression, preprocess


def test_preprocess_uses_yolox_shape_and_padding() -> None:
    image = Image.new("RGB", (320, 240), (10, 20, 30))
    tensor, ratio = preprocess(image, (416, 416))
    assert tensor.shape == (3, 416, 416)
    assert tensor.dtype == np.float32
    assert ratio == 1.3
    # BGR order used by the official ONNX demo.
    assert tensor[:, 0, 0].tolist() == [30.0, 20.0, 10.0]
    assert tensor[:, 350, 0].tolist() == [114.0, 114.0, 114.0]


def test_non_maximum_suppression_removes_overlapping_box() -> None:
    boxes = np.array([[0, 0, 100, 100], [4, 4, 98, 98], [150, 150, 200, 200]], dtype=np.float32)
    scores = np.array([0.9, 0.8, 0.7], dtype=np.float32)
    assert non_maximum_suppression(boxes, scores, 0.45) == [0, 2]


def test_multiclass_nms_keeps_overlapping_different_classes() -> None:
    boxes = np.array([[0, 0, 100, 100], [2, 2, 98, 98], [4, 4, 96, 96]], dtype=np.float32)
    scores = np.array([0.9, 0.85, 0.8], dtype=np.float32)
    classes = np.array([1, 2, 1])
    assert multiclass_non_maximum_suppression(boxes, scores, classes, 0.45) == [0, 1]
