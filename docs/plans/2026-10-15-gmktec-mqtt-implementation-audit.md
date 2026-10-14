# GMKtec MQTT usage配信 実装監査記録

本書は `docs/plans/2026-10-14-gmktec-mqtt-usage-plan.md` に基づくMQTT実装の監査の正本。対象は作業ツリー上の未コミット実装で、`07cc993` に対する差分（現在のHEADは文書だけのコミット `2eac257`）。
いつ見るか: MQTT実装のコミット・レビュー前、Phase 2／3の試験を書く前、本番でgateway／publisherを有効化する前。
関連: 計画 `docs/plans/2026-10-14-gmktec-mqtt-usage-plan.md`、計画監査 `docs/plans/2026-10-15-gmktec-mqtt-usage-plan-audit.md`、配備 `docs/deployment.md`、`gmktec-change-control`、`gmktec-validation-and-evidence`。
状態: **実装監査完了。ただし本番有効化不可**（2026-10-15、Asia/Tokyo）。
範囲: コード・テスト・ビルドのみ。GMKtecへの配備、Mosquitto、Tailscale Serve、systemd、Fire実機は変更・検証していない。

## 1. 結論

契約、永続 `streamId`／`usageRevision`、HTTP／MQTT共通の順序判定、MQTT publisher、reader認証付きWSS gateway、DashboardのHTTPフォールバックという骨格は実装されている。loopback broker URL、UTF-8 payload上限、Origin必須、`mqtt` サブプロトコル、上流のネゴシエーション確認後に下流101を返す順序もコード上は確認できる。

一方、段階導入と切り戻しに必要な端末単位のMQTT無効化がなく、gatewayのbackpressure判定が送信先と逆で、再接続時のretained `offline` と `too_large` 時の古いpending stateにも問題がある。publisher／gateway／ブラウザー購読の試験も不足している。したがって、現在は「実装コードがビルドできる」段階であり、計画のPhase 2〜4の受け入れ済み、またはPhase 5の本番配備済みとは扱わない。

有効化前の必須修正は次の4点である。

1. Dashboardに明示的なMQTT有効化・HTTP専用モードを追加し、既定をHTTP専用にする。
2. gatewayの送信先ソケットに対してbackpressureを検査する。
3. 意図した再接続でretained `offline` を発行せず、publisher instanceとheartbeatを用いて状態を判定する。
4. `too_large` 時にpending stateを破棄し、heartbeatのrevisionをHTTP値と照合する。

## 2. 検証結果

### 2.1 成功した検証

| コマンド | 結果 | 証拠・範囲 |
| --- | --- | --- |
| `rtk npm run typecheck` | 成功 | TypeScript型検査完了 |
| `rtk npm run build` | 成功 | Vite build完了。JS 708.53 kB、gzip 215.24 kB。500 kB超警告あり |
| `rtk npm run build:api` | 成功 | `mqtt`／`ws`を含むAPI bundle生成 |
| `rtk npm run build:collectors` | 成功 | collector bundle生成 |
| `rtk npm test -- --run tests/unit/usage-delivery.test.ts` | 成功 | 1 file、3 tests passed |
| `rtk git diff --check` | 成功 | 空白エラーなし |

### 2.2 全体テストの失敗

全体テストは実行環境によって結果が異なる。

| 実行環境 | 結果 | 内訳 |
| --- | --- | --- |
| 子プロセスを起動できない環境 | 652件中47件失敗（12ファイル） | 下記34件に加え、offline build／startup／private-audio／collectorの試験が子プロセス起動の `EPERM` で失敗。実行環境の制約によるもの |
| 通常のシェル | 652件中34件失敗（8ファイル） | RSS関連（jsdomの `window.matchMedia` 不足など）、weather catalog、weather settings API、weather status、card、chime |

通常のシェルで失敗した34件は、HEAD `07cc993` のクリーンなworktree（`git worktree` + 同じ `node_modules`）でも同じ8ファイル・34件が失敗した。したがって、これはMQTT変更による退行ではない。一方、全体テストの成功をMQTT実装の正しさの根拠にもしない。MQTT固有のfocused testは3件だけである。

