# 読み取り専用の利用状況収集

Windows等の収集元PCへの導入と認証接続は未実施です。GMKtec上のClaude Codeについては、2026-10-15にstatuslineからのsnapshot保存と専用senderの常駐を実施しました（詳細は実装監査§37）。アダプターの固定データ試験とGMKtecの実アカウント入力による受信確認が完了しています。プロンプト、回答、作業パス、メール、トークン、生のstdinは保存・送信しません。送信対象は許可された区分、率、リセット予定、状態、エイリアス、時刻だけです。

Antigravity・OpenCode Go・Hermes／Nousは[追加サービスの収集手順](provider-usage.md)を参照してください。

## Claude Code

公式仕様を2026-10-02に確認しました。[statusline仕様](https://code.claude.com/docs/en/statusline)のrate_limits.five_hourとseven_dayのみ読み、spend_limitは使いません。used_percentageは0〜100、resets_atはepoch秒です。公式ページではPro/MaxまたはGatewayにより項目の有無が異なり、最初のAPI応答前は欠損する場合があります。表示を更新するためのAI呼び出しは行いません。

### Anthropic OAuth usage API（API取得経路）

[Hermes provider-usage](https://github.com/PhoeniXAbhisheK/hermes-plugin-provider-usage)の取得方式を参考に、Claude Codeが保存したOAuth tokenでAnthropicの利用状況APIを読み取る経路も用意しています。対象は固定の `GET https://api.anthropic.com/api/oauth/usage` で、`five_hour.utilization` と `seven_day.utilization`、それぞれの `resets_at` だけを既存のClaude `Usage`へ変換します。`anthropic-beta: oauth-2025-04-20` を付け、別のAPI、会話、プロンプト、モデル実行は行いません。

tokenは既存の `~/.claude/.credentials.json` の `claudeAiOauth.accessToken` を読み取り専用で使います。資格情報ファイルの内容やAPI応答全体をsnapshot・ログ・母艦へ送らず、Fireへは既存契約の利用率、リセット予定、状態、時刻だけを送ります。HTTP 401/403、429、タイムアウト、過大応答、不正JSONは分類済み状態に変換し、レスポンス本文は保存しません。

GMKtecでAPI経路へ切り替える場合は、既存statusline collectorと同じsnapshotファイルを同時に書かないでください。次のサービスはClaude Codeのログイン済みcredentialsを一定間隔で読み、既存の送信APIへsnapshotを送ります。

```sh
npm run build:collectors
FIRE_SNAPSHOT_PATH="$HOME/.local/state/fire-dashboard/claude-api.json" \
FIRE_SOURCE_ALIAS="gmktec" \
FIRE_ENDPOINT="https://<gmktec>/api/v1/usage" \
FIRE_COLLECTOR_TOKEN_FILE="$HOME/.config/fire-dashboard/collector-token" \
node dist/collectors/claude-api-service.mjs
```

任意の `FIRE_CLAUDE_CREDENTIALS_FILE` でcredentialsの読み取り先を明示でき、`FIRE_POLL_SECONDS` は30〜280秒（既定60秒）です。statusline経路から切り替えるときは、送信側の `FIRE_SNAPSHOT_PATHS` もAPI用snapshotだけに合わせ、集約APIの `preferredSources.claude` は既存の `gmktec` を維持します。API経路はコードと固定データ試験までを実装しており、実アカウントでの切り替え・systemd反映は別途の運用作業です。

ローカルスクリプトは `FIRE_SNAPSHOT_PATH` と非個人情報の `FIRE_SOURCE_ALIAS` を指定して実行します。stdin JSONから指標だけ選別して原子的に保存し、ネットワークは使いません。statuslineは再描画のたびに呼ばれるため、`npm run build:collectors` で単一ファイルにまとめた `node dist/collectors/claude-statusline.mjs` を使います(`npx tsx` は Windows で1回1秒以上かかり、まとめたファイルは約0.1秒です)。既存statuslineがある場合はバックアップしてから併用ラッパーを管理者が作成してください。従来スクリプトの出力はそのまま画面に残し、抽出処理は出力を捨ててバックグラウンドで動かします。実際の設定ファイルをこのプロジェクトが変更することはありません。

### GMKtecでの実運用（2026-10-15）

GMKtecのClaude Code `2.1.300` は既存の `~/.claude/statusline-command.sh` を使い、従来の表示出力を維持したまま `dist/collectors/claude-statusline.mjs` を非同期実行する。snapshotは `~/.local/state/fire-dashboard/claude-snapshot.json` に保存し、`fire-dashboard-claude-sender.service` が15秒間隔で監視して、変化時または60秒heartbeatで既存のHTTPS collectorへ送信する。送信元エイリアスは `gmktec`、API側の表示選択は `preferredSources.claude=["gmktec","win-desktop"]` とする。同一アカウントを合算せず、許可された取得元の最新値を表示する。

statusline編集前に `~/.claude/statusline-command.sh.bak-20261015_074210`、設定編集前に `~/.claude/settings.json.bak-20261015_073949` と `~/.config/fire-dashboard/config.json.bak-20261015_073949` を作成した。Claudeのrate limit JSONは `provider=claude`、`sourceAlias=gmktec`、5時間／7日間の2枠だけを保存し、APIの正本stateで `receivedAt` 付きの受信を確認した。

保存したスナップショットは、常駐の送信プロセス `node dist/collectors/send-snapshot.mjs` が15秒ごとに読んで集約APIへ送ります。環境変数は `FIRE_SNAPSHOT_PATHS`(OSのパス区切りで複数指定可)、`FIRE_ENDPOINT`、`FIRE_COLLECTOR_TOKEN_FILE` です。内容が変わらないスナップショットは、送信側のハートビート(60秒)でだけ再送します。

同じ内容の再描画はsnapshotId、sequence、capturedAtを維持します。真の観測時刻を特定できないためsourceObservedAtはnullです。送信ハートビートで元データを新しい観測と表示しません。別プロセスでJSONを読み、createHttpSenderに渡します。任意のURL、認証ヘッダーや送信秘密をダッシュボードへ渡さないでください。

## Codex

[公式App Server仕様](https://learn.chatgpt.com/docs/app-server)を2026-10-02に確認しました。ログイン済みPCで固定コマンド `codex app-server` をstdio起動し、initialize → initialized → account/rateLimits/read のみ送ります。App ServerをTCP/LANへ公開せず、会話・購入・リセット・アカウント変更は呼びません。

rateLimitsByLimitIdがある場合は区分ごとに表示し、なければrateLimitsへ対応します。primary/secondaryの存在とwindowDurationMinsに従い、固定の二枠とは扱いません。正常な読み取りもサーバーの真の観測時刻を保証するフィールドがないため、sourceObservedAtはnullのままです。

startCodexCollector({path, sourceAlias, send}) は読み取り完了から60秒ごとに再度読みます。初版は短命stdio接続によるポーリングを採用し、account/rateLimits/updatedの常時購読は未実装です。安全な読み取り範囲を保つため、通知購読が必要なら同じインターフェースで別途検証してください。

常駐させる場合は `npx tsx collectors/codex/service.ts`、または `npm run build:collectors` 後の `node dist/collectors/codex-service.mjs` を使います。環境変数は `FIRE_SNAPSHOT_PATH`、`FIRE_SOURCE_ALIAS`(英数字・ハイフン・アンダースコアの1〜64文字。違反すると起動しません)、`FIRE_ENDPOINT`(集約APIの `https://…/api/v1/usage`)、`FIRE_COLLECTOR_TOKEN_FILE`(Bearerトークンを書いたファイル)、任意の `FIRE_POLL_SECONDS`(読み取り間隔、30〜280秒、既定60秒)です。読み取りのたびに `codex app-server` を起動するため(1回約0.5秒のCPU)、間隔が長いほど軽くなります。ただし読み取りのたびに受信時刻も更新されるので、画面の「取得元に未接続」(受信から5分)を超えない範囲に制限しています。トークンは環境変数やユニットファイルに書かず、送信のたびにファイルから読みます。失敗時は読み取り・保存・送信の区分だけを標準エラーへ出します。`codex` コマンドが PATH 上にあり、ログイン済みである必要があります。ログインが切れていると Codex は `-32603`(取得先の 401)を返し、カードは `invalid_data` のエラーになります。画面のない機械では `codex login --device-auth` で再ログインします。

### ChatGPT wham usage API（API取得経路）

App Serverを起動できない収集元では、読み取り専用の固定エンドポイント `GET https://chatgpt.com/backend-api/wham/usage` も使えます。`rate_limit.primary_window` と `secondary_window` の `used_percent` だけを5時間／7日間の利用率へ変換し、`reset_after_seconds` は収集時刻からのリセット予定に変換します。`plan_type` やアカウント情報などの応答フィールドはFireへ転送しません。会話、モデル実行、購入、アカウント変更は行いません。

tokenは既存の `~/.codex/auth.json` の `tokens.access_token` を読み取り専用で使います。ファイルに無い場合だけ、サービス起動時に明示した `OPENAI_API_KEY` をフォールバックとして使えます。認証情報とAPI応答本文はsnapshot・ログ・母艦へ送らず、既存契約の利用率、リセット予定、状態、エイリアス、時刻だけを保存します。401/403、404、429、タイムアウト、過大応答、不正JSONは分類済み状態へ変換し、最後の正常値は集約側の契約に従って保持します。

App Server経路とは別の常駐collectorです。両方を同じsnapshotファイルへ同時に書き込まないでください。起動例は次のとおりです。

```sh
npm run build:collectors
FIRE_SNAPSHOT_PATH="$HOME/.local/state/fire-dashboard/codex-api.json" \
FIRE_SOURCE_ALIAS="gmktec" \
FIRE_ENDPOINT="https://<gmktec>/api/v1/usage" \
FIRE_COLLECTOR_TOKEN_FILE="$HOME/.config/fire-dashboard/collector-token" \
node dist/collectors/codex-api-service.mjs
```

任意の `FIRE_CODEX_CREDENTIALS_FILE` でCodex認証ファイルの読み取り先を、`FIRE_POLL_SECONDS` で読み取り間隔（30〜280秒、既定60秒）を指定できます。単発保存だけなら `FIRE_SNAPSHOT_PATH` と `FIRE_SOURCE_ALIAS` を指定して `npx tsx collectors/codex/api-capture.ts` を実行します。実アカウントへの接続、systemd登録、既存App Server経路からの切り替えは別途の運用作業です。

## 送信と保存

createHttpSenderの接続先は承認済みHTTPS `/api/v1/usage` に限ります。認証情報はPC側の承認済みモジュールから注入してください。本プロジェクトはキーを作りません。送信は変化時または60秒ハートビートで、送信失敗時は同じsnapshotを次回再送します。サーバー側はproviderごとに許可したsourceAlias（一つまたは複数）だけを受け入れ、同一アカウントを合算しません。複数PCの場合は最も新しい観測を表示します。逆順sequenceはPCごとに判定して破棄し、同一sequenceの内容変更は拒否します。

ローカルスナップショットは一つの指定パスを使います。重複書き込みは `.lock` ディレクトリで拒否し、正常終了後に解放します。クラッシュでロックが残った場合は、書き込みプロセスが停止したことを人が確認してから削除してください。ロックを時間だけで自動解除して競合を起こす処理はありません。

サーバーは生の受信スナップショット（sequence・内容の照合用）と、各provider／sourceAliasの表示値を別々に保存します。エラー時に引き継いだ最後の正常な利用率・残高・観測時刻は、優先取得元の切り替えやサーバー再起動後も保持します。同じスナップショットの再送はreceivedAtだけを更新し、lastSuccessAtは更新しません。新しい正常スナップショットを受け付けたときだけ成功時刻を更新します。

旧形式の保存ファイルはそのまま読み込めます。画面に残っている取得元の表示値は新形式に引き継ぎますが、旧形式ですでに画面から外れた取得元のエラーには正常値が保存されていないため復元できません。その場合は受信時刻を成功時刻に代用せず、次の正常スナップショットを待ちます。
