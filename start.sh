#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT_DIR"
mkdir -p .logs maps
PROCESS_ROOT="$ROOT_DIR"
# shellcheck source=scripts/process_helpers.sh
source "$ROOT_DIR/scripts/process_helpers.sh"
LIFECYCLE_LOCK="$ROOT_DIR/.logs/lifecycle.lock"
lifecycle_lock_held=0

MODE="sim"
MODE_SELECTED=0
MAP_PATH=""
OPTIONAL_LLM_ENABLED="${ROS2_VISUAL_LLM_ENABLED:-0}"
if [[ "$OPTIONAL_LLM_ENABLED" != "0" && "$OPTIONAL_LLM_ENABLED" != "1" ]]; then
  echo "ROS2_VISUAL_LLM_ENABLEDは0または1で指定してください。" >&2
  exit 2
fi
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --sim|--ros|--mapping|--navigation|--exploration)
      if [[ "$MODE_SELECTED" == "1" ]]; then
        echo "起動構成は1つだけ指定してください。" >&2
        exit 2
      fi
      case "$1" in
        --sim) MODE="sim" ;;
        --ros) MODE="base" ;;
        --mapping) MODE="mapping" ;;
        --navigation) MODE="navigation" ;;
        --exploration) MODE="exploration" ;;
      esac
      MODE_SELECTED=1
      ;;
    --map)
      shift
      if [[ "$#" -eq 0 ]]; then
        echo "--map の後にyamlファイルを指定してください。" >&2
        exit 2
      fi
      MAP_PATH="$1"
      ;;
    *)
      echo "使い方: ./start.sh [--sim|--ros|--mapping|--navigation|--exploration] [--map PATH]" >&2
      exit 2
      ;;
  esac
  shift
done

if [[ -n "$MAP_PATH" && "$MODE" != "navigation" ]]; then
  echo "--mapは--navigationでのみ使用できます。" >&2
  exit 2
fi

PIXI_BIN="$(command -v pixi 2>/dev/null || true)"
if [[ -z "$PIXI_BIN" && -x "${HOME}/.pixi/bin/pixi" ]]; then
  PIXI_BIN="${HOME}/.pixi/bin/pixi"
fi
if [[ -z "$PIXI_BIN" ]]; then
  echo "Pixiが見つかりません。./setup.sh を先に実行してください。" >&2
  exit 1
fi
PIXI_PYTHON="$ROOT_DIR/.pixi/envs/default/bin/python"
if [[ ! -x "$PIXI_PYTHON" ]]; then
  echo "Pixi環境がありません。./setup.sh を先に実行してください。" >&2
  exit 1
fi

mode_label() {
  case "$1" in
    sim) echo "SIM" ;;
    base) echo "ROS BASE" ;;
    mapping) echo "MAPPING" ;;
    navigation) echo "NAVIGATION" ;;
    exploration) echo "EXPLORATION" ;;
    *) echo "$1" ;;
  esac
}

ros_runtime_is_healthy() {
  local active_mode processing operation_owner pid pgid ready token
  processing="$(cat .logs/runtime_processing 2>/dev/null || true)"
  if [[ -n "$processing" ]]; then
    operation_owner="$(cat .logs/runtime.lock 2>/dev/null || true)"
    [[ "$operation_owner" =~ ^[1-9][0-9]*$ ]] \
      && process_is_running "$operation_owner" \
      && process_is_owned "$operation_owner" runtime_operation \
      && kernel_lock_is_held "$ROOT_DIR/.logs/runtime.lock"
    return
  fi
  active_mode="$(cat .logs/runtime_mode 2>/dev/null || echo sim)"
  [[ "$active_mode" == "sim" ]] && return 0
  pid="$(cat .logs/ros_backend.pid 2>/dev/null || true)"
  pgid="$(cat .logs/ros_backend.pgid 2>/dev/null || true)"
  ready="$(cat .logs/ros_backend.session_ready 2>/dev/null || true)"
  token="$(cat .logs/ros_backend.token 2>/dev/null || true)"
  [[ "$pid" =~ ^[1-9][0-9]*$ && "$pgid" == "$pid" && "$ready" == "$pid" \
    && "$token" =~ ^[0-9a-f]{32}$ ]] || return 1
  process_is_running "$pid" && process_is_owned "$pid" ros_backend \
    && process_group_has_generation_identity "$pgid" ros_backend "$token"
}

