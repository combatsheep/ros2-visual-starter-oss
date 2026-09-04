from dataclasses import dataclass


@dataclass(frozen=True)
class SafetyConfig:
    stop_distance: float = 0.34
    resume_distance: float = 0.42
    front_angle_deg: float = 15.0
    scan_timeout_sec: float = 0.5
    command_timeout_sec: float = 0.5
    publish_rate_hz: float = 20.0
