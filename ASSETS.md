# Asset provenance

この文書は、公開repositoryへ同梱するasset、setup時にのみ取得するasset、
再配布承認待ちで同梱しないassetの来歴境界を記録します。machine-readableな
同梱file一覧とSHA-256は`assets/manifest.json`を正とします。現在のmanifestは
空であり、再配布条件を確認できていないbinary assetはcommitしていません。

## 再配布承認待ち（同梱しない）

### `maps/training_room.pgm` と `maps/training_room.yaml`

- 以下のhashは、再配布承認待ちの地図pairを識別するための記録です。両fileと
  補助的な`training_room.start_pose.json`は承認されるまで配布対象へ含めません。
- SHA-256:
  - PGM: `07df630df884ed8d2bf952a3f6dd828b45d85593cd74ad8c843f3883aff50764`
  - YAML: `70f9dbd8e5ace4163fcb389bbc500440989daa56fc5f8f7010e467a91997ae47`
- 内容: 完全な仮想Training RoomをSLAM Toolbox Map Saverで保存した
  OccupancyGridと相対画像参照
- 外部写真、実環境scan、個人情報: 使用していない
- 再配布license: owner確認待ちのため非同梱

`scripts/generate_default_map.py`は`.logs/default_map/default.*`を生成する
fallback入口であり、この候補地図をbyte-for-byte生成するscriptではありません。
承認後に同梱する場合も、asset manifestのcreator/sourceには、この二つを混同せず
「仮想Training RoomをSLAM Toolbox Map Saverで保存」と記録します。

候補YAMLの`image: training_room.pgm`は相対pathで解決し、絶対path、hostname、
個人名を含まないことを確認済みです。

### `public/vision/apple_search_target.jpg`

- SHA-256: `7e09f0b70a0ae3ce27a7d319a7c3b8e8df97a697e5e7a33e38392d23b87d9657`
- type／size: JPEG、640×480、45,093 bytes
- 生成: 2026-08-28、ROS2 Visual Starter用にOpenAI ImageGenで生成
- 外部source image: なし
- 処理: `scripts/prepare_apple_target.py` で640×480、JPEG quality 88へ変換し、
  metadataを除去
- 用途: YOLOX COCO `apple` classのsynthetic local vision target
- 再配布license: owner確認待ちのため非同梱

生成serviceの利用条件と、本repoから第三者へ与えるasset licenseは別の論点です。
この文書は生成物へMIT、CC0、CC-BY等を自動的に指定しません。ownerがcreatorと
再配布licenseを明示し、manifestへ承認済みentryを追加するまで公開repoへ
同梱しません。元prompt全文や不採用candidateも公開repoへ同梱しません。

## download-only（同梱しない）

### YOLOX-Nano ONNX weight

- URL: <https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx>
- SHA-256: `c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d`
- size: 3,659,407 bytes
- local cache: `public/vision/yolox_nano.onnx`（Git除外）
- 方針: YOLOX source repositoryはApache-2.0だが、release weight固有の
  再配布条件は別途明文化されていないため、本repoから再配布しない

### YOLOX dog validation image

- URL: <https://raw.githubusercontent.com/Megvii-BaseDetection/YOLOX/0.3.0/assets/dog.jpg>
- SHA-256: `5a9522051c3cec2bbd2f6323fccba32e8fbf3ddcc2b3e2fd46b04c720bc6f866`
- size: 163,759 bytes
- local cache: `public/vision/dog.jpg`（Git除外）
- 方針: YOLOX repository内のassetだが元写真の追加来歴が明記されていないため、
  本repoから再配布しない

download scriptはchecksum不一致時にpartial fileを削除して失敗し、取得物を
使用しません。download-only assetは `assets/manifest.json` のtracked asset
一覧へ加えません。

## 3D robot model

OSS v1の標準ロボットは、`src/starterRobotModel.ts` がThree.jsの基本geometryから
生成するfirst-party TypeScript codeです。外部3D asset、texture、character、商標、
既存ロボットデザインは使用していません。したがってbinary assetではなく、
`assets/manifest.json`への登録対象でもありません。rootのMIT Licenseがこのsource codeへ
適用されます。

このvisual modelはphysics、LiDAR、Camera、wheel geometry、floor位置とのinterfaceを
`src/robotGeometry.ts`とSimulation側で共有します。将来glTF、GLB、OBJ、PNG texture等へ
差し替える場合は、その時点でcreator／source、再配布license、SHA-256、承認flagを
manifestへ追加し、第三者assetとして別途監査します。licenseを推測して割り当てません。

## 公開前check

- tracked binaryがすべて `assets/manifest.json` に存在する
- manifest entryのfileが存在し、SHA-256が一致する
- `creatorOrSource` が空でない
- `approvedForRedistribution` が `true` である
- owner確認済みのlicenseが空、`unknown`、`TBD`でない
- download-only assetがtrackedされていない
- starter robotがfirst-party source codeとして提供され、外部3D binary assetを使用していない
