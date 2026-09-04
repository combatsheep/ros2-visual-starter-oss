#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"
mkdir -p .logs maps
PROCESS_ROOT="$ROOT_DIR"
# shellcheck source=scripts/process_helpers.sh
source "$ROOT_DIR/scripts/process_helpers.sh"

ACTION="${1:-status}"
MODE="${2:-sim}"
MAP_PATH="${3:-}"
DEFAULT_MAP_PATH=".logs/default_map/default.yaml"
LOCK_DIR=".logs/runtime.lock"
operation_succeeded=0
backend_replaced=0
launched_backend=0

write_error() {
  printf '%s\n' "$1" > .logs/runtime_error
  echo "$1" >&2
}

stop_backend() {
  local require_free="${1:-0}"
  local failed=0
  terminate_recorded_process_group .logs/ros_backend.pid .logs/ros_backend.pgid ros_backend .logs/ros_backend.session_ready .logs/ros_backend.token || failed=1
  terminate_recorded_bootstrap .logs/ros_bootstrap.pid .logs/ros_bootstrap.owner .logs/ros_bootstrap.token .logs/ros_backend.pid .logs/ros_backend.pgid .logs/ros_backend.session_ready .logs/ros_backend.token ros_bootstrap || failed=1
  if [[ "$failed" != "0" ]]; then return 1; fi
  for _ in {1..30}; do
    if ! port_is_open 9090; then break; fi
    sleep .1
  done
  if [[ "$require_free" == "1" ]] && port_is_open 9090; then
    return 1
  fi
}

