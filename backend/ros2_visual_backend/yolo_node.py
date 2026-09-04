"""Real rclpy YOLOX detector for Browser-published CompressedImage frames."""

from __future__ import annotations

import io
import json
import os
from pathlib import Path
from time import time

import rclpy
from PIL import Image
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import CompressedImage
from std_msgs.msg import String
from vision_msgs.msg import Detection2D, Detection2DArray, ObjectHypothesisWithPose

from .yolox_runtime import YoloxRuntime, annotate


ROOT = Path(__file__).resolve().parents[2]
MODEL_PATH = ROOT / "public" / "vision" / "yolox_nano.onnx"


class YoloNode(Node):
    def __init__(self) -> None:
        super().__init__("yolox_detector")
        sensor_qos = QoSProfile(
            history=HistoryPolicy.KEEP_LAST,
            depth=1,
            reliability=ReliabilityPolicy.BEST_EFFORT,
        )
        status_qos = QoSProfile(
            history=HistoryPolicy.KEEP_LAST,
            depth=1,
            reliability=ReliabilityPolicy.RELIABLE,
            durability=DurabilityPolicy.TRANSIENT_LOCAL,
        )
        self.detection_publisher = self.create_publisher(Detection2DArray, "/vision/detections", 10)
        self.annotated_publisher = self.create_publisher(CompressedImage, "/vision/annotated/compressed", sensor_qos)
        self.status_publisher = self.create_publisher(String, "/vision/status", status_qos)
        self.subscription = self.create_subscription(
            CompressedImage,
            "/camera/rgb/image_raw/compressed",
            self.on_image,
            sensor_qos,
        )
        self.runtime: YoloxRuntime | None = None
        self.last_inference_at = 0.0
        self.inference_fps = 0.0
        self.last_error = ""
        self.create_timer(2.0, self.ensure_model)
        self.ensure_model()

    def publish_status(self, **values: object) -> None:
        message = String()
        message.data = json.dumps(
            {
                "state": "ready" if self.runtime else "model_missing",
                "model": "YOLOX-Nano 0.1.1rc0 / COCO 80 class",
                "device": self.runtime.device if self.runtime else "CPU",
                "input_topic": "/camera/rgb/image_raw/compressed",
                "output_topic": "/vision/detections",
                **values,
            },
            ensure_ascii=False,
        )
        self.status_publisher.publish(message)

    def ensure_model(self) -> None:
        if self.runtime is not None:
            return
        if not MODEL_PATH.is_file():
            error = "model未取得です。pixi run vision-assets を実行してください。"
            if error != self.last_error:
                self.get_logger().warning(error)
                self.last_error = error
            self.publish_status(error=error)
            return
        try:
            requested_device = os.environ.get("ROS2_VISUAL_YOLO_DEVICE", "cpu")
            self.runtime = YoloxRuntime(MODEL_PATH, requested_device)
            self.last_error = ""
            self.get_logger().info(f"YOLOX-Nanoを起動しました: {self.runtime.device}")
            self.publish_status(state="ready", latency_ms=None, fps=0.0, detections=0)
        except Exception as error:  # ONNX Runtime reports provider/model errors here.
            self.runtime = None
            self.last_error = str(error)
            self.get_logger().error(f"YOLOX modelを開始できません: {error}")
            self.publish_status(error=f"YOLOX modelを開始できません: {error}")

    def on_image(self, message: CompressedImage) -> None:
        if self.runtime is None:
            self.ensure_model()
            return
        try:
            image = Image.open(io.BytesIO(bytes(message.data))).convert("RGB")
            result = self.runtime.infer(image)
            output = Detection2DArray()
            output.header = message.header
            for index, detected in enumerate(result.detections):
                detection = Detection2D()
                detection.header = message.header
                hypothesis = ObjectHypothesisWithPose()
                hypothesis.hypothesis.class_id = detected.class_id
                hypothesis.hypothesis.score = detected.score
                detection.results.append(hypothesis)
                detection.bbox.center.position.x = (detected.x1 + detected.x2) / 2
                detection.bbox.center.position.y = (detected.y1 + detected.y2) / 2
                detection.bbox.center.theta = 0.0
                detection.bbox.size_x = max(0.0, detected.x2 - detected.x1)
                detection.bbox.size_y = max(0.0, detected.y2 - detected.y1)
                detection.id = f"{detected.class_id}-{index}"
                output.detections.append(detection)
            self.detection_publisher.publish(output)

            annotated = annotate(image, result.detections)
            encoded = io.BytesIO()
            annotated.save(encoded, format="JPEG", quality=82)
            annotated_message = CompressedImage()
            annotated_message.header = message.header
            annotated_message.format = "jpeg; rgb8"
            annotated_message.data = encoded.getvalue()
            self.annotated_publisher.publish(annotated_message)

            now = time()
            if self.last_inference_at > 0:
                instantaneous = 1 / max(0.001, now - self.last_inference_at)
                self.inference_fps = instantaneous if self.inference_fps <= 0 else self.inference_fps * 0.8 + instantaneous * 0.2
            self.last_inference_at = now
            frame_at = message.header.stamp.sec + message.header.stamp.nanosec / 1_000_000_000
            self.publish_status(
                state="ready",
                latency_ms=round(result.latency_ms, 2),
                fps=round(self.inference_fps, 2),
                detections=len(result.detections),
                classes=sorted({detected.class_id for detected in result.detections}),
                frame_age_ms=round(max(0.0, now - frame_at) * 1000, 1),
            )
        except Exception as error:
            self.get_logger().error(f"Camera frameの実推論に失敗しました: {error}")
            self.publish_status(state="error", error=f"Camera frameの実推論に失敗しました: {error}")


def main() -> None:
    rclpy.init()
    node = YoloNode()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
