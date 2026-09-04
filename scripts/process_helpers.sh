#!/usr/bin/env bash

# Shared process helpers. The caller must set PROCESS_ROOT to a physical path.

process_cwd() {
  local target_pid="$1"
  if [[ -L "/proc/${target_pid}/cwd" ]]; then
    readlink "/proc/${target_pid}/cwd" 2>/dev/null || true
  elif command -v lsof >/dev/null 2>&1; then
    lsof -a -p "$target_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true
  fi
}

process_command() {
  ps -p "$1" -o command= 2>/dev/null || true
}

process_is_running() {
  local target_pid="$1"
  local state
  state="$(ps -p "$target_pid" -o stat= 2>/dev/null | tr -d '[:space:]' || true)"
  [[ -n "$state" && "$state" != Z* ]]
}

port_is_open() {
  local port="$1"
  (exec 3<>"/dev/tcp/127.0.0.1/${port}") >/dev/null 2>&1
}

port_listener_pids() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u
  elif command -v ss >/dev/null 2>&1; then
    ss -H -ltnp "sport = :$port" 2>/dev/null \
      | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' \
      | sort -u
  else
    return 1
  fi
}

port_listener_is_owned_by_process_group() {
  local port="$1"
  local expected_pgid="$2"
  local expected_token="$3"
  local kind="$4"
  local listener_output listener_pid listener_pgid listener_cwd listener_command found
  listener_output="$(port_listener_pids "$port")" || return 1
  [[ -n "$listener_output" ]] || return 1
  process_group_has_generation_identity "$expected_pgid" "$kind" "$expected_token" || return 1
  found=0
  while IFS= read -r listener_pid; do
    [[ "$listener_pid" =~ ^[1-9][0-9]*$ ]] || return 1
    found=1
    listener_pgid="$(ps -p "$listener_pid" -o pgid= 2>/dev/null | tr -d '[:space:]' || true)"
    listener_cwd="$(process_cwd "$listener_pid")"
    listener_command="$(process_command "$listener_pid")"
    [[ "$listener_pgid" == "$expected_pgid" && "$listener_cwd" == "$PROCESS_ROOT" ]] || return 1
    process_group_has_marker "$kind" "$listener_command" || return 1
  done <<< "$listener_output"
  [[ "$found" == "1" ]]
}

process_matches_kind() {
  local kind="$1"
  local command_line="$2"
  case "$kind:$command_line" in
    frontend:*vite*|frontend:*npm*run*dev*|frontend:*service_process_supervisor.py*frontend*) return 0 ;;
    optional_llm:*ros2_visual_backend.optional_llm_server*|optional_llm:*service_process_supervisor.py*optional_llm*) return 0 ;;
    frontend_bootstrap:*service_process_supervisor.py*frontend*) return 0 ;;
    optional_llm_bootstrap:*service_process_supervisor.py*optional_llm*) return 0 ;;
    ros_bootstrap:*ros_process_supervisor.py*) return 0 ;;
    ros_backend:*ros_process_supervisor.py*|ros_backend:*ros2_visual_backend.launcher*|ros_backend:*pixi*run*ros-*) return 0 ;;
    runtime_owner:*start.sh*) return 0 ;;
    runtime_operation:*scripts/runtime.sh*) return 0 ;;
    frontend_bootstrap_owner:*start.sh*|optional_llm_bootstrap_owner:*start.sh*) return 0 ;;
    ros_bootstrap_owner:*scripts/runtime.sh*start*) return 0 ;;
    *) return 1 ;;
  esac
}

process_is_owned() {
  local target_pid="$1"
  local kind="$2"
  local command_line working_directory
  command_line="$(process_command "$target_pid")"
  working_directory="$(process_cwd "$target_pid")"
  [[ -n "$command_line" ]] || return 1
  # Exact physical cwd is the ownership boundary. A command-line substring is
  # insufficient because a sibling clone may share this repository's prefix.
  [[ "$working_directory" == "$PROCESS_ROOT" ]] || return 1
  process_matches_kind "$kind" "$command_line"
}

PROCESS_TREE=()
collect_process_tree() {
  local parent_pid="$1"
  local excluded_pid="${2:-0}"
  local child_pid
  while IFS= read -r child_pid; do
    [[ -n "$child_pid" ]] || continue
    if [[ "$child_pid" == "$excluded_pid" ]]; then
      continue
    fi
    collect_process_tree "$child_pid" "$excluded_pid"
  done < <(ps -axo pid=,ppid= | awk -v parent="$parent_pid" '$2 == parent { print $1 }')
  if [[ "$parent_pid" != "$excluded_pid" ]]; then
    PROCESS_TREE+=("$parent_pid")
  fi
}

