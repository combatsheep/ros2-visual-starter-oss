# SPDX-License-Identifier: Apache-2.0
# Copyright (c) Megvii, Inc. and its affiliates.
# Modifications Copyright (c) 2026 ROS2 Visual Starter contributors.

"""Lightweight allowlist shared by Local LLM intent and YOLOX inference.

Only classes that the checksum-verified, download-only COCO-trained YOLOX
weight can actually emit are listed here. Keeping this module free of
ONNX/numpy imports lets the intent
contract validate targets without loading the vision runtime.

The class_id sequence is adapted from YOLOX 0.3.0
yolox/data/datasets/coco_classes.py at commit
419778480ab6ec0590e5d3831b3afb3b46ab2aa3. Japanese display names, aliases,
normalization, matching, and prompt formatting are project modifications.
See docs/DEPENDENCY_LICENSE_AUDIT.md and LICENSES/Apache-2.0.txt.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass


@dataclass(frozen=True)
class ObjectSearchTarget:
    class_id: str
    display_name: str
    aliases: tuple[str, ...] = ()


OBJECT_SEARCH_TARGETS = (
    ObjectSearchTarget("person", "人", ("人物", "ひと")),
    ObjectSearchTarget("bicycle", "自転車", ("じてんしゃ",)),
    ObjectSearchTarget("car", "車", ("自動車", "くるま")),
    ObjectSearchTarget("motorcycle", "バイク", ("オートバイ", "二輪車")),
    ObjectSearchTarget("airplane", "飛行機", ("航空機",)),
    ObjectSearchTarget("bus", "バス"),
    ObjectSearchTarget("train", "電車", ("列車",)),
    ObjectSearchTarget("truck", "トラック"),
    ObjectSearchTarget("boat", "ボート", ("船",)),
    ObjectSearchTarget("traffic light", "信号機", ("信号",)),
    ObjectSearchTarget("fire hydrant", "消火栓"),
    ObjectSearchTarget("stop sign", "一時停止標識", ("停止標識",)),
    ObjectSearchTarget("parking meter", "パーキングメーター"),
    ObjectSearchTarget("bench", "ベンチ"),
    ObjectSearchTarget("bird", "鳥", ("とり",)),
    ObjectSearchTarget("cat", "猫", ("ねこ",)),
    ObjectSearchTarget("dog", "犬", ("いぬ",)),
    ObjectSearchTarget("horse", "馬", ("うま",)),
    ObjectSearchTarget("sheep", "羊", ("ひつじ",)),
    ObjectSearchTarget("cow", "牛", ("うし",)),
    ObjectSearchTarget("elephant", "象", ("ゾウ",)),
    ObjectSearchTarget("bear", "熊", ("クマ",)),
    ObjectSearchTarget("zebra", "シマウマ"),
    ObjectSearchTarget("giraffe", "キリン"),
    ObjectSearchTarget("backpack", "リュック", ("バックパック",)),
    ObjectSearchTarget("umbrella", "傘", ("かさ",)),
    ObjectSearchTarget("handbag", "ハンドバッグ", ("かばん", "バッグ")),
    ObjectSearchTarget("tie", "ネクタイ"),
    ObjectSearchTarget("suitcase", "スーツケース", ("旅行かばん",)),
    ObjectSearchTarget("frisbee", "フリスビー"),
    ObjectSearchTarget("skis", "スキー"),
    ObjectSearchTarget("snowboard", "スノーボード"),
    ObjectSearchTarget("sports ball", "ボール", ("スポーツボール",)),
    ObjectSearchTarget("kite", "凧", ("たこ",)),
    ObjectSearchTarget("baseball bat", "バット", ("野球バット",)),
    ObjectSearchTarget("baseball glove", "グローブ", ("野球グローブ",)),
    ObjectSearchTarget("skateboard", "スケートボード"),
    ObjectSearchTarget("surfboard", "サーフボード"),
    ObjectSearchTarget("tennis racket", "テニスラケット", ("ラケット",)),
    ObjectSearchTarget("bottle", "ボトル", ("瓶", "びん")),
    ObjectSearchTarget("wine glass", "ワイングラス"),
    ObjectSearchTarget("cup", "カップ", ("コップ",)),
    ObjectSearchTarget("fork", "フォーク"),
    ObjectSearchTarget("knife", "ナイフ", ("包丁",)),
    ObjectSearchTarget("spoon", "スプーン"),
    ObjectSearchTarget("bowl", "ボウル", ("器",)),
    ObjectSearchTarget("banana", "バナナ"),
    ObjectSearchTarget("apple", "りんご", ("リンゴ", "林檎")),
    ObjectSearchTarget("sandwich", "サンドイッチ"),
    ObjectSearchTarget("orange", "オレンジ", ("みかん",)),
    ObjectSearchTarget("broccoli", "ブロッコリー"),
    ObjectSearchTarget("carrot", "にんじん", ("人参",)),
    ObjectSearchTarget("hot dog", "ホットドッグ"),
    ObjectSearchTarget("pizza", "ピザ"),
    ObjectSearchTarget("donut", "ドーナツ", ("ドーナッツ",)),
    ObjectSearchTarget("cake", "ケーキ"),
    ObjectSearchTarget("chair", "椅子", ("いす", "イス")),
    ObjectSearchTarget("couch", "ソファ", ("ソファー",)),
    ObjectSearchTarget("potted plant", "観葉植物", ("鉢植え",)),
    ObjectSearchTarget("bed", "ベッド"),
    ObjectSearchTarget("dining table", "テーブル", ("食卓",)),
    ObjectSearchTarget("toilet", "トイレ", ("便器",)),
    ObjectSearchTarget("tv", "テレビ", ("テレビジョン",)),
    ObjectSearchTarget("laptop", "ノートパソコン", ("ラップトップ",)),
    ObjectSearchTarget("mouse", "マウス"),
    ObjectSearchTarget("remote", "リモコン", ("リモートコントローラー",)),
    ObjectSearchTarget("keyboard", "キーボード"),
    ObjectSearchTarget("cell phone", "携帯電話", ("スマホ", "スマートフォン")),
    ObjectSearchTarget("microwave", "電子レンジ", ("レンジ",)),
    ObjectSearchTarget("oven", "オーブン"),
    ObjectSearchTarget("toaster", "トースター"),
    ObjectSearchTarget("sink", "シンク", ("流し台",)),
    ObjectSearchTarget("refrigerator", "冷蔵庫", ("冷蔵器",)),
    ObjectSearchTarget("book", "本", ("書籍",)),
    ObjectSearchTarget("clock", "時計"),
    ObjectSearchTarget("vase", "花瓶"),
    ObjectSearchTarget("scissors", "はさみ", ("ハサミ",)),
    ObjectSearchTarget("teddy bear", "テディベア", ("ぬいぐるみ",)),
    ObjectSearchTarget("hair drier", "ドライヤー", ("ヘアドライヤー",)),
    ObjectSearchTarget("toothbrush", "歯ブラシ"),
)

COCO_CLASSES = tuple(target.class_id for target in OBJECT_SEARCH_TARGETS)
TARGET_BY_CLASS = {target.class_id: target for target in OBJECT_SEARCH_TARGETS}


def _target_identifiers() -> dict[str, str]:
    identifiers: dict[str, str] = {}
    ambiguous: set[str] = set()
    for target in OBJECT_SEARCH_TARGETS:
        for value in (target.class_id, target.display_name, *target.aliases):
            normalized = normalize_target_text(value)
            previous = identifiers.get(normalized)
            if previous is not None and previous != target.class_id:
                ambiguous.add(normalized)
                continue
            identifiers[normalized] = target.class_id
    for normalized in ambiguous:
        identifiers.pop(normalized, None)
    return identifiers


def normalize_target_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).strip().lower().split())


TARGET_CLASS_BY_IDENTIFIER = _target_identifiers()


def canonical_target_class(value: str) -> str | None:
    """Resolve one exact detector class, display name, or alias without guessing."""
    return TARGET_CLASS_BY_IDENTIFIER.get(normalize_target_text(value))


def _alias_pattern(alias: str) -> re.Pattern[str]:
    normalized = normalize_target_text(alias)
    escaped = re.escape(normalized)
    if re.fullmatch(r"[a-z0-9 -]+", normalized):
        return re.compile(rf"(?<![a-z0-9]){escaped}(?![a-z0-9])", re.IGNORECASE)
    # Japanese has no generic word boundary. Requiring a following particle,
    # punctuation, whitespace, or end-of-input prevents compounds such as 人気,
    # 車輪, and 本棚 from being treated as person, car, and book.
    return re.compile(rf"{escaped}(?=$|[\s、。,.!?！？をがはもとにへで]|の(?:場所|居場所|位置))", re.IGNORECASE)


_TARGET_PATTERNS = tuple(
    (
        target,
        tuple(
            _alias_pattern(alias)
            for alias in dict.fromkeys((target.class_id, target.display_name, *target.aliases))
        ),
    )
    for target in OBJECT_SEARCH_TARGETS
)


def matched_target_classes(value: str) -> tuple[str, ...]:
    """Return non-overlapping explicit targets, preferring the longest token."""
    normalized = normalize_target_text(value)
    matches: list[tuple[int, int, str]] = []
    for target, patterns in _TARGET_PATTERNS:
        for pattern in patterns:
            matches.extend((match.start(), match.end(), target.class_id) for match in pattern.finditer(normalized))
    selected: list[tuple[int, int, str]] = []
    for start, end, class_id in sorted(matches, key=lambda item: (item[0], -(item[1] - item[0]))):
        if any(start < chosen_end and end > chosen_start for chosen_start, chosen_end, _ in selected):
            continue
        selected.append((start, end, class_id))
    return tuple(dict.fromkeys(class_id for _, _, class_id in selected))


def target_display_name(class_id: str) -> str:
    target = TARGET_BY_CLASS.get(class_id)
    return target.display_name if target else ""


def target_catalog_for_prompt() -> str:
    return ", ".join(f'{target.class_id}={target.display_name}' for target in OBJECT_SEARCH_TARGETS)
