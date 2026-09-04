#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"
PROCESS_ROOT="$ROOT_DIR"
# shellcheck source=scripts/process_helpers.sh
source "$ROOT_DIR/scripts/process_helpers.sh"

current_runner_pid=""
foreign_listener_pid=""
lock_smoke_file="$ROOT_DIR/.logs/ci-owned.lock"
lock_smoke_critical="$ROOT_DIR/.logs/ci-owned.critical"
cleanup() {
  ./stop.sh >/dev/null 2>&1 || true
  if [[ -n "$current_runner_pid" ]] && kill -0 "$current_runner_pid" 2>/dev/null; then
    kill "$current_runner_pid" 2>/dev/null || true
  fi
  if [[ -n "$foreign_listener_pid" ]] && kill -0 "$foreign_listener_pid" 2>/dev/null; then
    kill "$foreign_listener_pid" 2>/dev/null || true
  fi
  rm -f "$lock_smoke_file"
  rmdir "$lock_smoke_critical" 2>/dev/null || true
}
trap cleanup EXIT

assert_stopped() {
  local port runtime_artifact
  for port in 27182 27184 9090; do
    if port_is_open "$port"; then
      echo "crash recovery後も${port}番portが使用されています。" >&2
      return 1
    fi
  done
  for runtime_artifact in \
    .logs/frontend.pid .logs/frontend.pgid .logs/frontend.token .logs/frontend.session_ready .logs/frontend.bootstrap.pid .logs/frontend.bootstrap.owner .logs/frontend.bootstrap.token \
    .logs/optional_llm.pid .logs/optional_llm.pgid .logs/optional_llm.token .logs/optional_llm.session_ready .logs/optional_llm.bootstrap.pid .logs/optional_llm.bootstrap.owner .logs/optional_llm.bootstrap.token \
    .logs/ros_backend.pid .logs/ros_backend.pgid .logs/ros_backend.token .logs/ros_backend.session_ready .logs/ros_bootstrap.pid .logs/ros_bootstrap.owner .logs/ros_bootstrap.token \
    .logs/runtime_owner .logs/runtime_processing .logs/runtime_target; do
    if [[ -e "$runtime_artifact" ]]; then
      echo "crash recovery後もruntime台帳が残っています: $runtime_artifact" >&2
      return 1
    fi
  done
  [[ ! -s .logs/lifecycle.lock && ! -s .logs/runtime.lock ]]
}

exercise_group_leader_failure() {
  local service="$1"
  local kind="$service"
  local runner_pid service_pid ready
  mkdir -p .logs
  if [[ "$service" == "optional_llm" ]]; then
    ROS2_VISUAL_LLM_ENABLED=1 ROS2_VISUAL_LLM_MODEL=ci-model ROS2_VISUAL_NO_OPEN=1 \
      ./run.sh --sim >".logs/ci-${service}-bootstrap.log" 2>&1 &
  else
    ROS2_VISUAL_NO_OPEN=1 ./run.sh --sim >".logs/ci-${service}-bootstrap.log" 2>&1 &
  fi
  runner_pid=$!
  current_runner_pid="$runner_pid"

  ready=0
  for _ in {1..100}; do
    if port_is_open 27182 && [[ -f ".logs/${service}.pid" ]]; then ready=1; break; fi
    if ! kill -0 "$runner_pid" 2>/dev/null; then break; fi
    sleep .1
  done
  if [[ "$ready" != "1" ]]; then
    tail -n 50 ".logs/ci-${service}-bootstrap.log" >&2 || true
    echo "${service} group leader crash recovery smokeを開始できませんでした。" >&2
    return 1
  fi
  service_pid="$(<".logs/${service}.pid")"
  if ! process_is_owned "$service_pid" "$kind"; then
    echo "${service} group leaderの所有を確認できません: PID $service_pid" >&2
    return 1
  fi
  kill -KILL "$service_pid"

  for _ in {1..100}; do
    if ! kill -0 "$runner_pid" 2>/dev/null; then break; fi
    sleep .1
  done
  if kill -0 "$runner_pid" 2>/dev/null; then
    echo "group leader停止後もlauncherが終了しません: PID $runner_pid" >&2
    return 1
  fi
  set +e
  wait "$runner_pid"
  set -e
  ./stop.sh >/dev/null
  for _ in {1..100}; do
    if ! port_is_open 27182 && ! port_is_open 27184 && ! port_is_open 9090; then break; fi
    sleep .1
  done
  assert_stopped
  current_runner_pid=""
}