resolve_map() {
  if [[ -n "$MAP_PATH" ]]; then printf '%s\n' "$MAP_PATH"; return; fi
  local selected=""
  if [[ -f maps/.selected_map ]]; then IFS= read -r selected < maps/.selected_map || true; fi
  if [[ "$selected" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$ ]] && [[ -f "maps/${selected}.yaml" ]]; then
    printf 'maps/%s.yaml\n' "$selected"
    return
  fi
  local candidate
  for candidate in maps/*.yaml; do if [[ -f "$candidate" ]]; then printf '%s\n' "$candidate"; return; fi; done
  printf '%s\n' "$DEFAULT_MAP_PATH"
}

if [[ "$ACTION" == "status" ]]; then
  current="$(cat .logs/runtime_mode 2>/dev/null || echo sim)"
  processing="$(cat .logs/runtime_processing 2>/dev/null || true)"
  printf 'mode=%s processing=%s\n' "$current" "$processing"
  exit 0
fi

if [[ "$ACTION" != "start" && "$ACTION" != "stop" ]]; then
  echo "使い方: ./scripts/runtime.sh [status|start MODE [MAP]|stop]" >&2
  exit 2
fi

if ! acquire_owned_lock "$LOCK_DIR" 2400 "ROS切替処理" 8; then
  write_error "別のROS切替処理が進行中です。完了を待ってから再実行してください。"
  exit 1
fi
cleanup_runtime() {
  local status="$?"
  trap - EXIT INT TERM
  if [[ "$ACTION" == "start" && "$operation_succeeded" != "1" && "$launched_backend" == "1" ]]; then
    set +e
    stop_backend 0
    set -e
  fi
  if [[ "$ACTION" == "start" && "$operation_succeeded" != "1" \
    && ("$backend_replaced" == "1" || "$launched_backend" == "1") ]]; then
    printf 'sim\n' > .logs/runtime_mode
  fi
  rm -f .logs/runtime_processing .logs/runtime_target
  release_owned_lock "$LOCK_DIR" 8
  return "$status"
}
trap cleanup_runtime EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
rm -f .logs/runtime_error

if [[ "$ACTION" == "stop" ]]; then MODE="sim"; fi
case "$MODE" in sim|base|mapping|navigation|exploration) ;; *) write_error "未対応のROS modeです: $MODE"; exit 2 ;; esac
printf '%s\n' "$MODE" > .logs/runtime_target
printf '%s\n' "$([[ "$MODE" == "sim" ]] && echo closing || echo processing)" > .logs/runtime_processing
test_runtime_delay="${ROS2_VISUAL_TEST_RUNTIME_DELAY_MS:-}"
unset ROS2_VISUAL_TEST_RUNTIME_DELAY_MS
if [[ "$ACTION" == "start" && -n "$test_runtime_delay" ]]; then
  if [[ ! "$test_runtime_delay" =~ ^[0-9]+$ ]] || (( test_runtime_delay > 5000 )); then
    write_error "runtime test delayが不正です。"
    exit 2
  fi
  sleep "$(printf '%d.%03d' "$((test_runtime_delay / 1000))" "$((test_runtime_delay % 1000))")"
fi

if [[ "$MODE" == "sim" ]]; then
  if ! stop_backend 0; then
    write_error "記録済みROS backendを安全に停止できませんでした。"
    exit 1
  fi
  printf 'sim\n' > .logs/runtime_mode
  operation_succeeded=1
  exit 0
fi

PIXI_BIN="$(command -v pixi 2>/dev/null || true)"
if [[ -z "$PIXI_BIN" && -x "${HOME}/.pixi/bin/pixi" ]]; then PIXI_BIN="${HOME}/.pixi/bin/pixi"; fi
if [[ -z "$PIXI_BIN" ]]; then
  write_error "Pixiが見つかりません。./setup.sh を先に実行してください。"
  exit 1
fi
PIXI_PYTHON="$ROOT_DIR/.pixi/envs/default/bin/python"
if [[ ! -x "$PIXI_PYTHON" ]]; then
  write_error "Pixi環境がありません。./setup.sh を先に実行してください。"
  exit 1
fi

if [[ "$MODE" == "navigation" ]]; then
  if [[ -z "$MAP_PATH" ]]; then MAP_PATH="$(resolve_map)"; fi
  if [[ "$MAP_PATH" == "$DEFAULT_MAP_PATH" ]]; then
    "$PIXI_BIN" run python scripts/generate_default_map.py >/dev/null
  fi
  if [[ -z "$MAP_PATH" || ! -f "$MAP_PATH" ]]; then
    write_error "Nav2用の保存地図がありません。現在のMAPは停止していません。地図名を入力して保存してから、もう一度NAV2を押してください。"
    exit 1
  fi
fi
if [[ "$MODE" == "exploration" && -n "$MAP_PATH" ]]; then
  write_error "explorationは保存地図を読み込みません。--mapは固定地図navigationだけで使用してください。"
  exit 2
fi

if ! stop_backend 1; then
  write_error "9090番portを安全に確保できません。別processのlistenerまたは不完全な台帳を確認してください。"
  exit 1
fi
backend_replaced=1
environment=("ROS_LOCALHOST_ONLY=1" "RMW_IMPLEMENTATION=rmw_fastrtps_cpp" "FASTDDS_BUILTIN_TRANSPORTS=UDPv4")
if [[ -n "$MAP_PATH" ]]; then environment+=("ROS2_VISUAL_MAP=$MAP_PATH"); fi
run_ros_without_llm_environment() {
  env \
    -u ROS_STATIC_PEERS \
    -u ROS_DISCOVERY_SERVER \
    -u ROS_SUPER_CLIENT \
    -u ROS2_EASY_MODE \
    -u RMW_IMPLEMENTATION \
    -u CYCLONEDDS_URI \
    -u FASTDDS_DEFAULT_PROFILES_FILE \
    -u FASTRTPS_DEFAULT_PROFILES_FILE \
    -u FASTDDS_ENVIRONMENT_FILE \
    -u FASTDDS_BUILTIN_TRANSPORTS \
    -u ROS2_VISUAL_LLM_TOKEN \
    -u ROS2_VISUAL_LLM_BASE_URL \
    -u ROS2_VISUAL_LLM_MODEL \
    -u ROS2_VISUAL_LLM_ENABLED \
    "${environment[@]}" "$@"
}
rm -f .logs/ros_backend.pid .logs/ros_backend.pgid .logs/ros_backend.token .logs/ros_backend.session_ready .logs/ros_bootstrap.pid .logs/ros_bootstrap.owner .logs/ros_bootstrap.token
bootstrap_token="$("$PIXI_PYTHON" -c 'import secrets; print(secrets.token_hex(16))')"
printf '%s\n' "$$" > .logs/ros_bootstrap.owner
printf '%s\n' "$bootstrap_token" > .logs/ros_bootstrap.token
nohup env \
  -u ROS_STATIC_PEERS \
  -u ROS_DISCOVERY_SERVER \
  -u ROS_SUPER_CLIENT \
  -u ROS2_EASY_MODE \
  -u RMW_IMPLEMENTATION \
  -u CYCLONEDDS_URI \
  -u FASTDDS_DEFAULT_PROFILES_FILE \
  -u FASTRTPS_DEFAULT_PROFILES_FILE \
  -u FASTDDS_ENVIRONMENT_FILE \
  -u FASTDDS_BUILTIN_TRANSPORTS \
  -u ROS2_VISUAL_LLM_TOKEN \
  -u ROS2_VISUAL_LLM_BASE_URL \
  -u ROS2_VISUAL_LLM_MODEL \
  -u ROS2_VISUAL_LLM_ENABLED \
  "${environment[@]}" \
  "$PIXI_PYTHON" scripts/ros_process_supervisor.py "$MODE" "$bootstrap_token" "$$" >.logs/ros_backend.log 2>&1 < /dev/null 8>&- &
bootstrap_pid=$!
launched_backend=1
printf '%s\n' "$bootstrap_pid" > .logs/ros_bootstrap.pid
identity_ready=0
for _ in {1..250}; do
  recorded_pid="$(cat .logs/ros_backend.pid 2>/dev/null || true)"
  recorded_pgid="$(cat .logs/ros_backend.pgid 2>/dev/null || true)"
  recorded_token="$(cat .logs/ros_backend.token 2>/dev/null || true)"
  session_ready="$(cat .logs/ros_backend.session_ready 2>/dev/null || true)"
  if [[ "$recorded_pid" =~ ^[1-9][0-9]*$ && "$recorded_pgid" == "$recorded_pid" ]] \
    && [[ "$recorded_token" =~ ^[0-9a-f]{32}$ && "$session_ready" == "$recorded_pid" ]] \
    && process_is_running "$recorded_pid"; then
    identity_ready=1
    backend_pid="$recorded_pid"
    break
  fi
  if ! process_is_running "$bootstrap_pid"; then break; fi
  sleep .02
done
if [[ "$identity_ready" != "1" ]]; then
  write_error "ROS backendの専用process groupを確立できませんでした。"
  exit 1
fi

rosbridge_ready=0
for _ in {1..75}; do
  if ! process_is_running "$backend_pid"; then
    printf 'sim\n' > .logs/runtime_mode
    write_error "ROS backendの起動に失敗しました。.logs/ros_backend.logを確認してください。"
    tail -n 20 .logs/ros_backend.log >&2 || true
    exit 1
  fi
  if port_is_open 9090 && port_listener_is_owned_by_process_group 9090 "$recorded_pgid" "$recorded_token" ros_backend; then
    rosbridge_ready=1
    break
  fi
  if port_is_open 9090; then
    write_error "9090番portに本runtime以外のlistenerを検出しました。"
    stop_backend 0 || true
    exit 1
  fi
  sleep 1
done

if [[ "$rosbridge_ready" != "1" ]]; then
  printf 'sim\n' > .logs/runtime_mode
  write_error "rosbridgeが9090番で待受を開始しませんでした。"
  stop_backend 0 || true
  exit 1
fi

# rosbridgeのportだけでFrontendを開くと、初回起動ではrosapi serviceの
# advertise前にBrowserがgraph取得を始め、空graphを構成異常と誤認する。
# 必須serviceが見えるまで待ってからruntimeをreadyとして公開する。
rosapi_ready=0
for _ in {1..15}; do
  if ! process_is_running "$backend_pid"; then break; fi
  service_list="$(run_ros_without_llm_environment "$PIXI_BIN" run ros2 service list --no-daemon --spin-time 1 2>/dev/null || true)"
  padded_services=$'\n'"$service_list"$'\n'
  if [[ "$padded_services" == *$'\n/rosapi/nodes\n'* \
    && "$padded_services" == *$'\n/rosapi/topics\n'* \
    && "$padded_services" == *$'\n/rosapi/action_servers\n'* ]]; then
    rosapi_ready=1
    break
  fi
  sleep .5
done

managed_mapping_ready=1
if [[ "$rosapi_ready" == "1" && ("$MODE" == "mapping" || "$MODE" == "exploration") ]]; then
  managed_mapping_ready=0
  # Browserを先に公開すると、初回のrosapi graph照会がSLAM／Map Saverの
  # Lifecycle serviceと競合し、change_state timeout後に初期化モーダルが
  # 待ち続けることがある。scanが届く前でも両Nodeはactiveになれるため、
  # mapping側のmanaged bringup完了を確認してからruntimeを公開する。
  for _ in {1..30}; do
    if ! process_is_running "$backend_pid"; then break; fi
    slam_state="$(run_ros_without_llm_environment "$PIXI_BIN" run ros2 lifecycle get --no-daemon --spin-time 0.5 /slam_toolbox 2>/dev/null || true)"
    if [[ "$slam_state" == *'active [3]'* ]]; then
      map_saver_state="$(run_ros_without_llm_environment "$PIXI_BIN" run ros2 lifecycle get --no-daemon --spin-time 0.5 /map_saver 2>/dev/null || true)"
      if [[ "$map_saver_state" == *'active [3]'* ]]; then
        managed_mapping_ready=1
        break
      fi
    fi
    sleep .25
  done
fi

if [[ "$rosapi_ready" == "1" && "$managed_mapping_ready" == "1" ]]; then
  rm -f .logs/ros_bootstrap.pid .logs/ros_bootstrap.owner .logs/ros_bootstrap.token
  printf '%s\n' "$MODE" > .logs/runtime_mode
  operation_succeeded=1
  exit 0
fi

printf 'sim\n' > .logs/runtime_mode
if [[ "$rosapi_ready" != "1" ]]; then
  write_error "rosbridgeは起動しましたが、rosapiの必須serviceを確認できませんでした。再実行せず .logs/ros_backend.log を確認してください。"
else
  write_error "SLAM ToolboxとMap SaverのLifecycle初期化が完了しませんでした。再実行せず .logs/ros_backend.log を確認してください。"
fi
tail -n 20 .logs/ros_backend.log >&2 || true
stop_backend
exit 1
