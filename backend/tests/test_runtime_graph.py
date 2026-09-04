from pathlib import Path

import pytest

from ros2_visual_backend.runtime_graph import (
    BASE_REQUIRED_NODES,
    DEFERRED_NAV2_NODES,
    LOCALIZATION_NODES,
    MAPPING_NODES,
    MODE_SPECIFIC_NODES,
    NAV2_NODES,
    RUNTIME_GRAPH_PLANS,
    runtime_graph_plan,
)


@pytest.mark.parametrize(
    ("mode", "mode_nodes", "navigation_initial"),
    [
        ("base", (), False),
        ("mapping", MAPPING_NODES, False),
        ("navigation", (*LOCALIZATION_NODES, *NAV2_NODES), True),
        ("exploration", (*MAPPING_NODES, *NAV2_NODES, *DEFERRED_NAV2_NODES), False),
    ],
)
def test_runtime_required_and_forbidden_nodes(
    mode: str,
    mode_nodes: tuple[str, ...],
    navigation_initial: bool,
) -> None:
    plan = runtime_graph_plan(mode)
    assert plan.required_nodes == (*BASE_REQUIRED_NODES, *mode_nodes)
    assert plan.forbidden_nodes == tuple(node for node in MODE_SPECIFIC_NODES if node not in mode_nodes)
    assert plan.navigation_command_gate_initial is navigation_initial


def test_exploration_uses_online_slam_without_fixed_localization() -> None:
    plan = runtime_graph_plan("exploration")
    assert plan.launch_slam is True
    assert plan.launch_nav2 is True
    assert plan.launch_fixed_localization is False
    assert plan.requires_map is False
    assert plan.allow_nav2_unknown_space is False
    assert plan.defer_nav2_until_map_tf is True
    assert plan.slam_overlay == "slam_toolbox_exploration.yaml"
    assert plan.nav2_overlay == "nav2_exploration.yaml"
    assert (Path(__file__).parents[1] / "config" / plan.slam_overlay).is_file()
    assert (Path(__file__).parents[1] / "config" / plan.nav2_overlay).is_file()
    assert "/slam_toolbox" in plan.required_nodes
    assert "/navigation_lifecycle_coordinator" in plan.required_nodes
    assert "/map_server" in plan.forbidden_nodes
    assert "/amcl" in plan.forbidden_nodes


def test_fixed_navigation_graph_is_unchanged() -> None:
    plan = runtime_graph_plan("navigation")
    assert plan.launch_slam is False
    assert plan.launch_nav2 is True
    assert plan.launch_fixed_localization is True
    assert plan.requires_map is True
    assert plan.allow_nav2_unknown_space is True
    assert plan.defer_nav2_until_map_tf is False
    assert plan.slam_overlay is None
    assert plan.nav2_overlay is None
    assert "/map_server" in plan.required_nodes
    assert "/amcl" in plan.required_nodes
    assert "/slam_toolbox" in plan.forbidden_nodes
    assert "/navigation_lifecycle_coordinator" in plan.forbidden_nodes


def test_only_known_runtime_modes_are_accepted() -> None:
    assert tuple(RUNTIME_GRAPH_PLANS) == ("base", "mapping", "navigation", "exploration")
    with pytest.raises(ValueError, match="Unsupported runtime mode"):
        runtime_graph_plan("sim")
