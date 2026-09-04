# ROS2 Visual Starter

ROS2 Visual Starterは、ロボット、LiDAR、ROS 2メッセージ、地図、経路計画の関係をブラウザで観察しながら学ぶためのローカル教材です。Three.jsとRapierで動くSIMを入口にし、必要に応じてROS 2 Jazzy、SLAM Toolbox、Nav2、YOLOXを同じ画面へ接続します。

> [!IMPORTANT]
> OSS初版では、センサー位置や車体構造を理解しやすくするため、基本図形のみで構成したミニマルな教材用starter robotを正式採用しています。外部3D assetは使用していません。将来のmodel差し替えは可能ですが、必須ではありません。

## できること

- ROS 2なしで、走行、衝突、LiDAR、Odometry、TF、CameraのメッセージをSIM表示する
- ROS 2へ接続し、Topicの流れと生メッセージをブラウザで確認する
- SLAM Toolboxで仮想空間の地図を作り、保存する
- 保存地図とNav2を使って目標地点へ移動する
- online SLAMとNav2を組み合わせ、frontier候補を順番に探索する
- CameraとDepthをYOLOXへ渡し、COCOクラスの物体探索を行う
- STAGE画面で壁、箱、Gate、画像パネルを編集し、version付きJSONとして入出力する

## 構成要素の関係

SIMはThree.jsによる表示とRapierによる物理計算を担当し、ROS 2がなくても単独で動きます。ROS 2構成では、ブラウザ内のSIMがLiDAR、Odometry、TF、Cameraを配信し、rosbridge経由でROS graphと接続します。

- SLAM ToolboxはLiDARと姿勢からOccupancyGridを生成します。
- Nav2は保存地図またはonline map上で`NavigateToPose`を処理します。
- Frontier Explorationは地図から未知領域との境界を抽出し、安全余白と到達距離を評価してNav2へ目標を渡します。
- YOLOXはCamera画像を推論し、Detectionを返します。
- Object Searchは自然言語を限定された探索intentへ変換し、Frontier Exploration、YOLOX、Depth、Nav2を組み合わせます。
- 手動操作とNav2の速度はCommand Gateで一方だけが選択され、その後にSafety Controllerを通ってからロボットへ届きます。

詳しい境界は[アーキテクチャ](docs/ARCHITECTURE.md)と[状態機械](docs/STATE_MACHINE.md)を参照してください。

## サポート対象

正式対応環境はmacOS Apple Silicon（arm64）です。Terminal、Git、curlを利用できることを前提とします。Node.js、Python、ROS 2 Jazzy、Nav2、SLAM Toolbox等はPixi環境へ導入します。

Linux、Windows、Intel MacはOSS初版の正式サポート対象外です。動作する可能性があっても、検証済み環境としては扱いません。ブラウザにはES Modules、WebGL、IndexedDBを利用できる現行のデスクトップブラウザが必要です。

## Quick Start

Git、curl、インターネット接続が必要です。`setup.sh`は固定したPixiをユーザー領域へ導入し、lockfileどおりのNode.js 22、Python、ROS 2依存を準備します。`sudo`は使いません。

```bash
git clone https://example.invalid/ros2-visual-starter-oss.git
cd ros2-visual-starter-oss
./setup.sh
./run.sh --sim
```

起動後、ブラウザで `http://127.0.0.1:27182/` を開きます。自動でブラウザが開かなくてもruntimeは停止しません。

SIMモードはROS 2もLocal LLMも必要としません。終了時は次を実行します。

```bash
./stop.sh
```

## 起動モード

一度に選べる構成は1つです。別の構成へ切り替えると、現在のNavigation goalを取り消し、速度を0にしてから必要なprocessを入れ替えます。

