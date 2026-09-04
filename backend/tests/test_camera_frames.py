import math

from ros2_visual_backend.launcher import CAMERA_MOUNT_ARGUMENTS, CAMERA_OPTICAL_ARGUMENTS


def _rotate_optical_to_camera(vector: tuple[float, float, float]) -> tuple[float, float, float]:
    """Apply Rz(-pi/2) * Rx(-pi/2), matching static_transform_publisher."""
    x, y, z = vector
    after_roll = (x, z, -y)
    return (after_roll[1], -after_roll[0], after_roll[2])


def test_camera_mount_matches_browser_pose() -> None:
    assert CAMERA_MOUNT_ARGUMENTS[:6] == ["--x", "0.25", "--y", "0", "--z", "0.18"]
    assert CAMERA_MOUNT_ARGUMENTS[-4:] == ["--frame-id", "base_link", "--child-frame-id", "camera_link"]


def test_optical_frame_uses_rep_103_axes() -> None:
    assert math.isclose(float(CAMERA_OPTICAL_ARGUMENTS[7]), -math.pi / 2, abs_tol=1e-10)
    assert math.isclose(float(CAMERA_OPTICAL_ARGUMENTS[11]), -math.pi / 2, abs_tol=1e-10)
    assert CAMERA_OPTICAL_ARGUMENTS[-2:] == ["--child-frame-id", "camera_rgb_optical_frame"]
    assert _rotate_optical_to_camera((0.0, 0.0, 1.0)) == (1.0, -0.0, -0.0)  # forward
    assert _rotate_optical_to_camera((1.0, 0.0, 0.0)) == (0.0, -1.0, -0.0)  # right
    assert _rotate_optical_to_camera((0.0, 1.0, 0.0)) == (0.0, -0.0, -1.0)  # down
