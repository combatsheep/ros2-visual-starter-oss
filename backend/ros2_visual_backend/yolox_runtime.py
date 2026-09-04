# SPDX-License-Identifier: Apache-2.0
# Copyright (c) Megvii Inc. All rights reserved.
# Copyright (c) Megvii, Inc. and its affiliates.
# Modifications Copyright (c) 2026 ROS2 Visual Starter contributors.

"""Small YOLOX-Nano ONNX inference runtime.

Adapted from the Apache-2.0 YOLOX 0.3.0 sources at commit
419778480ab6ec0590e5d3831b3afb3b46ab2aa3:

* demo/ONNXRuntime/onnx_inference.py
* yolox/data/data_augment.py
* yolox/utils/demo_utils.py

This version replaces OpenCV rendering and CLI concerns with Pillow, adds
typed result objects and provider selection, and keeps the YOLOX preprocessing,
grid decoding, box conversion, and NMS behavior needed by the local ROS node.
See docs/DEPENDENCY_LICENSE_AUDIT.md and LICENSES/Apache-2.0.txt.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from time import perf_counter

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw

from .object_search_targets import COCO_CLASSES


@dataclass(frozen=True)
class Detection:
    class_id: str
    score: float
    x1: float
    y1: float
    x2: float
    y2: float


@dataclass(frozen=True)
class InferenceResult:
    detections: list[Detection]
    latency_ms: float


def preprocess(image: Image.Image, input_shape: tuple[int, int]) -> tuple[np.ndarray, float]:
    rgb = image.convert("RGB")
    width, height = rgb.size
    ratio = min(input_shape[0] / height, input_shape[1] / width)
    resized = rgb.resize((int(width * ratio), int(height * ratio)), Image.Resampling.BILINEAR)
    padded = np.full((input_shape[0], input_shape[1], 3), 114, dtype=np.uint8)
    # Official YOLOX ONNX preprocessing receives OpenCV BGR input.
    resized_bgr = np.asarray(resized, dtype=np.uint8)[:, :, ::-1]
    padded[: resized_bgr.shape[0], : resized_bgr.shape[1]] = resized_bgr
    tensor = np.ascontiguousarray(padded.transpose(2, 0, 1), dtype=np.float32)
    return tensor, ratio


def demo_postprocess(outputs: np.ndarray, image_size: tuple[int, int]) -> np.ndarray:
    grids: list[np.ndarray] = []
    expanded_strides: list[np.ndarray] = []
    for stride in (8, 16, 32):
        height = image_size[0] // stride
        width = image_size[1] // stride
        x_values, y_values = np.meshgrid(np.arange(width), np.arange(height))
        grid = np.stack((x_values, y_values), 2).reshape(1, -1, 2)
        grids.append(grid)
        expanded_strides.append(np.full((*grid.shape[:2], 1), stride))
    grid = np.concatenate(grids, 1)
    strides = np.concatenate(expanded_strides, 1)
    decoded = outputs.copy()
    decoded[..., :2] = (decoded[..., :2] + grid) * strides
    decoded[..., 2:4] = np.exp(decoded[..., 2:4]) * strides
    return decoded


def non_maximum_suppression(boxes: np.ndarray, scores: np.ndarray, threshold: float) -> list[int]:
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size > 0:
        index = int(order[0])
        keep.append(index)
        overlap_x1 = np.maximum(x1[index], x1[order[1:]])
        overlap_y1 = np.maximum(y1[index], y1[order[1:]])
        overlap_x2 = np.minimum(x2[index], x2[order[1:]])
        overlap_y2 = np.minimum(y2[index], y2[order[1:]])
        width = np.maximum(0.0, overlap_x2 - overlap_x1 + 1)
        height = np.maximum(0.0, overlap_y2 - overlap_y1 + 1)
        intersection = width * height
        overlap = intersection / (areas[index] + areas[order[1:]] - intersection)
        remaining = np.where(overlap <= threshold)[0]
        order = order[remaining + 1]
    return keep


def multiclass_non_maximum_suppression(
    boxes: np.ndarray,
    scores: np.ndarray,
    classes: np.ndarray,
    threshold: float,
) -> list[int]:
    keep: list[int] = []
    for class_index in np.unique(classes):
        class_candidates = np.where(classes == class_index)[0]
        class_keep = non_maximum_suppression(boxes[class_candidates], scores[class_candidates], threshold)
        keep.extend(int(class_candidates[index]) for index in class_keep)
    return sorted(keep, key=lambda index: float(scores[index]), reverse=True)


def decode_detections(
    output: np.ndarray,
    ratio: float,
    score_threshold: float = 0.25,
    nms_threshold: float = 0.45,
    input_shape: tuple[int, int] = (416, 416),
) -> list[Detection]:
    predictions = demo_postprocess(output, input_shape)[0]
    boxes = predictions[:, :4]
    scores = predictions[:, 4:5] * predictions[:, 5:]
    boxes_xyxy = np.empty_like(boxes)
    boxes_xyxy[:, 0] = boxes[:, 0] - boxes[:, 2] / 2
    boxes_xyxy[:, 1] = boxes[:, 1] - boxes[:, 3] / 2
    boxes_xyxy[:, 2] = boxes[:, 0] + boxes[:, 2] / 2
    boxes_xyxy[:, 3] = boxes[:, 1] + boxes[:, 3] / 2
    boxes_xyxy /= ratio
    class_indices = scores.argmax(1)
    class_scores = scores[np.arange(len(class_indices)), class_indices]
    valid = class_scores > score_threshold
    if not np.any(valid):
        return []
    valid_boxes = boxes_xyxy[valid]
    valid_scores = class_scores[valid]
    valid_classes = class_indices[valid]
    keep = multiclass_non_maximum_suppression(valid_boxes, valid_scores, valid_classes, nms_threshold)
    return [
        Detection(
            class_id=COCO_CLASSES[int(valid_classes[index])],
            score=float(valid_scores[index]),
            x1=float(valid_boxes[index, 0]),
            y1=float(valid_boxes[index, 1]),
            x2=float(valid_boxes[index, 2]),
            y2=float(valid_boxes[index, 3]),
        )
        for index in keep
    ]


class YoloxRuntime:
    input_shape = (416, 416)

    def __init__(self, model_path: Path, requested_device: str = "cpu") -> None:
        if not model_path.is_file():
            raise FileNotFoundError(model_path)
        providers = ["CPUExecutionProvider"]
        self.device = "CPUExecutionProvider"
        if requested_device.lower() == "coreml" and "CoreMLExecutionProvider" in ort.get_available_providers():
            providers = ["CoreMLExecutionProvider", "CPUExecutionProvider"]
            self.device = "CoreMLExecutionProvider（CPU fallback）"
        self.session = ort.InferenceSession(str(model_path), providers=providers)
        self.input_name = self.session.get_inputs()[0].name

    def infer(self, image: Image.Image) -> InferenceResult:
        tensor, ratio = preprocess(image, self.input_shape)
        started = perf_counter()
        output = self.session.run(None, {self.input_name: tensor[None, :, :, :]})[0]
        latency_ms = (perf_counter() - started) * 1000
        return InferenceResult(decode_detections(output, ratio, input_shape=self.input_shape), latency_ms)


def annotate(image: Image.Image, detections: list[Detection]) -> Image.Image:
    annotated = image.convert("RGB").copy()
    draw = ImageDraw.Draw(annotated)
    colors = ("#ffcf56", "#66e0c2", "#ff7d73", "#79a7ff")
    for index, detection in enumerate(detections):
        color = colors[index % len(colors)]
        draw.rectangle((detection.x1, detection.y1, detection.x2, detection.y2), outline=color, width=3)
        draw.text((max(0, detection.x1 + 3), max(0, detection.y1 + 3)), f"{detection.class_id} {detection.score:.2f}", fill=color, stroke_width=2, stroke_fill="#10272b")
    return annotated
