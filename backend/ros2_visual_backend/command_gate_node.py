"""Manual/Nav2 velocity selector. This is the only publisher of /cmd_vel_raw."""

from __future__ import annotations

import os
import sys

try:
    import rclpy
    from geometry_msgs.msg import Twist
    from rclpy.node import Node
    from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
    from std_msgs.msg import Bool, Float32, String
except ImportError as error:  # pragma: no cover
    raise SystemExit("ROS 2 Python packages are not available. Run this module inside `pixi run`.") from error

from .command_gate_logic import Velocity, limit_navigation_approach_speed, select_command


class CommandGate(Node):
    def __init__(self) -> None:
        super().__init__("command_gate")
        self.runtime_mode = os.environ.get("ROS2_VISUAL_RUNTIME_MODE", "base")
        self.navigation_mode = os.environ.get("ROS2_VISUAL_NAVIGATION_MODE", "0") == "1"
        self.manual = Velocity()
        self.navigation = Velocity()
        self.navigation_goal_distance = -1.0
        now = self._now_ms()
        self.last_manual_ms = now - 1000.0
        self.last_navigation_ms = now - 1000.0
        self.command_publisher = self.create_publisher(Twist, "/cmd_vel_raw", 10)
        state_qos = QoSProfile(depth=1)
        state_qos.reliability = ReliabilityPolicy.RELIABLE
        state_qos.durability = DurabilityPolicy.TRANSIENT_LOCAL
        self.mode_publisher = self.create_publisher(String, "/control/mode", state_qos)
        self.runtime_publisher = self.create_publisher(String, "/system/runtime_mode", state_qos)
        self.create_subscription(Twist, "/cmd_vel_manual", self.on_manual, 10)
        self.create_subscription(Twist, "/cmd_vel_nav", self.on_navigation, 10)
        self.create_subscription(Bool, "/control/navigation_mode", self.on_mode, 10)
        self.create_subscription(Float32, "/control/navigation_goal_distance", self.on_navigation_goal_distance, 10)
        self.create_timer(0.05, self.publish_selected_command)
        # rosbridge clients use volatile subscriptions, so repeat the retained
        # mode state for browsers that reload after this node has started.
        self.create_timer(1.0, self.publish_state)
        self.publish_state()
        self.get_logger().info(
            f"[Command Gate] runtime={self.runtime_mode}, source={'navigation' if self.navigation_mode else 'manual'}"
        )

    def _now_ms(self) -> float:
        return self.get_clock().now().nanoseconds / 1_000_000

    def on_manual(self, message: Twist) -> None:
        self.manual = Velocity(message.linear.x, message.angular.z)
        self.last_manual_ms = self._now_ms()

    def on_navigation(self, message: Twist) -> None:
        self.navigation = Velocity(message.linear.x, message.angular.z)
        self.last_navigation_ms = self._now_ms()

    def on_mode(self, message: Bool) -> None:
        if self.navigation_mode != message.data:
            self.navigation_mode = message.data
            self.command_publisher.publish(Twist())
            self.publish_state()
            self.get_logger().info(
                f"速度入力を{'Nav2' if self.navigation_mode else '手動'}へ切り替えました。"
            )

    def on_navigation_goal_distance(self, message: Float32) -> None:
        self.navigation_goal_distance = float(message.data)

    def publish_selected_command(self) -> None:
        decision = select_command(
            self.manual,
            self.navigation,
            self.navigation_mode,
            self._now_ms(),
            self.last_manual_ms,
            self.last_navigation_ms,
        )
        command = Twist()
        selected = limit_navigation_approach_speed(decision.command, self.navigation_goal_distance) \
            if decision.source == "navigation" and not decision.timed_out else decision.command
        command.linear.x = selected.linear_x
        command.angular.z = selected.angular_z
        self.command_publisher.publish(command)

    def publish_state(self) -> None:
        mode = String()
        mode.data = "navigation" if self.navigation_mode else "manual"
        self.mode_publisher.publish(mode)
        runtime = String()
        runtime.data = self.runtime_mode
        self.runtime_publisher.publish(runtime)


def main() -> None:
    rclpy.init(args=sys.argv)
    node = CommandGate()
    try:
        rclpy.spin(node)
    finally:
        node.command_publisher.publish(Twist())
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