exercise_owned_lock() {
  local contender_pid
  local contender_pids=()
  mkdir -p .logs
  rm -f "$lock_smoke_file"
  rmdir "$lock_smoke_critical" 2>/dev/null || true

  printf 'stale-metadata\n' > "$lock_smoke_file"
  acquire_owned_lock "$lock_smoke_file" 3 "CI stale検証" 7
  [[ "$(<"$lock_smoke_file")" == "$$" ]]
  release_owned_lock "$lock_smoke_file" 7

  for _ in {1..16}; do
    bash -c '
      set -euo pipefail
      PROCESS_ROOT="$1"
      source "$PROCESS_ROOT/scripts/process_helpers.sh"
      acquire_owned_lock "$2" 800 "CI競合検証" 7
      if ! mkdir "$3" 2>/dev/null; then
        release_owned_lock "$2" 7
        exit 1
      fi
      sleep .02
      rmdir "$3"
      release_owned_lock "$2" 7
    ' _ "$ROOT_DIR" "$lock_smoke_file" "$lock_smoke_critical" &
    contender_pids+=("$!")
  done
  for contender_pid in "${contender_pids[@]}"; do wait "$contender_pid"; done
  [[ ! -s "$lock_smoke_file" && ! -e "$lock_smoke_critical" ]]
}

exercise_pre_ready_owner_failure() {
  local runner_pid bootstrap_pid ready
  ROS2_VISUAL_TEST_READY_DELAY_MS=3000 ROS2_VISUAL_LLM_ENABLED=1 ROS2_VISUAL_LLM_MODEL=ci-model ROS2_VISUAL_NO_OPEN=1 \
    ./run.sh --sim >.logs/ci-pre-ready-owner.log 2>&1 &
  runner_pid=$!
  current_runner_pid="$runner_pid"
  ready=0
  for _ in {1..100}; do
    if [[ -f .logs/optional_llm.bootstrap.pid && ! -e .logs/optional_llm.session_ready ]]; then ready=1; break; fi
    if ! kill -0 "$runner_pid" 2>/dev/null; then break; fi
    sleep .02
  done
  if [[ "$ready" != "1" ]]; then
    tail -n 50 .logs/ci-pre-ready-owner.log >&2 || true
    echo "pre-ready owner crash recovery smokeを開始できませんでした。" >&2
    return 1
  fi
  bootstrap_pid="$(<.logs/optional_llm.bootstrap.pid)"
  kill -KILL "$runner_pid"
  set +e
  wait "$runner_pid" 2>/dev/null
  set -e
  ./stop.sh >/dev/null
  if process_is_running "$bootstrap_pid"; then
    echo "dead ownerのpre-ready bootstrapが残っています: PID $bootstrap_pid" >&2
    return 1
  fi
  assert_stopped
  current_runner_pid=""
}