## 3. 計画との対応

| 計画の領域 | 実装 | 判定 |
| --- | --- | --- |
| Phase 1 契約・保存・順序 | `packages/contracts/src/usage-delivery.ts`、`store.ts`、`usage/ingest.ts` | 部分完了。基本契約とrevisionはあるが、旧状態移行・サイズ境界・バックアップ復元の受け入れ試験がない |
| Phase 2 publisher | `services/aggregator/src/mqtt/publisher.ts` | 部分完了。QoS 1、retain、LWT、heartbeat、ACK期限、coalesceは実装。brokerを用いた試験がない |
| Phase 3 WSS認証・ACL | `services/aggregator/src/mqtt/gateway.ts`、`server.ts` | 部分完了。認証・Origin・subprotocol・上流確認は実装。実Serve、Mosquitto ACL、接続数制限、異常upgradeの試験がない |
| Phase 4 表示端末 | `usage-state.ts`、`usage-stream.ts`、`cache.ts`、`App.tsx` | 部分完了。共通reducerとHTTP fallbackはあるが、端末単位の有効化、Fire WebView、SW更新、heartbeat照合が未完了 |
| Phase 5 GMKtec段階導入 | 外部設定 | 未着手。broker、Serve、systemd、Fire設定を変更していない |
| Phase 6 常設運用 | 運用・長時間試験 | 未着手。24／72時間試験、負荷、復旧、台帳更新なし |

## 4. 実装確認

### 4.1 契約とrevision

- `UsageDelivery` は `schemaVersion`、`streamId`、10進文字列の `revision`、`publishedAt`、`usage` を持つ。
- `compareUsageRevision` は同一streamだけを比較し、異なるstreamは `null` を返す。
- provider重複、revisionの先頭ゼロ、heartbeat／availabilityの時刻・instanceIdをZodで検証する。
- `Store` は `streamId`、`usageRevision`、`usagePublishedAt` を状態ファイルへ保存し、atomic renameを使う。
- `ingestUsage` は accepted／duplicateでrevisionを進め、olderでは進めない。`store.inspect` により保存確定状態からpublisherが値を読む。

残る問題は、旧状態ファイルに `streamId` もdelivery metadataもない場合、最初の保存まで `createFileStore` の読み出しごとに `randomUUID()` が変わることである。移行時に一度永続化するか、revision `0` を明示的に扱う必要がある。

また、表示値が実際には変わらない非表示sourceの受信でもrevisionを進める。計画の「表示用状態が変化する保存で増やす」と実装の挙動をどちらかへ統一する必要がある。

### 4.2 publisher

`services/aggregator/src/mqtt/publisher.ts` で次を確認した。

- stateはQoS 1・retain、availabilityはQoS 1・retain、heartbeatはQoS 1・非retain。
- stateとheartbeatは別in-flight、別ACK timerで、stateのPUBACK待ちがheartbeatを停止させない。
- stateは一件だけin-flightにし、送信中の更新を最新payloadへcoalesceする。
- 古い接続のcallbackは `active !== client` で無視し、`reconnectPeriod: 0` とアプリ側backoffを併用する。
- state／heartbeatともPUBACK期限は30秒、意図した切断は最大5秒で正常切断を試み、失敗時に強制終了する。
- JSON直列化後のUTF-8 byte長を2 MiB候補と比較してからpublishする。

有効化前に直す点:

- `disconnectAndReconnect` が正常切断前に retained `offline` を明示publishする。30秒タイムアウトなど意図した再接続でofflineが表示され、LWTと重複する。意図した再接続は正常切断だけにし、offlineは停止処理とLWTの責務に分ける。
- `queueCurrentState` が `too_large` 時に既存の `pendingState` を破棄しない。旧revisionが後で送られ得るため、超過時はpendingを無効化し、上限内の最新stateが送信できるまで `ok` に戻さない。
- publisher単体試験がなく、PUBACK遅延、timeout、古いcallback、heartbeat独立、再接続後のretained順序を証明できない。

### 4.3 gateway

