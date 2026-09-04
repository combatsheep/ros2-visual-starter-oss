from ros2_visual_backend.nav_lifecycle_recovery import (
    NavLifecycleRecoveryState,
    command_after_health_check,
    complete_command,
    observe_map,
    retry_delay_ms,
    valid_map_shape,
)


def test_startup_waits_for_both_live_map_and_map_to_robot_transform() -> None:
    state = NavLifecycleRecoveryState()
    state, command = command_after_health_check(
        state, transform_ready=True, manager_active=False, now_ms=1_000
    )
    assert command is None

    state = observe_map(state)
    state, command = command_after_health_check(
        state, transform_ready=False, manager_active=False, now_ms=1_000
    )
    assert command is None

    state, command = command_after_health_check(
        state, transform_ready=True, manager_active=False, now_ms=1_000
    )
    assert command == "startup"


def test_map_evidence_requires_a_complete_non_empty_grid() -> None:
    assert valid_map_shape(100, 80, 8_000) is True
    assert valid_map_shape(0, 80, 0) is False
    assert valid_map_shape(100, 80, 7_999) is False


def test_failed_startup_is_reset_then_retried_with_bounded_backoff() -> None:
    state = observe_map(NavLifecycleRecoveryState())
    state = complete_command(state, "startup", success=False, now_ms=1_000)
    assert state.reset_required is True
    assert state.next_attempt_ms == 1_000 + retry_delay_ms(1)

    state, command = command_after_health_check(
        state,
        transform_ready=True,
        manager_active=False,
        now_ms=state.next_attempt_ms - 1,
    )
    assert command is None
    state, command = command_after_health_check(
        state,
        transform_ready=True,
        manager_active=False,
        now_ms=state.next_attempt_ms,
    )
    assert command == "reset"

    state = complete_command(state, "reset", success=True, now_ms=2_000)
    state, command = command_after_health_check(
        state,
        transform_ready=True,
        manager_active=False,
        now_ms=state.next_attempt_ms,
    )
    assert command == "startup"


def test_active_health_clears_failures_and_an_active_drop_requires_reset() -> None:
    state = observe_map(NavLifecycleRecoveryState(failures=3, reset_required=True))
    state, command = command_after_health_check(
        state, transform_ready=True, manager_active=True, now_ms=10_000
    )
    assert command is None
    assert state.active is True
    assert state.failures == 0
    assert state.reset_required is False

    state, command = command_after_health_check(
        state, transform_ready=True, manager_active=False, now_ms=state.next_attempt_ms
    )
    assert command == "reset"
    assert state.active is False
    assert state.reset_required is True


def test_retry_backoff_is_capped() -> None:
    assert retry_delay_ms(1) == 500
    assert retry_delay_ms(99) == 5_000