exercise_ros_group_leader_failure() {
  local runner_pid ros_pid replacement_pid ready http_code runtime_state websocket_status
  ROS2_VISUAL_NO_OPEN=1 ./run.sh --ros >.logs/ci-ros-group-leader.log 2>&1 &
  runner_pid=$!
  current_runner_pid="$runner_pid"
  ready=0
  for _ in {1..120}; do
    if port_is_open 27182 && port_is_open 9090 && [[ -f .logs/ros_backend.pid ]]; then ready=1; break; fi
    if ! kill -0 "$runner_pid" 2>/dev/null; then break; fi
    sleep 1
  done
  if [[ "$ready" != "1" ]]; then
    tail -n 60 .logs/ci-ros-group-leader.log >&2 || true
    echo "ROS group leader crash recovery smokeを開始できませんでした。" >&2
    return 1
  fi
  ros_pid="$(<.logs/ros_backend.pid)"
  if ! process_is_owned "$ros_pid" ros_backend; then
    echo "ROS group leaderの所有を確認できません: PID $ros_pid" >&2
    return 1
  fi
  websocket_status="$(./scripts/pixi.sh run node scripts/websocket_upgrade_probe.mjs \
    127.0.0.1 9090 / http://example.invalid)"
  if [[ "$websocket_status" != "HTTP/1.1 403 "* ]]; then
    echo "rosbridge本体がcross-origin接続を拒否しませんでした: $websocket_status" >&2
    return 1
  fi
  websocket_status="$(./scripts/pixi.sh run node scripts/websocket_upgrade_probe.mjs \
    127.0.0.1 9090 / -)"
  if [[ "$websocket_status" != "HTTP/1.1 403 "* ]]; then
    echo "rosbridge本体がOriginなし接続を拒否しませんでした: $websocket_status" >&2
    return 1
  fi
  websocket_status="$(./scripts/pixi.sh run node scripts/websocket_upgrade_probe.mjs \
    127.0.0.1 27182 /rosbridge http://127.0.0.1:27182)"
  if [[ "$websocket_status" != "HTTP/1.1 101 "* ]]; then
    echo "同一Originのrosbridge proxy接続を確立できませんでした: $websocket_status" >&2
    return 1
  fi
  http_code="$(curl -sS --max-time 2 -o .logs/ci-runtime-switch.json -w '%{http_code}' \
    -X POST -H 'Origin: http://127.0.0.1:27182' -H 'Content-Type: application/json' \
    --data '{"mode":"base"}' http://127.0.0.1:27182/api/runtime)"
  if [[ "$http_code" != "202" ]]; then
    echo "同一Originのruntime切替を開始できませんでした: $http_code" >&2
    return 1
  fi
  replacement_pid=""
  for _ in {1..120}; do
    replacement_pid="$(cat .logs/ros_backend.pid 2>/dev/null || true)"
    if [[ "$replacement_pid" =~ ^[1-9][0-9]*$ && "$replacement_pid" != "$ros_pid" \
      && ! -e .logs/runtime_processing ]] && process_is_running "$replacement_pid"; then
      break
    fi
    if ! kill -0 "$runner_pid" 2>/dev/null; then break; fi
    sleep .5
  done
  if [[ ! "$replacement_pid" =~ ^[1-9][0-9]*$ || "$replacement_pid" == "$ros_pid" \
    || ! -e .logs/ros_backend.session_ready ]] || ! kill -0 "$runner_pid" 2>/dev/null; then
    tail -n 60 .logs/ci-ros-group-leader.log >&2 || true
    echo "runtime切替後の新しいROS generationを確認できませんでした。" >&2
    return 1
  fi
  kill -KILL "$replacement_pid"
  for _ in {1..120}; do
    if ! port_is_open 9090; then break; fi
    sleep .1
  done
  if ! kill -0 "$runner_pid" 2>/dev/null || ! port_is_open 27182 || port_is_open 9090; then
    echo "ROS group leader停止後にFrontendを維持してSIMへ戻せませんでした。" >&2
    return 1
  fi
  runtime_state=""
  for _ in {1..50}; do
    runtime_state="$(curl -fsS --max-time 2 http://127.0.0.1:27182/api/runtime 2>/dev/null || true)"
    if [[ "$runtime_state" == *'"mode":"sim"'* ]]; then break; fi
    if ! kill -0 "$runner_pid" 2>/dev/null; then break; fi
    sleep .1
  done
  if [[ "$runtime_state" != *'"mode":"sim"'* ]]; then
    echo "ROS group leader停止後のruntime状態がSIMへ収束しませんでした: $runtime_state" >&2
    return 1
  fi
  ./stop.sh >/dev/null
  wait "$runner_pid" 2>/dev/null || true
  for _ in {1..100}; do
    if ! port_is_open 27182 && ! port_is_open 27184 && ! port_is_open 9090; then break; fi
    sleep .1
  done
  assert_stopped
  current_runner_pid=""
}

