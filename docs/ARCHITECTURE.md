# アーキテクチャ

ROS2 Visual Starterは、ROS 2がなくても成立するBrowser SIMと、loopback上のROS 2 runtimeを分離しています。UIはどちらの構成でも同じ`TransportAdapter`を使い、ROS固有処理を画面ロジックへ漏らしません。

## 全体像

```text
Browser
  LearningUI + AppState reducer
      ├─ Simulation (Three.js + Rapier)
      ├─ LocalTopicBusAdapter ─────────────── SIM
      └─ RosbridgeAdapter
            │ same-origin /rosbridge
            ▼
loopback rosbridge :9090
            │
            ├─ Sensor topics from Browser SIM
            ├─ Command Gate ──> Safety Controller ──> /cmd_vel
            ├─ SLAM Toolbox / Map Library
            ├─ Nav2 / AMCL / Map Server
            └─ YOLOX Vision
```

Viteは`127.0.0.1:27182`でUIを提供し、同一originの`/rosbridge`を`127.0.0.1:9090`へproxyします。外部interfaceでlistenする構成はありません。

## Browser層

### Simulation

`src/simulation.ts`はThree.jsのsceneとRapierのphysics worldを所有します。ロボットのpose、collision、LiDAR、RGB Camera、Depth Cameraを更新し、選択中の`TransportAdapter`へTopic messageを渡します。

ロボットの寸法とsensor位置は`src/robotGeometry.ts`に集約しています。表示モデルは`src/starterRobotModel.ts`の基本図形プレースホルダーで、公開ドラフト用の一時実装です。

ROS座標とThree.js座標の変換は`src/coordinateTransform.ts`に集約します。表示やUIで独自変換を増やさないことが、map、pose、LiDARの整合性を保つ前提です。

### TransportAdapter

`src/transport.ts`は次の2実装を提供します。

- `LocalTopicBusAdapter`: Browser内だけでpublish／subscribeするSIM用adapter
- `RosbridgeAdapter`: 同一origin WebSocketを使い、ROS Topic、Service、Actionへ接続するadapter

Navigation goalはadapterの`sendNavigationGoal`、地図保存とresetはadapterの専用methodから呼びます。UIがroslibのclassを直接作る構成にはしません。

### Stateとeffect

`src/appState.ts`はruntime、map、command owner、Navigation、Exploration、Vision、Object Search、Safety、操作権、画面modeを1つの`AppState`として管理します。

`transitionAppState`はeventから次stateと`AppEffect`を返します。ROS publish、Action送信、速度0、runtime切替、画面更新などの副作用は`LearningUI`側がeffectを実行します。この分離により、安全上重要な遷移をDOMやROSなしでunit testできます。

詳細は[状態機械](STATE_MACHINE.md)を参照してください。

### STAGE editor

`src/playground.ts`はstage schemaと値域を検査し、`src/stageImages.ts`はlocal mediaの形式と寸法を検査します。Stage定義はBrowser localStorage、追加mediaはIndexedDBに保存します。任意URLやserver uploadは使用しません。

## ROS backend層

`backend/ros2_visual_backend/launcher.py`が選択されたruntime modeに必要なROS nodeを組み立てます。`backend/ros2_visual_backend/runtime_graph.py`はmodeごとのrequired／forbidden nodeをROS importなしで定義し、testとlauncherで共有します。

### Command GateとSafety

```text
/cmd_vel_manual ─┐
                 ├─ Command Gate ── /cmd_vel_raw ── Safety Controller ── /cmd_vel
/cmd_vel_nav ────┘                         ▲
                                            └─ /scan
```

Command Gateは`/control/navigation_mode`で手動入力とNav2入力の一方だけを選びます。選択中のcommandが500 ms更新されなければ速度0を出します。Navigation goal付近では前進速度を制限します。

Safety Controllerは前方15度を監視し、0.34 m未満の障害物で前進を止め、0.42 m以上で再開します。scanまたはcommandが500 ms更新されない場合も速度0です。後退と旋回は自動生成せず、入力された値の範囲で扱います。

### Map

- `mapping`: SLAM ToolboxとMap Saverでonline mapを作成
- `navigation`: Map ServerとAMCLで保存地図を読み込み、Nav2を起動
- `exploration`: SLAM ToolboxとNav2を併用し、mapとTFが準備できてからNavigation lifecycleを有効化

Map Libraryは`maps/*.yaml`を列挙し、選択名を`maps/.selected_map`、開始poseを`maps/<name>.start_pose.json`へ保存します。地図名は厳格な文字allowlistで検査し、YAMLが参照する画像は同じmap directory内だけに限定します。

### Frontier Exploration

`src/frontierExploration.ts`はOccupancyGridの既知free cellと未知cellの境界を抽出し、cluster化します。robot footprintと安全marginからclearanceを計算し、到達可能性、距離、情報量、過去の失敗を評価して候補を選びます。

候補が停滞した場合は安全なcorner候補へ切り替えます。goal失敗はbounded retryとblacklistで処理し、古いmap generationの結果を再利用しません。

### VisionとObject Search

YOLOX nodeはBrowser SIMのCameraを受け、`vision_msgs/Detection2DArray`と状態を返します。Object Searchは次の証拠を組み合わせます。

- COCO classとconfidence
- freshなRGB frameとDetectionの対応
- Depthによる対象距離
- current map、SLAM pose、Nav2 readiness
- runtime／Vision／Transport／操作権のcycleまたはgeneration

自然言語は先に決定論パーサーへ渡し、1つの対象を持つ探索、取消、再開、helpだけを受け付けます。Optional Local LLMを有効にした場合も、未知の安全な表現を同じintentへ補助変換するだけです。

## runtime制御

`run.sh`と`start.sh`はViteとROS backendを専用process groupで起動し、PID、PGID、128-bit世代token、状態を`.logs/`へ記録します。世代tokenはgroup leaderと独立sentinelの両方にOS-visibleなidentityとして保持し、片方が停止してもexact working directoryと全memberのcommand markerを再検査して安全に回収します。起動・停止とROS切替はkernel lockで直列化し、切替workerが停止してlockを失った場合はstale状態をSIMへ回収します。

UIからのmode切替は同一originの`/api/runtime`を経由して`scripts/runtime.sh`へ渡されます。`stop.sh`は記録済みの本repository所有processだけを停止し、他のROS 2 processを無差別に終了しません。

Browser操作権は`/api/control-lease`で1つのclientへ短時間付与します。leaseを失ったBrowserは手動入力や探索を継続できません。

Optional Local LLMのBrowser APIは`/api/llm/status`と`/api/llm/intent`だけです。tokenはBrowserへ渡らず、LLM結果はintent検証後に通常の状態機械へ入ります。詳細は[Optional Local LLM](OPTIONAL_LOCAL_LLM.md)を参照してください。

## Networkとtrust boundary

- Vite: `127.0.0.1:27182`
- rosbridge: `127.0.0.1:9090`
- Optional Local LLM sidecar: `127.0.0.1:27184`
- Browserからのruntime、shutdown、操作権、LLM APIはsame-originを検査
- LLM provider URLはloopbackだけを許可
- arbitrary shellとarbitrary ROS forwardingは提供しない

この境界を越える公開方法は設計対象外です。
