#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"

PIXI_BIN="$(command -v pixi 2>/dev/null || true)"
if [[ -z "$PIXI_BIN" && -x "${HOME}/.pixi/bin/pixi" ]]; then
  PIXI_BIN="${HOME}/.pixi/bin/pixi"
fi
if [[ -z "$PIXI_BIN" ]]; then
  echo "Pixiが見つかりません。./setup.sh を先に実行してください。" >&2
  exit 1
fi

exec "$PIXI_BIN" "$@"
