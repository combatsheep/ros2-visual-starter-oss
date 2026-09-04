"""Start exploration Nav2 only after the online SLAM map frame is usable."""

from __future__ import annotations

import sys
from typing import Any

try:
    import rclpy
    from nav2_msgs.srv import ManageLifecycleNodes
    from nav_msgs.msg import OccupancyGrid
    from rclpy.node import Node
    from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
    from rclpy.time import Time
    from std_srvs.srv import Trigger
    from tf2_ros import Buffer, TransformListener
except ImportError as error:  # pragma: no cover - only reached outside ROS
    raise SystemExit("ROS 2 Python packages are not available. Run this module inside `pixi run`.") from error

from .nav_lifecycle_recovery import (
    LifecycleCommand,
    NavLifecycleRecoveryState,
    command_after_health_check,
    complete_command,
    observe_map,
    valid_map_shape,
)


class NavigationLifecycleCoordinator(Node):
    """Gate Nav2 lifecycle startup on live map and map-to-robot TF evidence."""

    def __init__(self) -> None:
        super().__init__("navigation_lifecycle_coordinator")
        map_qos = QoSProfile(depth=1)
        map_qos.reliability = ReliabilityPolicy.RELIABLE
        map_qos.durability = DurabilityPolicy.TRANSIENT_LOCAL
        self.state = NavLifecycleRecoveryState()
        self.pending_request = False
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self)
        self.active_client = self.create_client(Trigger, "/lifecycle_manager_navigation/is_active")
        self.manage_client = self.create_client(ManageLifecycleNodes, "/lifecycle_manager_navigation/manage_nodes")
        self.create_subscription(OccupancyGrid, "/map", self.on_map, map_qos)
        self.create_timer(0.5, self.poll)
        self.get_logger().info("Online SLAMの/mapとmap→base_link TFを待ってからNav2を起動します。")

    def now_ms(self) -> int:
        return self.get_clock().now().nanoseconds // 1_000_000

    def on_map(self, _message: OccupancyGrid) -> None:
        if not valid_map_shape(_message.info.width, _message.info.height, len(_message.data)):
            return
        first_map = not self.state.map_received
        self.state = observe_map(self.state)
        if first_map:
            self.get_logger().info("Online SLAMの/mapを受信しました。TFの準備を確認します。")

    def transform_ready(self) -> bool:
        try:
            return self.tf_buffer.can_transform("map", "base_link", Time())
        except Exception:  # pragma: no cover - tf2 reports false in normal waits
            return False

    def poll(self) -> None:
        if self.pending_request or not self.state.map_received or self.now_ms() < self.state.next_attempt_ms:
            return
        if not self.transform_ready():
            return
        if not self.active_client.service_is_ready() or not self.manage_client.service_is_ready():
            return
        self.pending_request = True
        future = self.active_client.call_async(Trigger.Request())
        future.add_done_callback(self.on_health_response)

    def on_health_response(self, future: Any) -> None:
        self.pending_request = False
        try:
            manager_active = bool(future.result().success)
        except Exception as error:
            self.get_logger().warning(f"Nav2 lifecycle health確認を再試行します: {error}")
            return
        self.state, command = command_after_health_check(
            self.state,
            transform_ready=self.transform_ready(),
            manager_active=manager_active,
            now_ms=self.now_ms(),
        )
        if command is not None:
            self.send_command(command)

    def send_command(self, command: LifecycleCommand) -> None:
        request = ManageLifecycleNodes.Request()
        request.command = request.RESET if command == "reset" else request.STARTUP
        self.pending_request = True
        self.get_logger().info(f"Nav2 lifecycleへ{command}を要求します。")
        future = self.manage_client.call_async(request)
        future.add_done_callback(lambda result: self.on_command_response(command, result))

    def on_command_response(self, command: LifecycleCommand, future: Any) -> None:
        self.pending_request = False
        try:
            success = bool(future.result().success)
        except Exception as error:
            success = False
            self.get_logger().warning(f"Nav2 lifecycle {command}応答を取得できませんでした: {error}")
        self.state = complete_command(self.state, command, success=success, now_ms=self.now_ms())
        if success and command == "startup":
            self.get_logger().info("Nav2 lifecycleがactiveになりました。探索goalを受け付けられます。")
        elif not success:
            self.get_logger().warning(f"Nav2 lifecycle {command}に失敗しました。安全に再試行します。")


def main() -> None:
    rclpy.init(args=sys.argv)
    node = NavigationLifecycleCoordinator()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
