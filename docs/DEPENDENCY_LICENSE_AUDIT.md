# Dependency and source provenance audit

監査日: 2026-09-04

本監査はsource-onlyの公開候補を対象とし、法的助言ではありません。実際に同梱する
source／assetと、setup時に取得するpackageを分けて記録します。ルートのMIT
Licenseは、第三者由来部分の適用licenseを置き換えません。

## 分類基準

- **A — 完全独自**: upstream example／codeの表現を取り込んでいない
- **B — API・設定仕様を参考に独自作成**: parameter名や公開APIだけを参照
- **C — upstream exampleを改変**: example全体または主要構造を基に調整
- **D — upstream code/configの一部をコピー**: 実装またはdata列の実質的部分を移植

## 比較基準

`pixi.lock` の解決versionと一致する公式tagを取得し、対象fileを構造・行単位で
比較しました。

| project | tag | commit | upstream license source |
| --- | --- | --- | --- |
| Navigation2 | `1.3.12` | `6be3614013ec586051b86c97b919b293281490fe` | packageごとの `package.xml` とroot `LICENSE` |
| SLAM Toolbox | `2.8.5` | `ec8f7635dea317b531c419f798f87d90a336f32e` | `package.xml` とroot `LICENSE` |
| rosbridge_suite | `2.6.0` | `a8870f63afa0c2ea147f57ef7f522a5d3deac6e4` | packageごとの `package.xml` とroot `LICENSE` |
| YOLOX | `0.3.0` | `419778480ab6ec0590e5d3831b3afb3b46ab2aa3` | root `LICENSE` と各source header |

公式参照先:

- <https://github.com/ros-navigation/navigation2/tree/1.3.12>
- <https://github.com/SteveMacenski/slam_toolbox/tree/2.8.5>
- <https://github.com/RobotWebTools/rosbridge_suite/tree/2.6.0>
- <https://github.com/Megvii-BaseDetection/YOLOX/tree/0.3.0>

## ファイル分類

| 本repoのfile | 分類 | upstream path | applicable license | 変更／同梱範囲 |
| --- | --- | --- | --- | --- |
| `backend/config/nav2.yaml` | C | Navigation2 `nav2_bringup/params/nav2_params.yaml`, `nav2_bringup/params/nav2_multirobot_params_1.yaml`, `nav2_system_tests/src/system/nav2_system_params.yaml` | Apache-2.0 | server構成を縮小し、AMCL、DWB、footprint、costmap、planner、behavior、lifecycle値を教材SIM向けに調整。file全体を同梱 |
| `backend/config/navigate_to_pose_with_bounded_backup.xml` | C | Navigation2 `nav2_bt_navigator/behavior_trees/navigate_to_pose_w_replanning_and_recovery.xml` | Apache-2.0 | replanning pipelineとplanner/controller recovery構造を保持し、広域recovery round-robinを1回のbounded BackUp＋costmap clearへ変更。file全体を同梱 |
| `backend/config/slam_toolbox.yaml` の `slam_toolbox` section | C | SLAM Toolbox `config/mapper_params_online_async.yaml` | LGPL-2.1-only（保守的判定） | solver／scan matcher／correlation設定を保持し、frame、range、period、travel／loop閾値を調整 |
| 同fileの `map_saver` section | C | Navigation2 `nav2_bringup/params/nav2_params.yaml` | Apache-2.0 | Map Saver設定を調整して同梱 |
| `backend/config/nav2_exploration.yaml` | B | Nav2 planner／costmap parameter API | first-party MIT。Nav2 packageは別途各license | growing map用の小さなoverlay。表現上のcopyは確認されず |
| `backend/config/slam_toolbox_exploration.yaml` | B | SLAM Toolbox parameter API | first-party MIT。SLAM Toolbox packageはLGPL-2.1-or-later | exploration用parameter overlayとproject固有comment |
| `backend/ros2_visual_backend/launcher.py` | B | ROS 2 Launch、Navigation2／SLAM Toolbox launch API | first-party MIT。起動対象packageは別途各license | standard node名／APIを使う独自runtime plan。公式launchとの一致は短いAPI boilerplateに限定 |
| `backend/ros2_visual_backend/yolox_runtime.py` | D | YOLOX `demo/ONNXRuntime/onnx_inference.py`, `yolox/data/data_augment.py`, `yolox/utils/demo_utils.py` | Apache-2.0 | preprocessing、grid decode、box変換、NMSを移植。Pillow、型、provider選択を追加 |
| `backend/ros2_visual_backend/object_search_targets.py` のCOCO class順序 | D | YOLOX `yolox/data/datasets/coco_classes.py` | Apache-2.0 | 80 class名と順序を移植。日本語名／alias／matchingはproject追加 |
| `src/objectSearchTargets.ts` のCOCO class順序 | D | YOLOX `yolox/data/datasets/coco_classes.py` | Apache-2.0 | 80 class名と順序を移植。日本語名／alias、TypeScript型、normalization／matchingはproject追加 |
| 非同梱候補の`training_room.yaml`／`.pgm` | A（生成data） | upstream source codeのcopyではない | owner確認待ち | 仮想roomをSLAM Toolbox Map Saverで保存したasset。再配布承認までは公開treeへ含めない |