terminate_recorded_tree() {
  local pid_file="$1"
  local kind="$2"
  local excluded_pid="${3:-0}"
  local target_pid
  [[ -f "$pid_file" ]] || return 0
  target_pid="$(<"$pid_file")"
  if [[ ! "$target_pid" =~ ^[1-9][0-9]*$ ]] || ! process_is_running "$target_pid"; then
    rm -f "$pid_file"
    return 0
  fi
  if ! process_is_owned "$target_pid" "$kind"; then
    echo "所有を確認できないprocessは停止しません: PID $target_pid ($kind)" >&2
    return 1
  fi

  PROCESS_TREE=()
  collect_process_tree "$target_pid" "$excluded_pid"
  if (( ${#PROCESS_TREE[@]} > 0 )); then
    kill "${PROCESS_TREE[@]}" 2>/dev/null || true
  fi
  local attempt pid running
  for attempt in {1..25}; do
    running=0
    for pid in "${PROCESS_TREE[@]}"; do
      if process_is_running "$pid"; then running=1; fi
    done
    [[ "$running" == "0" ]] && break
    sleep .2
  done
  local remaining=()
  for pid in "${PROCESS_TREE[@]}"; do
    if process_is_running "$pid"; then remaining+=("$pid"); fi
  done
  if (( ${#remaining[@]} > 0 )); then
    kill -KILL "${remaining[@]}" 2>/dev/null || true
    for attempt in {1..10}; do
      running=0
      for pid in "${remaining[@]}"; do
        if process_is_running "$pid"; then running=1; fi
      done
      [[ "$running" == "0" ]] && break
      sleep .1
    done
  fi
  for pid in "${PROCESS_TREE[@]}"; do
    if process_is_running "$pid"; then
      echo "processを停止できませんでした: PID $pid ($kind)" >&2
      return 1
    fi
  done
  rm -f "$pid_file"
}

terminate_runtime_owner_children() {
  local owner_file="$1"
  local excluded_pid="${2:-0}"
  local owner_pid child_pid attempt pid running
  [[ -f "$owner_file" ]] || return 0
  owner_pid="$(<"$owner_file")"
  if [[ ! "$owner_pid" =~ ^[1-9][0-9]*$ ]] || ! process_is_running "$owner_pid"; then
    rm -f "$owner_file"
    return 0
  fi
  if ! process_is_owned "$owner_pid" runtime_owner; then
    echo "runtime ownerを確認できません: PID $owner_pid" >&2
    return 1
  fi

  # Remove the marker before waking start.sh so its EXIT trap does not launch a
  # second stop operation. The lifecycle lock prevents further startup spawns.
  rm -f "$owner_file"
  PROCESS_TREE=()
  while IFS= read -r child_pid; do
    [[ -n "$child_pid" ]] || continue
    if [[ "$child_pid" != "$excluded_pid" ]]; then collect_process_tree "$child_pid" "$excluded_pid"; fi
  done < <(ps -axo pid=,ppid= | awk -v parent="$owner_pid" '$2 == parent { print $1 }')
  if (( ${#PROCESS_TREE[@]} > 0 )); then kill "${PROCESS_TREE[@]}" 2>/dev/null || true; fi
  for attempt in {1..25}; do
    running=0
    for pid in "${PROCESS_TREE[@]}"; do if process_is_running "$pid"; then running=1; fi; done
    [[ "$running" == "0" ]] && break
    sleep .2
  done
  local remaining=()
  for pid in "${PROCESS_TREE[@]}"; do if process_is_running "$pid"; then remaining+=("$pid"); fi; done
  if (( ${#remaining[@]} > 0 )); then
    kill -KILL "${remaining[@]}" 2>/dev/null || true
    for attempt in {1..10}; do
      running=0
      for pid in "${remaining[@]}"; do if process_is_running "$pid"; then running=1; fi; done
      [[ "$running" == "0" ]] && break
      sleep .1
    done
  fi
  for pid in "${PROCESS_TREE[@]}"; do
    if process_is_running "$pid"; then
      echo "runtime ownerの子processを停止できませんでした: PID $pid" >&2
      return 1
    fi
  done
}

PROCESS_GROUP_MEMBERS=()
collect_process_group() {
  local target_pgid="$1"
  local member_pid
  PROCESS_GROUP_MEMBERS=()
  while IFS= read -r member_pid; do
    [[ -n "$member_pid" ]] || continue
    if process_is_running "$member_pid"; then PROCESS_GROUP_MEMBERS+=("$member_pid"); fi
  done < <(ps -axo pid=,pgid= | awk -v group="$target_pgid" '$2 == group { print $1 }')
}

process_group_has_marker() {
  local kind="$1"
  local command_line="$2"
  case "$kind:$command_line" in
    frontend:*vite*|frontend:*npm*run*dev*|frontend:*npm-cli.js*dev*|frontend:*service_process_supervisor.py*frontend*|frontend:*process_group_sentinel.py*frontend*) return 0 ;;
    optional_llm:*ros2_visual_backend.optional_llm_server*|optional_llm:*service_process_supervisor.py*optional_llm*|optional_llm:*process_group_sentinel.py*optional_llm*) return 0 ;;
    ros_backend:*ros_process_supervisor.py*|ros_backend:*ros2_visual_backend.*|ros_backend:*rosbridge_server*|ros_backend:*rosapi*|ros_backend:*static_transform_publisher*|ros_backend:*slam_toolbox*|ros_backend:*nav2_*|ros_backend:*map_server*|ros_backend:*map_saver*|ros_backend:*process_group_sentinel.py*ros_backend*) return 0 ;;
    *) return 1 ;;
  esac
}

process_is_generation_sentinel() {
  local target_pid="$1"
  local kind="$2"
  local expected_token="$3"
  local command_line
  command_line="$(process_command "$target_pid")"
  [[ "$command_line" == *process_group_sentinel.py*" ${kind} ${expected_token}"* ]]
}

process_is_generation_anchor() {
  local target_pid="$1"
  local kind="$2"
  local expected_token="$3"
  local command_line
  command_line="$(process_command "$target_pid")"
  case "$kind:$command_line" in
    frontend:*service_process_supervisor.py*frontend*" $expected_token "*) return 0 ;;
    optional_llm:*service_process_supervisor.py*optional_llm*" $expected_token "*) return 0 ;;
    ros_backend:*ros_process_supervisor.py*" $expected_token "*) return 0 ;;
    *) return 1 ;;
  esac
}

process_group_has_generation_identity() {
  local target_pgid="$1"
  local kind="$2"
  local expected_token="$3"
  local member_pid
  collect_process_group "$target_pgid"
  for member_pid in "${PROCESS_GROUP_MEMBERS[@]}"; do
    if [[ "$(process_cwd "$member_pid")" == "$PROCESS_ROOT" ]] \
      && { process_is_generation_sentinel "$member_pid" "$kind" "$expected_token" \
        || process_is_generation_anchor "$member_pid" "$kind" "$expected_token"; }; then
      return 0
    fi
  done
  return 1
}

process_matches_bootstrap_generation() {
  local target_pid="$1"
  local kind="$2"
  local bootstrap_token="$3"
  local bootstrap_owner="$4"
  local command_line working_directory
  command_line="$(process_command "$target_pid")"
  working_directory="$(process_cwd "$target_pid")"
  [[ "$working_directory" == "$PROCESS_ROOT" ]] || return 1
  case "$kind:$command_line" in
    frontend_bootstrap:*service_process_supervisor.py*frontend*" $bootstrap_token $bootstrap_owner"*) return 0 ;;
    optional_llm_bootstrap:*service_process_supervisor.py*optional_llm*" $bootstrap_token $bootstrap_owner"*) return 0 ;;
    ros_bootstrap:*ros_process_supervisor.py*" $bootstrap_token $bootstrap_owner"*) return 0 ;;
    *) return 1 ;;
  esac
}

