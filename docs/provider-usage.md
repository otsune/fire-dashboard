# 5プロバイダーの利用状況

Claude、Codexに、Antigravity、OpenCode Go、Hermes / Nousを加えた表示・収集契約です。ClaudeとCodexの既存手順は[読み取り専用収集](collectors.md)、認可と配備の前提は[運用と認証](deployment.md)を参照してください。

この実装は、利用元PCで必要な数値だけを選別し、既存の `UsageEnvelope` と認証付き送信経路を使います。Fireへプロバイダーの認証情報や生のアカウント応答を渡しません。収集元PCへの導入、ログイン、ユーザー設定の変更、資格情報の探索・作成・保存は行っていません。実アカウントの入力と認証接続は未提供で、ライブ接続は未検証です。

## 表示の意味

| 画面名        | provider ID   | 表示対象                                          |
| ------------- | ------------- | ------------------------------------------------- |
| Claude        | `claude`      | statuslineの利用枠                                |
| Codex         | `codex`       | App Serverのレート制限枠                          |
| Antigravity   | `antigravity` | statuslineのモデル別・区分別quota残量             |
| OpenCode Go   | `opencode_go` | Go契約のrolling・weekly・monthly利用率            |
| Hermes / Nous | `hermes_nous` | Nousのサブスクリプション残高と追加購入残高（USD） |

- 利用率は契約枠の消費率です。コンテキストウィンドウの占有率、セッションのトークン数、推定料金とは区別します。
- 欠損は `null` または未取得状態です。未設定、未対応、認証失敗を0%や残高0として表示しません。
- `sourceObservedAt` は提供元の真の観測時刻、`capturedAt` はローカル収集時刻、`receivedAt` は集約APIの受信時刻です。今回の追加ソースから真の観測時刻は確定できないため、`sourceObservedAt` は `null`、`freshness` は `unknown` のままです。
- リセット・更新予定は観測時刻ではありません。受信ハートビートで古い値を新しい観測に見せません。
- 同一アカウントを複数PCで使っても合算しません。プロバイダーごとに承認済みの取得元を一つ以上選び、複数の場合は最も新しい観測を表示します。

## Antigravity

### 出典と対応範囲

