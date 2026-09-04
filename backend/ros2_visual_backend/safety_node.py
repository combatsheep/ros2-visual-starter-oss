"""rclpy Safety Controller used by ROS mode.

Run inside a RoboStack ROS 2 Jazzy environment:
    PYTHONPATH=backend python -m ros2_visual_backend.safety_node
"""

from __future__ import annotations

import sys

try:
    import rclpy
    from geometry_msgs.msg import Twist
    from nav_msgs.msg import Odometry
    from rclpy.node import Node
    from sensor_msgs.msg import LaserScan
    from std_msgs.msg import Bool, Float32
except ImportError as error:  # pragma: no cover - only reached outside ROS
    raise SystemExit("ROS 2 Python packages are not available. Run this module inside `pixi run`.") from error

from .config import SafetyConfig
from .safety_logic import decide_safe_command


class SafetyController(Node):
    def __init__(self) -> None:
        super().__init__("safety_controller")
        self.config = SafetyConfig()
        self.last_scan: LaserScan | None = None
        self.last_raw: Twist | None = None
        self.last_scan_ms = self._now_ms()
        self.last_command_ms = self._now_ms()
        self.stopped = False
        self.cmd_publisher = self.create_publisher(Twist, "/cmd_vel", 10)
        self.stop_publisher = self.create_publisher(Bool, "/safety/stop", 10)
        self.distance_publisher = self.create_publisher(Float32, "/safety/front_distance", 10)
        self.create_subscription(Twist, "/cmd_vel_raw", self.on_command, 10)
        self.create_subscription(LaserScan, "/scan", self.on_scan, 10)
        self.create_timer(1 / self.config.publish_rate_hz, self.publish_safe_command)
        self.get_logger().info(
            f"[Safety Controller] 前方{self.config.stop_distance:.2f}m以内の障害物を検知すると前進を停止し、"
            f"{self.config.resume_distance:.2f}mで再開します。後退と旋回は許可します。"
        )

    def _now_ms(self) -> float:
        return self.get_clock().now().nanoseconds / 1_000_000

    def on_command(self, message: Twist) -> None:
        self.last_raw = message
        self.last_command_ms = self._now_ms()

    def on_scan(self, message: LaserScan) -> None:
        self.last_scan = message
        self.last_scan_ms = self._now_ms()

    def publish_safe_command(self) -> None:
        now_ms = self._now_ms()
        raw = self.last_raw or Twist()
        scan = self.last_scan
        result = decide_safe_command(
            raw.linear.x,
            raw.angular.z,
            list(scan.ranges) if scan else None,
            scan.angle_min if scan else 0.0,
            scan.angle_increment if scan else 0.0,
            scan.range_min if scan else 0.05,
            scan.range_max if scan else 8.0,
            now_ms,
            self.last_scan_ms,
            self.last_command_ms,
            self.stopped,
            self.config,
        )
        command = Twist()
        command.linear.x = result.linear_x
        command.angular.z = result.angular_z
        self.cmd_publisher.publish(command)
        distance = Float32()
        distance.data = result.front_distance
        self.distance_publisher.publish(distance)
        stop = Bool()
        stop.data = result.stopped
        self.stop_publisher.publish(stop)
        self.stopped = result.stopped


def main() -> None:
    rclpy.init(args=sys.argv)
    node = SafetyController()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
