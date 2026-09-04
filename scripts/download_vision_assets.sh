#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CACHE_DIR="$ROOT_DIR/public/vision"
mkdir -p "$CACHE_DIR"

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else sha256sum "$1" | awk '{print $1}'; fi
}

download_verified() {
  local name="$1"
  local url="$2"
  local expected_sha256="$3"
  local output="$CACHE_DIR/$name"
  local partial="$output.partial"

  if [[ -f "$output" ]] && [[ "$(sha256_file "$output")" == "$expected_sha256" ]]; then
    echo "✓ $name は取得済みです"
    return
  fi

  rm -f "$partial"
  curl -fL --retry 3 --connect-timeout 15 -o "$partial" "$url"
  local actual_sha256
  actual_sha256="$(sha256_file "$partial")"
  if [[ "$actual_sha256" != "$expected_sha256" ]]; then
    rm -f "$partial"
    echo "checksumが一致しません: $name" >&2
    echo "expected: $expected_sha256" >&2
    echo "actual:   $actual_sha256" >&2
    exit 1
  fi
  mv "$partial" "$output"
  echo "✓ $name を取得しchecksumを確認しました"
}

download_verified \
  "yolox_nano.onnx" \
  "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx" \
  "c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d"

download_verified \
  "dog.jpg" \
  "https://raw.githubusercontent.com/Megvii-BaseDetection/YOLOX/0.3.0/assets/dog.jpg" \
  "5a9522051c3cec2bbd2f6323fccba32e8fbf3ddcc2b3e2fd46b04c720bc6f866"

wc -c "$CACHE_DIR/yolox_nano.onnx" "$CACHE_DIR/dog.jpg"
