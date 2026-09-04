# Third-party notices

ROS2 Visual Starter 本体の独自部分は、ルートの `LICENSE` に記載した MIT
License で提供します。ただし、その MIT License は、以下の第三者ソフトウェア、
第三者由来の設定・コード、モデル、画像を再許諾するものではありません。

このリポジトリは source-only 配布を前提とします。`node_modules/`、`.pixi/`、
ROS 2 package、Nav2、SLAM Toolbox、YOLOX ONNX weight、YOLOX の検証画像、
任意の LLM runtime／model は同梱しません。利用者の環境へ npm または Pixi、
もしくは checksum 付き download script が取得します。将来、依存物を含む
Docker image、binary archive、DMG 等を配布する場合は、別途 binary
redistribution 向けのライセンス監査が必要です。

既存のTraining Room地図と合成りんご画像も、所有者による再配布licenseの確認が
完了するまでは同梱しません。候補assetのhashと来歴は`ASSETS.md`へ記録しています。

詳細なファイル分類、比較した tag／commit、変更範囲は
[`docs/DEPENDENCY_LICENSE_AUDIT.md`](docs/DEPENDENCY_LICENSE_AUDIT.md) を参照してください。

## このリポジトリへ改変物を同梱するproject

### Navigation2

- Upstream: <https://github.com/ros-navigation/navigation2>
- 基準version: `1.3.12`
- 基準commit: `6be3614013ec586051b86c97b919b293281490fe`
- 用途: AMCL、costmap、DWB Controller、planner、behavior、BT Navigator、
  lifecycle manager、および NavigateToPose
- 同梱範囲:
  - `backend/config/nav2.yaml` — `nav2_bringup` 等の設定例を改変
  - `backend/config/navigate_to_pose_with_bounded_backup.xml` —
    `nav2_bt_navigator` の標準 Behavior Tree を改変
- 取得範囲: package 本体は Pixi が RoboStack Jazzy から取得し、Git へ同梱しない
- 改変: あり。project固有の footprint、速度、costmap、進捗判定、bounded
  BackUp、Command Gate 向け topic remap に調整
- 設定例／BT の適用license: `Apache-2.0`
- License text: `LICENSES/Apache-2.0.txt`
- Upstreamのpackage別license案内: `LICENSES/Navigation2-LICENSE.txt`

Navigation2 は package ごとにライセンスが異なります。少なくとも、本projectが
直接利用する package の `package.xml` は次のとおりです。

| package | license |
| --- | --- |
| `nav2_bringup`, `nav2_bt_navigator`, `nav2_behavior_tree` | Apache-2.0 |
| `nav2_behaviors`, `nav2_controller`, `nav2_lifecycle_manager`, `nav2_planner` | Apache-2.0 |
| `nav2_amcl` | LGPL-2.1-or-later |
| `dwb_core`, `dwb_critics` | BSD-3-Clause |
| `nav2_costmap_2d` | BSD-3-Clause and Apache-2.0 |
| `nav2_map_server`, `nav2_navfn_planner` | Apache-2.0 and BSD-3-Clause |

上表は package 本体の利用条件です。Git に同梱する二つの改変ファイルは、
それぞれの元ファイルが属する `nav2_bringup`／`nav2_bt_navigator` の
Apache-2.0 として扱います。

### SLAM Toolbox

- Upstream: <https://github.com/SteveMacenski/slam_toolbox>
- 基準version: `2.8.5`
- 基準commit: `ec8f7635dea317b531c419f798f87d90a336f32e`
- 用途: `/scan` と TF からの online mapping
- 同梱範囲: `backend/config/slam_toolbox.yaml` の `slam_toolbox` section
- 元ファイル: `config/mapper_params_online_async.yaml`
- 取得範囲: package 本体は Pixi が RoboStack Jazzy から取得し、Git へ同梱しない
- 改変: あり。frame、scan range、更新周期、移動閾値、loop closure を調整
- License for the adapted source section: `LGPL-2.1-only` (conservative
  interpretation of the upstream `LGPL` declaration and GitHub's `LGPL-2.1`
  identification)
- License text: `LICENSES/LGPL-2.1-only.txt`

同じ `backend/config/slam_toolbox.yaml` の `map_saver` section は
Navigation2 `nav2_bringup/params/nav2_params.yaml` の改変であり、
Apache-2.0 です。Apache全文は `LICENSES/Apache-2.0.txt`、Navigation2の
package別license案内は `LICENSES/Navigation2-LICENSE.txt` にあります。
このため、ファイル全体の SPDX expression は
`LGPL-2.1-only AND Apache-2.0` としています。Pixiが取得するSLAM Toolbox
binaryのmetadataは別途`LGPL-2.1-or-later`と記録されています。

### YOLOX

- Upstream: <https://github.com/Megvii-BaseDetection/YOLOX>
- 基準version: `0.3.0`
- 基準commit: `419778480ab6ec0590e5d3831b3afb3b46ab2aa3`
- 用途: YOLOX-Nano ONNX の前処理、grid decode、box変換、NMS、COCO class名
- 同梱範囲:
  - `backend/ros2_visual_backend/yolox_runtime.py`
  - `backend/ros2_visual_backend/object_search_targets.py` 内のCOCO 80 class順序
  - `src/objectSearchTargets.ts` 内のCOCO 80 class順序
