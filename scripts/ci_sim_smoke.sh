#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"
PROCESS_ROOT="$ROOT_DIR"
# shellcheck source=scripts/process_helpers.sh
source "$ROOT_DIR/scripts/process_helpers.sh"

if curl -fsS --max-time 1 http://127.0.0.1:27182/ >/dev/null 2>&1; then
  echo "27182番portは既に使用されています。" >&2
  exit 1
fi

mkdir -p .logs
ROS2_VISUAL_NO_OPEN=1 ./run.sh --sim >.logs/ci-sim.log 2>&1 &
runner_pid=$!

cleanup() {
  ./stop.sh >/dev/null 2>&1 || true
  if kill -0 "$runner_pid" 2>/dev/null; then kill "$runner_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

ready=0
for _ in {1..30}; do
  if curl -fsS --max-time 2 http://127.0.0.1:27182/ >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$runner_pid" 2>/dev/null; then break; fi
  sleep 1
done

if [[ "$ready" != "1" ]]; then
  tail -n 40 .logs/ci-sim.log >&2 || true
  echo "SIM frontendが起動しませんでした。" >&2
  exit 1
fi

for port in 27182 27184; do
  if command -v lsof >/dev/null 2>&1; then
    listener_output="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -Fn | sed -n 's/^n//p')"
  elif command -v ss >/dev/null 2>&1; then
    listener_output="$(ss -H -ltn "sport = :$port" | awk '{print $4}')"
  else
    echo "listener確認用のlsofまたはssがありません。" >&2
    exit 1
  fi

  if [[ -z "$listener_output" ]]; then
    echo "$listener_output" >&2
    echo "${port}番portのloopback listenerを確認できません。" >&2
    exit 1
  fi
  while IFS= read -r listener_address; do
    if [[ "$listener_address" != "127.0.0.1:${port}" ]]; then
      echo "$listener_output" >&2
      echo "${port}番portがloopback以外で待受しています: $listener_address" >&2
      exit 1
    fi
  done <<< "$listener_output"
done

curl -fsS --max-time 2 http://127.0.0.1:27182/api/runtime | grep -q '"mode":"sim"'

cross_origin_ws="$(./scripts/pixi.sh run node scripts/websocket_upgrade_probe.mjs \
  127.0.0.1 27182 /rosbridge http://example.invalid)"
if [[ "$cross_origin_ws" != "HTTP/1.1 404 "* ]]; then
  echo "cross-origin WebSocketが拒否されませんでした: $cross_origin_ws" >&2
  exit 1
fi
missing_origin_ws="$(./scripts/pixi.sh run node scripts/websocket_upgrade_probe.mjs \
  127.0.0.1 27182 /rosbridge -)"
if [[ "$missing_origin_ws" != "HTTP/1.1 404 "* ]]; then
  echo "OriginなしWebSocketが拒否されませんでした: $missing_origin_ws" >&2
  exit 1
fi

missing_origin_status="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' \
  -X POST http://127.0.0.1:27182/api/shutdown)"
if [[ "$missing_origin_status" != "403" ]]; then
  echo "Originなしshutdown要求が拒否されませんでした: $missing_origin_status" >&2
  exit 1
fi

rejected_status="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' \
  -X POST -H 'Origin: https://127.0.0.1:27182' http://127.0.0.1:27182/api/shutdown)"
if [[ "$rejected_status" != "403" ]]; then
  echo "HTTPS Originのshutdown要求が拒否されませんでした: $rejected_status" >&2
  exit 1
fi
accepted_status="$(curl -sS --max-time 2 -o .logs/ci-shutdown-response.json -w '%{http_code}' \
  -X POST -H 'Origin: http://127.0.0.1:27182' http://127.0.0.1:27182/api/shutdown)"
if [[ "$accepted_status" != "202" ]]; then
  cat .logs/ci-shutdown-response.json >&2 || true
  echo "同一Originのshutdown要求が受理されませんでした: $accepted_status" >&2
  exit 1
fi

for _ in {1..100}; do
  any_open=0
  for port in 27182 27184 9090; do
    if port_is_open "$port"; then any_open=1; fi
  done
  [[ "$any_open" == "0" ]] && break
  sleep .1
done
set +e
wait "$runner_pid"
runner_status=$?
set -e
if [[ "$runner_status" != "0" ]]; then
  echo "通常shutdown後のSIM launcherが0以外で終了しました: $runner_status" >&2
  exit 1
fi
for _ in {1..100}; do
  if [[ ! -e .logs/frontend.pid && ! -e .logs/optional_llm.pid \
    && ! -e .logs/ros_backend.pid && ! -s .logs/lifecycle.lock && ! -s .logs/runtime.lock ]]; then
    break
  fi
  sleep .05
done
for port in 27182 27184 9090; do
  if port_is_open "$port"; then
    echo "停止後も${port}番portが使用されています。" >&2
    exit 1
  fi
done
for runtime_artifact in \
  .logs/frontend.pid .logs/frontend.pgid .logs/frontend.token .logs/frontend.session_ready .logs/frontend.bootstrap.pid .logs/frontend.bootstrap.owner .logs/frontend.bootstrap.token \
  .logs/optional_llm.pid .logs/optional_llm.pgid .logs/optional_llm.token .logs/optional_llm.session_ready .logs/optional_llm.bootstrap.pid .logs/optional_llm.bootstrap.owner .logs/optional_llm.bootstrap.token \
  .logs/ros_backend.pid .logs/ros_backend.pgid .logs/ros_backend.token .logs/ros_backend.session_ready .logs/ros_bootstrap.pid .logs/ros_bootstrap.owner .logs/ros_bootstrap.token \
  .logs/runtime_owner .logs/runtime_processing .logs/runtime_target; do
  if [[ -e "$runtime_artifact" ]]; then
    echo "停止後もruntime台帳が残っています: $runtime_artifact" >&2
    exit 1
  fi
done
for lock_dir in .logs/lifecycle.lock .logs/runtime.lock; do
  if [[ -s "$lock_dir" ]]; then
    echo "停止後もactive lock metadataが残っています: $lock_dir" >&2
    exit 1
  fi
done
trap - EXIT
echo "SIM loopback/API shutdown smoke: PASS"
