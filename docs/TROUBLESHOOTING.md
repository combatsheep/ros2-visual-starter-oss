# トラブルシューティング

最初に、repository rootで診断を実行してください。

```bash
./scripts/doctor.sh
```

Frontendの静的検証だけを分けて確認する場合は次を実行します。

```bash
./scripts/pixi.sh run npm run typecheck
./scripts/pixi.sh run npm run lint
./scripts/pixi.sh run npm test
./scripts/pixi.sh run npm run build
```

## `setup.sh`が失敗する

### Gitまたはcurlがない

`setup.sh`は最初に必須commandを検査し、見つからなければ終了します。OSの標準手順でGitとcurlを導入してから再実行してください。`setup.sh`は`sudo`やsystem package managerを自動実行しません。

### Pixi installerで止まる

画面に表示されたinstaller URLとnetwork errorを確認してください。曖昧なfallbackは行いません。導入後に次でversionを確認できます。

```bash
./scripts/pixi.sh --version
```

### `./scripts/pixi.sh install --locked`が失敗する

lockfileと異なるplatform、壊れたcache、network errorを確認してください。まず同じcommandを再実行します。

```bash
./scripts/pixi.sh install --locked
```

lockfileを理由なく更新しないでください。対応platform外の場合は、失敗内容と`uname -s`、`uname -m`をIssueへ記載してください。個人pathは削除してください。

### `npm ci`が失敗する

Node.js 22をPixi経由で使っているか確認します。

```bash
./scripts/pixi.sh run node --version
./scripts/pixi.sh run npm --version
./scripts/pixi.sh run npm ci
```

`package.json`と`package-lock.json`が一致しない場合はrepository側の問題です。通常利用者がlockfileを書き換える必要はありません。

### Vision assetのchecksumが一致しない

途中まで取得したfileや配布元の予期しない変更を使用せず、download scriptのerrorで停止してください。checksum検査を無効にしないでください。

```bash
./scripts/pixi.sh run vision-assets
./scripts/pixi.sh run vision-smoke
```

## Browserが開かない

自動openの失敗だけではruntimeは停止しません。手動で次を開きます。

```text
http://127.0.0.1:27182/
```

応答を確認します。

```bash
curl --fail http://127.0.0.1:27182/
```

Frontend logは`.logs/frontend.log`を確認してください。

## Portが使用中と表示される

まず本repositoryのprocessを終了します。

```bash
./stop.sh
```

listenerを確認します。

```bash
lsof -nP -iTCP:27182 -sTCP:LISTEN
lsof -nP -iTCP:9090 -sTCP:LISTEN
```

別applicationが使用している場合は、そのapplication側を安全に停止してから再実行してください。所有者不明processを一括killしないでください。bind先を外部interfaceへ変更する回避策はサポートしません。

## ROS 2へ接続できない

1. `--sim`ではなく目的のROS modeで起動したか確認します。
2. `./scripts/doctor.sh`でrosbridgeと必要packageを確認します。
3. `127.0.0.1:9090`のlistenerを確認します。
4. `.logs/ros_backend.log`と`.logs/runtime_error`を確認します。
5. UIのTransport状態が`CONNECTED`へ変わるまで待ちます。

Browserはsame-originの`/rosbridge`だけへ接続します。別hostのrosbridgeはサポートしません。

## Mappingで地図が出ない、保存できない

- `./run.sh --mapping`で起動したか確認してください。
- ROS graphが準備中の場合は、live mapとposeの両方が届くまで待ってください。
- SIM画面でロボットを動かし、LiDAR scanが更新されていることを確認してください。
- STAGE編集中、runtime切替中、map reset中、Transport切断中は保存できません。
- 地図名は英数字、ハイフン、アンダースコアの48文字以内にしてください。

Map Saverのerrorは画面と`.logs/ros_backend.log`に表示されます。

## Navigationを開始できない

- `./run.sh --navigation`で起動したか確認します。
- 指定したYAMLと参照画像が存在することを確認します。
- 保存地図がない場合は、標準Medium stage用のdefault mapが生成されます。
- 現在のSTAGEを変更した場合は、Mappingで対応する地図を作り直します。
- map、pose、Nav2 lifecycleが`ready`になるまで待ちます。
- Safety stop、Transport切断、STAGE view、操作権なしの状態ではgoalを送れません。

地図を明示する例です。

```bash
./run.sh --navigation --map maps/example.yaml
```

## Explorationを開始・再開できない

Explorationは次をすべて確認してから開始します。

- runtimeが`exploration`でstable
- Transportが`CONNECTED`
- live map、SLAM pose、Nav2がready
- mapとposeがfresh
- Safety stopが解除済み
- SIM viewを表示中
- このBrowserが操作権を所有
- operatorのNavigation goalが進行中でない

pause後は古いmapやposeを使わず、新しい証拠を待ってから明示的に再開してください。繰り返しgoalが失敗する場合は、STAGEの通路幅、robot clearance、現在地が既知free cellにあるかを確認します。

## Object Searchが動かない

LLMは必須ではありません。まず決定論パーサーで次のような命令を試します。

```text
犬を探して
```

次を確認してください。

- `./run.sh --exploration`相当のgraphが準備できること
- YOLOX weightがchecksum検証済みであること
- `/vision/status`がreadyであること
- mission開始後のfresh Camera frameとDetectionがあること
- Depth、live map、SLAM poseがfreshであること
- 対象がYOLOX COCOクラスに含まれること
- 1つの命令に対象を1つだけ指定していること

```bash
./scripts/pixi.sh run vision-assets
./scripts/pixi.sh run vision-smoke
```

Detectionが見えても、古いframe、Depthなし、class違い、confidence不足、停止前の証拠だけでは成功になりません。

## Optional Local LLMが利用できない

既定はdisabledで、これはerrorではありません。決定論パーサーの対応命令はそのまま使えます。

有効化した場合は、providerがloopbackで起動していること、model IDを明示していること、必要なtokenをprocess環境変数へ設定していることを確認します。Browserへtokenを設定しないでください。詳細は[Optional Local LLM](OPTIONAL_LOCAL_LLM.md)を参照してください。

## STAGE JSONをimportできない

- 拡張子が`.json`であること
- 1 MB以下であること
- schema versionが対応値であること
- 未知field、重複ID、範囲外の位置・寸法・色がないこと
- assetが組み込み参照またはBrowserへ登録済みのlocal mediaであること

任意URLをasset fieldへ指定したJSONは受け付けません。

## Stage mediaを追加できない

- 対応形式はJPEG、PNG、WebMです。
- extensionとMIMEが一致する必要があります。
- 幅と高さはそれぞれ50〜5000 pxです。
- BrowserのIndexedDBが無効または容量不足の場合、一時表示だけになり、再読み込み後に残らないことがあります。

mediaはBrowser内へ保存され、serverへuploadされません。

## 終了できない、mode切替が止まる

別Terminalで次を実行します。

```bash
./stop.sh
```

`stop.sh`は`.logs/`へ記録された本repository所有processだけを対象にします。終了後もportが残る場合は`lsof`で所有processを確認し、無関係なROS 2 processを停止しないでください。

runtimeの状態は次で確認できます。

```bash
curl --fail http://127.0.0.1:27182/api/runtime
```

## Issueへ添える情報

- current `main`のcommit ID
- 実行したcommandと選択したmode
- OS名とarchitecture
- 秘密情報、個人path、自然言語の実入力を除いたerror
- 実行した診断と結果

credentialや脆弱性の詳細は公開Issueへ貼らず、[Security Policy](../SECURITY.md)に従ってください。