`services/aggregator/src/mqtt/gateway.ts` で次を確認した。

- デフォルト経路は `/api/v1/usage/stream`。
- FastifyのonRequestでGETをreaderとして認証し、preHandlerでOrigin必須・完全一致と `mqtt` 要求を検査する。
- preHandlerでloopbackの上流WSを開き、上流 `socket.protocol === "mqtt"` を確認してから、プラグインのupgradeハンドラーへ渡す。
- gatewayと上流の双方に `maxPayload` を明示し、接続期限は15分。
- `mqtt` 以外、Origin欠落・不一致、上流接続失敗は101を返さない実装になっている。

有効化前に直す点:

- `socket.on("message")` では送信先の `upstream` ではなく受信元 `socket` の `bufferedAmount` を見ている。`upstream.on("message")` も逆である。各方向で、書き込み先ソケットのbufferedAmountを上限判定する。
- preHandlerで上流を開いた後、下流upgrade自体が失敗すると上流だけが残る可能性がある。requestのclose／response cleanupで上流を確実に閉じる。
- `injectWS` またはローカルWS brokerによるOrigin、認証、subprotocol、上限、上流失敗、15分切断、backpressureの試験がない。

### 4.4 Dashboard

- `usage-state.ts` はHTTPとMQTTに同じrevision reducerを使う。
- 同一streamの古い値・duplicate・同revisionの異なるpayloadを拒否する。
- streamId切替は認証済みHTTPだけを許し、MQTTだけではstreamを切り替えない。
- IndexedDBへdelivery metadataを保存し、HTTP取得がMQTTの新しい値を巻き戻さない。
- MQTT不通・payload超過時にはHTTP refreshへ戻る経路がある。

有効化前に直す点:

- `App.tsx` はマウント時に `createUsageStream()` を無条件で呼ぶ。`mqtt.enabled` はサーバー側publisher／gatewayだけを制御し、ブラウザーの購読を止めない。現状ではgateway無効でも全端末が再接続を試みる。端末単位の明示的な有効化フラグを追加し、既定をHTTP専用にする。
- heartbeatの `streamId`／`revision`／`deliveryStatus` を表示状態の判定に使っていない。`too_large` heartbeatで現在HTTP revisionを照合し、表示中revisionより新しい場合にHTTPを取り直す。
- availabilityの `instanceId` を照合せず、任意publisherのofflineを `error` として表示する。接続後のheartbeatと自分が購読したpublisherのinstanceIdを基準にする。
- footerへ `MQTT connecting` など英語の内部状態を直接表示している。既存UIの日本語状態表示に対応付け、実機未検証の表示も残す。
- `mqtt`／`ws` の常時bundle化でdashboard JSが約709 kB（gzip約215 kB）となり500 kB警告が出る。HTTP専用端末ではdynamic importで不要資産を読み込まない方式を検討する。

### 4.5 設定・配備

- `configSchema` はpublisherとgatewayを独立した `enabled` で制御し、既定値は双方false。
- publisher／gatewayの接続先はloopback URLに限定する。
- publisher資格情報は `FIRE_MQTT_USERNAME`／`FIRE_MQTT_PASSWORD` をサーバー側だけで読む。ブラウザーへ渡していない。
- 変更された設定例と依存追加はリポジトリ内にある。

ただし `docs/deployment.md` は「mqtt.enabledとgateway.enabledがともにtrueのときだけ有効」と説明しており、実装の独立制御と一致しない。資格情報の配置、gateway接続数制限、listener別ACLも文書と実装で受け入れ条件を揃える必要がある。

## 5. セキュリティ・公開範囲監査

コード上の防御:

- reader認証は既存Fastify onRequestを経由する。
- Originは欠落も拒否し、許可済みOriginとの完全一致を要求する。
- `Sec-WebSocket-Protocol` に `mqtt` がなければ拒否する。
- publisherのusername／passwordはサーバー環境変数からのみ読む。
- MQTT／WSSのURLはloopbackに制限し、ブラウザーへpublisher write credentialを渡さない。
- payload byte上限をpublisher、gateway、Dashboardで持つ。

