import http.client
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from ros2_visual_backend.local_llm_client import LocalLlmClientError
from ros2_visual_backend.local_llm_contract import IntentCandidate, parse_intent_request
from ros2_visual_backend.optional_llm_server import OptionalLlmService, create_server


OPTIONAL_LLM_CASES = json.loads(
    (Path(__file__).parents[2] / "tests/fixtures/optional_llm_admission_cases.json").read_text(encoding="utf-8")
)


def payload(text: str = "この部屋のりんごを見つけに行ってくれる？") -> str:
    return json.dumps({
        "schema_version": 1,
        "request_id": 7,
        "generation": 3,
        "text": text,
        "requested_at_ms": 100,
    })


class FakeClient:
    def __init__(self, candidate: IntentCandidate | None = None, error: Exception | None = None) -> None:
        self.candidate = candidate or IntentCandidate("find_object", "apple", "")
        self.error = error
        self.calls: list[tuple[str, str]] = []

    def discover_model(self) -> str:
        self.calls.append(("models", ""))
        if self.error:
            raise self.error
        return "mock-model"

    def infer_intent(self, model_id: str, text: str) -> IntentCandidate:
        self.calls.append((model_id, text))
        if self.error:
            raise self.error
        return self.candidate


def test_default_configuration_is_disabled_and_does_not_contact_provider() -> None:
    with patch("ros2_visual_backend.optional_llm_server.LocalLlmClient") as client_factory:
        service = OptionalLlmService.from_environment({})
        client_factory.assert_not_called()
    assert service.status().state == "disabled"
    status_code, result = service.resolve(payload())
    assert status_code == 503
    assert result.status == "error"
    assert result.intent == "unsupported"


def test_disabled_service_never_uses_even_an_injected_client() -> None:
    client = FakeClient()
    service = OptionalLlmService(enabled=False, client=client, model_id="mock-model")  # type: ignore[arg-type]
    service.resolve(payload())
    assert client.calls == []


def test_enabled_configuration_rejects_remote_url_without_networking() -> None:
    service = OptionalLlmService.from_environment({
        "ROS2_VISUAL_LLM_ENABLED": "1",
        "ROS2_VISUAL_LLM_BASE_URL": "https://example.invalid/v1",
        "ROS2_VISUAL_LLM_MODEL": "mock-model",
    })
    assert service.status().state == "error"
    assert service.status().model_id == "mock-model"


def test_enabled_configuration_requires_explicit_model_without_provider_traffic() -> None:
    with patch("ros2_visual_backend.optional_llm_server.LocalLlmClient") as client_factory:
        service = OptionalLlmService.from_environment({"ROS2_VISUAL_LLM_ENABLED": "1"})
        client_factory.assert_not_called()
    assert service.status().state == "error"
    assert service.status().model_id == ""


def test_openai_compatible_loopback_mock_resolves_structured_intent() -> None:
    requests: list[str] = []
    token = "mock-token"

    class ProviderHandler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            return

        def _send(self, value: object) -> None:
            body = json.dumps(value).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            requests.append(self.path)
            self._send({"data": [{"id": "mock-model"}]})

        def do_POST(self):  # noqa: N802
            requests.append(self.path)
            assert self.headers.get("Authorization", "").endswith(token)
            length = int(self.headers["Content-Length"])
            request_body = json.loads(self.rfile.read(length))
            assert request_body["model"] == "mock-model"
            self._send({"choices": [{"message": {"content": json.dumps({
                "intent": "find_object",
                "target_class": "apple",
                "reason": "",
            })}}]})

    provider = ThreadingHTTPServer(("127.0.0.1", 0), ProviderHandler)
    thread = threading.Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    try:
        service = OptionalLlmService.from_environment({
            "ROS2_VISUAL_LLM_ENABLED": "1",
            "ROS2_VISUAL_LLM_BASE_URL": f"http://127.0.0.1:{provider.server_port}/v1",
            "ROS2_VISUAL_LLM_MODEL": "mock-model",
            "ROS2_VISUAL_LLM_TOKEN": token,
        })
        status_code, result = service.resolve(payload())
        assert status_code == 200
        assert result.status == "accepted"
        assert result.target_class == "apple"
        assert requests == ["/v1/models", "/v1/chat/completions"]
    finally:
        provider.shutdown()
        provider.server_close()
        thread.join(timeout=2)


