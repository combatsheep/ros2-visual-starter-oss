from ros2_visual_backend.command_gate_logic import Velocity, limit_navigation_approach_speed, select_command


def test_manual_and_navigation_are_exclusive() -> None:
    manual = Velocity(0.4, 0.1)
    navigation = Velocity(0.2, -0.3)
    assert select_command(manual, navigation, False, 1000, 900, 900).command == manual
    assert select_command(manual, navigation, True, 1000, 900, 900).command == navigation


def test_selected_source_timeout_returns_zero() -> None:
    result = select_command(Velocity(0.4, 0), Velocity(0.2, 0), True, 1000, 900, 100)
    assert result.command == Velocity()
    assert result.timed_out is True
    assert result.source == "navigation"


def test_navigation_approach_speed_is_limited_only_near_the_goal() -> None:
    command = Velocity(0.45, -0.2)
    assert limit_navigation_approach_speed(command, 1.1) == command
    assert limit_navigation_approach_speed(command, -1.0) == command
    assert limit_navigation_approach_speed(Velocity(-0.2, 0.3), 0.3) == Velocity(-0.2, 0.3)
    assert limit_navigation_approach_speed(command, 0.28) == Velocity(0.12, -0.2)
    limited = limit_navigation_approach_speed(command, 0.64)
    assert 0.12 < limited.linear_x < 0.45
    assert limited.angular_z == command.angular_z
