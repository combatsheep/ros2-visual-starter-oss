# Optional Local LLM

ROS2 Visual Starterの自然言語入力は、Local LLMがなくても決定論的な
Rule-based parserで動きます。任意のLocal LLMは、parserが一意に理解できない
安全な言い回しを、既存のObject Search Mission intentへ分類する補助機能です。
速度、座標、ROS操作、shell実行を生成する機能ではありません。

## 既定動作

既定値は`ROS2_VISUAL_LLM_ENABLED=0`です。この状態ではprovider clientを構築せず、
provider endpointへの通信も行いません。次の入力はLocal LLMなしで処理できます。

```text
りんごを探して
appleを探して
探索を中止して
```

Rule-based parserが受理した入力ではLocal LLMを呼びません。複数対象、未対応class、
任意座標移動、速度指定、shell命令、任意のROS Topic／Service／Action、URL取得、
安全ルール変更を含む入力は拒否します。

## 接続境界

```text
Browser
  -> same-origin /api/llm
  -> 127.0.0.1:27184 の内部adapter
  -> 利用者が管理するOpenAI-compatible local endpoint
```

内部adapterは`./run.sh`がSIM／ROS 2の両方で起動します。LLM runtimeとmodelは
repositoryへ同梱せず、`setup.sh`も導入・download・起動・停止しません。利用者が
自分で起動したloopback serviceだけを接続先にできます。LM Studioは利用可能な
OpenAI-compatible local serverの一例ですが、必須依存でも既定providerでもありません。

## 設定

利用するshellで次を設定してから起動します。model IDはlocal endpointの
`/v1/models`が返す値と完全に一致させてください。

```bash
export ROS2_VISUAL_LLM_ENABLED=1
export ROS2_VISUAL_LLM_BASE_URL=http://127.0.0.1:1234/v1
export ROS2_VISUAL_LLM_MODEL='<model-id>'
export ROS2_VISUAL_LLM_TOKEN=
./run.sh --sim
```

認証が必要なlocal endpointだけ、最後の変数へtokenを設定します。tokenはPython
adapterだけが読み、Browser responseへ含めません。Authorization、token、入力全文を
logへ出しません。設定をlocal fileへ保存する場合は`.env.example`を参考に
`.env.local`を作り、利用者自身が信頼するshellへ読み込んでください。`.env.local`は
Gitの除外対象です。

`ROS2_VISUAL_LLM_BASE_URL`には次の制約があります。

- schemeは`http`または`https`
- hostは`localhost`、`127.0.0.1`、`::1`のいずれか
- pathは`/v1`
- username、password、query、fragmentは禁止
- redirectとsystem proxyの利用は禁止

接続先processの管理とmodelの選択は利用者の責任です。本repositoryの設定だけで
loopback制限を解除する方法はありません。

## Intentの検証

処理順は固定です。

1. Rule-based parserで入力を評価する
2. 一意に解釈できれば、Local LLMへ送らず既存intentを使う
3. 解釈できず、入力が事前安全検査を通り、adapterが明示的に有効な場合だけ問い合わせる
4. `/v1/models`で設定modelを完全一致確認する
5. `/v1/chat/completions`のStructured Outputをstrict schemaで読む
6. 単一intent、単一COCO class、入力中の対象tokenとの一致を再検証する
7. request ID、generation、Transport cycle、Control Leaseを再検証してmissionへ渡す

許可するLLM intentは`find_object`、`cancel_object_search`、`unsupported`だけです。
自由文、未知field、複数対象、未知class、巨大response、timeout、通信失敗、古いresponseは
すべてfail-closedで拒否します。失敗時に推測したmissionへfallbackしません。

## 状態確認

起動後、Browserと同じoriginからadapter状態を確認できます。

```bash
curl --fail http://127.0.0.1:27182/api/llm/status
```

`disabled`は既定の正常状態です。`ready`は設定を受理した状態であり、providerとmodelの
実在確認は最初の未知表現を処理するときに行います。`unavailable`または`error`では、
UIに日本語の理由を表示し、Rule-based parserだけを継続します。

## 決定的テスト

実modelはacceptanceに不要です。loopback mock serverとpure contract testで境界を
検証します。

```bash
PYTHONPATH=backend ./scripts/pixi.sh run python -m pytest \
  backend/tests/test_local_llm_client.py \
  backend/tests/test_local_llm_contract.py \
  backend/tests/test_optional_llm_server.py
./scripts/pixi.sh run npm test -- \
  tests/objectSearchIntent.test.ts \
  tests/localLlmIntent.test.ts \
  tests/localLlmIntentBoundary.test.ts \
  tests/optionalLlmBoundary.test.ts
```

テストはdefault-off時の無通信、valid Structured Output、invalid JSON、未知class、
複数対象、巨大response、timeout、redirect、非loopback URL、token／promptの非露出、
stale response拒否を確認します。
