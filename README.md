# Fire Dashboard

Fire HD 10 Plus（第11世代）向けの、日本語・常時表示ダッシュボードです。DSEGの時計を中心に、天気、RSS、Claude／Codex／Antigravity／OpenCode Go／Hermes・Nousの利用状況をまとめます。

ローカルWeb実装と集約API・収集アダプターを含みます。時計はそのまま動作します。天気地域、RSS、認証接続、時刻音声は未設定です。架空の天気・利用率をライブデータとして表示しません。

## ローカルで試す

Node.js 24を推奨します。依存はpackage-lock.jsonに固定しています。

```sh
npm ci
npm run dev
```

`http://127.0.0.1:5173` を開きます。DSEG7 Classic 0.46.0は同梱済みです。画面の「設定」からタイムゾーン、12／24時間、音量、静音、RSS切替を変更できます。時計は端末時刻を毎秒読み直します。

本番形式のローカルプレビューとオフライン資産生成：

```sh
npm run build
npm run preview
```

`http://127.0.0.1:4173` で開きます。HTTPSまたはlocalhostの安全な配信元でService Workerを使用し、初回の資産準備後にオフラインへ対応します。更新版は画面の「更新して再読み込み」から切り替えます。LANのHTTP配信ではオフラインを保証しません。

実APIを接続していないUIでは「集約サービスに未接続」と表示します。これは認証を省略するデモサーバーではありません。

## 表示と音声

- 時計：Asia/Tokyo、24時間、淡い白、黒に近い背景が初期値
- 天気：気象庁の予報、地域・期間・代表地点・発表時刻を区別
- RSS：RSS／Atomの見出しと出典のみ。15秒切替は停止可能
- 利用状況：欠損は0％にせず、受信・観測・リセット予定と状態を区別
- 音声：24本の権利確認済み録音と任意のチャイムを追加してから、タップで有効化
- 時報：前面で連続監視した時間境界から10秒以内だけ再生。復帰後の追補なし
- 排他：IndexedDBで時間ごとの試行と再生リースを管理。保存できなければ停止
- 点灯保持：対応ブラウザーで利用者のタップ後に要求し、解除を表示

録音済み音声・チャイムは提供されていないため同梱していません。音源未設定のモードは有効化できません。[音源の準備](docs/audio-assets.md)をご覧ください。

## 実データをつなぐ

[運用と認証](docs/deployment.md)、[読み取り専用収集](docs/collectors.md)を参照してください。認証情報は利用元PC／サーバーに留めます。Fireの画面へキー、会話内容、作業パスは渡しません。APIは認可モジュールなしでは起動を拒否します。地域・RSSは管理者の設定ファイルに指定します。

認証連携、運用先への配備、収集元PCへの導入は別途設定が必要です。[追加3サービスの収集手順](docs/provider-usage.md)では、利用枠の使用率とNousのUSD残高を区別しています。

## 検証

```sh
npm test
npm run typecheck
npm run build
npm run test:e2e
```

E2EはPlaywrightとChromiumを使います。既存の `/usr/bin/chromium` がなければ、手元の環境で `npx playwright install chromium` してから実行してください。`PLAYWRIGHT_EXECUTABLE_PATH` でブラウザー実行ファイルを指定することもできます。E2Eの音声は明記されたテスト代替であり、実音源の品質確認ではありません。

検証環境の制約により、ブラウザーE2E・スクリーンショット・Fire実機試験は未完了です。単体／統合テストと型検査・ビルドの結果は[検証と実機チェック](docs/acceptance.md)に記載しています。

Fire実機で24時間、可能なら72時間の連続運転・音声・充電温度を確認するまで、常設運用の合格とは扱わないでください。バックグラウンド時報、OSキオスク、再起動後自動表示、APKは含みません。

## 構成

- `apps/dashboard`：時計、設定、カード、時報、オフライン
- `services/aggregator`：認可された読取API、制限付き天気／RSS取得、利用率受信
- `collectors`：Claude statusline／Codex stdioの数値選別
- `packages/contracts`：共通スキーマ、長さ・数値・URLの検証
- `tests`：正常値と悪意ある入力、時刻境界、排他、障害復旧

DSEGはSIL Open Font License 1.1です。著作権表示とライセンスは `apps/dashboard/public/licenses/DSEG-LICENSE.txt` に同梱しています。天気の出典：[気象庁](https://www.jma.go.jp/bosai/forecast/)、[利用条件](https://www.jma.go.jp/jma/kishou/info/coment.html)。
