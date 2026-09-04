"""Single-process launch supervisor for the ROS backend runtime modes."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from launch import LaunchDescription, LaunchService
from launch.actions import ExecuteProcess
from launch_ros.actions import LifecycleNode, Node

from .default_map import DEFAULT_START_POSE, default_map_path, ensure_default_map
from .map_library import MapStartPose, load_map_start_pose, resolve_selected_map
from .runtime_graph import RUNTIME_GRAPH_PLANS, runtime_graph_plan


ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "backend" / "config"
NAVIGATE_TO_POSE_BT = CONFIG / "navigate_to_pose_with_bounded_backup.xml"
CAMERA_MOUNT_ARGUMENTS = [
    "--x", "0.25", "--y", "0", "--z", "0.18",
    "--roll", "0", "--pitch", "0", "--yaw", "0",
    "--frame-id", "base_link", "--child-frame-id", "camera_link",
]
CAMERA_OPTICAL_ARGUMENTS = [
    "--x", "0", "--y", "0", "--z", "0",
    "--roll", "-1.57079632679", "--pitch", "0", "--yaw", "-1.57079632679",
    "--frame-id", "camera_link", "--child-frame-id", "camera_rgb_optical_frame",
]


def backend_process(
    module: str,
    runtime_mode: str,
    navigation_mode: bool = False,
    arguments: list[str] | None = None,
) -> ExecuteProcess:
    environment = {
        "PYTHONPATH": str(ROOT / "backend"),
        "ROS2_VISUAL_RUNTIME_MODE": runtime_mode,
        "ROS2_VISUAL_NAVIGATION_MODE": "1" if navigation_mode else "0",
    }
    return ExecuteProcess(
        cmd=[sys.executable, "-m", module, *(arguments or [])],
        output="screen",
        additional_env=environment,
        sigterm_timeout="3",
        sigkill_timeout="3",
    )


def base_actions(runtime_mode: str, navigation_mode: bool) -> list:
    return [
        backend_process(
            "ros2_visual_backend.secure_rosbridge",
            runtime_mode,
            arguments=["--address", "127.0.0.1", "--port", "9090"],
        ),
        Node(
            package="rosapi",
            executable="rosapi_node",
            name="rosapi",
            output="screen",
        ),
        backend_process("ros2_visual_backend.safety_node", runtime_mode),
        backend_process("ros2_visual_backend.command_gate_node", runtime_mode, navigation_mode),
        backend_process("ros2_visual_backend.map_library_node", runtime_mode),
        backend_process("ros2_visual_backend.yolo_node", runtime_mode),
        Node(
            package="tf2_ros",
            executable="static_transform_publisher",
            name="laser_static_transform",
            output="screen",
            arguments=[
                "--x", "0", "--y", "0", "--z", "0.25",
                "--roll", "0", "--pitch", "0", "--yaw", "0",
                "--frame-id", "base_link", "--child-frame-id", "laser_frame",
            ],
        ),
        Node(
            package="tf2_ros",
            executable="static_transform_publisher",
            name="camera_mount_static_transform",
            output="screen",
            arguments=CAMERA_MOUNT_ARGUMENTS,
        ),
        Node(
            package="tf2_ros",
            executable="static_transform_publisher",
            name="camera_optical_static_transform",
            output="screen",
            arguments=CAMERA_OPTICAL_ARGUMENTS,
        ),
    ]


def mapping_actions(slam_overlay: str | None = None) -> list:
    slam_params = str(CONFIG / "slam_toolbox.yaml")
    slam_parameters: list = [slam_params]
    if slam_overlay:
        overlay_path = CONFIG / slam_overlay
        if not overlay_path.is_file():
            raise ValueError(f"SLAM Toolbox overlay is missing: {overlay_path}")
        slam_parameters.append(str(overlay_path))
    return [
        LifecycleNode(
            package="slam_toolbox",
            executable="async_slam_toolbox_node",
            name="slam_toolbox",
            namespace="",
            output="screen",
            parameters=slam_parameters,
        ),
        LifecycleNode(
            package="nav2_map_server",
            executable="map_saver_server",
            name="map_saver",
            namespace="",
            output="screen",
            parameters=[slam_params],
        ),
        Node(
            package="nav2_lifecycle_manager",
            executable="lifecycle_manager",
            name="lifecycle_manager_mapping",
            output="screen",
            parameters=[{
                "use_sim_time": False,
                "autostart": True,
                "bond_timeout": 0.0,
                "node_names": ["slam_toolbox", "map_saver"],
            }],
        ),
    ]


def navigation_actions(
    map_path: Path | None,
    *,
    include_fixed_localization: bool = True,
    allow_unknown_space: bool = True,
    nav2_overlay: str | None = None,
    defer_until_online_slam_ready: bool = False,
) -> list:
    nav_params = str(CONFIG / "nav2.yaml")
    if not NAVIGATE_TO_POSE_BT.is_file():
        raise ValueError(f"Nav2 navigation behavior tree is missing: {NAVIGATE_TO_POSE_BT}")
    nav_parameters: list = [nav_params]
    if nav2_overlay:
        overlay_path = CONFIG / nav2_overlay
        if not overlay_path.is_file():
            raise ValueError(f"Nav2 overlay is missing: {overlay_path}")
        nav_parameters.append(str(overlay_path))
    planner_parameters = [*nav_parameters]
    if not allow_unknown_space:
        planner_parameters.append({"GridBased.allow_unknown": False})
    lifecycle_nodes: list[str] = []
    actions: list = []
    if include_fixed_localization:
        if map_path is None:
            raise ValueError("Fixed-map navigation requires a map path")
        start_pose = load_map_start_pose(map_path) or MapStartPose(**DEFAULT_START_POSE)
        amcl_parameters: list = [nav_params]
        if start_pose:
            amcl_parameters.append({
                "set_initial_pose": True,
                "initial_pose.x": start_pose.x,
                "initial_pose.y": start_pose.y,
                "initial_pose.z": 0.0,
                "initial_pose.yaw": start_pose.yaw,
            })
        actions.extend([
            LifecycleNode(
                package="nav2_map_server", executable="map_server", name="map_server",
                namespace="",
                output="screen", parameters=[nav_params, {"yaml_filename": str(map_path)}],
            ),
            LifecycleNode(
                package="nav2_amcl", executable="amcl", name="amcl",
                namespace="",
                output="screen", parameters=amcl_parameters,
            ),
        ])
        lifecycle_nodes.extend(["map_server", "amcl"])
    actions.extend([
        LifecycleNode(
            package="nav2_controller", executable="controller_server", name="controller_server",
            namespace="", output="screen", parameters=nav_parameters,
            remappings=[("cmd_vel", "/cmd_vel_nav")],
        ),
        LifecycleNode(
            package="nav2_planner", executable="planner_server", name="planner_server",
            namespace="", output="screen", parameters=planner_parameters,
        ),
        LifecycleNode(
            package="nav2_behaviors", executable="behavior_server", name="behavior_server",
            namespace="", output="screen", parameters=nav_parameters,
            remappings=[("cmd_vel", "/cmd_vel_nav")],
        ),
        LifecycleNode(
            package="nav2_bt_navigator", executable="bt_navigator", name="bt_navigator",
            namespace="", output="screen", parameters=[
                *nav_parameters,
                {"default_nav_to_pose_bt_xml": str(NAVIGATE_TO_POSE_BT)},
            ],
        ),
    ])
    lifecycle_nodes.extend(["controller_server", "planner_server", "behavior_server", "bt_navigator"])
    actions.append(
        Node(
            package="nav2_lifecycle_manager", executable="lifecycle_manager",
            name="lifecycle_manager_navigation", output="screen",
            parameters=[{
                "use_sim_time": False,
                "autostart": not defer_until_online_slam_ready,
                "bond_timeout": 0.0,
                "node_names": lifecycle_nodes,
            }],
        )
    )
    if defer_until_online_slam_ready:
        actions.append(backend_process("ros2_visual_backend.nav_lifecycle_coordinator", "exploration"))
    return actions


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="ROS2 Visual Starter launch supervisor")
    parser.add_argument("mode", choices=list(RUNTIME_GRAPH_PLANS))
    parser.add_argument("--map", dest="map_path", default=os.environ.get("ROS2_VISUAL_MAP"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    plan = runtime_graph_plan(args.mode)
    if args.mode == "exploration" and args.map_path:
        raise SystemExit("explorationは保存地図を読み込みません。--mapは固定地図navigationだけで使用してください。")
    map_path: Path | None = None
    if plan.requires_map:
        configured_map = Path(args.map_path) if args.map_path else resolve_selected_map(ROOT / "maps")
        map_path = (ROOT / configured_map).resolve() if not configured_map.is_absolute() else configured_map
        if map_path == default_map_path(ROOT).resolve():
            ensure_default_map(ROOT)
        if not map_path.is_file():
            raise SystemExit(f"Nav2用の地図が見つかりません: {map_path}")
    actions = base_actions(args.mode, plan.navigation_command_gate_initial)
    if plan.launch_slam:
        actions.extend(mapping_actions(plan.slam_overlay))
    if plan.launch_nav2:
        actions.extend(navigation_actions(
            map_path,
            include_fixed_localization=plan.launch_fixed_localization,
            allow_unknown_space=plan.allow_nav2_unknown_space,
            nav2_overlay=plan.nav2_overlay,
            defer_until_online_slam_ready=plan.defer_nav2_until_map_tf,
        ))
    service = LaunchService()
    service.include_launch_description(LaunchDescription(actions))
    raise SystemExit(service.run())


if __name__ == "__main__":
    main()
