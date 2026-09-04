import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Velocity:
    linear_x: float = 0.0
    angular_z: float = 0.0


@dataclass(frozen=True)
class GateDecision:
    command: Velocity
    source: str
    timed_out: bool


NAVIGATION_APPROACH_START_METERS = 1.0
NAVIGATION_GOAL_TOLERANCE_METERS = 0.28
NAVIGATION_APPROACH_MIN_SPEED = 0.12
NAVIGATION_APPROACH_CRUISE_SPEED = 0.45


def limit_navigation_approach_speed(command: Velocity, goal_distance_meters: float) -> Velocity:
    """Limit forward speed near a goal without adding a new velocity owner."""
    if command.linear_x <= 0 or not math.isfinite(goal_distance_meters) or goal_distance_meters < 0:
        return command
    if goal_distance_meters >= NAVIGATION_APPROACH_START_METERS:
        return command
    span = NAVIGATION_APPROACH_START_METERS - NAVIGATION_GOAL_TOLERANCE_METERS
    progress = max(0.0, min(1.0, (goal_distance_meters - NAVIGATION_GOAL_TOLERANCE_METERS) / span))
    speed_limit = NAVIGATION_APPROACH_MIN_SPEED + progress * (
        NAVIGATION_APPROACH_CRUISE_SPEED - NAVIGATION_APPROACH_MIN_SPEED
    )
    return Velocity(min(command.linear_x, speed_limit), command.angular_z)


def select_command(
    manual: Velocity,
    navigation: Velocity,
    navigation_mode: bool,
    now_ms: float,
    last_manual_ms: float,
    last_navigation_ms: float,
    timeout_ms: float = 500.0,
) -> GateDecision:
    command = navigation if navigation_mode else manual
    updated_at = last_navigation_ms if navigation_mode else last_manual_ms
    source = "navigation" if navigation_mode else "manual"
    if now_ms - updated_at > timeout_ms:
        return GateDecision(Velocity(), source, True)
    return GateDecision(command, source, False)