| コマンド | 用途 | 主なprocess |
| --- | --- | --- |
| `./run.sh --sim` | ROS 2なしで教材を試す | Vite、Three.js、Rapier、ブラウザ内Topic bus |
| `./run.sh --ros` | ROS Topicと安全制御の基礎を確認する | rosbridge、Command Gate、Safety、Map Library、Vision |
| `./run.sh --mapping` | 地図を作成して保存する | ROS基礎構成、SLAM Toolbox、Map Saver |
| `./run.sh --navigation` | 選択中の保存地図でNav2を使う | ROS基礎構成、Map Server、AMCL、Nav2 |
| `./run.sh --navigation --map maps/example.yaml` | 指定した地図でNav2を使う | navigationと同じ |
| `./run.sh --exploration` | online mapを作りながら自律探索する | ROS基礎構成、SLAM Toolbox、Nav2、Frontier Exploration |

### Mapping

```bash
./run.sh --mapping
```

SIM画面で走行して地図を作り、画面の地図保存操作で名前を指定します。地図名には英数字、ハイフン、アンダースコアを使用でき、最大48文字です。生成した地図は`maps/`へ保存されます。

### Navigation

```bash
./run.sh --navigation
```

保存地図を選んでいる場合はその地図を読み込みます。保存地図がない場合は、標準のMedium stageに対応するローカル生成のdefault mapを使います。地図を明示する場合は次のように指定します。

```bash
./run.sh --navigation --map maps/example.yaml
```

### Exploration

```bash
./run.sh --exploration
```

Explorationは保存地図を読み込まず、新しいonline mapから開始します。live map、SLAM pose、Nav2、操作権が準備できるまで開始操作は無効です。

### Object Search

Object SearchはExploration構成、YOLOX weight、Camera、Depthを必要とします。`setup.sh`は検証済みchecksumのVision assetを取得します。画面で、たとえば次のように入力します。

```text
バナナを探して
探索を中止して
探索を再開して
ヘルプ
```

この限定的な自然言語操作はLLMなしで動作します。対象はYOLOXが識別できるCOCOクラスから1つだけ選び、速度、座標、安全ルールの変更を直接指示する入力は受け付けません。

## Optional Local LLM

任意のローカルLLMを接続すると、決定論パーサーが認識できない安全な表現を、同じ限定intentへ補助変換できます。既知の命令は常に決定論パーサーが先に処理し、LLMを呼びません。LLMの結果もschemaとallowlistで再検証され、直接robot commandにはなりません。

LLM runtimeとmodelはこのrepositoryに同梱せず、`setup.sh`でも自動インストールしません。利用者自身が管理するloopback serviceだけを任意で接続できます。設定方法は[Optional Local LLM](docs/OPTIONAL_LOCAL_LLM.md)を参照してください。

## Network boundary

本プロジェクトは**localhost-only**です。Frontend、rosbridge、ROS backend、任意のLocal LLM接続はloopbackに限定され、`http://127.0.0.1:27182/` から利用します。LANまたはInternetへ公開する構成はサポートしません。

詳細と脆弱性の連絡方法は[セキュリティポリシー](SECURITY.md)を参照してください。

## 現時点の制約

- 3Dロボットは外部assetを使わず、Three.jsの基本geometryから生成するOSS v1の正式な教材用starter robotです。将来のmodel差し替えは任意です。
- 教材用の仮想環境を対象とし、実機ロボットや安全重要用途の動作保証はありません。
- SIMだけではSLAM Toolbox、Nav2、YOLOX Object Searchは実行できません。
- Navigation用default mapは標準のMedium stage向けです。STAGEを変更した場合はMappingで地図を作り直してください。
- Object SearchはYOLOXのCOCOクラスと、freshなCamera、Depth、map、poseが揃う場合に限られます。
- Local LLMは表現の補助だけを行い、任意の会話、任意のROS操作、直接速度制御には対応しません。
- 正式対応platformはmacOS Apple Siliconです。Linux CIを使う場合もportable unit test用であり、macOS対応の証明にはなりません。

## 開発・ライセンス

- 開発手順: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- コントリビューション: [CONTRIBUTING.md](CONTRIBUTING.md)
- トラブルシューティング: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- プロジェクトライセンス: [LICENSE](LICENSE)
- Third-party notice: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- Assetと再配布条件: [ASSETS.md](ASSETS.md)
- Dependency license audit: [docs/DEPENDENCY_LICENSE_AUDIT.md](docs/DEPENDENCY_LICENSE_AUDIT.md)
