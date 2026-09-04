from ros2_visual_backend.local_llm_contract import IntentCandidate
from ros2_visual_backend.local_llm_client import LocalLlmClientError
from ros2_visual_backend.local_llm_smoke import classify


class FakeClient:
    def __init__(self, candidate: IntentCandidate) -> None:
        self.candidate = candidate

    def infer_intent(self, _model_id: str, _text: str) -> IntentCandidate:
        return self.candidate


class FailingClient:
    def infer_intent(self, _model_id: str, _text: str) -> IntentCandidate:
        raise LocalLlmClientError("schema違反")


def test_positive_smoke_case_requires_validated_apple_intent() -> None:
    status, report = classify(
        FakeClient(IntentCandidate("find_object", "apple", "")),  # type: ignore[arg-type]
        "mock-model",
        "りんごを見つけに行ってくれる？",
        1,
    )
    assert status == "accepted"
    assert report["intent"] == "find_object"


def test_positive_smoke_case_accepts_validated_banana_intent() -> None:
    status, report = classify(
        FakeClient(IntentCandidate("find_object", "banana", "")),  # type: ignore[arg-type]
        "mock-model",
        "この部屋のバナナはどこかな？",
        2,
    )
    assert status == "accepted"
    assert report["target_class"] == "banana"


def test_negative_smoke_case_accepts_deterministic_validator_block() -> None:
    status, report = classify(
        FakeClient(IntentCandidate("find_object", "apple", "")),  # type: ignore[arg-type]
        "mock-model",
        "1m前進して",
        2,
    )
    assert status == "blocked_by_validator"
    assert report["reason"]


def test_smoke_case_records_fail_closed_contract_error() -> None:
    status, report = classify(
        FailingClient(),  # type: ignore[arg-type]
        "mock-model",
        "バナナはどこかな？",
        3,
    )
    assert status == "blocked_by_contract"
    assert report["reason"] == "schema違反"
