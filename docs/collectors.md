# 読み取り専用の利用状況収集

収集元PCへの導入と認証接続は未実施です。アダプターの固定データ試験のみ完了しています。プロンプト、回答、作業パス、メール、トークン、生のstdinは保存・送信しません。送信対象は許可された区分、率、リセット予定、状態、エイリアス、時刻だけです。

Antigravity・OpenCode Go・Hermes／Nousは[追加サービスの収集手順](provider-usage.md)を参照してください。

## Claude Code

公式仕様を2026-10-02に確認しました。[statusline仕様](https://code.claude.com/docs/en/statusline)のrate_limits.five_hourとseven_dayのみ読み、spend_limitは使いません。used_percentageは0〜100、resets_atはepoch秒です。公式ページではPro/MaxまたはGatewayにより項目の有無が異なり、最初のAPI応答前は欠損する場合があります。表示を更新するためのAI呼び出しは行いません。

ローカルスクリプトは `FIRE_SNAPSHOT_PATH` と非個人情報の `FIRE_SOURCE_ALIAS` を指定して `npx tsx collectors/claude/statusline.ts` を実行します。stdin JSONから指標だけ選別して原子的に保存し、ネットワークは使いません。既存statuslineがある場合はバックアップしてから併用ラッパーを管理者が作成してください。従来スクリプトの出力はそのまま画面に残し、抽出処理のstdoutを混ぜない構成です。実際の設定ファイルをこのプロジェクトが変更することはありません。

同じ内容の再描画はsnapshotId、sequence、capturedAtを維持します。真の観測時刻を特定できないためsourceObservedAtはnullです。送信ハートビートで元データを新しい観測と表示しません。別プロセスでJSONを読み、createHttpSenderに渡します。任意のURL、認証ヘッダーや送信秘密をダッシュボードへ渡さないでください。

## Codex

[公式App Server仕様](https://learn.chatgpt.com/docs/app-server)を2026-10-02に確認しました。ログイン済みPCで固定コマンド `codex app-server` をstdio起動し、initialize → initialized → account/rateLimits/read のみ送ります。App ServerをTCP/LANへ公開せず、会話・購入・リセット・アカウント変更は呼びません。

rateLimitsByLimitIdがある場合は区分ごとに表示し、なければrateLimitsへ対応します。primary/secondaryの存在とwindowDurationMinsに従い、固定の二枠とは扱いません。正常な読み取りもサーバーの真の観測時刻を保証するフィールドがないため、sourceObservedAtはnullのままです。

startCodexCollector({path, sourceAlias, send}) は読み取り完了から60秒ごとに再度読みます。初版は短命stdio接続によるポーリングを採用し、account/rateLimits/updatedの常時購読は未実装です。安全な読み取り範囲を保つため、通知購読が必要なら同じインターフェースで別途検証してください。

常駐させる場合は `npx tsx collectors/codex/service.ts` を使います。環境変数は `FIRE_SNAPSHOT_PATH`、`FIRE_SOURCE_ALIAS`、`FIRE_ENDPOINT`(集約APIの `https://…/api/v1/usage`)、`FIRE_COLLECTOR_TOKEN_FILE`(Bearerトークンを書いたファイル)です。トークンは環境変数やユニットファイルに書かず、送信のたびにファイルから読みます。失敗時は読み取り・保存・送信の区分だけを標準エラーへ出します。`codex` コマンドが PATH 上にあり、ログイン済みである必要があります。ログインが切れていると Codex は `-32603`(取得先の 401)を返し、カードは `invalid_data` のエラーになります。画面のない機械では `codex login --device-auth` で再ログインします。

## 送信と保存

createHttpSenderの接続先は承認済みHTTPS `/api/v1/usage` に限ります。認証情報はPC側の承認済みモジュールから注入してください。本プロジェクトはキーを作りません。送信は変化時または60秒ハートビートで、送信失敗時は同じsnapshotを次回再送します。サーバー側はproviderごとに許可したsourceAlias（一つまたは複数）だけを受け入れ、同一アカウントを合算しません。複数PCの場合は最も新しい観測を表示します。逆順sequenceはPCごとに判定して破棄し、同一sequenceの内容変更は拒否します。

ローカルスナップショットは一つの指定パスを使います。重複書き込みは `.lock` ディレクトリで拒否し、正常終了後に解放します。クラッシュでロックが残った場合は、書き込みプロセスが停止したことを人が確認してから削除してください。ロックを時間だけで自動解除して競合を起こす処理はありません。

サーバーは生の受信スナップショット（sequence・内容の照合用）と、各provider／sourceAliasの表示値を別々に保存します。エラー時に引き継いだ最後の正常な利用率・残高・観測時刻は、優先取得元の切り替えやサーバー再起動後も保持します。同じスナップショットの再送はreceivedAtだけを更新し、lastSuccessAtは更新しません。新しい正常スナップショットを受け付けたときだけ成功時刻を更新します。

旧形式の保存ファイルはそのまま読み込めます。画面に残っている取得元の表示値は新形式に引き継ぎますが、旧形式ですでに画面から外れた取得元のエラーには正常値が保存されていないため復元できません。その場合は受信時刻を成功時刻に代用せず、次の正常スナップショットを待ちます。
