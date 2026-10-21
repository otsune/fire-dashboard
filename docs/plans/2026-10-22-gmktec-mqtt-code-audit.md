# GMKtec MQTT 実装の独立コード監査（2026-10-22）

対象: ブランチ `codex-gmktec-mqtt-implementation`（HEAD `0f1ad9e`、`main` 07cc993 との差分 58 commits / 68 files / +8,985 −104）
監査用 worktree: `C:\Users\user\dev\fire-dashboard\.worktrees\gmktec-mqtt`
本書は既存の実装監査記録（`docs/plans/2026-10-15-gmktec-mqtt-implementation-audit.md`）とは独立に、実コードと実行結果だけを根拠にした再監査である。既存記録の記述は引用以外の根拠にしていない。

## 0. 判定

設計の骨格（単一 revision、HTTP を正本とした stream 交代、QoS1 + retain + LWT、資格情報をブラウザーへ渡さない gateway）は妥当で、型検査・ビルド・主要テストは通る。一方で **表示値の意味が壊れうる箇所が 2 つ**（Codex の枠ラベル、端末側 revision の巻き戻し不能）あり、実機運用に載せる前に直す価値がある。MQTT 経路そのもの（gateway / publisher / 契約 / ブラウザー側の順序判定）は概ね堅牢で、指摘の多くは「壊れたときに壊れたと分からない」種類の問題である。

## 1. 実行して確認したこと

サンドボックスが子プロセス生成を禁止しているため、Vite の `net use` 探索だけを無効化する一時シムと `--pool=threads` を使って実行した（シムは監査後に削除）。

