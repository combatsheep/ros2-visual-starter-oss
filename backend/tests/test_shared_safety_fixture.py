import json
import math
from pathlib import Path

from ros2_visual_backend.safety_logic import decide_safe_command


CASES = json.loads((Path(__file__).parents[2] / "tests/fixtures/safety_cases.json").read_text())


def make_ranges(distance: float) -> list[float]:
    values = [8.0] * 180
    values[90] = distance
    return values


def test_shared_safety_cases_match_python_node_logic() -> None:
    now = 1000.0
    for case in CASES:
        result = decide_safe_command(
            case["linear"], case["angular"], make_ranges(case["front_distance"]),
            -math.pi, math.pi / 90, 0.05, 8.0, now,
            now - case["scan_age_ms"], now - case["command_age_ms"], case["was_stopped"],
        )
        assert result.linear_x == case["expected_linear"], case["name"]
        assert result.angular_z == case["expected_angular"], case["name"]
        assert result.stopped is case["expected_stopped"], case["name"]
        assert result.reason == case["reason"], case["name"]
