import json
from pathlib import Path

from ros2_visual_backend.default_map import DEFAULT_MAP_CELLS, DEFAULT_START_POSE, ensure_default_map


def test_generates_medium_default_map(tmp_path: Path) -> None:
    map_path = ensure_default_map(tmp_path)
    assert map_path == tmp_path / ".logs/default_map/default.yaml"
    assert map_path.read_text(encoding="utf-8").startswith("image: default.pgm\n")
    assert json.loads(map_path.with_name("default.start_pose.json").read_text(encoding="utf-8")) == DEFAULT_START_POSE

    pgm = map_path.with_name("default.pgm").read_bytes()
    header = f"P5\n{DEFAULT_MAP_CELLS} {DEFAULT_MAP_CELLS}\n255\n".encode("ascii")
    assert pgm.startswith(header)
    pixels = pgm[len(header):]
    assert len(pixels) == DEFAULT_MAP_CELLS * DEFAULT_MAP_CELLS
    assert 0 in pixels
    assert 254 in pixels