owner_aware_sleep() {
  local duration="$1"
  local sleep_status owner
  sleep "$duration"
  sleep_status=$?
  [[ "$sleep_status" == "0" ]] && return 0
  owner="$(cat .logs/runtime_owner 2>/dev/null || true)"
  # stop.sh removes the owner marker before terminating this monitor's helper
  # children. Treat only that verified handoff as a normal wake-up.
  [[ "$owner" != "$$" ]] && return 10
  return "$sleep_status"
}

frontend_pid=""
optional_llm_pid=""
cleanup_owned_processes() {
  local original_status="$?"
  trap - INT TERM EXIT
  # Serialize the owner recheck and cleanup. Releasing first would allow a new
  # launcher to publish its owner between this check and stop.sh.
  if [[ "$lifecycle_lock_held" != "1" ]]; then
    if acquire_owned_lock "$LIFECYCLE_LOCK" 2400 "終了処理" 9; then
      lifecycle_lock_held=1
    fi
  fi
  if [[ "$lifecycle_lock_held" == "1" ]]; then
    if [[ -f .logs/runtime_owner ]] && [[ "$(<.logs/runtime_owner)" == "$$" ]]; then
      ./stop.sh --lock-held >/dev/null 2>&1 || true
    fi
    release_owned_lock "$LIFECYCLE_LOCK" 9
    lifecycle_lock_held=0
  fi
  return "$original_status"
}
trap cleanup_owned_processes EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 起動・停止とPID台帳更新を直列化する。dead ownerのlockだけを回収する。
acquire_owned_lock "$LIFECYCLE_LOCK" 2400 "起動・停止処理" 9
lifecycle_lock_held=1
# 前回このworkspaceが記録したprocessだけを停止してから再起動する。
if ! ./stop.sh --lock-held >/dev/null; then
  echo "前回のprocessを安全に停止できないため、起動を中止します。" >&2
  exit 1
fi
for _ in {1..250}; do
  ports_busy=0
  port_is_open 27182 && ports_busy=1
  port_is_open 27184 && ports_busy=1
  if [[ "$MODE" != "sim" ]] && port_is_open 9090; then ports_busy=1; fi
  if [[ "$ports_busy" == "0" ]]; then break; fi
  sleep .1
done
for port in 27182 27184; do
  if port_is_open "$port"; then
    echo "${port}番portは別processが使用中です。所有者を確認してから再実行してください。" >&2
    exit 1
  fi
done
if [[ "$MODE" != "sim" ]] && port_is_open 9090; then
  echo "9090番portは別processが使用中です。所有者を確認してから再実行してください。" >&2
  exit 1
fi

printf '%s\n' "$$" > .logs/runtime_owner

if [[ "$MODE" == "sim" ]]; then
  ./scripts/runtime.sh stop 9>&-
  ros_backend_pid=""
else
  ./scripts/runtime.sh start "$MODE" "$MAP_PATH" 9>&-
  ros_backend_pid="$(cat .logs/ros_backend.pid 2>/dev/null || true)"
  if [[ ! "$ros_backend_pid" =~ ^[1-9][0-9]*$ ]] || ! process_is_running "$ros_backend_pid"; then
    echo "ROS backendの起動台帳を確認できませんでした。" >&2
    exit 1
  fi
  echo "✓ ROS 2 Jazzy backend started ($MODE)"
fi

