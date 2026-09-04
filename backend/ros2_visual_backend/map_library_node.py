"""ROS topic API for listing, selecting, and deleting saved maps."""

from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    import rclpy
    from rclpy.node import Node
    from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
    from std_msgs.msg import String
except ImportError as error:  # pragma: no cover
    raise SystemExit("ROS 2 Python packages are not available. Run this module inside `pixi run`.") from error

from .default_map import DEFAULT_START_POSE
from .map_library import delete_saved_map, list_saved_maps, load_map_start_pose, map_library_signature, save_map_start_pose, select_saved_map, selected_map_name


ROOT = Path(__file__).resolve().parents[2]
MAPS_DIR = ROOT / "maps"


class MapLibraryNode(Node):
    def __init__(self) -> None:
        super().__init__("map_library")
        state_qos = QoSProfile(depth=1)
        state_qos.reliability = ReliabilityPolicy.RELIABLE
        state_qos.durability = DurabilityPolicy.TRANSIENT_LOCAL
        self.state_publisher = self.create_publisher(String, "/map_library/state", state_qos)
        self.create_subscription(String, "/map_library/request", self.on_request, 10)
        self.last_signature = map_library_signature(MAPS_DIR)
        self.create_timer(0.5, self.publish_if_changed)
        self.publish_state("保存地図を読み込みました。")

    def publish_if_changed(self) -> None:
        signature = map_library_signature(MAPS_DIR)
        if signature != self.last_signature:
            self.publish_state("保存地図を自動更新しました。")

    def on_request(self, message: String) -> None:
        try:
            request = json.loads(message.data)
            action = request.get("action", "list")
            name = str(request.get("name", ""))
            if action == "select":
                select_saved_map(MAPS_DIR, name)
                self.publish_state(f"{name} を次回のNav2地図に選択しました。")
            elif action == "set_start_pose":
                save_map_start_pose(MAPS_DIR, name, request.get("pose", {}))
                select_saved_map(MAPS_DIR, name)
                self.publish_state(f"{name} の地図と開始位置を保存しました。")
            elif action == "delete":
                delete_saved_map(MAPS_DIR, name)
                self.publish_state(f"{name} を削除しました。")
            elif action == "list":
                self.publish_state("保存地図を更新しました。")
            else:
                raise ValueError(f"未対応の操作です: {action}")
        except (ValueError, FileNotFoundError, json.JSONDecodeError) as error:
            self.publish_state("", str(error))

    def publish_state(self, status: str, error: str = "") -> None:
        maps = list_saved_maps(MAPS_DIR)
        selected = selected_map_name(MAPS_DIR, maps)
        self.last_signature = tuple((item.name, item.modified_ms) for item in maps), selected
        if not maps and not error:
            status = "保存地図がないため、Midサイズの初期default地図をNav2で使用します。"
        start_pose = load_map_start_pose(MAPS_DIR / f"{selected}.yaml") if selected else None
        active_start_pose = {
            "x": start_pose.x,
            "y": start_pose.y,
            "yaw": start_pose.yaw,
        } if start_pose else dict(DEFAULT_START_POSE)
        payload = {
            "maps": [{"name": item.name, "modifiedMs": item.modified_ms} for item in maps],
            "selected": selected,
            "startPose": active_start_pose,
            "defaultMap": not maps,
            "status": status,
            "error": error,
        }
        message = String()
        message.data = json.dumps(payload, ensure_ascii=False)
        self.state_publisher.publish(message)


def main() -> None:
    rclpy.init(args=sys.argv)
    node = MapLibraryNode()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
