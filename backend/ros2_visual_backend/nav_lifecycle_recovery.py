"""Pure recovery policy for deferred Nav2 lifecycle startup.

Online exploration receives its map and ``map -> odom`` transform from SLAM
Toolbox; together with Browser ``odom -> base_link`` that must form a usable
``map -> base_link`` transform.  Starting Nav2 before that evidence exists
makes the planner costmap wait for a transform and eventually leaves the
lifecycle stack half started.
This module keeps the retry policy independent from rclpy so its transitions
remain deterministic in unit tests.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Literal


LifecycleCommand = Literal["startup", "reset"]
ACTIVE_HEALTH_POLL_MS = 2_000


@dataclass(frozen=True)
class NavLifecycleRecoveryState:
    map_received: bool = False
    active: bool = False
    reset_required: bool = False
    failures: int = 0
    next_attempt_ms: int = 0


def valid_map_shape(width: int, height: int, data_length: int) -> bool:
    expected_cells = int(width) * int(height)
    return int(width) > 0 and int(height) > 0 and int(data_length) == expected_cells


def observe_map(state: NavLifecycleRecoveryState) -> NavLifecycleRecoveryState:
    return state if state.map_received else replace(state, map_received=True)


def retry_delay_ms(failures: int) -> int:
    """Return a short bounded backoff without making recovery feel hung."""
    bounded_failures = max(1, min(int(failures), 5))
    return min(5_000, 500 * (2 ** (bounded_failures - 1)))


def command_after_health_check(
    state: NavLifecycleRecoveryState,
    *,
    transform_ready: bool,
    manager_active: bool,
    now_ms: int,
) -> tuple[NavLifecycleRecoveryState, LifecycleCommand | None]:
    """Choose the next lifecycle command after querying manager health."""
    if manager_active:
        return replace(
            state,
            active=True,
            reset_required=False,
            failures=0,
            next_attempt_ms=now_ms + ACTIVE_HEALTH_POLL_MS,
        ), None

    next_state = state
    if state.active:
        # A stack that was active and later became inactive may contain a mix
        # of lifecycle states.  Normalize it before another startup attempt.
        next_state = replace(state, active=False, reset_required=True)
    if not next_state.map_received or not transform_ready or now_ms < next_state.next_attempt_ms:
        return next_state, None
    return next_state, "reset" if next_state.reset_required else "startup"


def complete_command(
    state: NavLifecycleRecoveryState,
    command: LifecycleCommand,
    *,
    success: bool,
    now_ms: int,
) -> NavLifecycleRecoveryState:
    """Record a lifecycle command result and prepare a safe retry if needed."""
    if command == "startup" and success:
        return replace(
            state,
            active=True,
            reset_required=False,
            failures=0,
            next_attempt_ms=now_ms + ACTIVE_HEALTH_POLL_MS,
        )

    failures = state.failures + (0 if command == "reset" and success else 1)
    failures = max(1, failures)
    return replace(
        state,
        active=False,
        # A failed/partial startup is reset before its next attempt.  After a
        # reset response, try startup next even if the reset reported false;
        # the manager can already be unconfigured in that case.
        reset_required=command == "startup",
        failures=failures,
        next_attempt_ms=now_ms + retry_delay_ms(failures),
    )