if [[ "$OPTIONAL_LLM_ENABLED" == "1" ]]; then
  rm -f .logs/optional_llm.pid .logs/optional_llm.pgid .logs/optional_llm.token .logs/optional_llm.session_ready .logs/optional_llm.bootstrap.pid .logs/optional_llm.bootstrap.owner .logs/optional_llm.bootstrap.token
  optional_llm_bootstrap_token="$("$PIXI_PYTHON" -c 'import secrets; print(secrets.token_hex(16))')"
  printf '%s\n' "$$" > .logs/optional_llm.bootstrap.owner
  printf '%s\n' "$optional_llm_bootstrap_token" > .logs/optional_llm.bootstrap.token
  "$PIXI_PYTHON" scripts/service_process_supervisor.py optional_llm "$optional_llm_bootstrap_token" "$$" >.logs/optional_llm.log 2>&1 9>&- &
  optional_llm_bootstrap_pid=$!
  printf '%s\n' "$optional_llm_bootstrap_pid" > .logs/optional_llm.bootstrap.pid
  optional_llm_pid=""
  for _ in {1..250}; do
    recorded_pid="$(cat .logs/optional_llm.pid 2>/dev/null || true)"
    recorded_pgid="$(cat .logs/optional_llm.pgid 2>/dev/null || true)"
    recorded_token="$(cat .logs/optional_llm.token 2>/dev/null || true)"
    session_ready="$(cat .logs/optional_llm.session_ready 2>/dev/null || true)"
    if [[ "$recorded_pid" =~ ^[1-9][0-9]*$ && "$recorded_pgid" == "$recorded_pid" ]] \
      && [[ "$recorded_token" =~ ^[0-9a-f]{32}$ && "$session_ready" == "$recorded_pid" ]] \
      && process_is_running "$recorded_pid"; then
      optional_llm_pid="$recorded_pid"
      break
    fi
    if ! process_is_running "$optional_llm_bootstrap_pid"; then break; fi
    sleep .02
  done
  if [[ -z "$optional_llm_pid" ]]; then
    echo "警告: Optional Local LLM adapterの専用process groupを確立できません。Rule-based parserと他のruntimeは継続します。" >&2
  fi
  if [[ -n "$optional_llm_pid" ]]; then
    optional_llm_ready=0
    for _ in {1..100}; do
      if curl -fsS --max-time 1 http://127.0.0.1:27184/status >/dev/null 2>&1; then
        optional_llm_ready=1
        break
      fi
      if ! process_is_running "$optional_llm_pid"; then break; fi
      sleep .1
    done
    if [[ "$optional_llm_ready" != "1" ]]; then
      echo "警告: Optional Local LLM adapterが利用できません。.logs/optional_llm.logを確認してください。Rule-based parserと他のruntimeは継続します。" >&2
    fi
  fi
  rm -f .logs/optional_llm.bootstrap.pid .logs/optional_llm.bootstrap.owner .logs/optional_llm.bootstrap.token
else
  rm -f .logs/optional_llm.pid .logs/optional_llm.pgid .logs/optional_llm.token .logs/optional_llm.session_ready .logs/optional_llm.bootstrap.pid .logs/optional_llm.bootstrap.owner .logs/optional_llm.bootstrap.token
  echo "Optional Local LLM adapter: disabled（Rule-based parserを使用）"
fi

rm -f .logs/frontend.pid .logs/frontend.pgid .logs/frontend.token .logs/frontend.session_ready .logs/frontend.bootstrap.pid .logs/frontend.bootstrap.owner .logs/frontend.bootstrap.token
frontend_bootstrap_token="$("$PIXI_PYTHON" -c 'import secrets; print(secrets.token_hex(16))')"
printf '%s\n' "$$" > .logs/frontend.bootstrap.owner
printf '%s\n' "$frontend_bootstrap_token" > .logs/frontend.bootstrap.token
env -u ROS2_VISUAL_LLM_TOKEN \
  -u ROS2_VISUAL_LLM_BASE_URL \
  -u ROS2_VISUAL_LLM_MODEL \
  -u ROS2_VISUAL_LLM_ENABLED \
  "$PIXI_PYTHON" scripts/service_process_supervisor.py frontend "$frontend_bootstrap_token" "$$" >.logs/frontend.log 2>&1 9>&- &
