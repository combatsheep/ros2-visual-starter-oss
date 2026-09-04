# 開発ガイド

この文書は、公開treeだけを使って変更、検証、Pull Requestを行うための手順です。

## 前提

- Git
- curl
- Terminalでcommandの失敗を確認できること
- 正式対応環境はmacOS Apple Silicon（arm64）
- Linux、Windows、Intel Macは正式サポート対象外

Node.js 22、Python 3.12、ROS 2 Jazzyとruntime dependencyは`pixi.toml`と`pixi.lock`で管理します。systemへROS 2を別途導入する必要はありません。

```bash
git clone https://example.invalid/ros2-visual-starter-oss.git
cd ros2-visual-starter-oss
./setup.sh
```

`setup.sh`は固定したPixiを必要に応じてユーザー領域へ導入し、`./scripts/pixi.sh install --locked`、`npm ci`、Vision assetのchecksum検証を実行します。`sudo`とHomebrewは要求しません。以降は、shellの`PATH`を変更しない導入でも動くrepository内wrapperを使用します。

## Directory構成

```text
src/                         Browser UI、SIM、state、TransportAdapter
tests/                       Frontend unit testと公開監査
backend/ros2_visual_backend/ ROS node、launcher、純粋logic
backend/tests/               Backend unit test
backend/config/              SLAM ToolboxとNav2の設定
scripts/                     setup補助、runtime制御、診断
examples/stages/             version付きStage例
public/vision/               trackedまたはdownload-only Vision asset
assets/manifest.json         tracked binaryのprovenanceとchecksum
docs/                        公開技術文書
```

`.logs/`、`.pixi/`、`node_modules/`、`dist/`、download-only assetは生成物でありcommitしません。

## 通常の開発loop

SIMだけの変更は次で確認できます。

```bash
./run.sh --sim
```

UIは`http://127.0.0.1:27182/`です。別Terminalでtestを実行します。

```bash
./scripts/pixi.sh run npm run typecheck
./scripts/pixi.sh run npm run lint
./scripts/pixi.sh run npm test
./scripts/pixi.sh run npm run build
```

終了します。

```bash
./stop.sh
```

## ROS runtime

```bash
./run.sh --ros
./run.sh --mapping
./run.sh --navigation
./run.sh --navigation --map maps/example.yaml
./run.sh --exploration
```

初回起動時は`start.sh`が`stop.sh`を呼び、本repositoryが記録したprocessだけを停止してから起動します。UIからのmode切替では`scripts/runtime.sh`が記録済みROS graphだけを停止し、新しいgraphへ入れ替えます。独自のkill-all処理を追加しないでください。

Backendの純粋logicとgraph planは次で検証します。

```bash
./scripts/pixi.sh run test-backend
./scripts/doctor.sh
```

ROS 2を起動できる環境では、変更したmodeについてprocess起動、graph readiness、shutdown、mode切替を確認します。MappingまたはNavigationを変更した場合は地図作成・保存・選択・goal送信も確認します。ExplorationまたはVisionを変更した場合は、fresh map／pose、frontier goal、Detectionのreadiness表示まで確認します。

## Frontendの境界

### State reducer

状態追加は`src/appState.ts`のtype、event、transition、effect、testを同時に更新します。`transitionAppState`内でDOM操作、fetch、ROS publishを実行せず、必要な処理を`AppEffect`として返します。

非同期callbackにはruntime、map、transport、Vision、missionのcycleまたはgenerationを持たせ、古い結果をrejectします。

### Transport

SIMとROS 2の差は`TransportAdapter`で吸収します。roslib固有class、Topic type、Service、Actionを画面componentへ直接追加しないでください。

### 座標とsensor

- ROS／Three.js変換: `src/coordinateTransform.ts`
- robot寸法とsensor mount: `src/robotGeometry.ts`
- LiDAR sampling: `src/lidarSampling.ts`
- RGB／Depth処理: `src/vision.ts`

同じ変換式や寸法定数を別fileへ複製しないでください。LiDARのhot pathではTypedArrayと既存Geometryを再利用します。

### 3D robot starter model

`src/starterRobotModel.ts`はOSS v1の正式な教材用starter robotです。Three.jsの基本geometry
から生成するfirst-party MIT sourceで、外部3D binary assetは使用しません。physics、LiDAR、
Camera、wheel geometryとのinterfaceは維持します。将来binary modelへ置き換える場合だけ、
再配布licenseとprovenanceを確認し、`assets/manifest.json`、`ASSETS.md`、必要なthird-party
noticeを同じ変更で更新します。

## STAGEと地図

Stage schemaを変更するときは、version互換、未知fieldの拒否、値域、object ID重複、asset allowlist、1 MBのimport上限を維持します。local mediaは対応形式、MIME、寸法を検査し、任意URLを保存しません。

標準Stageとdefault mapの形状は対応しています。標準Stageのcollisionを変更した場合は`backend/ros2_visual_backend/default_map.py`も更新し、生成結果のtestを追加してください。

保存地図はruntime dataです。実環境で作った地図や`maps/.selected_map`をfixtureとしてcommitしないでください。必要なfixtureは個人環境を含まない最小データとして作成します。

## Vision

download-only weightと検証画像は次で取得・検査します。

```bash
./scripts/pixi.sh run vision-assets
./scripts/pixi.sh run vision-smoke
```

URLやchecksumを変更するときは、配布元、version、licenseを確認し、download script、manifestまたはasset文書、testを同時に更新します。checksum不一致をfallbackで無視しないでください。

## Optional Local LLM

LLMなしの決定論パーサーが常に先です。LLM統合を変更するときは、disabled状態、mock provider、timeout、invalid JSON、schema違反、直接制御intent、古いresponseの破棄をtestします。実model、token、会話logをtest fixtureへ入れないでください。

設定とprotocolは[Optional Local LLM](OPTIONAL_LOCAL_LLM.md)を参照してください。

## 公開監査

公開treeでは通常のtestに加え、root allowlist、禁止path、秘密形式、個人path、network literal、symlink、実行bit、binary manifest、required docsを検査します。

```bash
make public-audit
```

初回公開直前のclean-room commitだけは、通常監査とは別の初回公開監査を実行します。

```bash
make initial-release-audit
```

## 依存更新

- 通常の再現確認では`npm ci`と`./scripts/pixi.sh install --locked`を使用します。
- dependencyを変更したときだけmanifestとlockfileを更新します。
- Node.js、Python、ROS 2の対応範囲を同時に広げないでください。
- CIで検証していないplatformをREADMEの正式対応へ追加しないでください。Linux CIはportable
  unit test用であり、macOS Apple Siliconの対応確認とは別です。
- upstream由来の設定を更新した場合は[Dependency License Audit](DEPENDENCY_LICENSE_AUDIT.md)も更新します。

## 提出前checklist

```bash
./scripts/pixi.sh run node --test tests/public-release/public-release.test.mjs
./scripts/pixi.sh run npm run typecheck
./scripts/pixi.sh run npm run lint
./scripts/pixi.sh run npm test
./scripts/pixi.sh run npm run build
./scripts/pixi.sh run test-backend
./scripts/doctor.sh
git diff --check
```

実行できなかった検証は成功扱いにせず、理由と影響範囲をPull Requestへ記載してください。
