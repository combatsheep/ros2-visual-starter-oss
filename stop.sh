#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT_DIR"
mkdir -p .logs
PROCESS_ROOT="$ROOT_DIR"
# shellcheck source=scripts/process_helpers.sh
source "$ROOT_DIR/scripts/process_helpers.sh"

LOCK_DIR="$ROOT_DIR/.logs/lifecycle.lock"
lock_held=0
lock_acquired_here=0
if [[ "${1:-}" == "--lock-held" ]]; then
  lock_owner="$(cat "$LOCK_DIR" 2>/dev/null || true)"
  if [[ "$lock_owner" != "$PPID" ]] || ! validate_inherited_lock "$LOCK_DIR" 9 "$PPID"; then
    echo "内部用lock引継ぎを確認できません。" >&2
    exit 2
  fi
  lock_held=1
elif [[ "$#" -ne 0 ]]; then
  echo "使い方: ./stop.sh" >&2
  exit 2
else
  acquire_owned_lock "$LOCK_DIR" 2400 "起動・停止処理" 9
  lock_held=1
  lock_acquired_here=1
fi

cleanup_lock() {
  if [[ "$lock_held" == "1" && "$lock_acquired_here" == "1" ]]; then
    release_owned_lock "$LOCK_DIR" 9
  fi
}
trap cleanup_lock EXIT

failed=0
# Frontendの子として起動された場合も、現在のstop.sh（$$）のsubtreeは
# 停止対象から除外する。startup handshake前の子もowner treeから回収する。
terminate_runtime_owner_children .logs/runtime_owner "$$" || failed=1
terminate_recorded_process_group .logs/frontend.pid .logs/frontend.pgid frontend .logs/frontend.session_ready .logs/frontend.token || failed=1
terminate_recorded_bootstrap .logs/frontend.bootstrap.pid .logs/frontend.bootstrap.owner .logs/frontend.bootstrap.token .logs/frontend.pid .logs/frontend.pgid .logs/frontend.session_ready .logs/frontend.token frontend_bootstrap || failed=1
terminate_recorded_process_group .logs/optional_llm.pid .logs/optional_llm.pgid optional_llm .logs/optional_llm.session_ready .logs/optional_llm.token || failed=1
terminate_recorded_bootstrap .logs/optional_llm.bootstrap.pid .logs/optional_llm.bootstrap.owner .logs/optional_llm.bootstrap.token .logs/optional_llm.pid .logs/optional_llm.pgid .logs/optional_llm.session_ready .logs/optional_llm.token optional_llm_bootstrap || failed=1
./scripts/runtime.sh stop 9>&- >/dev/null 2>&1 || failed=1

if [[ "$failed" != "0" ]]; then
  echo "一部processを安全に停止できませんでした。PID台帳を保持しています。" >&2
  exit 1
fi
echo "ROS2 Visual Starterを停止しました。"
