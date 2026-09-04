#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"
failed=0
check() { local label="$1"; shift; if "$@" >/dev/null 2>&1; then echo "✓ $label"; else echo "✗ $label"; failed=1; fi; }
check_vision_assets() {
  local model="public/vision/yolox_nano.onnx" asset="public/vision/dog.jpg"
  [[ -f "$model" && -f "$asset" ]] || return 1
  local model_hash asset_hash
  if command -v shasum >/dev/null 2>&1; then
    model_hash="$(shasum -a 256 "$model" | awk '{print $1}')"
    asset_hash="$(shasum -a 256 "$asset" | awk '{print $1}')"
  else
    model_hash="$(sha256sum "$model" | awk '{print $1}')"
    asset_hash="$(sha256sum "$asset" | awk '{print $1}')"
  fi
  [[ "$model_hash" == "c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d" && "$asset_hash" == "5a9522051c3cec2bbd2f6323fccba32e8fbf3ddcc2b3e2fd46b04c720bc6f866" ]]
}
check_node_22() {
  [[ "$("$PIXI_BIN" run node --version 2>/dev/null)" == v22.* ]]
}

echo "ROS2 Visual Starter doctor"
check "Frontend dependencies" test -d node_modules
PIXI_BIN="$(command -v pixi 2>/dev/null || true)"
if [[ -z "$PIXI_BIN" && -x "${HOME}/.pixi/bin/pixi" ]]; then PIXI_BIN="${HOME}/.pixi/bin/pixi"; fi
if [[ -n "$PIXI_BIN" ]]; then
  echo "✓ Pixi $("$PIXI_BIN" --version 2>/dev/null | head -n 1)"
  check "Node.js 22" check_node_22
  check "npm" "$PIXI_BIN" run npm --version
  check "TypeScript" "$PIXI_BIN" run npm run typecheck
  check "Unit tests" "$PIXI_BIN" run npm run test
  check "Production build" "$PIXI_BIN" run npm run build
  check "ROS 2 Jazzy CLI" "$PIXI_BIN" run ros2 --help
  check "Backend tests" "$PIXI_BIN" run test-backend
  check "rosbridge" "$PIXI_BIN" run ros2 pkg executables rosbridge_server
  check "SLAM Toolbox" "$PIXI_BIN" run ros2 pkg executables slam_toolbox
  check "Map Server / Saver" "$PIXI_BIN" run ros2 pkg executables nav2_map_server
  check "Nav2 Controller" "$PIXI_BIN" run ros2 pkg executables nav2_controller
  check "Nav2 Planner" "$PIXI_BIN" run ros2 pkg executables nav2_planner
  check "Nav2 Behaviors" "$PIXI_BIN" run ros2 pkg executables nav2_behaviors
  check "Nav2 BT Navigator" "$PIXI_BIN" run ros2 pkg executables nav2_bt_navigator
  check "Nav2 Lifecycle Manager" "$PIXI_BIN" run ros2 pkg executables nav2_lifecycle_manager
  check "vision_msgs" "$PIXI_BIN" run ros2 interface show vision_msgs/msg/Detection2DArray
  check "ONNX Runtime" "$PIXI_BIN" run python -c "import onnxruntime"
  check "YOLOX weight / Vision Target checksum" check_vision_assets
else
  echo "✗ Pixiがありません。対応launcherを使うには./setup.shを実行してください。"
  failed=1
fi
if [[ "$failed" -ne 0 ]]; then echo "Doctor: 要確認項目があります。"; exit 1; fi
echo "Doctor: Frontend SIMは起動可能です。"
