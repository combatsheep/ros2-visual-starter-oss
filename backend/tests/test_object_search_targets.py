from ros2_visual_backend.object_search_targets import (
    COCO_CLASSES,
    canonical_target_class,
    matched_target_classes,
    target_display_name,
)
from ros2_visual_backend.yolox_runtime import COCO_CLASSES as YOLOX_COCO_CLASSES


def test_intent_and_yolox_share_the_same_80_class_allowlist() -> None:
    assert len(COCO_CLASSES) == 80
    assert COCO_CLASSES == YOLOX_COCO_CLASSES
    assert "banana" in COCO_CLASSES
    assert "apple" in COCO_CLASSES


def test_japanese_and_english_aliases_resolve_to_detector_classes() -> None:
    assert matched_target_classes("バナナを探して") == ("banana",)
    assert matched_target_classes("犬を探して") == ("dog",)
    assert matched_target_classes("find a banana") == ("banana",)
    assert target_display_name("chair") == "椅子"
    assert canonical_target_class("dog") == "dog"
    assert canonical_target_class("犬") == "dog"
    assert canonical_target_class("キュウリ") is None


def test_longest_non_overlapping_alias_avoids_substring_target_confusion() -> None:
    assert matched_target_classes("自転車を探して") == ("bicycle",)
    assert matched_target_classes("carrotを探して") == ("carrot",)
    assert matched_target_classes("犬と猫を探して") == ("dog", "cat")


def test_unsupported_japanese_compounds_do_not_match_shorter_coco_aliases() -> None:
    for text in ("人気スポットを探して", "車輪を探して", "本棚を探して", "人形を探して", "たこ焼きを探して"):
        assert matched_target_classes(text) == ()
