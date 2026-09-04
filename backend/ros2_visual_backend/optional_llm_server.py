"""Loopback HTTP sidecar for the optional, provider-neutral Local LLM.

The browser never receives provider credentials or a provider URL.  It talks to
Vite on the existing origin, and Vite forwards only ``/api/llm/*`` to this
loopback-only process.  This module has no ROS imports and is available in SIM.
"""

from __future__ import annotations

import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Mapping
from urllib.parse import urlsplit

from .local_llm_client import (
    DEFAULT_BASE_URL,
    LocalLlmClient,
    LocalLlmClientConfig,
    LocalLlmClientError,
    LocalLlmOutputError,
)
from .local_llm_contract import (
    MODEL_LABEL,
    PROVIDER,
    SCHEMA_VERSION,
    IntentRequest,
    IntentResult,
    LocalLlmContractError,
    LocalLlmStatus,
    make_error_result,
    make_intent_result,
    parse_intent_request,
    request_identity_or_zero,
    validate_optional_llm_request_text,
)


SIDECAR_HOST = "127.0.0.1"
SIDECAR_PORT = 27_184
MAX_REQUEST_BYTES = 4_096


def _failure_state(error: LocalLlmClientError) -> tuple[str, str]:
    if isinstance(error, LocalLlmOutputError):
        return "ready", ""
    reason = str(error)
    state = "unavailable" if any(
        marker in reason for marker in ("接続", "timeout", "HTTP", "model", "redirect")
    ) else "error"
    return state, reason


def resolve_intent_request(
    payload: str,
    client: LocalLlmClient,
    model_id: str,
    *,
    resolved_at_ms: int,
    latency_ms: float,
) -> IntentResult:
    """Resolve one request without HTTP side effects; kept small for tests."""
    request = parse_intent_request(payload)
    validate_optional_llm_request_text(request.text)
    candidate = client.infer_intent(model_id, request.text)
    return make_intent_result(
        request,
        candidate,
        model_id=model_id,
        latency_ms=latency_ms,
        resolved_at_ms=resolved_at_ms,
    )


class OptionalLlmService:
    """Own configuration and serialize at most one provider request at a time."""

    def __init__(
        self,
        *,
        enabled: bool,
        client: LocalLlmClient | None = None,
        model_id: str = "",
        configuration_error: str = "",
    ) -> None:
        self.enabled = enabled
        self._client = client
        self._model_id = model_id
        self._state = "disabled" if not enabled else "ready"
        self._error = ""
        if configuration_error:
            self._state = "error"
            self._error = configuration_error[:240]
        elif enabled and (client is None or not model_id):
            self._state = "error"
            self._error = "Local LLM設定が不完全です。"
        self._last_latency_ms = 0.0
        self._busy = False
        self._state_lock = threading.RLock()
        self._inference_lock = threading.Lock()

    @classmethod
    def from_environment(cls, environment: Mapping[str, str] | None = None) -> "OptionalLlmService":
        env = os.environ if environment is None else environment
        enabled_value = env.get("ROS2_VISUAL_LLM_ENABLED", "0").strip()
        if enabled_value not in {"0", "1"}:
            return cls(enabled=True, configuration_error="ROS2_VISUAL_LLM_ENABLEDは0または1で指定してください。")
        if enabled_value == "0":
            # Critical default-off boundary: do not even construct the provider
            # client, because construction is the first step toward networking.
            return cls(enabled=False)
        token = env.get("ROS2_VISUAL_LLM_TOKEN", "")
        if len(token) > 4_096:
            return cls(enabled=True, configuration_error="Local LLM tokenが長すぎます。")
        model_id = env.get("ROS2_VISUAL_LLM_MODEL", "").strip()
        if not model_id or len(model_id) > 300:
            return cls(enabled=True, configuration_error="Local LLMを有効にするにはmodel idを明示してください。")
        try:
            client = LocalLlmClient(LocalLlmClientConfig(
                base_url=env.get("ROS2_VISUAL_LLM_BASE_URL", DEFAULT_BASE_URL),
                configured_model=model_id,
                token=token,
            ))
        except LocalLlmClientError as error:
            return cls(enabled=True, model_id=model_id, configuration_error=str(error))
        return cls(enabled=True, client=client, model_id=model_id)

    def status(self) -> LocalLlmStatus:
        with self._state_lock:
            return LocalLlmStatus(
                schema_version=SCHEMA_VERSION,
                state=self._state,  # type: ignore[arg-type]
                provider=PROVIDER,
                model_label=MODEL_LABEL,
                model_id=self._model_id if self.enabled else "",
                busy=self._busy,
                last_latency_ms=round(self._last_latency_ms, 3),
                error=self._error,
            )

    def resolve(self, payload: str) -> tuple[int, IntentResult]:
        request_id, generation = request_identity_or_zero(payload)
        resolved_at_ms = int(time.time() * 1_000)
        try:
            request = parse_intent_request(payload)
            # Run deterministic safety gates before acquiring the provider lock
            # and, importantly, before any provider communication.
            validate_optional_llm_request_text(request.text)
        except LocalLlmContractError as error:
            return 400, make_error_result(
                request_id,
                generation,
                str(error),
                resolved_at_ms=resolved_at_ms,
            )
        with self._state_lock:
            if not self.enabled:
                return 503, make_error_result(
                    request.request_id,
                    request.generation,
                    "Optional Local LLMは無効です。rule-based parserだけを使用します。",
                    resolved_at_ms=resolved_at_ms,
                )
            if self._client is None or self._state == "error":
                return 503, make_error_result(
                    request.request_id,
                    request.generation,
                    self._error or "Local LLM設定が不完全です。",
                    model_id=self._model_id,
                    resolved_at_ms=resolved_at_ms,
                )
        if not self._inference_lock.acquire(blocking=False):
            return 409, make_error_result(
                request.request_id,
                request.generation,
                "Local LLMは別のrequestを処理中です。",
                model_id=self._model_id,
                resolved_at_ms=resolved_at_ms,
            )
        with self._state_lock:
            self._busy = True
            self._error = ""
        started = time.perf_counter()
        try:
            assert self._client is not None
            model_id = self._client.discover_model()
            candidate = self._client.infer_intent(model_id, request.text)
            latency_ms = (time.perf_counter() - started) * 1_000
            result = make_intent_result(
                request,
                candidate,
                model_id=model_id,
                latency_ms=latency_ms,
                resolved_at_ms=int(time.time() * 1_000),
            )
        except LocalLlmContractError as error:
            result = make_error_result(
                request.request_id,
                request.generation,
                str(error),
                model_id=self._model_id,
                resolved_at_ms=int(time.time() * 1_000),
            )
        except LocalLlmClientError as error:
            result = make_error_result(
                request.request_id,
                request.generation,
                str(error),
                model_id=self._model_id,
                resolved_at_ms=int(time.time() * 1_000),
            )
            with self._state_lock:
                self._state, self._error = _failure_state(error)
        except Exception:
            result = make_error_result(
                request.request_id,
                request.generation,
                "Local LLM inferenceで予期しないエラーが発生しました。",
                model_id=self._model_id,
                resolved_at_ms=int(time.time() * 1_000),
            )
            with self._state_lock:
                self._state = "error"
                self._error = result.reason
        else:
            with self._state_lock:
                self._state = "ready"
                self._last_latency_ms = result.latency_ms
                self._error = ""
        finally:
            with self._state_lock:
                self._busy = False
            self._inference_lock.release()
        return 200, result


