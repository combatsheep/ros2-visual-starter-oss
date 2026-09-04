"""Safe filesystem operations for saved OccupancyGrid maps."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path


MAP_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$")
SELECTION_FILE = ".selected_map"
START_POSE_SUFFIX = ".start_pose.json"
DEFAULT_MAP_DIRECTORY = Path(".logs") / "default_map"
DEFAULT_MAP_NAME = "default"


@dataclass(frozen=True)
class SavedMap:
    name: str
    modified_ms: int


@dataclass(frozen=True)
class MapStartPose:
    x: float
    y: float
    yaw: float


def validate_map_name(name: str) -> str:
    value = name.strip()
    if not MAP_NAME_PATTERN.fullmatch(value):
        raise ValueError("地図名は英数字・ハイフン・アンダースコアの48文字以内で指定してください。")
    return value


def list_saved_maps(maps_dir: Path) -> list[SavedMap]:
    if not maps_dir.is_dir():
        return []
    maps = [SavedMap(path.stem, int(path.stat().st_mtime * 1000)) for path in maps_dir.glob("*.yaml") if MAP_NAME_PATTERN.fullmatch(path.stem)]
    return sorted(maps, key=lambda item: (-item.modified_ms, item.name))


def map_library_signature(maps_dir: Path) -> tuple[tuple[tuple[str, int], ...], str | None]:
    maps = list_saved_maps(maps_dir)
    return tuple((item.name, item.modified_ms) for item in maps), selected_map_name(maps_dir, maps)


def selected_map_name(maps_dir: Path, maps: list[SavedMap] | None = None) -> str | None:
    available = maps if maps is not None else list_saved_maps(maps_dir)
    available_names = {item.name for item in available}
    selection_path = maps_dir / SELECTION_FILE
    selected = selection_path.read_text(encoding="utf-8").strip() if selection_path.is_file() else ""
    if selected in available_names:
        return selected
    if "training_room" in available_names:
        return "training_room"
    return available[0].name if available else None


def select_saved_map(maps_dir: Path, name: str) -> str:
    selected = validate_map_name(name)
    if not (maps_dir / f"{selected}.yaml").is_file():
        raise FileNotFoundError(f"保存地図が見つかりません: {selected}")
    maps_dir.mkdir(parents=True, exist_ok=True)
    (maps_dir / SELECTION_FILE).write_text(f"{selected}\n", encoding="utf-8")
    return selected


def save_map_start_pose(maps_dir: Path, name: str, pose: dict) -> MapStartPose:
    target_name = validate_map_name(name)
    if not (maps_dir / f"{target_name}.yaml").is_file():
        raise FileNotFoundError(f"保存地図が見つかりません: {target_name}")
    try:
        start_pose = MapStartPose(float(pose["x"]), float(pose["y"]), float(pose["yaw"]))
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("地図の開始姿勢を読み取れません。") from error
    if not all(math.isfinite(value) and abs(value) <= 1000 for value in (start_pose.x, start_pose.y, start_pose.yaw)):
        raise ValueError("地図の開始姿勢が安全な範囲ではありません。")
    path = maps_dir / f"{target_name}{START_POSE_SUFFIX}"
    path.write_text(json.dumps({"x": start_pose.x, "y": start_pose.y, "yaw": start_pose.yaw}, ensure_ascii=False) + "\n", encoding="utf-8")
    return start_pose


def load_map_start_pose(map_path: Path) -> MapStartPose | None:
    pose_path = map_path.parent / f"{map_path.stem}{START_POSE_SUFFIX}"
    if not pose_path.is_file():
        return None
    try:
        payload = json.loads(pose_path.read_text(encoding="utf-8"))
        pose = MapStartPose(float(payload["x"]), float(payload["y"]), float(payload["yaw"]))
    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
        return None
    return pose if all(math.isfinite(value) and abs(value) <= 1000 for value in (pose.x, pose.y, pose.yaw)) else None


def _referenced_image(yaml_path: Path) -> Path | None:
    for line in yaml_path.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("image:"):
            value = line.split(":", 1)[1].strip().strip("'\"")
            candidate = (yaml_path.parent / value).resolve()
            try:
                candidate.relative_to(yaml_path.parent.resolve())
            except ValueError:
                return None
            return candidate
    return None


def delete_saved_map(maps_dir: Path, name: str) -> None:
    target_name = validate_map_name(name)
    yaml_path = maps_dir / f"{target_name}.yaml"
    if not yaml_path.is_file():
        raise FileNotFoundError(f"削除する地図が見つかりません: {target_name}")
    image_path = _referenced_image(yaml_path)
    yaml_path.unlink()
    if image_path and image_path.is_file():
        image_path.unlink()
    start_pose_path = maps_dir / f"{target_name}{START_POSE_SUFFIX}"
    if start_pose_path.is_file():
        start_pose_path.unlink()
    remaining = list_saved_maps(maps_dir)
    next_selected = selected_map_name(maps_dir, remaining)
    selection_path = maps_dir / SELECTION_FILE
    if next_selected:
        selection_path.write_text(f"{next_selected}\n", encoding="utf-8")
    elif selection_path.exists():
        selection_path.unlink()


def resolve_selected_map(maps_dir: Path) -> Path:
    selected = selected_map_name(maps_dir)
    if selected:
        return maps_dir / f"{selected}.yaml"
    return maps_dir.parent / DEFAULT_MAP_DIRECTORY / f"{DEFAULT_MAP_NAME}.yaml"