### `nav2.yaml` のpackage license補足

設定例自体は `nav2_bringup` 等のApache-2.0として扱います。一方、設定から利用する
runtime packageのlicenseは一律ではありません。

| package | official `package.xml` license |
| --- | --- |
| `nav2_amcl` | LGPL-2.1-or-later |
| `nav2_bt_navigator`, `nav2_behavior_tree`, `nav2_behaviors` | Apache-2.0 |
| `nav2_controller`, `nav2_lifecycle_manager`, `nav2_planner` | Apache-2.0 |
| `dwb_core`, `dwb_critics` | BSD-3-Clause |
| `nav2_costmap_2d` | BSD-3-Clause and Apache-2.0 |
| `nav2_map_server`, `nav2_navfn_planner` | Apache-2.0 and BSD-3-Clause |

plugin名やparameter名の利用だけで各packageの実装を本repoへcopyしたとは扱いません。
ただし、package本体を含むbinary配布では、それぞれのlicense義務を再評価します。

## 同梱したlicense／notice対応

- `backend/config/nav2.yaml` とBehavior Treeへ、Apache-2.0、upstream path、
  tag commit、主要変更をheaderで記録
- `backend/config/slam_toolbox.yaml` へ、sectionごとのupstreamと
  `LGPL-2.1-only AND Apache-2.0` を記録。upstream `package.xml` の`LGPL`と
  GitHubの`LGPL-2.1`判定から、同梱する改変sourceは保守的に`-only`とした
- YOLOX由来の三fileへ、Apache-2.0、元path、tag commit、変更内容、元の
  Megvii copyrightを記録
- `LICENSES/Apache-2.0.txt` — YOLOX `0.3.0/LICENSE` のverbatim copy。
  Apache-2.0のNavigation2改変物にも適用
- `LICENSES/LGPL-2.1-only.txt` — SLAM Toolbox `2.8.5/LICENSE` のverbatim copy
- `LICENSES/Navigation2-LICENSE.txt` — Navigation2 `1.3.12/LICENSE` のverbatim copy。
  packageごとのlicenseを案内するupstream文書であり、Apache全文ではない
- `THIRD_PARTY_NOTICES.md` — bundled derivativeとfetched-only依存を分離

## dependency inventory

### npm runtime

| package | locked version | license | delivery |
| --- | --- | --- | --- |
| `@dimforge/rapier3d-compat` | 0.19.3 | Apache-2.0 | npm取得、非同梱 |
| `roslib` | 2.1.0 | BSD-2-Clause | npm取得、非同梱 |
| `@xmldom/xmldom` | 0.9.12 | MIT | `roslib`経由でnpm取得。root overrideで修正版へ固定、非同梱 |
| `three` | 0.178.0 | MIT | npm取得、非同梱 |

主なbuild／test toolは Vite 7.3.6（MIT）、Vitest 3.2.7（MIT）、TypeScript
5.9.3（Apache-2.0）、ESLint 9.39.5（MIT）、typescript-eslint 8.67.0
（MIT）です。`package-lock.json` のpackage entryにはlicense欠落がありません。

### Pixi runtime／test