2026-10-02に確認した[公式statusline仕様](https://antigravity.google/docs/cli/statusline)の、トップレベル `quota` だけを読みます。各区分の `remaining_fraction`（0〜1）を `(1 - remaining_fraction) * 100` で消費率に変換し、有効な絶対時刻の `reset_time` だけをリセット予定に使います。`reset_in_seconds` しかない場合、真の観測時刻が分からないためリセット予定は `null`／未取得です。相対秒数を収集時刻へ足すと、古い入力の再描画でも予定が延びてしまうため、その補完は行いません。`context_window` の使用率は契約枠に流用しません。区分名だけから枠の長さを推定しません。

区分キー自体に個人情報が含まれる場合に備え、公式例で確認できた `gemini-weekly` だけを既知の名前として扱います。他のキーは `quota-N`／`利用枠 N` に置き換え、元のキーを転送しません。受け付ける区分は最大32件です。

このアダプターは、公式statuslineがstdinへ渡すJSONの受け口です。CLIのprint出力を解析するものではなく、`agy` を起動しません。[公式変更履歴](https://antigravity.google/docs/changelog)で、読み取り専用スラッシュコマンドのprintモード対応は1.1.11からです。それ以前で同様のコマンドを試すと、通常のプロンプトとして利用枠を消費するおそれがあります。printモードJSONの入れ子構造もこの実装では未検証のため、確認目的でも実行しません。

### ローカルでの接続

以下は利用者・管理者が今後、承認済みの収集元PCで実行する手順です。Node.jsとこのリポジトリの依存が既に導入済みで、リポジトリのルートにいることを前提とします。CLIのインストールや既存statuslineの置き換えは含みません。

```sh
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/fire-dashboard"
```

既存のstatusline連携から、公式JSONを次のコマンドのstdinへ直接渡します。

```sh
FIRE_SNAPSHOT_PATH="$STATE_DIR/antigravity.json" \
FIRE_SOURCE_ALIAS="primary-pc" \
./node_modules/.bin/tsx collectors/antigravity/statusline.ts
```

このコマンド単体はJSONを取得せず、stdinが閉じるまで待ちます。生のstatusline JSONをログや一時ファイルへ保存する必要はありません。既存の画面出力を維持する併用ラッパーは、管理者が設定を確認して用意してください。収集器自身はstdoutへ表示文字列を出さず、ネットワークも使いません。

プログラムから使う場合は `collectors/antigravity/statusline.ts` の `captureAntigravity` に、入力、収集時刻、保存先、取得元エイリアスを渡します。

## OpenCode Go

### 出典と対応範囲

2026-10-02に確認した[OpenCodeの公式実装](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts)に従い、読み取り先を `GET https://opencode.ai/zen/go/v1/usage` に固定します。汎用のOpenCodeセッション統計やZenの従量課金残高ではありません。

応答の `usage.rolling`、`usage.weekly`、`usage.monthly` から、それぞれ `percent` と `resetsAt` を読みます。`percent` は消費率であり、残量率への反転はしません。`status` の `rate-limited` は制限状態として扱います。月次枠を30日と仮定せず、リセット予定はサーバーの `resetsAt` に従います。

### ローカルでの接続

既存のGoキーを、利用者が承認済みの方法でローカルプロセスの `OPENCODE_GO_API_KEY` 環境変数へ渡していることが前提です。キーはコマンドライン引数に書かず、ここで新規作成・探索・表示しません。Goキーと集約APIへの送信用認証情報は別物です。

```sh
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/fire-dashboard"
: "${OPENCODE_GO_API_KEY:?既存の承認済みGoキーを環境変数へ設定してください}"
FIRE_SNAPSHOT_PATH="$STATE_DIR/opencode-go.json" \
FIRE_SOURCE_ALIAS="primary-pc" \
./node_modules/.bin/tsx collectors/opencode-go/capture.ts
```

このコマンドだけは、実行時に上記の公式エンドポイントへ認証付きGETを1回送ります。実装作業中には実行していません。送るキーは既にexportされた環境変数に限り、認証ファイルを自動走査しません。応答は最大1MiB、待ち時間は10秒に制限し、リダイレクトを拒否します。stdin、接続先変更フラグ、モデル実行、チャット送信は使いません。

キー未設定は `unconfigured`、HTTP 401・403は認証／アクセス拒否エラー、429はレート制限として記録します。通信失敗・タイムアウト・過大応答・不正なJSONも分類済み状態だけをsnapshotへ残し、生エラー本文は保存しません。403だけでは恒久的な未対応と判断せず、同じ取得元の最後の正常な利用率を集約側で維持します。正常な利用情報を得られなかった場合、CLIはsnapshot保存後に終了コード1と汎用診断を返します。終了コードだけでなく、保存された状態を確認してください。

`collectors/opencode-go/adapter.ts` の `fetchOpenCodeGo` はローカルから渡されたキーを使い、`normalizeOpenCodeGo` は取得済み応答を選別します。`collectors/opencode-go/capture.ts` の `captureOpenCodeGo` が選別結果を保存します。

## Hermes / Nous

### 出典と対応範囲

入力は公式TUI gatewayの `usage.bars` 結果です。[プログラム連携仕様](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)、メソッド名を確認できる[公式gateway実装](https://github.com/NousResearch/hermes-agent/blob/main/tui_gateway/server.py)、[シリアライザー](https://github.com/NousResearch/hermes-agent/blob/main/tui_gateway/billing_view.py)、[USD利用モデル](https://github.com/NousResearch/hermes-agent/blob/main/agent/billing_usage.py)を2026-10-02に確認しました。これはHermes全体のセッショントークン集計ではありません。

公式利用モデルの `*_credits` は旧来の命名で、金額の単位はUSDです。トークン数やモデル共通の固定トークン予算へ換算しません。サブスクリプションと追加購入分は別々に保ちます。

| 入力の選別対象                   | Fireの `balance`        |
| -------------------------------- | ----------------------- |
| `subscription_remaining_display` | `subscriptionRemaining` |
| `topup_remaining_display`        | `purchasedRemaining`    |
| `total_spendable_display`        | `totalRemaining`        |
| 有効なplan barの `total_display` | `monthlyAllowance`      |
| `renews_at`                      | `renewsAt`              |
| 通貨は固定                       | `currency: "USD"`       |

`balance` は利用状況payloadの任意項目です。金額は検証済みの数値、未知値は `null` です。提供された合計を尊重し、不足する内訳を0で補って合計を捏造しません。

追加購入分には月次の上限がないため利用率を作りません。サブスクリプションも上限不明、0以下の上限、または繰越等で残高が月次枠を超える場合は利用率を出しません。金額は残高として表示します。更新日だけの値から、時刻やタイムゾーンを推測しません。

### ローカルでの接続

承認済みローカル連携が読み取った `usage.bars` の結果を、次のコマンドのstdinへ渡します。直接の結果オブジェクト、またはJSON-RPC 2.0応答の `result` を受け付けます。

```sh
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/fire-dashboard"
FIRE_SNAPSHOT_PATH="$STATE_DIR/hermes-nous.json" \
FIRE_SOURCE_ALIAS="primary-pc" \
./node_modules/.bin/tsx collectors/hermes-nous/capture.ts
```

このコマンドは取得済みJSONを選別するだけで、Hermesプロセスの起動、gatewayへの接続、ログイン、Nousへの通信はしません。実際のgatewayとの接続ラッパーと利用者の実データは未提供です。`hermes usage --provider nous` というコマンドは仮定していません。支払い情報、組織情報、portal URLを含むアカウント応答全体は入力契約に含めません。

プログラムからは `collectors/hermes-nous/capture.ts` の `captureHermesNous` を使えます。`available: false` は「利用情報が取得できない」という意味で、残高0ではありません。AntigravityとNousのstdinは最大1MiBです。CLIの終了成功は入力を選別・保存できたことを表し、取得元へライブ接続できたという意味ではありません。

## 保存・送信・取得元の選択

3つの追加CLIは `FIRE_SNAPSHOT_PATH` と `FIRE_SOURCE_ALIAS` を必要とします。プロバイダーごとに別のsnapshotファイルを指定してください。エイリアスは `primary-pc` のような、個人を識別しない英数字・ハイフン・アンダースコアに限定します。氏名、メール、ホスト名、アカウントIDを転用しないでください。

共通の `captureSnapshot` は選別済み `UsageEnvelope` だけを原子的に保存します。同じ内容なら `snapshotId`、`sequence`、`capturedAt` を維持し、書き込み競合は既存の `.lock` で拒否します。ロック回復は[既存手順](collectors.md#送信と保存)に従います。生入力・キー・応答本文を診断ログへ出しません。

これらのCLIは集約APIへ自動送信しません。既存の承認済みローカル送信処理がsnapshotを読み、`collectors/shared/sender.ts` の `createHttpSender` に渡す構成です。送信先は承認済みHTTPSの `/api/v1/usage`、認証は既存の承認済みモジュールから注入します。新しい資格情報や無認証の送信経路は追加しません。送信失敗時は同じsnapshotを再送し、送信ハートビートは60秒より細かくしません。

集約APIの管理者設定では、選んだエイリアスを `preferredSources` に追加します。以下は設定の形を示す例であり、実環境へ適用していません。既存の天気・RSS・認証設定を置き換えないでください。

```json
{
  "preferredSources": {
    "claude": "primary-pc",
    "codex": "primary-pc",
    "antigravity": "primary-pc",
    "opencode_go": "primary-pc",
    "hermes_nous": "primary-pc"
  }
}
```

サーバーは認証済み主体に関連付いたsourceAliasと照合し、プロバイダーごとに許可した取得元（一つまたは複数）だけを受け入れます。本文に書かれたエイリアスだけでは認可されません。古いsequenceは破棄し、同じsequenceで内容が変わった再送は拒否します。

## Fireへ渡す許可リスト

- 固定provider ID、検証済み区分識別子と表示名、利用率、枠の長さが明示される場合の分数、リセット予定
- NousのUSD残高・月次枠・更新予定。サブスクリプションと追加購入分は別項目
- 許可された状態・エラー分類、非個人情報のsourceAlias、収集・受信などの時刻
- `schemaVersion`、`snapshotId`、単調増加する `sequence`

APIキー、アクセストークン、Cookie、認証ヘッダー、メール、アカウント・組織・セッションID、カード情報、支払いURL、作業パス、会話、プロンプト、回答、生JSON、提供元の生エラーメッセージは保存・転送対象外です。ブラウザーのVite環境変数にも資格情報を置きません。数値の選別はFireへ届く前の収集元PCで行います。

## 検証と未設定の項目

ローカルの固定データ・モックによる検証は、リポジトリルートで行います。これらのコマンドは実アカウントへの接続やCLIのインストールを必要としません。

```sh
npm test
npm run typecheck
npm run build
```

2026-10-02の追加実装では、単体・統合の21ファイル／204テスト、型検査、本番ビルドが成功しています。CLI試験は架空の入力とモック通信のみです。取得元を切り替えた際に別の取得元の残高を引き継がないことと、元の取得元へ戻した再送で正しいsnapshotが復元されることも検証しています。

`npm run test:e2e` は全6件がChromium起動時の `socket() failed: Operation not permitted` で停止し、画面操作に到達していません。追加した5カードの幅・設定往復テストも未実行扱いです。実ピクセル、スクリーンショット、Fire実機、ライブ認証接続は未検証です。

実運用へ接続する前に、管理者が次を確認してください。

1. Antigravityの公式statusline JSON、Goの承認済みキー、Nousの `usage.bars` 結果が実際に得られること
2. 各providerの優先sourceAlias、個別snapshot保存先、既存送信認証とHTTPS配信先
3. 生入力が残らず、キーやアカウント情報がAPI応答・ブラウザー・ログへ出ないこと
4. 未設定・認証切れ・タイムアウト・欠損・再送・古いsnapshotが、0%や新しい観測として表示されないこと
5. Fire実機の読みやすさと長時間運用。実機での合格条件は[検証と実機チェック](acceptance.md)を参照

公開ソースの構造確認と固定データ試験は、実契約・実バージョンでのライブ動作を保証しません。収集元への導入、認証の接続、定期実行の登録、公開配信は別途の作業です。

## 追加カードの表示と配置

Claude・Codexは従来どおり表示します。追加3サービスは、取得元エイリアス・収集／受信記録・取得状態・利用率または残高のどれもない初期の未設定状態では非表示です。取得元から未取得・認証失敗を受け取った場合は、その状態を隠さず表示します。明示された0%やUSD 0も有効なデータとして扱います。

幅1000px以上では利用状況を左側の2列グリッド、RSSを右側の専用列に配置します。幅999px以下ではRSSを利用状況の下へ、600px以下では利用状況も1列へ並べます。利用状況が奇数枚の場合、最後のカードはその行の幅を使います。接続済みサービスが増えれば縦方向に伸びるため、常に1画面へ収まることは保証しません。

このレビュー修正後は23ファイル／219テスト、型検査、本番ビルドが成功しています。レイアウトE2Eは既定2カードと設定済み5カードの配置を確認する内容へ更新し、`--list` で全7件の収集を確認しました。既知のChromium起動制限によりブラウザー実行は再試行せず、修正後の実ピクセルも未検証です。