- 元ファイル:
  - `demo/ONNXRuntime/onnx_inference.py`
  - `yolox/data/data_augment.py`
  - `yolox/utils/demo_utils.py`
  - `yolox/data/datasets/coco_classes.py`
- 改変: あり。Pillow入力、型付きresult、provider選択、日本語名／alias、
  deterministic matching を追加
- License: `Apache-2.0`
- License text: `LICENSES/Apache-2.0.txt`

元ファイルにある次のcopyright表示を、該当する改変ファイルにも保持します。

```text
Copyright (c) Megvii Inc. All rights reserved.
Copyright (c) Megvii, Inc. and its affiliates.
```

## setup時に取得し、Gitへ同梱しない主な依存

version は現在の `package-lock.json`／`pixi.lock` の解決結果です。

| project | version | upstream | 用途 | license | 改変コード同梱 |
| --- | --- | --- | --- | --- | --- |
| ROS 2 Jazzy / RoboStack packages | lockfile参照 | <https://github.com/ros2/ros2>, <https://github.com/RoboStack> | ROS runtime／message／launch | packageごとに Apache-2.0、BSD系等 | なし |
| geometry_msgs／sensor_msgs／nav_msgs／std_msgs | 5.3.7 | <https://github.com/ros2/common_interfaces> | pose、scan、map、基本message | Apache-2.0 | なし |
| tf2_msgs／tf2_ros／tf2_tools | 0.36.20 | <https://github.com/ros2/geometry2> | TF message、変換、診断 | BSD-3-Clause | なし |
| map_msgs | 2.4.1 | <https://github.com/ros2/common_interfaces> | OccupancyGrid更新message | BSD-3-Clause | なし |
| vision_msgs | 4.1.1 | <https://github.com/ros-perception/vision_msgs> | Detection message | Apache-2.0 | なし |
| launch／launch_ros | 3.4.10／0.26.11 | <https://github.com/ros2/launch>, <https://github.com/ros2/launch_ros> | ROS graph起動 | Apache-2.0 | なし |
| rosbridge_suite | 2.6.0 | <https://github.com/RobotWebTools/rosbridge_suite> | loopback WebSocket bridge／rosapi | BSD-3-Clause | なし |
| Tornado | 6.5.8 | <https://github.com/tornadoweb/tornado> | rosbridgeのWebSocket Origin拒否境界 | Apache-2.0 | なし |
| roslib | 2.1.0 | <https://github.com/RobotWebTools/roslibjs> | Browser側ROS transport | BSD-2-Clause | なし |
| @xmldom/xmldom | 0.9.12 | <https://github.com/xmldom/xmldom> | roslibのXML処理用transitive dependency。root overrideでversion固定 | MIT | なし |
| Three.js | 0.178.0 | <https://github.com/mrdoob/three.js> | 3D表示 | MIT | なし |
| Rapier JavaScript | 0.19.3 | <https://github.com/dimforge/rapier.js> | physics／raycast | Apache-2.0 | なし |
| Vite | 7.3.6 | <https://github.com/vitejs/vite> | frontend build／dev server | MIT | なし |
| ONNX Runtime | 1.28.0 | <https://github.com/microsoft/onnxruntime> | CPU／CoreML推論 | upstream codeはMIT。conda metadataはLinuxでMIT AND BSL-1.0、macOSでMIT AND BSL-1.0 AND BSD-3-Clause | なし |
| NumPy | 2.5.2 | <https://github.com/numpy/numpy> | tensor処理／NMS | BSD-3-Clause | なし |
| Pillow | 12.3.0 | <https://github.com/python-pillow/Pillow> | image decode／annotation | HPND | なし |
| Python | 3.12.13 | <https://github.com/python/cpython> | backend runtime | Python-2.0 | なし |
| Node.js | 22.23.2 | <https://github.com/nodejs/node> | frontend runtime／npm実行 | MIT（upstream同梱のthird-party noticesも適用） | なし |
| Pixi | setup scriptの固定version | <https://github.com/prefix-dev/pixi> | 環境解決／task実行 | BSD-3-Clause | なし |

ONNX Runtime は upstream の `ThirdPartyNotices.txt` も参照してください。
Pixi lockfile 内の transitive package には、上表以外のライセンスも含まれます。
依存本体を再配布する成果物では、実際にbundleするartifactを基準に再監査します。

開発専用の TypeScript、ESLint、Vitest、pytest、型定義等も package manager が
取得し、Gitへ本体を同梱しません。正確なversionと各package metadataは
lockfileを参照してください。

## download-only vision assets

次の二つはGitへ同梱せず、`scripts/download_vision_assets.sh` が公式配置先から
取得してSHA-256を検証します。

| artifact | source | SHA-256 | 再配布方針 |
| --- | --- | --- | --- |
| `yolox_nano.onnx` | YOLOX release `0.1.1rc0` | `c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d` | weight固有の条件が明文化されていないため同梱しない |
| `dog.jpg` | YOLOX `0.3.0/assets/dog.jpg` | `5a9522051c3cec2bbd2f6323fccba32e8fbf3ddcc2b3e2fd46b04c720bc6f866` | 元写真の追加来歴が不明なため同梱しない |

committed asset の来歴と未解決項目は [`ASSETS.md`](ASSETS.md) を参照してください。