| package | locked version | lock metadata license | delivery |
| --- | --- | --- | --- |
| `ros-jazzy-ros-base` | 0.11.0 | Apache-2.0 | Pixi取得、非同梱 |
| `ros-jazzy-rosbridge-suite` | 2.6.0 | BSD-3-Clause | Pixi取得、非同梱 |
| `tornado` | 6.5.8 | Apache-2.0 | rosbridgeのWebSocket Origin拒否境界。Pixi取得、非同梱 |
| `ros-jazzy-rclpy` | 7.1.11 | Apache-2.0 | Pixi取得、非同梱 |
| `ros-jazzy-geometry-msgs`／`sensor-msgs`／`nav-msgs`／`std-msgs` | 5.3.7 | Apache-2.0 | pose、scan、map、基本message。Pixi取得、非同梱 |
| `ros-jazzy-tf2-msgs`／`tf2-ros`／`tf2-tools` | 0.36.20 | BSD-3-Clause | TF message、変換、診断。Pixi取得、非同梱 |
| `ros-jazzy-map-msgs` | 2.4.1 | BSD-3-Clause | Pixi取得、非同梱 |
| `ros-jazzy-vision-msgs` | 4.1.1 | Apache-2.0 | Detection message。Pixi取得、非同梱 |
| `ros-jazzy-launch`／`launch-ros` | 3.4.10／0.26.11 | Apache-2.0 | ROS graph起動。Pixi取得、非同梱 |
| `ros-jazzy-nav2-msgs`／`navigation2` | 1.3.12 | Apache-2.0 meta-package。構成packageは上記参照 | Pixi取得、非同梱 |
| `ros-jazzy-slam-toolbox` | 2.8.5 | LGPL-2.1-or-later | Pixi取得、非同梱 |
| `ros-jazzy-rmw-fastrtps-cpp` | 8.4.3 | Apache-2.0 | runtimeが明示選択するRMW。Pixi取得、非同梱 |
| `onnxruntime` | 1.28.0 | Linux: MIT AND BSL-1.0、macOS: MIT AND BSL-1.0 AND BSD-3-Clause | Pixi取得、非同梱 |
| `numpy` | 2.5.2 | BSD-3-Clause | Pixi取得、非同梱 |
| `pillow` | 12.3.0 | HPND | Pixi取得、非同梱 |
| `pytest` | 8.4.2 | MIT | Pixi取得、非同梱 |
| `python` | 3.12.13 | Python-2.0 | Pixi取得、非同梱 |
| `nodejs` | 22.23.2 | MIT | Pixi取得、非同梱。Node upstreamのthird-party noticesも参照 |

`pixi.lock` は2 platform分を展開しているため同一projectのrecordが複数あります。
license fieldがないrecordは `tbb-devel 2023.0.0` の2件
（linux-64、osx-arm64）のみです。conda-forgeの公式
`tbb-feedstock` recipeはsourceをoneTBB `v2023.0.0`へ固定し、`LICENSE.txt` と
`third-party-programs.txt` をlicense fileとして指定しています。oneTBBの
`LICENSE.txt` はApache-2.0です。この解決根拠を保持し、lock metadataの欠落を
「licenseなし」と誤認しません。

参照:

- <https://github.com/conda-forge/tbb-feedstock/blob/0171d73a0a64a4f6a98a829b845bee4bdfddfd80/recipe/meta.yaml>
- <https://github.com/uxlfoundation/oneTBB/blob/v2023.0.0/LICENSE.txt>

Pixi環境にはtransitiveなGPL／LGPL／MPL等のpackageも含まれます。本repoの
source-only配布ではpackage本体を再配布しません。依存込みartifactを作る際は、
lockfileのlicense名だけで判断せず、実際に含むbinaryとnoticeを再監査します。

## model／asset boundary

- YOLOX-Nano ONNX weightは公式releaseからchecksum付きでdownloadし、Gitへ
  commitしない。weight固有の再配布条件が明示されていないため再配布しない
- YOLOX `dog.jpg` は元写真の追加来歴が不明なためdownload-onlyとする
- apple画像とTraining Room mapは再配布licenseのowner確認待ちのため非同梱
- 最終3D robot modelは未提供。creator、license、SHA-256が確定するまで
  Public release readyとはしない

assetの詳細は [`../ASSETS.md`](../ASSETS.md) を参照してください。

## 未解決gate

1. map／appleを将来同梱する場合は、ownerがcreatorと再配布licenseを明示し、
   承認flag、正しいsource、SHA-256をmanifestへ登録する
2. Training Room候補地図はSLAM Toolbox保存物であり、fallback generatorの
   `default.*` とは別物として扱う
3. ユーザー提供3D modelのcreator、再配布license、SHA-256を登録する
4. 将来binary/containerを配布する場合は、transitive dependencyを含む別監査を行う
