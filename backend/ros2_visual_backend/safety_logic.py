from dataclasses import dataclass
from math import isfinite

from .config import SafetyConfig


@dataclass(frozen=True)
class SafetyResult:
    linear_x: float
    angular_z: float
    stopped: bool
    front_distance: float
    reason: str


def nearest_front_distance(
    ranges: list[float],
    angle_min: float,
    angle_increment: float,
    range_min: float,
    range_max: float,
    front_angle_deg: float = 15.0,
) -> float:
    limit = front_angle_deg / 180.0 * 3.141592653589793
    values = []
    for index, value in enumerate(ranges):
        angle = angle_min + angle_increment * index
        if abs(angle) <= limit and isfinite(value) and range_min <= value <= range_max:
            values.append(value)
    return min(values, default=float("inf"))


def decide_safe_command(
    linear_x: float,
    angular_z: float,
    ranges: list[float] | None,
    angle_min: float,
    angle_increment: float,
    range_min: float,
    range_max: float,
    now_ms: float,
    last_scan_ms: float,
    last_command_ms: float,
    was_stopped: bool,
    config: SafetyConfig = SafetyConfig(),
) -> SafetyResult:
    if now_ms - last_command_ms > config.command_timeout_sec * 1000:
        return SafetyResult(0.0, 0.0, True, float("inf"), "command-timeout")
    if ranges is None or now_ms - last_scan_ms > config.scan_timeout_sec * 1000:
        return SafetyResult(0.0, 0.0, True, float("inf"), "scan-timeout")
    distance = nearest_front_distance(ranges, angle_min, angle_increment, range_min, range_max, config.front_angle_deg)
    blocked = distance < config.stop_distance
    can_resume = distance >= config.resume_distance or distance == float("inf")
    stopped = linear_x > 0 and (blocked or (was_stopped and not can_resume))
    return SafetyResult(0.0 if stopped else linear_x, angular_z, stopped, distance, "obstacle" if stopped else "clear")
