from dataclasses import dataclass


@dataclass(frozen=True)
class SafetyConfig:
    stop_distance: float = 0.30
    resume_distance: float = 0.38
    front_angle_deg: float = 15.0
    scan_timeout_sec: float = 0.5
    command_timeout_sec: float = 0.5
    publish_rate_hz: float = 20.0
