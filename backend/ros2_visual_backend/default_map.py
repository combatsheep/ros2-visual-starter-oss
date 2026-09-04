"""Generate the immutable fallback map for the default Medium stage."""

from __future__ import annotations

import json
import math
from pathlib import Path


DEFAULT_MAP_NAME = "default"
DEFAULT_MAP_DIRECTORY = Path(".logs") / "default_map"
DEFAULT_MAP_RESOLUTION = 0.05
DEFAULT_MAP_CELLS = 160
DEFAULT_MAP_ORIGIN = -4.0
DEFAULT_MAP_SIZE = 8.0
DEFAULT_START_POSE = {"x": -2.65, "y": 0.0, "yaw": 0.0}

# The footprint rectangles are copied from DEFAULT_PLAYGROUND's Medium stage.
# Coordinates are Three.js x/z; the renderer's ROS frame is x=-z, y=-x.
DEFAULT_STAGE_OBJECTS = (
    (0.0, -4.0, 0.0, 8.0, 0.18),
    (0.0, 4.0, 0.0, 8.0, 0.18),
    (-4.0, 0.0, math.pi / 2, 8.0, 0.18),
    (4.0, 0.0, math.pi / 2, 8.0, 0.18),
    (0.0, -0.35, 0.0, 1.15, 0.90),
    (-1.75, -1.80, 0.0, 1.25, 0.70),
    (1.75, -1.65, 0.0, 0.80, 1.35),
    (-2.38, 1.15, 0.0, 0.95, 0.12),
    (0.0, 1.15, 0.0, 1.60, 0.05),
)


def default_map_path(root: Path) -> Path:
    return root / DEFAULT_MAP_DIRECTORY / f"{DEFAULT_MAP_NAME}.yaml"


def _occupied(world_x: float, world_y: float) -> bool:
    stage_x = -world_y
    stage_z = -world_x
    for object_x, object_z, rotation, width, depth in DEFAULT_STAGE_OBJECTS:
        delta_x = stage_x - object_x
        delta_z = stage_z - object_z
        cosine = math.cos(rotation)
        sine = math.sin(rotation)
        local_x = cosine * delta_x - sine * delta_z
        local_z = sine * delta_x + cosine * delta_z
        if abs(local_x) <= width / 2 and abs(local_z) <= depth / 2:
            return True
    return False


def _render_pgm() -> bytes:
    pixels = bytearray([254]) * (DEFAULT_MAP_CELLS * DEFAULT_MAP_CELLS)
    for cell_y in range(DEFAULT_MAP_CELLS):
        world_y = DEFAULT_MAP_ORIGIN + (cell_y + 0.5) * DEFAULT_MAP_RESOLUTION
        image_row = DEFAULT_MAP_CELLS - 1 - cell_y
        for cell_x in range(DEFAULT_MAP_CELLS):
            world_x = DEFAULT_MAP_ORIGIN + (cell_x + 0.5) * DEFAULT_MAP_RESOLUTION
            if _occupied(world_x, world_y):
                pixels[image_row * DEFAULT_MAP_CELLS + cell_x] = 0
    header = f"P5\n{DEFAULT_MAP_CELLS} {DEFAULT_MAP_CELLS}\n255\n".encode("ascii")
    return header + pixels


def ensure_default_map(root: Path) -> Path:
    """Create the fallback map and return its YAML path."""
    map_directory = root / DEFAULT_MAP_DIRECTORY
    map_directory.mkdir(parents=True, exist_ok=True)
    map_path = default_map_path(root)
    map_path.with_name(f"{DEFAULT_MAP_NAME}.pgm").write_bytes(_render_pgm())
    map_path.write_text(
        "image: default.pgm\n"
        "mode: trinary\n"
        "resolution: 0.050\n"
        "origin: [-4.000, -4.000, 0]\n"
        "negate: 0\n"
        "occupied_thresh: 0.65\n"
        "free_thresh: 0.196\n",
        encoding="utf-8",
    )
    map_path.with_name(f"{DEFAULT_MAP_NAME}.start_pose.json").write_text(
        json.dumps(DEFAULT_START_POSE, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return map_path