| 検証                                                                                                                                                                        | 結果                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsc --noEmit`                                                                                                                                                              | 成功（エラー 0）                                                                                                                                                                |
| 重点テスト 9 ファイル（usage-delivery / mqtt-gateway / usage-stream / mqtt-credentials / claude-api / codex-api / grok-api / hermes-nous-api / validate-mqtt-observations） | 71 件中 68 成功。失敗 3 件は環境要因（Windows の `chmod`/mode、CLI 起動が spawn 禁止に当たる）                                                                                  |
| 全テスト                                                                                                                                                                    | 726 件中 675 成功・50 失敗。失敗のうち UI 系 4 ファイル 8 件は `main` で同一に失敗することを確認済み（ブランチ起因ではない）。残りは spawn 禁止・Windows パス・ネットワーク依存 |
| `vite build` + `scripts/build-sw.mjs`                                                                                                                                       | 成功。`assets/mqtt.esm-C4SyFvUx.js` 335.6 kB（gzip 99.9 kB）を動的 import し、SW のプリキャッシュ 59 件からは除外されている                                                     |
| 追加プローブ（publisher の stop→start）                                                                                                                                     | **再接続しないことを再現**（下記 M3）                                                                                                                                           |

限界: 実 broker・実 Mosquitto ACL・Fire HD 10 実機・24/72 時間の連続稼働は検証していない。

## 2. High

### H1. Codex wham collector が枠の意味を「位置」で決め打ちしている

`collectors/codex/api.ts:17-20,49-60`

`primary_window` を常に「5時間 / 300 分」、`secondary_window` を常に「7日間 / 10080 分」として `Usage` に変換している。レスポンスに `limit_window_seconds` が入っていても読んでいない。公開されている同エンドポイントの観測（例: [ai-usagebar の型定義](https://docs.rs/ai-usagebar/1.9.0/src/ai_usagebar/openai/types.rs.html)）では、OpenAI 側が 7 日枠を `primary_window` に移し `secondary_window` を省略した形が確認されている。

影響: 壁の表示が「5時間 42%」と出していても、実際は 7 日枠 42% でありうる。数値は正しくラベルだけが嘘になるため、人間は誤りに気づけない。`docs/collectors.md:46` が App Server 経路について定めた「固定の二枠とは扱わない」方針とも食い違う。

修正: `limit_window_seconds`（18000 / 604800）で分類し、位置はフォールバックに落とす。未知の長さは窓を作らず `windowMinutes: null` にする。枠が入れ替わった fixture を 1 本追加する。

### H2. 端末側 revision が一度進むと、サーバー側の巻き戻しから復帰できない

`apps/dashboard/src/data/usage-state.ts:60-78`、`apps/dashboard/src/data/usage-state.ts:30-40`、`services/aggregator/src/store.ts:163-186`

MQTT も HTTP も「同一 streamId で revision が小さい配信」を `stale` として破棄する。heartbeat も「ローカルより新しい」ときだけ HTTP 再取得を促す。`publishedAt` は保存しているが比較に使っていない。aggregator は state ファイルが読めない（ENOENT）場合にしか `streamId` を切り直さない。

影響: `FIRE_STATE_FILE` を古いバックアップから復元する、あるいは稼働中に state をロールバックすると、端末の IndexedDB に入った高い revision が永遠に勝ち、**利用状況カードだけが復元前の値で固定される**。天気と RSS は更新され続けるので、画面は生きているように見える。復旧手段はサイトデータ消去のみ。

修正: 案は 3 つ。(a) サーバー起動ごとの epoch を配信に載せ、epoch が変われば HTTP は無条件に採用する、(b) 復元・起動時に `streamId` を切り直す、(c) HTTP の `publishedAt` がローカルのそれより古ければ「サーバーリセット」とみなして採用する。運用でバックアップ復元を許すなら必須。

## 3. Medium

### M1. HTTP 応答に delivery metadata が無いと、配信を自分で永久に止める

`apps/dashboard/src/App.tsx:233-237`、`apps/dashboard/src/App.tsx:123-172`、`apps/dashboard/src/data/cache.ts:95-103`

`next.usageDelivery` が無い応答を 1 回でも受けると `usageStreamRef.current?.stop()` して ref を `null` にする。ストリームを作る effect は依存配列 `[]` なので再生成されない。さらに cache 側は「metadata が無い HTTP」に対して以前の `usage` / `usageDelivery` を保持するため、以降 30 秒ごとのポーリングも無視される。

発生条件: API を MQTT 以前のビルドへロールバックした、publisher を無効化した、あるいは `parseDashboard` が不正な metadata を黙って落とした場合。ロールバック手順が docs に存在する以上、絵空事ではない。

修正: metadata が無い/不正なら `next.usage` をそのまま採用してキャッシュ側 metadata を消し、ストリームは「停止」ではなく「休止」にする（再有効化できる形で保持する）。

### M2. gateway の topic 認可は完全にリポジトリ外（Mosquitto ACL）に依存している

`services/aggregator/src/mqtt/gateway.ts:200-230`、`docs/deployment.md:69-77`

gateway は reader 認証と Origin を upgrade 前に検査するが、その先は raw frame を中継するだけで、**どの topic を subscribe / publish してよいかを検査しない**。read listener が匿名で、ACL が read-only に絞られていない場合、reader 権限を持つ端末（＝Tailscale 経由の利用者）は `usage/state` へ retain publish でき、壁の表示を恒久的に差し替えられる。docs は ACL 設定を指示しているが、リポジトリ内にその設定・検査・テストは無い。

修正（コードでできる範囲）: gateway 側で MQTT パケット種別を最小限検査し（CONNECT 後の SUBSCRIBE topic を `state|availability|heartbeat` に限定、PUBLISH を拒否）、あるいは「ACL 未設定なら gateway を起動しない」自己診断を入れる。少なくとも `docs` の手順を実行する検証スクリプトを `scripts/` に置く。

### M3. publisher は stop 後に start できない（再現済み）

`services/aggregator/src/mqtt/publisher.ts:406-408`（`stopping = true` を立てたまま）、`:335`・`:396-401`

`stop()` が `stopping` を戻さないため、その後の `start()` は `connect()` の `if (!started || stopping || client) return` で即 return する。`status().state` は `"connecting"` のまま残り、実際には再接続しない。

再現: 偽 clientFactory で `start → stop → start` を実行し、生成された client が 1 個のまま・status が `connecting` のままであることを確認した。

影響: 現状の起動経路（1 プロセス 1 回 start）では踏まない。テストや将来のホットリロード、`app.close()` 後に同一 publisher を再利用する実装で無言の停止になる。修正は `stop()` の最後で `stopping = false` にするか、`started` と `stopping` を 1 つの状態機械にまとめる。

### M4. Grok の protobuf 走査は「別の数値」を静かに掴みうる

`collectors/grok/api.ts:208-258`

length-delimited を深さ 4 まで再帰し、「末尾フィールド番号 1 の fixed32 で 0〜100 の最小パス」を使用率とみなす。共有枠を識別する安定タグは無く、リセット時刻のパスも「あれば望ましい」程度の扱い。他のプロダクト（API/Build/Chat）の率や、偶々その形に読める文字列フィールドを拾っても `invalid_data` にならず、そのまま配信される。実観測は 1 件（1%）のみ。

修正: 実測で確認したメッセージパス（親パスを含む）とリセットパスを必須条件にし、満たさなければ `invalid_data` にする。sanitize 済みの実応答 fixture を固定する。

### M5. sender が非 2xx の body を読み捨てない

`collectors/shared/sender.ts:47-57`

`!response.ok` で即 throw し、`response.body?.cancel()` を呼んでいない（provider 側 fetcher は呼んでいる）。60 秒ごとの heartbeat が 401 を返し続けると、未読 body が接続を解放させず、undici の接続プールが詰まる可能性がある。数週間稼働の常駐で効いてくる種類のリーク。修正は 1 行。

### M6. poll 間隔の実効値が「5 分で未接続」判定を超えうる

`collectors/claude/api-service.ts:40-56`、`collectors/hermes-nous/api-service.ts`、`collectors/codex/monitor.ts:43`

`setTimeout` を read + 保存 + 送信の**後**に張るため、1 周期は `poll + 実処理時間`。`FIRE_POLL_SECONDS` は 280 まで許容され、Hermes は read 12 秒 + send 10 秒で 302 秒に達する。画面側の「取得元に未接続」は受信から 5 分なので、健全な collector が intermittently 未接続表示になる。周期の起点を固定するか、上限を 240 秒へ下げる。

### M7. Codex App Server 経路がサーバー由来の文字列をそのまま配信する

`collectors/codex/adapter.ts:17-21`

`rateLimitsByLimitId` の任意キーを bucket id、`limitName`（最大 2048 文字）を label にして `Usage` へ入れている。Antigravity は未知キーを匿名化しており、`docs/provider-usage.md:197` の「許可された識別子・表示名だけ」という原則から外れる。App Server の応答変更でアカウント識別文字列が MQTT と壁に出る経路になる。既知 id → 固定ラベルの対応表にし、未知は捨てる。

### M8. 可視化・online のたびに健全な接続を切っている

`apps/dashboard/src/data/usage-stream.ts:164-184`

`visibilitychange`（visible）と `online` で無条件に `reconnect()` し、`retry = 0` に戻して即再接続する。接続中かどうか、直近 heartbeat が新しいかを見ていない。Fire の画面消灯・復帰やネットワーク揺らぎで接続がチャーンし、backoff も毎回リセットされる。`client.connected` と最終 heartbeat を見て、必要なら debounce する。

### M9. ブラウザー側ライフサイクルと常駐ループのテストが無い

`tests/unit/usage-stream.test.ts`（3 件のみ）、`tests/unit/usage-delivery.test.ts`

close→backoff、stop の冪等性とタイマー解放、malformed/oversized、stale、resume、`?usageMqtt=1` での App 統合、cache と live のマージが未テスト。collector 側も `startClaudeApiService` / `startGrokApiService` / `startHermesNousApiService` と各 `api-capture.ts` にテストが無い（Codex の monitor だけ）。今回の指摘 M3・M8・M1 は、いずれもこの空白に落ちている。

## 4. Low

| #   | 内容                                                                                                                                                                                | 位置                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | 雪（JMA 4xx、summary「雪」）を雨として ☂️/「雨」表示。不明・欠損 summary は ☁️ にフォールバックし「予報未取得」に雲が付く                                                           | `apps/dashboard/src/cards/WeatherCard.tsx:9-20,70-74`                                                                                       |
| L2  | JSON/Zod/サイズ超過の失敗を握りつぶし、status は `connected` のまま。スキーマ変更時に全 state を捨てていることが外から分からない                                                    | `apps/dashboard/src/data/usage-stream.ts:126-142`                                                                                           |
| L3  | Codex のリセット時刻を `reset_after_seconds` だけで計算。`reset_at` のみの応答では null になる。基準も要求前の `capturedAt`                                                         | `collectors/codex/api.ts:31-44,58`                                                                                                          |
| L4  | 資格情報ファイルの permission 検査が POSIX mode 前提。Windows では常に `mqtt_credentials_permissions` になり publisher を起動できない。stat→read の間に差し替えられる TOCTOU もある | `services/aggregator/src/mqtt/credentials.ts:29-48`                                                                                         |
| L5  | 契約の循環再輸出（`usage-delivery.ts` ⇄ `index.ts`）と schema の二重定義。`applyHttpDashboard` は未使用                                                                             | `packages/contracts/src/usage-delivery.ts:1-10`、`packages/contracts/src/index.ts:356-361`、`apps/dashboard/src/data/usage-state.ts:99-103` |
| L6  | 生存状態の表示が 10px の footer のみ。heartbeat が先行しただけの通常の追いつきを `error` と表示し、`stale` でも再接続しない。`?usageMqtt=1` が無い端末は永久に「未接続」            | `apps/dashboard/src/App.tsx:150-157,511-515`、`usage-stream.ts:185-187`                                                                     |
| L7  | gateway の接続寿命 15 分で定期切断→再接続の瞬断が起きる（仕様だが docs に記載なし）                                                                                                 | `services/aggregator/src/mqtt/gateway.ts:41,260`                                                                                            |
| L8  | SW は mqtt chunk を意図的にプリキャッシュしないため、`?usageMqtt=1` の端末をオフライン起動すると chunk 取得に失敗し続ける（設計意図どおりだが、起動時の見え方の説明が無い）         | `scripts/build-sw.mjs:19-25`                                                                                                                |
| L9  | state 受信ごとに dashboard 全体を IndexedDB へ書き直す。毎分 1 回の書き込みで、天気保存の中止と競合すると不要な警告が出る                                                           | `apps/dashboard/src/App.tsx:142-148`                                                                                                        |

## 5. 良かった点

- revision / stream の順序判定が 1 箇所（`usage-state.ts`）に集約され、HTTP だけが stream を交代できる。判定関数は表でテストされている。
- gateway は upgrade 前に Origin・subprotocol・reader 認証・上流 CONNACK をすべて確認し、失敗時は上流を確実に閉じる。実 ws を使った統合テストがある。
- 資格情報はファイル（mode 検査つき）から読み、ブラウザーにもログにも出さない。status API は revision と時刻だけで payload を含まない。
- collector は固定 endpoint、`redirect: "error"`、応答 URL 一致確認、HTTPS 固定、1 MiB 上限、timeout、契約 enum への分類で、raw body を保存しない。
- CSP の `connect-src 'self'` と blob worker 禁止に合わせた `timerVariant: "native"` の対応は、実機で踏む前に潰している。
- 既存監査記録は未完了事項（Grok の実機確認・24/72 時間観測・再起動復帰）を「保留」と明記しており、達成を過大に主張していない。

## 6. 推奨する順序

1. H1（Codex 枠ラベル）と H2（revision 巻き戻し）— 表示の正しさに直結。H1 は fixture 追加だけで回帰を防げる。
2. M1（配信の永久停止）と M3（publisher 再起動）— 小さな状態機械の修正で、どちらも再現手順が明確。
3. M2（ACL）— 運用側の設定を `scripts/` の検査に落とし、gateway の前提を機械的に確認できるようにする。
4. M5・M6・M8 — 常駐の長時間稼働で効く。まとめて 1 つの PR でよい。
5. テスト（M9）— 1〜4 の修正に対する回帰テストとして、close→backoff / stop 冪等 / metadata 欠落 / restore の 4 本を足す。
6. L 群は次の通常回帰で。

補足: ブランチの差分のうち 1,558 行は 58 節の監査記録そのもので、コードのレビュー対象を圧迫している。記録は `docs/audits/` などへ分離し、コード差分には結論だけを残すことを勧める。

## 7. 追記 — `0824b8e` 時点の再確認（2026-10-22）

監査のあと origin は 12 commits 進み、usage 配信は独立サービス（`services/usage`）へ分離された。§2〜§4 の指摘を新しい tip で読み直した結果を残す。番号は本書のもの。

| 指摘                       | `0824b8e` での状態 | 根拠                                                                                                                                                                                                                  |
| -------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1 Codex 枠ラベル          | 未修正             | `collectors/codex/api.ts:17-20` は依然として位置で 5時間/7日間を決め打ち                                                                                                                                              |
| H2 revision 巻き戻し       | 未修正             | `apps/dashboard/src/data/usage-state.ts:96` は同一 streamId の小さい revision を今も `stale`。`publishedAt` 比較は追加されていない                                                                                    |
| M1 配信の永久停止          | 一部緩和           | `App.tsx:234` が `usageConnection === "unavailable"` のときストリームを維持する。ただし metadata も `usageConnection` も無い応答（MQTT 以前の aggregator）では従来どおり停止し、effect は `[]` のままなので再開しない |
| M2 gateway の topic 認可   | 未修正             | `services/usage/src/mqtt/gateway.ts` へ移動しただけで、topic 検査は増えていない                                                                                                                                       |
| M3 publisher 再起動        | 未修正             | `services/usage/src/mqtt/publisher.ts:418`（`started` のみ判定）、`:430`（`stopping` を立てたまま）                                                                                                                   |
| M4 Grok ヒューリスティック | 一部緩和           | protobuf 走査が途中で失敗したら `invalid_data` を投げるようになった。フィールド取り違え自体は残る                                                                                                                     |
| M5 sender の body          | 未修正             | `collectors/shared/sender.ts:57` は今も cancel しない                                                                                                                                                                 |
| M6 poll 周期               | 未修正             | `collectors/claude/api-service.ts` は import 行のみの変更                                                                                                                                                             |
| M7 Codex label             | 未修正             | `collectors/codex/adapter.ts:20-21` は任意キーと `limitName` をそのまま使う                                                                                                                                           |
| M8 可視化時 reconnect      | 未修正             | `usage-stream.ts:197` は無条件 `reconnect()`。ただし stale 検知時に `reconnect()` を呼ぶようになり（`:202-207`）、止まったまま放置される時間は短くなった                                                              |
| M9 テスト空白              | 未修正             | 追加テストは publisher/store/契約側に寄っており、ブラウザーの close→backoff と collector 常駐ループは依然未テスト                                                                                                     |
| L5 契約の循環              | 一部解消           | 契約は `packages/usage-contracts` へ分離され、`usage-delivery.ts` の循環再輸出は縮小した                                                                                                                              |

新しく増えた挙動: aggregator は `/api/v1/dashboard` で `usageConnection` を返し、停止時は画面に「usage提供サービスに未接続 · 最後の値を表示」を出す（`App.tsx:241-247`）。L6 の一部はこれで解消している。

なお本節は `0824b8e` のコードを読んだ限りの状態整理で、独立サービス化後の実 broker・Fire 実機・長時間稼働の再試験は行っていない。

## 8. 現行コードでの検討と修正（2026-10-22）

本節は独立サービス化後のコードに対する対応記録。元の指摘は履歴として残す。指摘の修正案をそのまま適用するのではなく、同一streamの順序保証やbroker ACLを維持する方法で対応した。本番サービス・公開経路・実アカウントへの操作は行っていない。

| 指摘 | 検討・対応                                                                                                                                                                                             | 根拠・回帰確認                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1   | 修正。limit_window_secondsで5時間／7日を分類。duration省略時だけ位置へfallback、未知のdurationは利用枠・null                                                                                           | codex-apiの枠入れ替わりと未知duration試験                                                                                                                              |
| H2   | 修正。起動時に新streamIdを永続化。稼働中のファイル巻き戻し・stream変更も検出して新系列を保存。publisherはheartbeatで系列変化を検出しstateを再配信                                                      | usage-storeの起動／live rollback試験。同一streamの古いHTTP／MQTTを拒否する規則は維持。publishedAtだけで巻き戻りを許す案は遅延応答を採用するため不採用                  |
| M1   | 修正。metadataなしの旧HTTP応答を正本として扱い旧metadataを消す。ストリームは再作成可能に休止し、metadata復帰で再開。一時unavailableでは接続を維持                                                      | usage-outage-ui、usage-recovery-appの旧API→新API復帰試験                                                                                                               |
| M2   | 補強。broker ACLは引き続き必須。usage gatewayでもCONNECT制約、対象3トピックへの完全一致購読、許可packet種別を検査。PUBLISH／Will／username・password注入／wildcardを拒否。分割packetを上限付きで再構成 | mqtt-reader-filter、実ws gateway、隔離MosquittoとFire中継試験。scripts/test-usage-broker.mjsを追加。元記録の「検査・テストが無い」は分離実装の実broker試験追加前の状態 |
| M3   | 修正。stop完了後に再start可能。stopは冪等。旧runのasync読取・接続イベントを新runへ混入させない                                                                                                         | usage-publisherのstart→stop→startと旧イベント試験                                                                                                                      |
| M4   | 修正。任意のprotobuf領域の再帰探索を廃止し、既知のusage 1.1とreset 1.5.1のみ読取。resetと一意メッセージを必須化。0%は既知period markerがある場合のみ                                                   | grok-apiの別フィールド・reset欠落・重複message拒否。fixtureは合成値であり、sanitize済み実応答を取得済みとは扱わない。実サービスの形式変更時はinvalid_dataへ倒す        |
| M5   | 修正。成功／失敗とも未使用response bodyをcancel                                                                                                                                                        | sender-cleanupで200／401／503の解放試験                                                                                                                                |
| M6   | 修正。共通poll loopで処理開始基準の周期にする。期限超過時は追いつきburstを起こさない。設定上限は240秒へ下げ、stop後のin-flight読取は送信しない                                                         | collector-api-loopsで4収集器の20秒処理・60秒周期・停止を試験                                                                                                           |
| M7   | 修正。codexは固定id／ラベル、未知bucketは匿名の追加枠へ変換。数値を保持し、任意id／limitNameを配信しない                                                                                               | codexのprivate id／label非混入試験                                                                                                                                     |
| M8   | 修正。正常接続、接続試行中、backoff中はresumeイベントで切断しない。明示再接続では旧async factory結果を破棄                                                                                             | usage-streamのresume／close-backoff／late factory／stop試験                                                                                                            |
| M9   | 補完。ブラウザー再試行、異常payload、旧API復帰、stop、cache、API常駐loop、capture entrypointの回帰試験を追加                                                                                           | usage-stream、usage-recovery-app、usage-cache、collector-api-loops、api-capture                                                                                        |
| L1   | 修正。JMA 4xx／雪のsummaryは雪、欠測／未知は予報未取得。雲や雨を捏造しない                                                                                                                             | cardsの雪／欠測symbol試験                                                                                                                                              |
| L2   | 修正。JSON／schema／byte上限違反をerror状態として通知。最後の正常値は維持                                                                                                                              | usage-stream異常payload試験                                                                                                                                            |
| L3   | 修正。妥当なreset_atを優先し、なければreset_after_secondsを使用                                                                                                                                        | codex-api絶対reset優先試験                                                                                                                                             |
| L4   | TOCTOUを修正。同じfdのstatとread、O_NOFOLLOW、owner・mode検査。Windows ACLへの対応は範囲外                                                                                                             | mqtt-credentialsのpermission／symlink拒否試験。Windows収集器とLinuxバックエンドを区別し、POSIX検査を省略する修正はしない                                               |
| L5   | 修正。metadataのprimitiveとschemaを独立moduleへ集約し、index↔deliveryの実行時循環を除去。旧importパスは互換export                                                                                      | usage-contracts、usage-delivery、typecheck。applyHttpDashboardはテストで利用する副作用のない互換helperとして保持                                                       |
| L6   | 一部修正。追いつきは同期中、MQTT無効時はHTTPと表示。不正payloadはerror。footerの字体・配置変更は保留                                                                                                   | Appとusage-stream試験。長時間の可読性評価は今回未実施                                                                                                                  |
| L7   | 仕様維持。15分寿命はreader再認可のため必要で、独立サービス手順へ明記                                                                                                                                   | 既存gateway lifecycle試験                                                                                                                                              |
| L8   | 仕様維持。MQTT chunkのoffline除外と、失敗時の時計・保存済みカード維持／online復旧を手順へ明記                                                                                                          | 既存offline-build・worker試験                                                                                                                                          |
| L9   | 修正。MQTT受信ではusageだけをIndexedDBへ保存し、天気・RSSを古いコピーで再保存しない                                                                                                                    | usage-cacheで異なる天気値が上書きされないことを確認                                                                                                                    |

起動ごとの新系列は、従来の「同一保存ファイルなら起動後もstreamIdを維持」からの意図的変更。providerの観測時刻・最終正常時刻・sequence・数値・revisionは維持し、変更するのは配信系列とその確定時刻だけ。端末のサイトデータ消去は不要。

原記録の前提も補正する。publisher無効化だけではdelivery metadataは消えないため、M1の再現対象は旧版APIやmetadata欠落応答である。また§5の「上流CONNACK確認」は正確ではなく、101前に確認するのは上流WebSocketのmqttサブプロトコル。MQTT CONNECT／CONNACKは接続成立後に中継される。gatewayはHTTP認証とMQTT権限の別層であり、今回のpacket制約とbroker ACLを併用する。

### 対応後の検証

`rtk npm test` は767件成功・隔離broker用1件skip、`rtk npm run test:e2e` は69件成功。`rtk npm run test:usage:broker` を別実行し、実Mosquittoで1件成功。型検査、usage／Fire API／collectorビルドも成功。独立した最終レビューで重要・重大な追加指摘は無かった。今回も本番設定・稼働サービス・実アカウントは変更していない。
