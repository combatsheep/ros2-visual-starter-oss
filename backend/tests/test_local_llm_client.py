import json
import inspect
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError

import pytest

from ros2_visual_backend.local_llm_client import (
    _direct_opener,
    LocalLlmClient,
    LocalLlmClientConfig,
    LocalLlmClientError,
    LocalLlmOutputError,
    validate_loopback_base_url,
)


MODEL_ID = "mock-model"


class FakeResponse:
    def __init__(self, payload: object) -> None:
        self.payload = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self, _limit: int) -> bytes:
        return self.payload


class SequenceOpener:
    def __init__(self, *items: object) -> None:
        self.items = list(items)
        self.requests = []

    def __call__(self, request, *, timeout: float):
        self.requests.append((request, timeout))
        item = self.items.pop(0)
        if isinstance(item, BaseException):
            raise item
        return FakeResponse(item)


def config(**changes) -> LocalLlmClientConfig:
    values = {"configured_model": MODEL_ID, **changes}
    return LocalLlmClientConfig(**values)


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:1234/v1",
        "http://localhost:1234/v1/",
        "http://[::1]:1234/v1",
    ],
)
def test_loopback_urls_are_allowed(url: str) -> None:
    assert validate_loopback_base_url(url).endswith("/v1")


@pytest.mark.parametrize(
    "url",
    [
        "https://example.invalid/v1",
        "file:///tmp/v1",
        "http://user@localhost:1234/v1",
        "http://@localhost:1234/v1",
        "http://:@localhost:1234/v1",
        "http://localhost:1234/v1?value=redacted",
        "http://localhost:1234/v1?",
        "http://localhost:1234/v1#fragment",
        "http://localhost:1234/v1#",
        "http://localhost:1234/v1;parameter",
        "http://localhost:1234/v1;",
        "http://localhost:1234/not-v1",
    ],
)
def test_remote_credential_bearing_and_non_api_urls_are_rejected(url: str) -> None:
    with pytest.raises(LocalLlmClientError):
        validate_loopback_base_url(url)


def test_static_non_loopback_ip_is_rejected() -> None:
    address = ".".join(("192", "0", "2", "1"))
    with pytest.raises(LocalLlmClientError):
        validate_loopback_base_url(f"http://{address}:1234/v1")


def test_model_identifier_is_required_and_never_auto_selected() -> None:
    with pytest.raises(LocalLlmClientError, match="model id"):
        LocalLlmClient(LocalLlmClientConfig())


def test_header_control_characters_are_rejected_without_reflection() -> None:
    with pytest.raises(LocalLlmClientError) as raised:
        LocalLlmClient(config(token="line-one\nline-two"))
    assert "line-one" not in str(raised.value)


def test_configured_model_must_match_actual_identifier_exactly() -> None:
    opener = SequenceOpener({"data": [{"id": MODEL_ID}, {"id": "another-model"}]})
    client = LocalLlmClient(config(), opener)
    assert client.discover_model() == MODEL_ID

    missing = LocalLlmClient(config(), SequenceOpener({"data": [{"id": "another-model"}]}))
    with pytest.raises(LocalLlmClientError, match="model id"):
        missing.discover_model()


def test_client_construction_does_not_probe_or_infer() -> None:
    opener = SequenceOpener({"data": [{"id": MODEL_ID}]})
    LocalLlmClient(config(), opener)
    assert opener.requests == []


def test_structured_inference_uses_schema_without_sdk_or_streaming() -> None:
    token = "unit-test-token"
    opener = SequenceOpener(
        {"choices": [{"message": {"content": json.dumps({
            "intent": "find_object",
            "target_class": "apple",
            "reason": "",
        })}}]},
    )
    client = LocalLlmClient(config(token=token), opener)
    result = client.infer_intent(MODEL_ID, "りんごを見つけに行ってくれる？")
    assert result.intent == "find_object"
    request, timeout = opener.requests[0]
    body = json.loads(request.data)
    assert body["response_format"]["type"] == "json_schema"
    assert body["response_format"]["json_schema"]["strict"] is True
    assert body["stream"] is False
    assert body["temperature"] == 0
    assert timeout == client.inference_timeout_seconds
    assert request.get_header("Authorization").endswith(token)


@pytest.mark.parametrize(
    "error",
    [
        TimeoutError(),
        URLError("offline"),
        HTTPError("http://localhost", 500, "bad", {}, None),
    ],
)
def test_http_failures_are_redacted(error: BaseException) -> None:
    token = "do-not-reflect"
    prompt = "this prompt must not be reflected"
    client = LocalLlmClient(config(token=token), SequenceOpener(error))
    with pytest.raises(LocalLlmClientError) as raised:
        client.infer_intent(MODEL_ID, prompt)
    assert token not in str(raised.value)
    assert prompt not in str(raised.value)


def test_malformed_huge_and_invalid_structured_content_fail_closed() -> None:
    class BrokenResponse(FakeResponse):
        def read(self, _limit: int) -> bytes:
            return b"not-json"

    malformed = LocalLlmClient(config(), lambda *_args, **_kwargs: BrokenResponse({}))
    with pytest.raises(LocalLlmClientError):
        malformed.discover_model()

    class HugeResponse(FakeResponse):
        def read(self, _limit: int) -> bytes:
            return b"x" * 70_000

    huge = LocalLlmClient(config(), lambda *_args, **_kwargs: HugeResponse({}))
    with pytest.raises(LocalLlmClientError, match="上限"):
        huge.discover_model()

    invalid = SequenceOpener({"choices": [{"message": {"content": "plain text fallback"}}]})
    client = LocalLlmClient(config(), invalid)
    with pytest.raises(LocalLlmOutputError):
        client.infer_intent(MODEL_ID, "りんごを見つけに行ってくれる？")


def test_drip_response_cannot_extend_the_total_wall_clock_deadline() -> None:
    class DripResponse(FakeResponse):
        def __init__(self) -> None:
            super().__init__({"data": [{"id": MODEL_ID}]})
            self.offset = 0

        def read1(self, limit: int) -> bytes:
            time.sleep(0.015)
            if self.offset >= len(self.payload):
                return b""
            chunk = self.payload[self.offset:self.offset + min(limit, 1)]
            self.offset += len(chunk)
            return chunk

    client = LocalLlmClient(
        config(health_timeout_seconds=0.05),
        lambda *_args, **_kwargs: DripResponse(),
    )
    started = time.monotonic()
    with pytest.raises(LocalLlmClientError, match="timeout"):
        client.discover_model()
    assert time.monotonic() - started < 0.25


def test_default_network_opener_rejects_redirects() -> None:
    target_hits: list[str] = []

    class RedirectHandler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            return

        def do_GET(self):  # noqa: N802
            if self.path == "/v1/models":
                self.send_response(302)
                self.send_header("Location", "/redirect-target")
                self.end_headers()
                return
            target_hits.append(self.path)
            body = json.dumps({"data": [{"id": MODEL_ID}]}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = LocalLlmClient(config(base_url=f"http://127.0.0.1:{server.server_port}/v1"))
        with pytest.raises(LocalLlmClientError, match="redirect"):
            client.discover_model()
        assert target_hits == []
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_default_network_opener_disables_environment_proxies() -> None:
    source = inspect.getsource(_direct_opener)
    assert "ProxyHandler({})" in source