frontend_bootstrap_pid=$!
printf '%s\n' "$frontend_bootstrap_pid" > .logs/frontend.bootstrap.pid
frontend_pid=""
for _ in {1..50}; do
  recorded_pid="$(cat .logs/frontend.pid 2>/dev/null || true)"
  recorded_pgid="$(cat .logs/frontend.pgid 2>/dev/null || true)"
  recorded_token="$(cat .logs/frontend.token 2>/dev/null || true)"
  session_ready="$(cat .logs/frontend.session_ready 2>/dev/null || true)"
  if [[ "$recorded_pid" =~ ^[1-9][0-9]*$ && "$recorded_pgid" == "$recorded_pid" ]] \
    && [[ "$recorded_token" =~ ^[0-9a-f]{32}$ && "$session_ready" == "$recorded_pid" ]] \
    && process_is_running "$recorded_pid"; then
    frontend_pid="$recorded_pid"
    break
  fi
  if ! process_is_running "$frontend_bootstrap_pid"; then break; fi
  sleep .02
done
if [[ -z "$frontend_pid" ]]; then
  echo "Frontendの専用process groupを確立できませんでした。" >&2
  exit 1
fi
frontend_ready=0
for _ in {1..60}; do
  if curl -fsS --max-time 2 http://127.0.0.1:27182/ >/dev/null 2>&1; then
    frontend_ready=1
    break
  fi
  if ! process_is_running "$frontend_pid"; then break; fi
  sleep .5
done
if [[ "$frontend_ready" != "1" ]]; then
  tail -n 40 .logs/frontend.log >&2 || true
  echo "Frontendを起動できませんでした。" >&2
  exit 1
fi
rm -f .logs/frontend.bootstrap.pid .logs/frontend.bootstrap.owner .logs/frontend.bootstrap.token

query=""
if [[ "$MODE" != "sim" ]]; then query="?ros=1"; fi
echo ""
echo "✓ $(mode_label "$MODE") started"
echo "Open: http://127.0.0.1:27182/${query}"
if command -v open >/dev/null 2>&1 && [[ "${ROS2_VISUAL_NO_OPEN:-0}" != "1" ]]; then
  open "http://127.0.0.1:27182/${query}" >/dev/null 2>&1 || true
fi
echo "終了: Ctrl+C"

release_owned_lock "$LIFECYCLE_LOCK" 9
lifecycle_lock_held=0

while process_is_running "$frontend_pid" && process_is_running "$frontend_bootstrap_pid"; do
  if ! ros_runtime_is_healthy; then
    monitor_sleep_status=0
    owner_aware_sleep .2 || monitor_sleep_status=$?
    if [[ "$monitor_sleep_status" == "10" ]]; then break; fi
    if [[ "$monitor_sleep_status" != "0" ]]; then exit "$monitor_sleep_status"; fi
    if ! ros_runtime_is_healthy; then
      echo "ROS backendが予期せず停止したため、所有processを回収してSIMへ戻します。" >&2
      if ! ./scripts/runtime.sh stop; then
        echo "ROS backendを安全に回収できませんでした。" >&2
        exit 1
      fi
    fi
  fi
  if [[ "$OPTIONAL_LLM_ENABLED" == "1" && -n "$optional_llm_pid" ]] \
    && ! process_is_running "$optional_llm_pid"; then
    echo "警告: Optional Local LLM adapterが停止しました。UIを未接続として継続します。" >&2
    optional_llm_pid=""
  fi
  monitor_sleep_status=0
  owner_aware_sleep 1 || monitor_sleep_status=$?
  if [[ "$monitor_sleep_status" == "10" ]]; then break; fi
  if [[ "$monitor_sleep_status" != "0" ]]; then exit "$monitor_sleep_status"; fi
done
set +e
wait "$frontend_bootstrap_pid"
frontend_status=$?
set -e
if [[ "$frontend_status" == "130" || "$frontend_status" == "143" ]]; then
  exit 0
fi
exit "$frontend_status"
