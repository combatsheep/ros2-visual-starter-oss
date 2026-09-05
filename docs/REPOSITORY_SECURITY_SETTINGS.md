# GitHubの保護・監視設定

公開repositoryの管理者は、コードの検証に加えて以下のGitHub設定を維持してください。
設定の有効化はGitHub側で行います。この文書やCIの成功だけでは有効化の証拠になりません。

## main ruleset

Settings → Rules → Rulesetsでbranch rulesetをActiveにします。

- 対象: `refs/heads/main`
- Pull Request必須、approvalは0（個人管理でも自分のPRをmerge可能）
- review conversationの解決必須
- 必須check: **CI / verify**。APIで指定するcheck contextは`verify`、発行元はGitHub Actions（app ID `15368`）
- merge前に最新mainへの追従とcheck成功を要求
- force push禁止（non-fast-forwardの禁止）
- branch削除禁止
- 常設bypassなし。緊急対応は所有者だけが一時的な例外設定を行い、理由を記録し、完了後ただちに復旧する

signed commitの必須化は全contributorの署名準備ができた時点で検討します。
release tagは可能なら署名し、release assetはimmutable releaseとdigestで固定してください。

## Code security / Secret protection

SettingsのCode securityおよびSecret protectionで次を有効にします。

- Dependency graph
- Dependabot alerts
- Dependabot security updates
- CodeQL default setup: JavaScript/TypeScript、Python（standard runner、default query suite）
- Secret scanning
- Push protection
- Private vulnerability reporting

脆弱性の非公開報告は[Securityタブ](https://github.com/combatsheep/ros2-visual-starter-oss/security)の
「Report a vulnerability」を使用します。公開Issueへ秘密情報を投稿しないでください。
CodeQL default setupはGitHub管理の解析です。repositoryの通常CIは`contents: read`を維持し、
外部Actionは完全なcommit SHAに固定します。

## 定期更新

`.github/dependabot.yml`はnpmとGitHub Actionsを毎週月曜09:00（日本時間）に確認します。
更新PRは通常の`verify`を通してからmergeし、Actionsのcommit SHA固定を維持します。
`npm ci --no-audit`は再現可能なインストール用であり、advisoryの検査ゲートではありません。
新しいadvisoryはDependabot alertsで監視します。

Pixi/CondaはDependabotの対象外です。管理者は月1回およびupstreamのセキュリティ通知時に
[Pixi releases](https://github.com/prefix-dev/pixi/releases)、使用するConda packageのupstream advisoryを確認し、
必要な更新を専用PRで行います。`pixi update`による`pixi.lock`の差分を確認し、
frontend/backend test、public audit、SIM smoke、Vision smokeを再実行してください。
通常のセットアップは`pixi install --locked`を維持します。

## 実行物の取得

`setup.sh`はローカルの`scripts/bootstrap_pixi.sh`を使用します。
[Pixi v0.77.0](https://github.com/prefix-dev/pixi/releases/tag/v0.77.0)のimmutable release archiveを取得し、
repository内に固定したOS/CPU別SHA-256と一致した後にのみ展開・実行します。
固定値は公式`sha256.sum`とGitHub release assetの`digest`を照合したものです。
配布元のchecksumをその場で信頼する方式や、可変remote installerの直接実行は禁止します。
不一致・取得失敗・検証ツール失敗・未対応OS/CPUでは中止し、sudoを使いません。
既存のローカルPixiは従来どおり信頼済みとしてversionを確認します。
macOS Apple Siliconのみ正式サポートで、他の定義済みbootstrap platformはCI override用です。

public auditはshell/workflowのremote installer実行を検出し、ネットワーク取得を含むshellの
レビュー済みdigestを固定します。新規download経路や既存経路の変更は監査を失敗させます。
digestの更新は自動化せず、取得元固定・実行前検証・失敗時停止をレビューし、bootstrapの
正常系と失敗系テストを通した後に行います。これは任意言語の完全な静的解析ではありません。

## Stage media

画像は10 MiB以下、WebMは25 MiB以下かつ0秒超60秒以下です。長さ不明の動画は拒否します。
サイズをObject URL作成前に確認し、metadata読込は15秒で中止してURLを解放します。
保存済み動画も復元時に実データを検証し、制限外の古いmediaは復元対象から除外します。
表示用URLは置換・ページ終了時に解放し、back/forward cache内のページでは保持します。
IndexedDBの総容量はブラウザのquotaに従い、容量不足は日本語で通知します。
保存失敗時の既存仕様（一時的にページ内だけで使用可能）は維持します。

## 公式資料

- [Repository rulesets API](https://docs.github.com/en/rest/repos/rules)
- [CodeQL default setup API](https://docs.github.com/en/rest/code-scanning/code-scanning)
- [Repository security settings API](https://docs.github.com/en/rest/repos/repos)