class _OptionalLlmHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], service: OptionalLlmService) -> None:
        self.service = service
        super().__init__(address, OptionalLlmRequestHandler)


class OptionalLlmRequestHandler(BaseHTTPRequestHandler):
    server: _OptionalLlmHttpServer
    server_version = "ROS2VisualOptionalLlm/1"

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(5.0)

    def log_message(self, _format: str, *_args: object) -> None:
        # Request bodies can contain user prompts. Never place them in logs.
        return

    def _send_json(self, status_code: int, payload: str) -> None:
        encoded = payload.encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(encoded)

    def _path(self) -> str:
        parsed = urlsplit(self.path)
        return parsed.path if not parsed.query and not parsed.fragment else ""

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self._path() != "/status":
            self._send_json(404, '{"error":"Not found"}')
            return
        self._send_json(200, self.server.service.status().to_json())

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self._path() != "/intent":
            self._send_json(404, '{"error":"Not found"}')
            return
        if self.headers.get_content_type() != "application/json":
            self._send_json(415, '{"error":"Content-Type must be application/json"}')
            return
        try:
            content_length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            content_length = -1
        if content_length < 0 or content_length > MAX_REQUEST_BYTES:
            self._send_json(413, '{"error":"Request body is invalid"}')
            return
        try:
            raw = self.rfile.read(content_length)
        except (TimeoutError, OSError):
            self._send_json(408, '{"error":"Request body timed out"}')
            return
        try:
            payload = raw.decode("utf-8")
        except UnicodeDecodeError:
            self._send_json(400, '{"error":"Request body must be UTF-8"}')
            return
        status_code, result = self.server.service.resolve(payload)
        self._send_json(status_code, result.to_json())

    def do_OPTIONS(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        # No CORS response is intentional. Browser access must stay same-origin
        # through Vite rather than exposing this loopback port as a web API.
        self._send_json(405, '{"error":"Method not allowed"}')


def create_server(
    service: OptionalLlmService | None = None,
    *,
    host: str = SIDECAR_HOST,
    port: int = SIDECAR_PORT,
) -> ThreadingHTTPServer:
    if host != SIDECAR_HOST:
        raise ValueError("Optional Local LLM sidecar must bind to 127.0.0.1")
    return _OptionalLlmHttpServer((host, port), service or OptionalLlmService.from_environment())


def main() -> None:
    server = create_server()
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
