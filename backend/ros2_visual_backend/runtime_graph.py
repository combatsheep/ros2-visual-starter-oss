"""Pure ROS graph plans for each backend runtime mode.

This module intentionally has no ROS imports.  Tests and the launcher consume the
same plans, so the safety-sensitive differences between fixed-map navigation and
online exploration can be inspected without starting a ROS graph.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


RuntimeMode = Literal["base", "mapping", "navigation", "exploration"]

BASE_REQUIRED_NODES = (
    "/safety_controller",
    "/command_gate",
    "/map_library",
    "/rosbridge_websocket",
)
MAPPING_NODES = (
    "/slam_toolbox",
    "/map_saver",
    "/lifecycle_manager_mapping",
)
LOCALIZATION_NODES = (
    "/map_server",
    "/amcl",
)
NAV2_NODES = (
    "/controller_server",
    "/planner_server",
    "/behavior_server",
    "/bt_navigator",
    "/lifecycle_manager_navigation",
)
DEFERRED_NAV2_NODES = (
    "/navigation_lifecycle_coordinator",
)
MODE_SPECIFIC_NODES = (*MAPPING_NODES, *LOCALIZATION_NODES, *NAV2_NODES, *DEFERRED_NAV2_NODES)


@dataclass(frozen=True)
class RuntimeGraphPlan:
    mode: RuntimeMode
    launch_slam: bool
    launch_nav2: bool
    launch_fixed_localization: bool
    requires_map: bool
    navigation_command_gate_initial: bool
    allow_nav2_unknown_space: bool
    defer_nav2_until_map_tf: bool
    slam_overlay: str | None
    nav2_overlay: str | None
    required_nodes: tuple[str, ...]
    forbidden_nodes: tuple[str, ...]


def _plan(
    mode: RuntimeMode,
    *,
    launch_slam: bool = False,
    launch_nav2: bool = False,
    launch_fixed_localization: bool = False,
    requires_map: bool = False,
    navigation_command_gate_initial: bool = False,
    allow_nav2_unknown_space: bool = True,
    defer_nav2_until_map_tf: bool = False,
    slam_overlay: str | None = None,
    nav2_overlay: str | None = None,
) -> RuntimeGraphPlan:
    mode_nodes: tuple[str, ...] = ()
    if launch_slam:
        mode_nodes += MAPPING_NODES
    if launch_fixed_localization:
        mode_nodes += LOCALIZATION_NODES
    if launch_nav2:
        mode_nodes += NAV2_NODES
    if defer_nav2_until_map_tf:
        mode_nodes += DEFERRED_NAV2_NODES
    launched_mode_nodes = frozenset(mode_nodes)
    forbidden_nodes = tuple(node for node in MODE_SPECIFIC_NODES if node not in launched_mode_nodes)
    return RuntimeGraphPlan(
        mode=mode,
        launch_slam=launch_slam,
        launch_nav2=launch_nav2,
        launch_fixed_localization=launch_fixed_localization,
        requires_map=requires_map,
        navigation_command_gate_initial=navigation_command_gate_initial,
        allow_nav2_unknown_space=allow_nav2_unknown_space,
        defer_nav2_until_map_tf=defer_nav2_until_map_tf,
        slam_overlay=slam_overlay,
        nav2_overlay=nav2_overlay,
        required_nodes=(*BASE_REQUIRED_NODES, *mode_nodes),
        forbidden_nodes=forbidden_nodes,
    )


RUNTIME_GRAPH_PLANS: dict[RuntimeMode, RuntimeGraphPlan] = {
    "base": _plan("base"),
    "mapping": _plan("mapping", launch_slam=True),
    "navigation": _plan(
        "navigation",
        launch_nav2=True,
        launch_fixed_localization=True,
        requires_map=True,
        navigation_command_gate_initial=True,
    ),
    "exploration": _plan(
        "exploration",
        launch_slam=True,
        launch_nav2=True,
        allow_nav2_unknown_space=False,
        defer_nav2_until_map_tf=True,
        slam_overlay="slam_toolbox_exploration.yaml",
        nav2_overlay="nav2_exploration.yaml",
    ),
}


def runtime_graph_plan(mode: str) -> RuntimeGraphPlan:
    try:
        return RUNTIME_GRAPH_PLANS[mode]  # type: ignore[index]
    except KeyError as error:
        supported = ", ".join(RUNTIME_GRAPH_PLANS)
        raise ValueError(f"Unsupported runtime mode {mode!r}; expected one of: {supported}") from error