exercise_optional_llm_failure() {
  local runner_pid optional_pid ready runtime_state
  ROS2_VISUAL_LLM_ENABLED=1 ROS2_VISUAL_LLM_MODEL=ci-model ROS2_VISUAL_NO_OPEN=1 \
    ./run.sh --sim >.logs/ci-optional-llm-failure.log 2>&1 &
  runner_pid=$!
  current_runner_pid="$runner_pid"
  ready=0
  for _ in {1..120}; do
    if port_is_open 27182 && port_is_open 27184 \
      && [[ -f .logs/frontend.pid && -f .logs/optional_llm.pid ]]; then
      ready=1
      break
    fi
    if ! kill -0 "$runner_pid" 2>/dev/null; then break; fi
    sleep .1
  done
  if [[ "$ready" != "1" ]]; then
    tail -n 60 .logs/ci-optional-llm-failure.log >&2 || true
    echo "Optional Local LLM failure smokeを開始できませんでした。" >&2
    return 1
  fi
  optional_pid="$(<.logs/optional_llm.pid)"
  kill -KILL "$optional_pid"
  for _ in {1..100}; do
    if ! process_is_running "$optional_pid"; then break; fi
    sleep .1
  done
  sleep .5
  if process_is_running "$optional_pid" || ! kill -0 "$runner_pid" 2>/dev/null \
    || ! port_is_open 27182; then
    echo "Optional Local LLM停止時にFrontend/launcherが継続しませんでした。" >&2
    return 1
  fi
  runtime_state="$(curl -fsS --max-time 2 http://127.0.0.1:27182/api/runtime)"
  if [[ "$runtime_state" != *'"mode":"sim"'* ]]; then
    echo "Optional Local LLM停止後にSIM runtimeが継続しませんでした: $runtime_state" >&2
    return 1
  fi
  ./stop.sh >/dev/null
  wait "$runner_pid" 2>/dev/null || true
  for _ in {1..100}; do
    if ! port_is_open 27182 && ! port_is_open 27184 && ! port_is_open 9090; then break; fi
    sleep .1
  done
  assert_stopped
  current_runner_pid=""
}

