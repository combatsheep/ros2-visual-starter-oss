from pathlib import Path

import pytest

from ros2_visual_backend.map_library import (
    delete_saved_map,
    list_saved_maps,
    load_map_start_pose,
    map_library_signature,
    resolve_selected_map,
    save_map_start_pose,
    select_saved_map,
    selected_map_name,
    validate_map_name,
)


def write_map(maps_dir: Path, name: str) -> None:
    maps_dir.mkdir(parents=True, exist_ok=True)
    (maps_dir / f"{name}.pgm").write_bytes(b"P5\n1 1\n255\n\x00")
    (maps_dir / f"{name}.yaml").write_text(f"image: {name}.pgm\nresolution: 0.05\n", encoding="utf-8")


def test_lists_selects_and_resolves_maps(tmp_path: Path) -> None:
    write_map(tmp_path, "training_room")
    write_map(tmp_path, "office_01")
    assert {item.name for item in list_saved_maps(tmp_path)} == {"training_room", "office_01"}
    assert selected_map_name(tmp_path) == "training_room"
    assert select_saved_map(tmp_path, "office_01") == "office_01"
    assert resolve_selected_map(tmp_path) == tmp_path / "office_01.yaml"


def test_resolves_default_map_when_no_saved_map_exists(tmp_path: Path) -> None:
    assert resolve_selected_map(tmp_path) == tmp_path.parent / ".logs/default_map/default.yaml"


def test_delete_removes_yaml_and_referenced_image(tmp_path: Path) -> None:
    write_map(tmp_path, "training_room")
    write_map(tmp_path, "office_01")
    select_saved_map(tmp_path, "office_01")
    save_map_start_pose(tmp_path, "office_01", {"x": 1.2, "y": -0.4, "yaw": 0.3})
    delete_saved_map(tmp_path, "office_01")
    assert not (tmp_path / "office_01.yaml").exists()
    assert not (tmp_path / "office_01.pgm").exists()
    assert not (tmp_path / "office_01.start_pose.json").exists()
    assert selected_map_name(tmp_path) == "training_room"


def test_saves_and_loads_map_start_pose(tmp_path: Path) -> None:
    write_map(tmp_path, "training_room")
    saved = save_map_start_pose(tmp_path, "training_room", {"x": -2.1, "y": 0.7, "yaw": -0.4})
    loaded = load_map_start_pose(tmp_path / "training_room.yaml")
    assert saved == loaded
    assert loaded is not None
    assert (loaded.x, loaded.y, loaded.yaw) == (-2.1, 0.7, -0.4)


def test_library_signature_changes_when_map_is_added(tmp_path: Path) -> None:
    write_map(tmp_path, "training_room")
    before = map_library_signature(tmp_path)
    write_map(tmp_path, "new_room")
    after = map_library_signature(tmp_path)
    assert after != before
    assert {name for name, _modified_ms in after[0]} == {"training_room", "new_room"}


def test_ignores_invalid_map_start_pose(tmp_path: Path) -> None:
    write_map(tmp_path, "training_room")
    (tmp_path / "training_room.start_pose.json").write_text('{"x": "broken"}', encoding="utf-8")
    assert load_map_start_pose(tmp_path / "training_room.yaml") is None


@pytest.mark.parametrize("name", ["../outside", "bad name", "", "a" * 49])
def test_rejects_unsafe_map_names(name: str) -> None:
    with pytest.raises(ValueError):
        validate_map_name(name)