未証明の範囲:

- 外部から送られた偽の `Tailscale-User-Login` をTailscale Serveが上書き・除去すること。既存の `/api` 中継がWebSocket upgradeと認証ヘッダーを転送すること。
- Mosquittoのwrite listener／read listener分離、ACL、readerのpublish拒否、管理topic拒否。
- loopback以外からの到達拒否、Fire WebViewのCSP・WSS・subprotocol挙動。
- gateway接続数制限と異常upgrade時のリソース解放。

これらは本リポジトリの型検査だけでは証明できず、Phase 0／3の開発環境・GMKtec実測・Fire実機試験が必要である。

## 6. 外部変更と本番配備の状態

今回の作業では次を変更していない。

- GMKtecのMosquitto／Podman／quadlet。
- Tailscale Serve、HTTPS入口、listener、ACL。
- `fire-dashboard-api.service` などのsystemd unit。
- `FIRE_CONFIG`、`FIRE_MQTT_USERNAME`、`FIRE_MQTT_PASSWORD` の本番値。
- Fireタブレット、Fully Kiosk、他の表示端末。
- brokerの本番topicやretained message。

従って、本監査文書の存在や作業ツリーの実装だけでは、配信が稼働していること、FireがMQTTを購読できること、既存の公開範囲が保たれていることを意味しない。ネットワーク露出やsystem層の変更が必要になった場合は、`gmktec-change-control` のバックアップ・承認・正負検証を別途適用する。

## 7. 切り戻し監査

現状は端末側のMQTT有効化フラグがないため、計画§15.1の「端末単位でHTTP専用へ戻す」は未達である。切り戻し可能と記録する前に、次を実装・試験する必要がある。

1. HTTP専用を既定にし、Fire 1台だけ明示的にMQTTを有効化できること。
2. MQTT購読停止後も30秒HTTP polling、天気、RSS、時計、時報が継続すること。
3. publisher／gatewayを無効化してもusage POSTと状態保存が継続すること。
4. 旧版がdelivery metadataを無視して起動できること、または状態ファイル変換とバックアップ復元を用意すること。
5. 追加broker／gatewayだけを停止し、既存Serve経路や共有brokerを停止しないこと。

## 8. 推奨する修正・検証順序

1. 端末単位のMQTT opt-in、HTTP専用表示、dynamic importを実装する。
2. gatewayのbackpressure向き、異常upgrade時の上流cleanupを修正する。
3. publisherの再接続offline、`too_large` pending破棄、Dashboardのheartbeat／instanceId照合を修正する。
4. publisher、gateway、usage-streamのfocused testsを追加する。少なくともPUBACK遅延、timeout、古いcallback、heartbeat独立、Origin欠落、不正Origin、reader／collector、subprotocol、payload上限、上流失敗、backpressure、15分切断を含める。
5. focused tests、typecheck、各buildを再実行し、全体テストの既存／環境依存失敗とは別に結果を記録する。
6. Phase 0でbroker・port・Serve・unit・ACL・Fire経路を読み取り専用確認する。設定変更前に時刻付きバックアップと切り戻し手順を用意する。
7. 開発brokerでQoS／retain／LWT／ACLを統合試験し、Fire以外の検証端末でWSSを確認する。
8. Fire 1台だけを有効化し、24時間（可能なら72時間）の正負証拠を取得する。成功後にのみPhase 6へ進む。

## 9. 監査判定

| 判定項目 | 判定 |
| --- | --- |
| 実装コードが存在する | 合格 |
| 型検査・主要buildが通る | 合格 |
| 共通契約とrevision順序がある | 部分合格 |
| publisherのQoS／LWT／再接続がbrokerで実証された | 未実施 |
| gatewayの認証・ACL・公開範囲が実機で実証された | 未実施 |
| FireのMQTT over WSS表示が実証された | 未実施 |
| 端末単位の段階導入・HTTP切り戻しが可能 | 不合格（修正要） |
| 本番配備してよい | **不可** |

本書は実装の監査記録であり、GMKtecへの変更承認、本番配備完了、長時間運用の成功を意味しない。