def test_valid_result_keeps_request_identity_and_allowlisted_target() -> None:
    client = FakeClient()
    service = OptionalLlmService(enabled=True, client=client, model_id="mock-model")  # type: ignore[arg-type]
    status_code, result = service.resolve(payload())
    assert status_code == 200
    assert result.status == "accepted"
    assert result.request_id == 7
    assert result.generation == 3
    assert result.target_class == "apple"
    assert client.calls[0] == ("models", "")
    assert client.calls[1][0] == "mock-model"


def test_safe_unknown_cancel_phrase_can_only_propose_high_level_cancel() -> None:
    client = FakeClient(IntentCandidate("cancel_object_search", "none", ""))
    service = OptionalLlmService(enabled=True, client=client, model_id="mock-model")  # type: ignore[arg-type]
    status_code, result = service.resolve(payload("そろそろ終わりにしよう"))
    assert status_code == 200
    assert result.status == "accepted"
    assert result.intent == "cancel_object_search"
    assert result.target_class == "none"


def test_non_optional_rule_control_and_ambiguous_requests_never_reach_provider() -> None:
    rejected_payloads = [
        "not-json",
        *(payload(text) for text in OPTIONAL_LLM_CASES["ruleOnly"]),
        *(payload(text) for text in OPTIONAL_LLM_CASES["reject"]),
    ]
    for body in rejected_payloads:
        client = FakeClient()
        service = OptionalLlmService(enabled=True, client=client, model_id="mock-model")  # type: ignore[arg-type]
        status_code, result = service.resolve(body)
        assert status_code == 400
        assert result.status == "error"
        assert client.calls == []


def test_model_output_must_exactly_match_the_admitted_frame() -> None:
    cases = [
        ("この部屋のりんごを見つけに行ってくれる？", IntentCandidate("find_object", "dog", "")),
        ("この部屋のりんごを見つけに行ってくれる？", IntentCandidate("cancel_object_search", "none", "")),
        ("そろそろ終わりにしよう", IntentCandidate("find_object", "apple", "")),
    ]
    for text, proposed in cases:
        client = FakeClient(proposed)
        service = OptionalLlmService(enabled=True, client=client, model_id="mock-model")  # type: ignore[arg-type]
        status_code, result = service.resolve(payload(text))
        assert status_code == 200
        assert result.status == "error"
        assert result.intent == "unsupported"
        normalized_text = parse_intent_request(payload(text)).text
        assert client.calls == [("models", ""), ("mock-model", normalized_text)]


def test_invalid_model_output_and_timeout_fail_closed_without_fallback() -> None:
    unknown = FakeClient(IntentCandidate("find_object", "unknown-class", ""))  # type: ignore[arg-type]
    service = OptionalLlmService(enabled=True, client=unknown, model_id="mock-model")  # type: ignore[arg-type]
    _, result = service.resolve(payload())
    assert result.status == "error"
    assert result.intent == "unsupported"

    control_bearing = FakeClient(IntentCandidate("unsupported", "apple", ""))  # type: ignore[arg-type]
    service = OptionalLlmService(enabled=True, client=control_bearing, model_id="mock-model")  # type: ignore[arg-type]
    _, result = service.resolve(payload())
    assert result.status == "error"
    assert result.target_class == "none"

    timeout = FakeClient(error=LocalLlmClientError("Local LLM requestがtimeoutしました。"))
    service = OptionalLlmService(enabled=True, client=timeout, model_id="mock-model")  # type: ignore[arg-type]
    _, result = service.resolve(payload())
    assert result.status == "error"
    assert result.intent == "unsupported"
    assert service.status().state == "unavailable"


def test_http_sidecar_binds_loopback_and_exposes_bounded_json_endpoints() -> None:
    service = OptionalLlmService(enabled=False)
    server = create_server(service, port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        assert host == "127.0.0.1"
        connection = http.client.HTTPConnection(host, port, timeout=2)
        connection.request("GET", "/status")
        response = connection.getresponse()
        status = json.loads(response.read())
        assert response.status == 200
        assert status["state"] == "disabled"

        connection.request(
            "POST",
            "/intent",
            body=payload(),
            headers={"Content-Type": "application/json"},
        )
        response = connection.getresponse()
        result = json.loads(response.read())
        assert response.status == 503
        assert result["intent"] == "unsupported"
        connection.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
