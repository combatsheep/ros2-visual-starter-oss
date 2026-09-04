"""Bounded, provider-neutral OpenAI-compatible client for a local model."""

from __future__ import annotations

import json
import socket
import time
from dataclasses import dataclass
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .local_llm_contract import (
    INTENT_JSON_SCHEMA,
    SYSTEM_PROMPT,
    IntentCandidate,
    LocalLlmContractError,
    parse_intent_candidate,
)


DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1"
DEFAULT_HEALTH_TIMEOUT_SECONDS = 1.5
DEFAULT_INFERENCE_TIMEOUT_SECONDS = 20.0
MAX_RESPONSE_BYTES = 65_536
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


class LocalLlmClientError(RuntimeError):
    """A redacted fail-closed client error safe to publish in status."""


class LocalLlmOutputError(LocalLlmClientError):
    """The local service responded, but its structured content was rejected."""


class _NoRedirectHandler(HTTPRedirectHandler):
    """Reject redirects so a loopback URL cannot escape to another host."""

    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


def _direct_opener(request: Request, *, timeout: float):
    opener = build_opener(ProxyHandler({}), _NoRedirectHandler())
    return opener.open(request, timeout=timeout)


def _set_response_socket_timeout(response: Any, timeout: float) -> None:
    """Apply the remaining wall-clock budget to urllib's response socket."""
    stream = getattr(response, "fp", None)
    raw = getattr(stream, "raw", None)
    response_socket = getattr(raw, "_sock", None)
    if response_socket is not None:
        response_socket.settimeout(max(timeout, 0.001))


def _read_bounded_response(response: Any, *, deadline: float) -> bytes:
    read1 = getattr(response, "read1", None)
    if not callable(read1):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise LocalLlmClientError("Local LLM requestがtimeoutしました。")
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if time.monotonic() > deadline:
            raise LocalLlmClientError("Local LLM requestがtimeoutしました。")
        return raw
    chunks: list[bytes] = []
    total = 0
    while total <= MAX_RESPONSE_BYTES:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise LocalLlmClientError("Local LLM requestがtimeoutしました。")
        _set_response_socket_timeout(response, remaining)
        chunk = read1(min(8_192, MAX_RESPONSE_BYTES + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    return b"".join(chunks)


def validate_loopback_base_url(base_url: str) -> str:
    try:
        parsed = urlparse(base_url)
        port = parsed.port
    except ValueError as error:
        raise LocalLlmClientError("Local LLM URLを解析できません。") from error
    if parsed.scheme not in {"http", "https"}:
        raise LocalLlmClientError("Local LLM URLはhttpまたはhttpsで指定してください。")
    if parsed.hostname not in LOOPBACK_HOSTS:
        raise LocalLlmClientError("Local LLM URLはloopbackだけを許可します。")
    if (parsed.username is not None
            or parsed.password is not None
            or parsed.params
            or any(delimiter in base_url for delimiter in ("?", "#", ";"))):
        raise LocalLlmClientError("Local LLM URLへ認証情報・parameter・query・fragmentを含めないでください。")
    if port is not None and not 1 <= port <= 65_535:
        raise LocalLlmClientError("Local LLM URLのportが不正です。")
    path = parsed.path.rstrip("/")
    if path != "/v1":
        raise LocalLlmClientError("Local LLM URLには/v1 pathが必要です。")
    return parsed._replace(path=path, params="", query="", fragment="").geturl()


@dataclass(frozen=True)
class LocalLlmClientConfig:
    base_url: str = DEFAULT_BASE_URL
    configured_model: str = ""
    token: str = ""
    health_timeout_seconds: float = DEFAULT_HEALTH_TIMEOUT_SECONDS
    inference_timeout_seconds: float = DEFAULT_INFERENCE_TIMEOUT_SECONDS


class LocalLlmClient:
    def __init__(
        self,
        config: LocalLlmClientConfig,
        opener: Callable[..., Any] = _direct_opener,
    ) -> None:
        self.base_url = validate_loopback_base_url(config.base_url)
        self.configured_model = config.configured_model.strip()
        if not self.configured_model or len(self.configured_model) > 300:
            raise LocalLlmClientError("Local LLMを有効にするにはmodel idを明示してください。")
        if any(ord(character) < 32 or ord(character) == 127 for character in self.configured_model):
            raise LocalLlmClientError("Local LLM model idが不正です。")
        if len(config.token) > 4_096 or any(ord(character) < 33 or ord(character) > 126 for character in config.token):
            raise LocalLlmClientError("Local LLM tokenが不正です。")
        self._token = config.token
        self.health_timeout_seconds = config.health_timeout_seconds
        self.inference_timeout_seconds = config.inference_timeout_seconds
        self._opener = opener

    def _request_json(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None,
        timeout: float,
    ) -> dict[str, Any]:
        headers = {"Accept": "application/json"}
        body = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        request = Request(f"{self.base_url}/{path.lstrip('/')}", data=body, headers=headers, method=method)
        deadline = time.monotonic() + timeout
        try:
            with self._opener(request, timeout=timeout) as response:
                raw = _read_bounded_response(response, deadline=deadline)
        except HTTPError as error:
            if 300 <= error.code < 400:
                raise LocalLlmClientError("Local LLM redirectを拒否しました。") from error
            raise LocalLlmClientError(f"Local LLM HTTP {error.code}。") from error
        except (TimeoutError, socket.timeout) as error:
            raise LocalLlmClientError("Local LLM requestがtimeoutしました。") from error
        except URLError as error:
            raise LocalLlmClientError("Local LLMへ接続できません。") from error
        except OSError as error:
            raise LocalLlmClientError("Local LLMとの通信に失敗しました。") from error
        if len(raw) > MAX_RESPONSE_BYTES:
            raise LocalLlmClientError("Local LLM responseが上限を超えました。")
        try:
            decoded = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
            raise LocalLlmClientError("Local LLM response JSONを読み取れません。") from error
        if not isinstance(decoded, dict):
            raise LocalLlmClientError("Local LLM responseはJSON objectである必要があります。")
        return decoded

    def discover_model(self) -> str:
        response = self._request_json(
            "GET",
            "models",
            payload=None,
            timeout=self.health_timeout_seconds,
        )
        data = response.get("data")
        if not isinstance(data, list):
            raise LocalLlmClientError("Local LLM model listが不正です。")
        model_ids = [entry.get("id") for entry in data if isinstance(entry, dict)]
        model_ids = [model_id for model_id in model_ids if isinstance(model_id, str) and model_id]
        if self.configured_model not in model_ids:
            raise LocalLlmClientError("設定したmodel idをLocal LLMで確認できません。")
        return self.configured_model

    def infer_intent(self, model_id: str, text: str) -> IntentCandidate:
        response = self._request_json(
            "POST",
            "chat/completions",
            payload={
                "model": model_id,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": text},
                ],
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "ros2_visual_mission_intent",
                        "strict": True,
                        "schema": INTENT_JSON_SCHEMA,
                    },
                },
                "temperature": 0,
                "seed": 0,
                "max_tokens": 128,
                "stream": False,
            },
            timeout=self.inference_timeout_seconds,
        )
        try:
            content = response["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as error:
            raise LocalLlmClientError("Local LLM Structured Output fieldがありません。") from error
        if not isinstance(content, str):
            raise LocalLlmClientError("Local LLM Structured Outputが文字列ではありません。")
        try:
            return parse_intent_candidate(content)
        except LocalLlmContractError as error:
            raise LocalLlmOutputError(str(error)) from error