terminate_recorded_process_group() {
  local pid_file="$1"
  local pgid_file="$2"
  local kind="$3"
  local ready_file="$4"
  local token_file="$5"
  local recorded_pid target_pgid ready_pid generation_token current_pgid
  if [[ ! -e "$pid_file" && ! -e "$pgid_file" && ! -e "$ready_file" && ! -e "$token_file" ]]; then
    return 0
  fi

  recorded_pid="$(cat "$pid_file" 2>/dev/null || true)"
  target_pgid="$(cat "$pgid_file" 2>/dev/null || true)"
  ready_pid="$(cat "$ready_file" 2>/dev/null || true)"
  generation_token="$(cat "$token_file" 2>/dev/null || true)"
  current_pgid="$(ps -p "$$" -o pgid= 2>/dev/null | tr -d '[:space:]' || true)"

  if [[ -z "$ready_pid" ]]; then
    # A token-bearing sentinel can recover the tiny interval between sentinel
    # creation and ready publication. Otherwise bootstrap ownership decides.
    if [[ "$recorded_pid" =~ ^[1-9][0-9]*$ && "$target_pgid" == "$recorded_pid" \
      && "$generation_token" =~ ^[0-9a-f]{32}$ && "$target_pgid" != "$current_pgid" ]] \
      && process_group_has_generation_identity "$target_pgid" "$kind" "$generation_token"; then
      :
    else
      return 0
    fi
  elif [[ ! "$recorded_pid" =~ ^[1-9][0-9]*$ || "$target_pgid" != "$recorded_pid" \
    || "$ready_pid" != "$recorded_pid" || ! "$generation_token" =~ ^[0-9a-f]{32}$ ]]; then
    echo "不完全なready process group台帳を自動回収しません: $kind" >&2
    return 1
  fi

  if [[ ! "$target_pgid" =~ ^[1-9][0-9]*$ || "$target_pgid" == "1" || "$target_pgid" == "$current_pgid" ]]; then
    echo "安全でないROS process group台帳を拒否しました: $target_pgid" >&2
    return 1
  fi

  collect_process_group "$target_pgid"
  if (( ${#PROCESS_GROUP_MEMBERS[@]} == 0 )); then
    rm -f "$pid_file" "$pgid_file" "$ready_file" "$token_file"
    return 0
  fi
  local member_pid working_directory command_line marker_found generation_found
  marker_found=0
  generation_found=0
  for member_pid in "${PROCESS_GROUP_MEMBERS[@]}"; do
    working_directory="$(process_cwd "$member_pid")"
    command_line="$(process_command "$member_pid")"
    if [[ "$working_directory" != "$PROCESS_ROOT" ]]; then
      echo "所有を確認できないprocess group memberは停止しません: PID $member_pid" >&2
      return 1
    fi
    if process_is_generation_sentinel "$member_pid" "$kind" "$generation_token" \
      || process_is_generation_anchor "$member_pid" "$kind" "$generation_token"; then
      generation_found=1
    fi
    if process_group_has_marker "$kind" "$command_line"; then marker_found=1; fi
  done
  if [[ "$generation_found" != "1" ]]; then
    echo "process group世代identityを確認できません: PGID $target_pgid ($kind)" >&2
    return 1
  fi
  if [[ "$marker_found" != "1" ]]; then
    echo "managed process groupの起動markerを確認できません: PGID $target_pgid ($kind)" >&2
    return 1
  fi

  kill -TERM -- "-$target_pgid" 2>/dev/null || true
  local attempt
  for attempt in {1..30}; do
    collect_process_group "$target_pgid"
    (( ${#PROCESS_GROUP_MEMBERS[@]} == 0 )) && break
    sleep .1
  done
  collect_process_group "$target_pgid"
  if (( ${#PROCESS_GROUP_MEMBERS[@]} > 0 )); then
    kill -KILL -- "-$target_pgid" 2>/dev/null || true
    for attempt in {1..10}; do
      collect_process_group "$target_pgid"
      (( ${#PROCESS_GROUP_MEMBERS[@]} == 0 )) && break
      sleep .1
    done
  fi
  collect_process_group "$target_pgid"
  if (( ${#PROCESS_GROUP_MEMBERS[@]} > 0 )); then
    echo "managed process groupを停止できませんでした: PGID $target_pgid ($kind)" >&2
    return 1
  fi
  rm -f "$pid_file" "$pgid_file" "$ready_file" "$token_file"
}

terminate_recorded_bootstrap() {
  local bootstrap_pid_file="$1"
  local bootstrap_owner_file="$2"
  local bootstrap_token_file="$3"
  local managed_pid_file="$4"
  local pgid_file="$5"
  local ready_file="$6"
  local token_file="$7"
  local bootstrap_kind="$8"
  local bootstrap_pid bootstrap_owner bootstrap_token managed_pid target_pgid
  [[ -e "$bootstrap_pid_file" || -e "$bootstrap_owner_file" || -e "$bootstrap_token_file" ]] || return 0
  bootstrap_pid="$(cat "$bootstrap_pid_file" 2>/dev/null || true)"
  bootstrap_owner="$(cat "$bootstrap_owner_file" 2>/dev/null || true)"
  bootstrap_token="$(cat "$bootstrap_token_file" 2>/dev/null || true)"

  if [[ ! "$bootstrap_pid" =~ ^[1-9][0-9]*$ ]] || ! process_is_running "$bootstrap_pid"; then
    target_pgid="$(cat "$pgid_file" 2>/dev/null || true)"
    if [[ "$target_pgid" =~ ^[1-9][0-9]*$ ]]; then
      collect_process_group "$target_pgid"
      if (( ${#PROCESS_GROUP_MEMBERS[@]} > 0 )); then
        echo "bootstrap消失後のprocess groupを自動回収しません: PGID $target_pgid ($bootstrap_kind)" >&2
        return 1
      fi
    fi
    rm -f "$bootstrap_pid_file" "$bootstrap_owner_file" "$bootstrap_token_file" "$managed_pid_file" "$pgid_file" "$ready_file" "$token_file"
    return 0
  fi
  if [[ -e "$ready_file" ]]; then
    echo "ready processのtokenless bootstrap停止を拒否しました: PID $bootstrap_pid" >&2
    return 1
  fi
  managed_pid="$(cat "$managed_pid_file" 2>/dev/null || true)"
  if [[ -n "$managed_pid" && "$managed_pid" != "$bootstrap_pid" ]]; then
    echo "bootstrap PIDとmanaged PIDが一致しません。" >&2
    return 1
  fi
  if [[ ! "$bootstrap_owner" =~ ^[1-9][0-9]*$ || ! "$bootstrap_token" =~ ^[0-9a-f]{32}$ ]]; then
    echo "bootstrap generation台帳を確認できません。" >&2
    return 1
  fi
  if ! process_matches_bootstrap_generation "$bootstrap_pid" "$bootstrap_kind" "$bootstrap_token" "$bootstrap_owner"; then
    echo "bootstrap世代所有権を確認できません: PID $bootstrap_pid" >&2
    return 1
  fi
  if ! terminate_recorded_tree "$bootstrap_pid_file" "$bootstrap_kind" "$$"; then return 1; fi
  rm -f "$bootstrap_owner_file" "$bootstrap_token_file" "$managed_pid_file" "$pgid_file" "$ready_file" "$token_file"
}

acquire_owned_lock() {
  local lock_file="$1"
  local attempts="${2:-200}"
  local label="${3:-処理}"
  local lock_fd="${4:-9}"
  local attempt lock_python
  lock_python="$PROCESS_ROOT/.pixi/envs/default/bin/python"
  if [[ ! -x "$lock_python" ]]; then lock_python="$(command -v python3 2>/dev/null || true)"; fi
  if [[ -z "$lock_python" ]]; then
    echo "${label}lockに必要なPythonが見つかりません。" >&2
    return 1
  fi
  mkdir -p "$(dirname "$lock_file")"
  (umask 077; : >> "$lock_file")
  case "$lock_fd" in
    7) exec 7<>"$lock_file" ;;
    8) exec 8<>"$lock_file" ;;
    9) exec 9<>"$lock_file" ;;
    *) echo "未対応のlock file descriptorです: $lock_fd" >&2; return 1 ;;
  esac
  for ((attempt = 0; attempt < attempts; attempt += 1)); do
    if "$lock_python" "$PROCESS_ROOT/scripts/lock_fd.py" acquire "$lock_fd" "$lock_file" "$$" 2>/dev/null; then
      return 0
    fi
    sleep .05
  done
  case "$lock_fd" in 7) exec 7>&- ;; 8) exec 8>&- ;; 9) exec 9>&- ;; esac
  echo "別の${label}が進行中です。完了を待ってから再実行してください。" >&2
  return 1
}

release_owned_lock() {
  local lock_file="$1"
  local lock_fd="${2:-9}"
  local lock_python="$PROCESS_ROOT/.pixi/envs/default/bin/python"
  if [[ ! -x "$lock_python" ]]; then lock_python="$(command -v python3 2>/dev/null || true)"; fi
  [[ -n "$lock_python" ]] || return 1
  "$lock_python" "$PROCESS_ROOT/scripts/lock_fd.py" release "$lock_fd" "$lock_file" "$$"
  case "$lock_fd" in 7) exec 7>&- ;; 8) exec 8>&- ;; 9) exec 9>&- ;; esac
}

validate_inherited_lock() {
  local lock_file="$1"
  local lock_fd="$2"
  local expected_owner="$3"
  local lock_python="$PROCESS_ROOT/.pixi/envs/default/bin/python"
  [[ -x "$lock_python" ]] || return 1
  "$lock_python" "$PROCESS_ROOT/scripts/lock_fd.py" validate "$lock_fd" "$lock_file" "$expected_owner"
}

kernel_lock_is_held() {
  local lock_file="$1"
  local lock_python="$PROCESS_ROOT/.pixi/envs/default/bin/python"
  [[ -x "$lock_python" ]] || return 1
  "$lock_python" "$PROCESS_ROOT/scripts/lock_probe.py" "$lock_file"
}
