# Contributing

ROS2 Visual Starterへの改善提案を歓迎します。本プロジェクトは、ROS 2初学者がSIM、Topic、地図、Navigation、安全境界を同じ画面で理解できることを優先します。

## 最初に確認すること

- Issueを検索し、同じ問題や提案がないか確認してください。
- 大きな機能追加やnetwork境界の変更は、実装前にIssueで目的と安全上の影響を相談してください。
- credential、実際のprompt、個人の絶対path、実ログ、非公開endpointをIssueやPull Requestへ貼らないでください。
- 再配布権が不明な画像、3D model、地図、音声、設定例を追加しないでください。

## セットアップ

```bash
git clone https://github.com/combatsheep/ros2-visual-starter-oss.git
cd ros2-visual-starter-oss
./setup.sh
./run.sh --sim
```

`setup.sh`はlockfileを使って依存を導入します。Local LLM runtimeとmodelは開発環境にも自動導入しません。

## 実装ルール

- UI文言とドキュメントは日本語、コード識別子とbranch名は英語にします。
- SIMモードをROS 2なしで常に起動可能に保ちます。
- roslib固有処理は`TransportAdapter`の内側に閉じ込めます。
- ROS座標とThree.js座標の変換は`src/coordinateTransform.ts`へ集約します。
- LiDAR描画ではTypedArrayとGeometryを再利用し、frameごとの不要なobject生成を避けます。
- エラーはconsoleだけに残さず、利用者が判断できる日本語の状態として画面へ表示します。
- listenerはloopbackに固定し、外部CDN、Telemetry、任意のshell実行、任意のROS forwardingを追加しません。
- LLM出力を直接robot commandへ変換しません。決定論パーサー、strict schema、intent allowlist、既存の状態機械を通します。
- 状態遷移は`src/appState.ts`、副作用は`AppEffect`の実行側へ分離します。
- runtime、map、Vision、探索のcycle/generationを無視して古いcallbackを適用しないでください。

## テスト

Frontendの変更では次を実行します。

```bash
./scripts/pixi.sh run npm run typecheck
./scripts/pixi.sh run npm run lint
./scripts/pixi.sh run npm test
./scripts/pixi.sh run npm run build
```

BackendまたはROS graph構成を変更した場合は次も実行します。

```bash
./scripts/pixi.sh run test-backend
./scripts/doctor.sh
```

公開可能性の監査は外せません。

```bash
./scripts/pixi.sh run node --test tests/public-release/public-release.test.mjs
```

可能な変更では、`./run.sh --sim`を起動し、`http://127.0.0.1:27182/` の表示と手動停止も確認してください。ROS関連の変更では、利用できる環境で該当するmapping、navigation、explorationを起動し、実行できなかった検証はPull Requestへ明記します。

## 変更別の確認事項

### UIまたはSIM

- ROS 2なしで起動できること
- Keyboard、pointer、window focus喪失時に速度0へ戻ること
- LiDAR、Topic inspector、状態表示が更新されること
- 画面サイズを変えて主要操作が隠れないこと

### ROS 2、Navigation、安全制御

- `TransportAdapter`境界を維持すること
- 手動速度とNav2速度がCommand Gateで排他的に選択されること
- `/cmd_vel_raw`からSafety Controllerを通った`/cmd_vel`だけが最終速度になること
- commandまたはscanがtimeoutした場合に速度0になること
- runtime切替と切断時にgoal取消、入力解除、速度0が行われること

### STAGE、地図、asset

- JSONのversion、field allowlist、値域、最大1 MBの検査を維持すること
- JPEG、PNG、WebMの形式検査と50〜5000 pxの寸法検査を維持すること
- 任意URLをasset参照として受け付けないこと
- binary assetを追加する場合は`assets/manifest.json`へpath、SHA-256、sourceまたはcreator、purpose、licenseを追加すること
- upstream例を変更した設定は、出典、version、license、変更点をnoticeへ記録すること

## 依存関係の変更

利用者向け導入は`npm ci`と`./scripts/pixi.sh install --locked`を維持します。依存を変更したPull Requestでは、対応するmanifestとlockfileを同時に更新し、floating versionを追加しないでください。未使用の依存は追加しないでください。

## Pull Request

Pull Requestには次を含めてください。

- 変更の目的と利用者への影響
- 安全境界、network境界、asset licenseへの影響
- 実行した検証コマンドと結果
- 実行できなかった検証と理由
- UI変更時の画像または短い動画。ただし個人情報や非公開環境を含めないこと

本プロジェクトのfirst-party部分へのContributionは、MIT Licenseで提供してください。

第三者由来、または第三者projectのcode・config・exampleを改変したファイルへのContributionには、
各ファイルのSPDX headerおよび[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、
[docs/DEPENDENCY_LICENSE_AUDIT.md](docs/DEPENDENCY_LICENSE_AUDIT.md)に記載された適用ライセンスが
引き続き適用されます。

再配布権やライセンスが確認できない第三者asset・code・configはPull Requestへ含めないでください。