exercise_runtime_worker_failure() {
  local runner_pid runtime_pid ready recovered http_code runtime_state
  ROS2_VISUAL_TEST_RUNTIME_DELAY_MS=3000 ROS2_VISUAL_NO_OPEN=1 \
    ./run.sh --ros >.logs/ci-runtime-worker.log 2>&1 &
  runner_pid=$!
  current_runner_pid="$runner_pid"
  ready=0
  for _ in {1..120}; do
    if port_is_open 27182 && port_is_open 9090 && [[ -f .logs/ros_backend.pid ]]; then ready=1; break; fi
    if ! kill -0 "$runner_pid" 2>/dev/null; then break; fi
    sleep 1
  done
  if [[ "$ready" != "1" ]]; then
    tail -n 60 .logs/ci-runtime-worker.log >&2 || true
    echo "runtime worker crash recovery smokeを開始できませんでした。" >&2
    return 1
  fi
  http_code="$(curl -sS --max-time 2 -o .logs/ci-runtime-worker-switch.json -w '%{http_code}' \
    -X POST -H 'Origin: http://127.0.0.1:27182' -H 'Content-Type: application/json' \
    --data '{"mode":"base"}' http://127.0.0.1:27182/api/runtime)"
  if [[ "$http_code" != "202" ]]; then
    echo "runtime worker切替を開始できませんでした: $http_code" >&2
    return 1
  fi
  runtime_pid=""
  for _ in {1..250}; do
    runtime_pid="$(cat .logs/runtime.lock 2>/dev/null || true)"
    if [[ -e .logs/runtime_processing && "$runtime_pid" =~ ^[1-9][0-9]*$ ]] \
      && process_is_running "$runtime_pid" && process_is_owned "$runtime_pid" runtime_operation; then
      break
    fi
    sleep .02
  done
  if [[ ! "$runtime_pid" =~ ^[1-9][0-9]*$ ]] || ! process_is_owned "$runtime_pid" runtime_operation; then
    echo "runtime workerのkernel lock所有者を確認できませんでした。" >&2
    return 1
  fi
  kill -KILL "$runtime_pid"
  recovered=0
  runtime_state=""
  for _ in {1..150}; do
    runtime_state="$(curl -fsS --max-time 2 http://127.0.0.1:27182/api/runtime 2>/dev/null || true)"
    if [[ "$runtime_state" == *'"mode":"sim"'* && ! -e .logs/runtime_processing ]] \
      && ! port_is_open 9090; then
      recovered=1
      break
    fi
    if ! kill -0 "$runner_pid" 2>/dev/null; then break; fi
    sleep .1
  done
  if [[ "$recovered" != "1" ]] || ! port_is_open 27182; then
    tail -n 60 .logs/ci-runtime-worker.log >&2 || true
    echo "停止したruntime workerを回収してSIMへ戻せませんでした: $runtime_state" >&2
    return 1
  fi
  http_code="$(curl -sS --max-time 2 -o .logs/ci-runtime-worker-retry.json -w '%{http_code}' \
    -X POST -H 'Origin: http://127.0.0.1:27182' -H 'Content-Type: application/json' \
    --data '{"mode":"base"}' http://127.0.0.1:27182/api/runtime)"
  if [[ "$http_code" != "202" ]]; then
    echo "回収後のruntime切替を再開できませんでした: $http_code" >&2
    return 1
  fi
  ready=0
  for _ in {1..300}; do
    runtime_state="$(curl -fsS --max-time 2 http://127.0.0.1:27182/api/runtime 2>/dev/null || true)"
    if [[ "$runtime_state" == *'"mode":"base"'* \
      && "$runtime_state" == *'"processing":false'* \
      && "$runtime_state" == *'"backendAlive":true'* ]] && port_is_open 9090; then
      ready=1
      break
    fi
    if ! kill -0 "$runner_pid" 2>/dev/null; then break; fi
    sleep .1
  done
  if [[ "$ready" != "1" ]]; then
    echo "回収後のruntime切替がreadyになりませんでした: $runtime_state" >&2
    return 1
  fi
  ./stop.sh >/dev/null
  wait "$runner_pid" 2>/dev/null || true
  assert_stopped
  current_runner_pid=""
}

