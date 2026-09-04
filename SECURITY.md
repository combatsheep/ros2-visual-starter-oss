# Security Policy

## 対象

ROS2 Visual Starterはlocal development／learning toolです。セキュリティ修正はcurrent `main`だけを対象とし、過去のcommitやforkへの個別対応は行いません。paid SLAとbug bounty programはありません。

本プロジェクトは実機ロボット、安全重要システム、共有server、Internet service向けの製品ではありません。

## Network boundary

- Vite、rosbridge、ROS backendはloopback-onlyです。
- UIは`http://127.0.0.1:27182/`から利用します。
- 変更系APIとWebSocketはOrigin必須です。rosbridge本体もdocumented loopback UI Originだけを受理し、Vite proxyの迂回を拒否します。
- LANまたはInternetへの公開はサポートしません。
- Optional Local LLMは利用者が管理するloopback serviceに限ります。
- 既定ではOptional Local LLM adapterを起動せず、Rule-based parserだけを使います。
- LLM tokenはprocessの環境変数だけから読み、Browserへ渡しません。
- Local LLM runtimeとmodelは同梱せず、自動インストールも自動起動も行いません。

listenerのbind先やproxy先をloopback以外へ変更すると、このセキュリティ前提から外れます。

停止処理はPIDだけを信用せず、専用PGID、exact working directory、世代tokenを持つleaderまたはsentinel、group内command markerを照合します。識別できないprocess groupは自動停止しません。

## Robot command boundary

- LLM出力が直接robot commandになることはありません。
- LLM結果はstrict schemaとintent allowlistで検査し、既存の状態機械へ入力します。
- 自然言語から速度、座標、shell command、任意のROS Topic／Service／Actionをforwardする機能はありません。
- 手動操作とNav2出力はCommand Gateで一方だけが選択され、Safety ControllerがLiDAR、command timeout、scan timeoutを検査してから`/cmd_vel`を配信します。
- runtime切替、接続喪失、window focus喪失、安全停止では速度0を要求します。

これらは教材内の防御境界であり、実機向けの機能安全認証ではありません。

## Local file input

STAGE JSON importは`.json`、最大1 MB、version付きschema、field allowlist、値域を検査します。画像パネルへ追加できるlocal mediaはJPEG、PNG、WebMだけで、extensionとMIMEの整合、50〜5000 pxの寸法を検査します。asset fieldに任意URLは指定できません。

追加したmediaはBrowserのIndexedDBへ保存され、server upload APIへ送信されません。信頼できないファイルは読み込まないでください。

## 秘密情報の扱い

- tokenは環境変数に設定し、repository、screenshot、logへ保存しないでください。
- `.env`、credential、実際のprompt、自然言語入力を含む実ログ、個人の絶対pathをcommitしないでください。
- IssueやPull Requestには、秘密情報を除いた最小再現例だけを貼ってください。
- 誤って秘密情報を公開した場合は、投稿の削除だけでなく、提供元で直ちに失効・再発行してください。

## 脆弱性の報告

公開Issueへ詳細を書かず、GitHubの`Security`からprivate vulnerability reportingを使用してください。次を、秘密情報を除いて添えてください。

- 影響するcurrent `main`のcommit
- 再現条件と最小手順
- 想定される影響
- 可能なら緩和案

受領確認や修正期限を保証するSLAはありません。公開時期は、影響範囲と修正の準備状況を確認して調整します。
