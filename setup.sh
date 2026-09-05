#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT_DIR"

PIXI_VERSION="0.77.0"
PLATFORM_OVERRIDE="${ROS2_VISUAL_ALLOW_UNSUPPORTED_PLATFORM_FOR_CI:-0}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "必要なコマンドが見つかりません: $1" >&2
    exit 1
  fi
}

OS_NAME="$(uname -s)"
MACHINE_ARCH="$(uname -m)"
echo "ROS2 Visual Starter OSS v1 setup"
echo "OS: ${OS_NAME}"
echo "Architecture: ${MACHINE_ARCH}"
if [[ "$OS_NAME" != "Darwin" || "$MACHINE_ARCH" != "arm64" ]]; then
  if [[ "$PLATFORM_OVERRIDE" != "1" ]]; then
    echo "ROS2 Visual Starter OSS v1はmacOS Apple Silicon（Darwin/arm64）を正式対応環境としています。" >&2
    echo "Detected OS: ${OS_NAME}" >&2
    echo "Detected architecture: ${MACHINE_ARCH}" >&2
    echo "Linux、Windows、Intel Macではsetupを続行しません。" >&2
    exit 1
  fi
  echo "警告: unsupported platform overrideはCI用の限定検証として有効です。release対応を意味しません。" >&2
fi
require_command git
require_command curl

PIXI_BIN="$(command -v pixi 2>/dev/null || true)"
if [[ -z "$PIXI_BIN" && -x "${HOME}/.pixi/bin/pixi" ]]; then
  PIXI_BIN="${HOME}/.pixi/bin/pixi"
fi

if [[ -z "$PIXI_BIN" ]]; then
  "$ROOT_DIR/scripts/bootstrap_pixi.sh"
  PIXI_BIN="${HOME}/.pixi/bin/pixi"
fi

if [[ ! -x "$PIXI_BIN" ]]; then
  echo "Pixiを利用できません。bootstrapの出力を確認してください。" >&2
  exit 1
fi

installed_pixi="$($PIXI_BIN --version | awk '{print $2}')"
echo "Pixi: ${installed_pixi}（検証基準 ${PIXI_VERSION}）"
if [[ "$installed_pixi" != "$PIXI_VERSION" ]]; then
  echo "既存Pixi ${installed_pixi} は検証済みversion ${PIXI_VERSION}と一致しません。" >&2
  echo "Pixi ${PIXI_VERSION}へ切り替えてから再実行してください。" >&2
  exit 1
fi

"$PIXI_BIN" install --locked
"$PIXI_BIN" run npm ci --no-audit --no-fund
"$PIXI_BIN" run vision-assets

required_executables=(
  "rosbridge_server rosbridge_websocket"
  "rosapi rosapi_node"
  "tf2_ros static_transform_publisher"
  "slam_toolbox async_slam_toolbox_node"
  "nav2_map_server map_server"
  "nav2_map_server map_saver_server"
  "nav2_amcl amcl"
  "nav2_controller controller_server"
  "nav2_planner planner_server"
  "nav2_behaviors behavior_server"
  "nav2_bt_navigator bt_navigator"
  "nav2_lifecycle_manager lifecycle_manager"
)
for specification in "${required_executables[@]}"; do
  read -r package_name executable_name <<< "$specification"
  if ! "$PIXI_BIN" run ros2 pkg executables "$package_name" | grep -Fxq "$package_name $executable_name"; then
    echo "必要なROS 2 executableを確認できません: $package_name/$executable_name" >&2
    exit 1
  fi
done

"$PIXI_BIN" run python -c "import numpy, onnxruntime, PIL"
"$PIXI_BIN" run ros2 interface show vision_msgs/msg/Detection2DArray >/dev/null

echo ""
echo "Setup completed. Optional Local LLM runtime/modelは導入していません。"
echo "起動方法:"
echo "  ./run.sh --sim"
echo "  ./run.sh --mapping"
echo "  ./run.sh --navigation"
echo "  ./run.sh --exploration"
