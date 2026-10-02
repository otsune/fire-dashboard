# 読み取り専用の利用状況収集

収集元PCへの導入と認証接続は未実施です。アダプターの固定データ試験のみ完了しています。プロンプト、回答、作業パス、メール、トークン、生のstdinは保存・送信しません。送信対象は許可された区分、率、リセット予定、状態、エイリアス、時刻だけです。

## Claude Code

公式仕様を2026-10-02に確認しました。[statusline仕様](https://code.claude.com/docs/en/statusline)のrate_limits.five_hourとseven_dayのみ読み、spend_limitは使いません。used_percentageは0〜100、resets_atはepoch秒です。公式ページではPro/MaxまたはGatewayにより項目の有無が異なり、最初のAPI応答前は欠損する場合があります。表示を更新するためのAI呼び出しは行いません。

ローカルスクリプトは `FIRE_SNAPSHOT_PATH` と非個人情報の `FIRE_SOURCE_ALIAS` を指定して `npx tsx collectors/claude/statusline.ts` を実行します。stdin JSONから指標だけ選別して原子的に保存し、ネットワークは使いません。既存statuslineがある場合はバックアップしてから併用ラッパーを管理者が作成してください。従来スクリプトの出力はそのまま画面に残し、抽出処理のstdoutを混ぜない構成です。実際の設定ファイルをこのプロジェクトが変更することはありません。

同じ内容の再描画はsnapshotId、sequence、capturedAtを維持します。真の観測時刻を特定できないためsourceObservedAtはnullです。送信ハートビートで元データを新しい観測と表示しません。別プロセスでJSONを読み、createHttpSenderに渡します。任意のURL、認証ヘッダーや送信秘密をダッシュボードへ渡さないでください。

## Codex

[公式App Server仕様](https://learn.chatgpt.com/docs/app-server)を2026-10-02に確認しました。ログイン済みPCで、明示指定したCodex実行ファイルを固定引数 `app-server`、`shell: false` でstdio起動し、initialize → initialized → account/rateLimits/read のみ送ります。App ServerをTCP/LANへ公開せず、会話・購入・リセット・アカウント変更は呼びません。

`FIRE_CODEX_EXECUTABLE` に、信頼できるインストール先の実行ファイルの絶対パスを設定してください（例: POSIXは `/opt/codex/codex`、Windowsは `C:\Tools\Codex\codex.exe`。実際のインストール先に合わせます）。`readCodexLimits({ executable })` または `startCodexCollector({ path, sourceAlias, send, executable })` の明示オプションは環境変数より優先されます。引数や引用符を含むコマンド文字列ではなく、ファイルのパスだけを渡してください。未設定・空文字・相対パスは起動前に拒否し、PATHやカレントディレクトリ内の `codex` へフォールバックしません。起動失敗時も別の実行ファイルを探しません。

Windowsでは `C:codex.exe` や `\codex.exe` のようなカレントドライブ依存のパス、`.cmd` / `.bat` のシェル用shimを拒否します。npm等が置く `codex.cmd` ではなく、信頼できるインストール先のネイティブ実行ファイルを直接指定してください。パス内の空白はそのまま扱い、シェル展開は行いません。設定エラーは `readCodexLimits` が例外にし、collectorでは `onError("read")` として通知してその回の保存・送信を行いません。

rateLimitsByLimitIdがある場合は区分ごとに表示し、なければrateLimitsへ対応します。primary/secondaryの存在とwindowDurationMinsに従い、固定の二枠とは扱いません。正常な読み取りもサーバーの真の観測時刻を保証するフィールドがないため、sourceObservedAtはnullのままです。

startCodexCollector({path, sourceAlias, send, executable}) は読み取り完了から60秒ごとに再度読みます。`executable` を省略する場合は `FIRE_CODEX_EXECUTABLE` が必須です。初版は短命stdio接続によるポーリングを採用し、account/rateLimits/updatedの常時購読は未実装です。安全な読み取り範囲を保つため、通知購読が必要なら同じインターフェースで別途検証してください。

## 送信と保存

createHttpSenderの接続先は承認済みHTTPS `/api/v1/usage` に限ります。認証情報はPC側の承認済みモジュールから注入してください。本プロジェクトはキーを作りません。送信は変化時または60秒ハートビートで、送信失敗時は同じsnapshotを次回再送します。サーバー側はproviderごとの優先sourceAlias一つだけを受け入れ、同一アカウントを合算しません。逆順sequenceは破棄し、同一sequenceの内容変更は拒否します。

ローカルスナップショットは一つの指定パスを使います。重複書き込みは `.lock` ディレクトリで拒否し、正常終了後に解放します。ロック内の一意な所有者ファイルにはホスト名・PID・識別子を記録します。同じホストの所有プロセスが存在しないことを確認できた場合だけ、次の取得時に回収します。複数の回収処理が競合しても、古い所有者のファイルを削除できた一つだけがディレクトリを解放します。生存中の長時間処理は経過時間だけで解除しません。

保存先は、同じホスト・PID名前空間のプロセスだけが利用するローカルファイルシステムに置いてください。ネットワーク共有や、異なるコンテナーのPID名前空間からの共同書き込みはサポートしません。別ホスト、PIDの再利用、プロセス確認の権限不足、旧形式・欠損・破損した所有者情報は安全側に倒して取得を拒否します。ディレクトリ作成直後や解放途中の異常終了では、所有者情報のないロックが残る場合があります。この場合は全収集処理を停止し、当該保存先へ書き込むプロセスがないことを確認してから、その `.lock` ディレクトリだけを手動で削除してください。稼働中のロックを時間だけで自動削除する運用はしないでください。
