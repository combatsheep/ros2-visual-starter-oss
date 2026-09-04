from pathlib import Path
from xml.etree import ElementTree

import yaml


ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "backend" / "config"


def test_nav2_uses_real_robot_footprint_and_bounded_progress_timeout() -> None:
    config = yaml.safe_load((CONFIG / "nav2.yaml").read_text(encoding="utf-8"))
    controller = config["controller_server"]["ros__parameters"]
    assert controller["progress_checker"]["movement_time_allowance"] == 5.0
    for costmap_name in ("local_costmap", "global_costmap"):
        costmap = config[costmap_name][costmap_name]["ros__parameters"]
        assert costmap["footprint_padding"] == 0.02
        assert "robot_radius" not in costmap
        assert costmap["inflation_layer"]["inflation_radius"] == 0.40


def test_nav2_uses_stable_dwb_and_slows_for_final_goal_alignment() -> None:
    config = yaml.safe_load((CONFIG / "nav2.yaml").read_text(encoding="utf-8"))
    controller = config["controller_server"]["ros__parameters"]
    goal_checker = controller["goal_checker"]
    follow_path = controller["FollowPath"]

    assert goal_checker["plugin"] == "nav2_controller::SimpleGoalChecker"
    assert goal_checker["xy_goal_tolerance"] == 0.28
    assert goal_checker["yaw_goal_tolerance"] == 0.50
    assert follow_path["plugin"] == "dwb_core::DWBLocalPlanner"
    assert follow_path["min_vel_x"] == 0.0
    assert follow_path["max_vel_x"] == 0.45
    assert follow_path["transform_tolerance"] == 1.0
    assert follow_path["xy_goal_tolerance"] == goal_checker["xy_goal_tolerance"]
    assert follow_path["RotateToGoal.slowing_factor"] == 6.0


def test_navigation_recovery_backs_out_once_then_replans_without_spin() -> None:
    config = yaml.safe_load((CONFIG / "nav2.yaml").read_text(encoding="utf-8"))
    behaviors = config["behavior_server"]["ros__parameters"]
    assert behaviors["behavior_plugins"] == ["backup"]
    assert behaviors["backup"]["plugin"] == "nav2_behaviors::BackUp"
    assert "spin" not in behaviors
    root = ElementTree.parse(CONFIG / "navigate_to_pose_with_bounded_backup.xml").getroot()
    follow_recovery = root.find(".//RecoveryNode[@name='FollowPath']")
    assert follow_recovery is not None
    assert follow_recovery.attrib["number_of_retries"] == "1"
    sequence = follow_recovery.find("Sequence[@name='BackOutBeforeReplanning']")
    assert sequence is not None
    assert [node.tag for node in sequence] == [
        "WouldAControllerRecoveryHelp",
        "BackUp",
        "ClearEntireCostmap",
        "ClearEntireCostmap",
    ]
    backup = sequence.find("BackUp")
    assert backup is not None
    assert backup.attrib == {
        "backup_dist": "0.40",
        "backup_speed": "0.12",
        "time_allowance": "4.5",
        "error_code_id": "{backup_error_code}",
    }
    assert len(root.findall(".//BackUp")) == 1
    assert root.find(".//Spin") is None


def test_slam_mapping_keeps_full_rate_scan_matching_for_fast_turns() -> None:
    config = yaml.safe_load((CONFIG / "slam_toolbox.yaml").read_text(encoding="utf-8"))
    slam = config["slam_toolbox"]["ros__parameters"]
    assert slam["scan_topic"] == "/scan"
    assert slam["throttle_scans"] == 1
    assert slam["minimum_time_interval"] == 0.1
    assert slam["transform_publish_period"] == 0.05


def test_exploration_slam_does_not_jump_map_to_odom_during_nav2_goals() -> None:
    config = yaml.safe_load((CONFIG / "slam_toolbox_exploration.yaml").read_text(encoding="utf-8"))
    slam = config["slam_toolbox"]["ros__parameters"]
    assert slam["minimum_travel_distance"] == 0.0
    assert slam["minimum_travel_heading"] == 0.0
    assert slam["do_loop_closing"] is False
