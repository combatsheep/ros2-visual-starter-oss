import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

from ros2_visual_backend.safety_logic import decide_safe_command, nearest_front_distance


def make_ranges(distance: float) -> list[float]:
    values = [8.0] * 180
    values[90] = distance
    return values


def test_front_distance_and_obstacle_stop() -> None:
    ranges = make_ranges(0.33)
    assert nearest_front_distance(ranges, -math.pi, math.pi / 90, .05, 8.0) == .33
    result = decide_safe_command(1.0, .5, ranges, -math.pi, math.pi / 90, .05, 8.0, 1000, 900, 900, False)
    assert result.stopped is True
    assert result.linear_x == 0.0
    assert result.angular_z == .5


def test_reverse_and_resume_hysteresis() -> None:
    assert decide_safe_command(-.6, 0, make_ranges(.3), -math.pi, math.pi / 90, .05, 8.0, 1000, 900, 900, False).linear_x == -.6
    assert decide_safe_command(1, 0, make_ranges(.38), -math.pi, math.pi / 90, .05, 8.0, 1000, 900, 900, True).stopped is True
    assert decide_safe_command(1, 0, make_ranges(.43), -math.pi, math.pi / 90, .05, 8.0, 1000, 900, 900, True).stopped is False


def test_timeout_stops() -> None:
    assert decide_safe_command(1, 0, make_ranges(3), -math.pi, math.pi / 90, .05, 8.0, 2000, 1000, 1900, False).reason == "scan-timeout"
    assert decide_safe_command(1, 0, make_ranges(3), -math.pi, math.pi / 90, .05, 8.0, 2000, 1900, 1000, False).reason == "command-timeout"