exercise_generation_sentinel_failure() {
  local kind="$1"
  local launch_flag="$2"
  local runner_pid leader_pid group_id generation_token sentinel_pid ready runner_status member_pid
  if [[ "$kind" == "optional_llm" ]]; then
    ROS2_VISUAL_LLM_ENABLED=1 ROS2_VISUAL_LLM_MODEL=ci-model ROS2_VISUAL_NO_OPEN=1 \
      ./run.sh "$launch_flag" >".logs/ci-${kind}-sentinel.log" 2>&1 &
  else
    ROS2_VISUAL_NO_OPEN=1 ./run.sh "$launch_flag" >".logs/ci-${kind}-sentinel.log" 2>&1 &
  fi
  runner_pid=$!
  current_runner_pid="$runner_pid"
  ready=0
  for _ in {1..120}; do
    if port_is_open 27182 \
      && { [[ "$kind" != "optional_llm" ]] || port_is_open 27184; } \
      && [[ -f ".logs/${kind}.pid" ]] \
      && { [[ "$kind" != "ros_backend" ]] || port_is_open 9090; }; then
      ready=1
      break
    fi
    if ! kill -0 "$runner_pid" 2>/dev/null; then break; fi
    sleep .1
  done
  if [[ "$ready" != "1" ]]; then
    tail -n 60 ".logs/ci-${kind}-sentinel.log" >&2 || true
    echo "${kind} sentinel failure smokeを開始できませんでした。" >&2
    return 1
  fi
  leader_pid="$(<".logs/${kind}.pid")"
  group_id="$(<".logs/${kind}.pgid")"
  generation_token="$(<".logs/${kind}.token")"
  sentinel_pid=""
  collect_process_group "$group_id"
  for member_pid in "${PROCESS_GROUP_MEMBERS[@]}"; do
    if process_is_generation_sentinel "$member_pid" "$kind" "$generation_token"; then
      sentinel_pid="$member_pid"
      break
    fi
  done
  if [[ ! "$sentinel_pid" =~ ^[1-9][0-9]*$ ]]; then
    echo "${kind} generation sentinelを確認できませんでした。" >&2
    return 1
  fi
  kill -KILL "$sentinel_pid"
  for _ in {1..50}; do
    if ! process_is_running "$sentinel_pid"; then break; fi
    sleep .02
  done
  if ! process_is_running "$leader_pid" \
    || ! process_group_has_generation_identity "$group_id" "$kind" "$generation_token"; then
    echo "${kind} leader generation anchorがsentinel単独停止後に残りませんでした。" >&2
    return 1
  fi
  if ! port_is_open 27182 \
    || { [[ "$kind" == "optional_llm" ]] && ! port_is_open 27184; } \
    || { [[ "$kind" == "ros_backend" ]] && ! port_is_open 9090; }; then
    echo "${kind} sentinel単独停止でmanaged serviceが停止しました。" >&2
    return 1
  fi
  ./stop.sh >/dev/null
  set +e
  wait "$runner_pid" 2>/dev/null
  runner_status=$?
  set -e
  if [[ "$runner_status" != "0" ]]; then
    echo "${kind} sentinel単独停止後のlauncher終了statusが不正です: $runner_status" >&2
    return 1
  fi
  assert_stopped
  current_runner_pid=""
}

exercise_foreign_rosbridge_listener() {
  local foreign_cwd="$ROOT_DIR/.logs/foreign-listener-cwd"
  local runtime_exit=0
  mkdir -p "$foreign_cwd"
  (
    cd "$foreign_cwd"
    exec "$ROOT_DIR/.pixi/envs/default/bin/python" -m http.server 9090 --bind 127.0.0.1
  ) >.logs/ci-foreign-listener.log 2>&1 &
  foreign_listener_pid=$!
  for _ in {1..50}; do
    if port_is_open 9090; then break; fi
    sleep .1
  done
  if ! port_is_open 9090; then
    echo "foreign 9090 listenerを開始できませんでした。" >&2
    return 1
  fi
  set +e
  ./scripts/runtime.sh start base >.logs/ci-foreign-runtime.log 2>&1
  runtime_exit=$?
  set -e
  if [[ "$runtime_exit" == "0" ]]; then
    echo "foreign 9090 listenerをROS backendとして受理してしまいました。" >&2
    return 1
  fi
  if ! kill -0 "$foreign_listener_pid" 2>/dev/null; then
    echo "foreign 9090 listenerを停止してしまいました。" >&2
    return 1
  fi
  kill "$foreign_listener_pid"
  wait "$foreign_listener_pid" 2>/dev/null || true
  foreign_listener_pid=""
  rmdir "$foreign_cwd"
  ./scripts/runtime.sh stop >/dev/null
  assert_stopped
}

assert_stopped
exercise_owned_lock
exercise_foreign_rosbridge_listener
exercise_pre_ready_owner_failure
exercise_group_leader_failure frontend
exercise_optional_llm_failure
exercise_runtime_worker_failure
exercise_ros_group_leader_failure
exercise_generation_sentinel_failure frontend --sim
exercise_generation_sentinel_failure optional_llm --sim
exercise_generation_sentinel_failure ros_backend --ros
trap - EXIT
echo "Managed process crash recovery smoke: PASS"
