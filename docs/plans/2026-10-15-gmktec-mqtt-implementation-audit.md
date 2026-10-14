# GMKtec MQTT usage配信 実装監査記録

本書は `docs/plans/2026-10-14-gmktec-mqtt-usage-plan.md` に基づくMQTT実装の監査の正本。対象は作業ツリー上の未コミット実装で、`07cc993` に対する差分。`07cc993` 以降のコミットは文書のみ。
いつ見るか: MQTT実装のコミット・レビュー前、Phase 2／3の試験を書く前、本番でgateway／publisherを有効化する前。
関連: 計画 `docs/plans/2026-10-14-gmktec-mqtt-usage-plan.md`、計画監査 `docs/plans/2026-10-15-gmktec-mqtt-usage-plan-audit.md`、配備 `docs/deployment.md`、`gmktec-change-control`、`gmktec-validation-and-evidence`。
状態: **初回監査の必須4件、upgrade拒否時の上流cleanup、revision／資格情報／接続数制限／publisher起動分離／設定・接続状態可視化をコード修正・試験済み。本番有効化不可**（2026-10-15、Asia/Tokyo）。
範囲: コード・テスト・ビルドのみ。GMKtecへの配備、Mosquitto、Tailscale Serve、systemd、Fire実機は変更・検証していない。

## 1. 結論

契約、永続 `streamId`／`usageRevision`、HTTP／MQTT共通の順序判定、MQTT publisher、reader認証付きWSS gateway、DashboardのHTTPフォールバックという骨格は実装されている。loopback broker URL、UTF-8 payload上限、Origin必須、`mqtt` サブプロトコル、上流のネゴシエーション確認後に下流101を返す順序もコード上は確認できる。

初回監査で指摘した端末単位のMQTT無効化、gatewayのbackpressure向き、再接続時のretained `offline`、`too_large` 時の古いpending state、publisherの接続状態可視化はコード修正済みで、今回の修正を含むfocused test 57件が成功している。MQTT opt-in端末だけがchunkを実行時に読み込み、HTTP専用端末のService Worker事前キャッシュからはMQTT chunkを除外した。

残るのは、publisher／gateway／ブラウザー購読の実broker試験、Mosquitto／Serve／systemd／Fireの配備と24時間以上の実機試験である。upgrade拒否時の保留upstreamはraw TCP socketの終了監視で閉じることを実ソケット回帰試験で確認したが、実ネットワークでの資源上限と運用証拠は未取得である。したがって、計画のPhase 2〜4を完全受け入れ済み、またはPhase 5の本番配備済みとは扱わない。

## 2. 検証結果

### 2.1 成功した検証

| コマンド | 結果 | 証拠・範囲 |
| --- | --- | --- |
| `rtk npm run typecheck` | 成功 | TypeScript型検査完了 |
| `rtk npm run build` | 成功 | Vite build完了。本体JS 374.31 kB（gzip 115.60 kB）、mqtt chunk 335.62 kB（gzip 99.90 kB）。Service Worker事前キャッシュは59 assetsでMQTT chunkを除外 |
| `rtk npm run build:api` | 成功 | `mqtt`／`ws`を含むAPI bundle生成 |
| `rtk npm run build:collectors` | 成功 | collector bundle生成 |
| `rtk npm test -- --run tests/unit/mqtt-credentials.test.ts tests/unit/offline-build.test.ts tests/unit/usage-delivery.test.ts tests/unit/usage-stream.test.ts tests/integration/mqtt-gateway.test.ts tests/unit/usage.test.ts tests/unit/usage-replay.test.ts tests/unit/opencode-go-ingestion.test.ts` | 成功 | 8 files、57 tests passed。Service WorkerのMQTT chunk除外、表示状態に基づくrevision、資格情報ファイル権限と不備時のHTTP継続、資格情報読取権限エラーの分類、publisher状態API、publisher runtime状態（接続・再接続回数・最終publish・エラー・payload超過）、同revision再送抑止、旧状態のrevision 0 metadata、heartbeat status順序、publisherのoffline単独再接続、PUBACK timeout、LWT、gatewayの認証・Origin・subprotocol・双方向転送・接続数上限・実ソケットupgrade拒否cleanupを含む |
| `rtk git diff --check` | 成功 | 空白エラーなし |

### 2.2 全体テストの失敗

全体テストは実行環境によって結果が異なる。今回の確認では権限制約なしで `rtk npm test` を実行し、682件中34件失敗を観測した。失敗は既存のweather／RSS／chime系で、MQTT focused testの失敗は無い。sandbox内の再実行では子プロセス起動・TCP listenのEPERMが追加されるため、以下は権限制約なしの結果を採用する。

| 実行環境 | 結果 | 内訳 |
| --- | --- | --- |
| 今回の確認環境（権限制約なしの `rtk npm test`） | 682件中34件失敗（8ファイル、648 passed） | RSS関連（jsdomの `window.matchMedia` 不足など）、weather catalog、weather settings API、weather status、card、chime。MQTT focused testは成功 |
| focused test追加前の通常環境比較記録 | 652件中34件失敗（8ファイル） | RSS関連、weather catalog、weather settings API、weather status、card、chime。focused test追加後の同条件比較は未実施 |

focused test追加前の34件は、HEAD `07cc993` のクリーンなworktree（`git worktree` + 同じ `node_modules`）でも同じ8ファイル・34件が失敗したという比較記録がある。今回の環境ではその比較を再実行していないため、ここでは過去の証拠として扱う。全体テストの成功をMQTT実装の正しさの根拠にもしない。今回のMQTT固有focused testは57件である。

## 3. 計画との対応

| 計画の領域 | 実装 | 判定 |
| --- | --- | --- |
| Phase 1 契約・保存・順序 | `packages/contracts/src/usage-delivery.ts`、`store.ts`、`usage/ingest.ts` | 部分完了。基本契約とrevisionはあるが、旧状態移行・サイズ境界・バックアップ復元の受け入れ試験がない |
| Phase 2 publisher | `services/aggregator/src/mqtt/publisher.ts` | 部分完了。QoS 1、retain、LWT、heartbeat、ACK期限、coalesce、offline単独時の再接続、`mqtt-status.runtime`による実行時状態をfocused testで確認。brokerを用いた試験がない |
| Phase 3 WSS認証・ACL | `services/aggregator/src/mqtt/gateway.ts`、`server.ts` | 部分完了。認証・Origin・subprotocol・上流確認・双方向転送・上流拒否・接続寿命・設定可能な接続数上限を`injectWS`＋注入上流で確認。実Serve、Mosquitto ACL、実ネットワークでの資源挙動は未確認 |
| Phase 4 表示端末 | `usage-state.ts`、`usage-stream.ts`、`cache.ts`、`App.tsx` | 部分完了。端末単位の有効化、共通reducer、HTTP fallback、heartbeat照合は実装。Fire WebView、SW更新、実機到着順は未検証 |
| Phase 5 GMKtec段階導入 | 外部設定 | 未着手。broker、Serve、systemd、Fire設定を変更していない |
| Phase 6 常設運用 | 運用・長時間試験 | 未着手。24／72時間試験、負荷、復旧、台帳更新なし |

## 4. 実装確認

### 4.1 契約とrevision

- `UsageDelivery` は `schemaVersion`、`streamId`、10進文字列の `revision`、`publishedAt`、`usage` を持つ。
- `compareUsageRevision` は同一streamだけを比較し、異なるstreamは `null` を返す。
- provider重複、revisionの先頭ゼロ、heartbeat／availabilityの時刻・instanceIdをZodで検証する。
- `Store` は `streamId`、`usageRevision`、`usagePublishedAt` を状態ファイルへ保存し、atomic renameを使う。
- `ingestUsage` は表示用usageが変化する accepted／duplicateでrevisionを進め、表示に反映されない受信やolderでは進めない。表示中のduplicateはreceivedAtが変わるため対象になる。`store.inspect` により保存確定状態からpublisherが値を読む。

旧状態ファイルに `streamId` もdelivery metadataもない場合のIDは、最初の保存までStoreインスタンス内で保持し、保存後は状態ファイルへ永続化するよう修正した。移行前ファイルの読み出し安定性をfocused testで確認している。

### 4.2 publisher

`services/aggregator/src/mqtt/publisher.ts` で次を確認した。

- stateはQoS 1・retain、availabilityはQoS 1・retain、heartbeatはQoS 1・非retain。
- stateとheartbeatは別in-flight、別ACK timerで、stateのPUBACK待ちがheartbeatを停止させない。
- stateは一件だけin-flightにし、送信中の更新を最新payloadへcoalesceする。
- 古い接続のcallbackは `active !== client` で無視し、`reconnectPeriod: 0` とアプリ側backoffを併用する。
- state／heartbeatともPUBACK期限は30秒、意図した切断は最大5秒で正常切断を試み、失敗時に強制終了する。
- JSON直列化後のUTF-8 byte長を2 MiB候補と比較してからpublishする。
- `status()` は接続状態、再接続回数、現在revision、直近PUBACK時刻・revision、直近エラー、delivery statusを返し、`/api/v1/mqtt-status` の `runtime` としてreaderへ公開する。

対応済み:

- `disconnectAndReconnect` は正常切断前に retained `offline` を明示publishしない。offlineは停止処理とLWTの責務に分けた。
- `queueCurrentState` は `too_large` 時に既存の `pendingState` を破棄するため、古いrevisionを後から送らない。

残る試験:

- publisherのfocused testでheartbeat独立、offline単独再接続、QoS／retain指定、PUBACK timeout、古いcallback、LWT設定を確認した。再接続後のbroker retained順序とLWTの実効動作は実brokerで証明する必要がある。

### 4.3 gateway

`services/aggregator/src/mqtt/gateway.ts` で次を確認した。

- デフォルト経路は `/api/v1/usage/stream`。
- FastifyのonRequestでGETをreaderとして認証し、preHandlerでOrigin必須・完全一致と `mqtt` 要求を検査する。
- preHandlerでloopbackの上流WSを開き、上流 `socket.protocol === "mqtt"` を確認してから、プラグインのupgradeハンドラーへ渡す。
- gatewayと上流の双方に `maxPayload` を明示し、接続期限は15分。
- `mqtt` 以外、Origin欠落・不一致、上流接続失敗は101を返さない実装になっている。

対応済み:

- 各方向の送信先ソケットの `bufferedAmount` を検査するhelperを追加した。
- preHandler後に下流upgradeが破棄された場合、requestと`request.raw.socket`の`close`／`error`で保留中の上流WSを閉じるcleanupを追加した。実Fastify＋実TCPソケットで、不正なWebSocket versionの400応答後に上流が閉じることを確認した。

残る試験:

- `injectWS` と注入上流によるOrigin、認証、subprotocol、上流失敗、接続寿命、双方向転送はfocused integration testで実施した。実WebSocket／Mosquitto brokerによるpayload上限、backpressure、接続数上限、Serve経路は未確認である。

### 4.4 Dashboard

- `usage-state.ts` はHTTPとMQTTに同じrevision reducerを使う。
- 同一streamの古い値・duplicate・同revisionの異なるpayloadを拒否する。
- streamId切替は認証済みHTTPだけを許し、MQTTだけではstreamを切り替えない。
- IndexedDBへdelivery metadataを保存し、HTTP取得がMQTTの新しい値を巻き戻さない。
- MQTT不通・payload超過時にはHTTP refreshへ戻る経路がある。

対応済み:

- URLの `?usageMqtt=1` がある端末だけ購読し、指定がない端末はHTTP専用にした。無効時はMQTT clientをloadしない。
- heartbeatの `streamId`／`revision`／`deliveryStatus` をreducerで判定し、超過または未反映の新revisionならHTTPで照合する。
- availabilityのofflineは、heartbeatで確認したpublisher instanceと一致する場合だけエラー表示する。
- footerのMQTT状態を日本語へ対応付けた。
- MQTT clientをdynamic importし、buildでメインJS 374.31 kB（gzip 115.60 kB）、MQTT chunk 335.62 kB（gzip 99.90 kB）へ分割した。Service Workerの事前キャッシュにはMQTT chunkを含めない。

残る試験:

- Fire WebView、SW更新、Wi-Fi切替、複数タブ、実際のretained availabilityとheartbeatの到着順は未実機確認である。

### 4.5 設定・配備

- `configSchema` はpublisherとgatewayを独立した `enabled` で制御し、既定値は双方false。
- publisher／gatewayの接続先はloopback URLに限定する。
- publisher資格情報は `mqtt.credentialsFile` のowner-only JSONファイルからサーバー側だけで読む。ブラウザーへ渡していない。
- 変更された設定例と依存追加はリポジトリ内にある。

`docs/deployment.md` のpublisher／gateway独立制御、資格情報ファイル、gateway接続数上限の説明は実装に合わせて修正した。listener別ACLは引き続き本番配備時の確認項目であり、コードだけでは受け入れ済みとしない。
`/api/v1/mqtt-status` の `publisher`／`reason` は資格情報の設定状態、`runtime` はbroker接続とpublishの実行状態を表す。runtimeはpull型の確認経路で、自動通知の代替ではない。

## 5. セキュリティ・公開範囲監査

コード上の防御:

- reader認証は既存Fastify onRequestを経由する。
- Originは欠落も拒否し、許可済みOriginとの完全一致を要求する。
- `Sec-WebSocket-Protocol` に `mqtt` がなければ拒否する。
- publisherのusername／passwordはowner-onlyのサーバー資格情報ファイルからのみ読む。
- MQTT／WSSのURLはloopbackに制限し、ブラウザーへpublisher write credentialを渡さない。
- payload byte上限をpublisher、gateway、Dashboardで持つ。

未証明の範囲:

- 外部から送られた偽の `Tailscale-User-Login` をTailscale Serveが上書き・除去すること。既存の `/api` 中継がWebSocket upgradeと認証ヘッダーを転送すること。
- Mosquittoのwrite listener／read listener分離、ACL、readerのpublish拒否、管理topic拒否。
- loopback以外からの到達拒否、Fire WebViewのCSP・WSS・subprotocol挙動。
- gatewayの実ネットワークでの資源上限挙動。コード上の接続数制限と異常upgrade時の保留上流cleanupは確認したが、Serve経路を含む負荷試験は未確認。

これらは本リポジトリの型検査だけでは証明できず、Phase 0／3の開発環境・GMKtec実測・Fire実機試験が必要である。

## 6. 外部変更と本番配備の状態

今回の作業では次を変更していない。

- GMKtecのMosquitto／Podman／quadlet。
- Tailscale Serve、HTTPS入口、listener、ACL。
- `fire-dashboard-api.service` などのsystemd unit。
- `FIRE_CONFIG`、`mqtt.credentialsFile` の本番パスや資格情報ファイル。
- Fireタブレット、Fully Kiosk、他の表示端末。
- brokerの本番topicやretained message。

従って、本監査文書の存在や作業ツリーの実装だけでは、配信が稼働していること、FireがMQTTを購読できること、既存の公開範囲が保たれていることを意味しない。ネットワーク露出やsystem層の変更が必要になった場合は、`gmktec-change-control` のバックアップ・承認・正負検証を別途適用する。

## 7. 切り戻し監査

端末側のURL opt-inを追加したため、HTTP専用へ戻す切り替え手段は実装済みである。ただし実機での切り戻し証拠は未取得であり、次を試験する必要がある。

1. HTTP専用を既定にし、Fire 1台だけ明示的にMQTTを有効化できること。
2. MQTT購読停止後も30秒HTTP polling、天気、RSS、時計、時報が継続すること。
3. publisher／gatewayを無効化してもusage POSTと状態保存が継続すること。
4. 旧版がdelivery metadataを無視して起動できること、または状態ファイル変換とバックアップ復元を用意すること。
5. 追加broker／gatewayだけを停止し、既存Serve経路や共有brokerを停止しないこと。

## 8. 推奨する修正・検証順序

1. publisher、gateway、usage-streamのfocused／統合testsを追加する。認証・Origin・subprotocol・上流失敗・heartbeat独立・offline単独再接続・接続寿命・backpressure・異常upgrade cleanupは実装した。PUBACK遅延／timeout／古いcallback、payload上限、実brokerのQoS／retain／LWTは実broker試験へ残す。
2. focused tests、typecheck、各buildを再実行し、全体テストの既存／環境依存失敗とは別に結果を記録する。
3. Phase 0でbroker・port・Serve・unit・ACL・Fire経路を読み取り専用確認する。設定変更前に時刻付きバックアップと切り戻し手順を用意する。
4. 開発brokerでQoS／retain／LWT／ACLを統合試験し、Fire以外の検証端末でWSSを確認する。
5. Fire 1台だけを `?usageMqtt=1` で有効化し、24時間（可能なら72時間）の正負証拠を取得する。成功後にのみPhase 6へ進む。

## 9. 監査判定

| 判定項目 | 判定 |
| --- | --- |
| 実装コードが存在する | 合格 |
| 型検査・主要buildが通る | 合格（focused修正後に再確認） |
| 共通契約とrevision順序がある | 合格（表示用usage変化時のみ進行、旧移行安定化を反映） |
| 端末単位のMQTT opt-in・HTTP切り戻しがある | 合格（実機未確認） |
| gatewayの送信先backpressure・異常upgrade cleanup | コード修正済み。backpressure helper、`injectWS`転送／接続寿命、実TCPソケットのupgrade拒否cleanup試験を実施（実ネットワーク未確認） |
| gatewayの接続数上限・切断後の枠再利用 | コード修正済み。既定8／最大256、upgrade前の503拒否とfocused integration testを実施（Serve負荷未確認） |
| publisherの再接続offline・too_large pending処理 | コード修正済み。focused test実施（broker試験未実施） |
| publisherのQoS／LWT／再接続がbrokerで実証された | 未実施 |
| gatewayの認証・ACL・公開範囲が実機で実証された | 未実施 |
| FireのMQTT over WSS表示が実証された | 未実施 |
| 端末単位の段階導入・HTTP切り戻しが可能 | 部分合格（実機試験待ち） |
| 本番配備してよい | **不可** |

本書は実装の監査記録であり、GMKtecへの変更承認、本番配備完了、長時間運用の成功を意味しない。

## 10. 追加対応（2026-10-15）

### 10.1 実装・試験の追加

- `gateway.ts` に上流WebSocket factoryの注入点を追加した。通常起動では従来どおり `ws` の実WebSocketを使い、テストではTCP listenを必要としない上流doubleを使う。
- `@fastify/websocket` の `injectWS` で、reader認証、collector拒否、Origin欠落、`mqtt` subprotocol必須、上流subprotocol不一致、双方向転送、上流cleanup、接続寿命を確認した。
- 本番の15分接続寿命は既定値として維持し、試験では `connectionTimeoutMs` を短縮して両方向切断を観測した。
- MQTT publisherは、`offline`イベントだけで`close`が来ない場合に古いclientを保持しないよう、明示的な切断・再接続へ進む。stateはQoS 1・retain、heartbeatはQoS 1・非retainで、stateのPUBACK待ち中にもheartbeatを送るfocused testを追加した。
- gateway cleanupは実IncomingMessageと`request.raw.socket`の`close`／`error`を使い、テスト用inject requestにそのAPIが無い場合は安全に省略する。実Fastify＋loopback TCPの回帰試験で、upgrade拒否後の上流切断を確認した。

### 10.2 Phase 0読み取り専用確認の制約

2026-10-15 02:58 JSTにGMKtec上で読み取り専用確認を再実行した。次の事実を取得できた。

| 確認 | 結果 |
| --- | --- |
| `ss -ltnp` | APIは`127.0.0.1:18787`。MQTT候補の`1883`／WS候補の`9001`は待受なし。Serve入口の`100.106.71.32:8444`は待受中 |
| `systemctl --user show fire-dashboard-api.service` | `enabled`、`active/running`、`MainPID=2958627`、`NRestarts=0` |
| `systemctl --user is-enabled` | `fire-dashboard-usage-sender.service=disabled`、Codex collector=enabled、Antigravity／Hermes Nous／OpenCode Goの各timer=enabled |
| `systemctl --user list-timers` | 3つのusage timerは`active waiting`。API unitは稼働中 |
| `podman ps --all` | Mosquitto／MQTT brokerコンテナなし。ntfy等の既存コンテナのみ |
| `tailscale serve status` | `:8444`はtailnet-only。`/`はdashboard dist、`/api`は`http://127.0.0.1:18787/api`へproxy。別のFunnel `:443`はntfyへ向く |
| Serve経由 `GET /api/v1/health` | `200`。Serveが有効なTailscale認証ヘッダーを付与する経路としての到達性を確認 |
| loopback直接／偽ヘッダー `GET /api/v1/health` | いずれも`401`。`attacker@example.invalid`は許可されない |
| Serve経由のWSS upgrade試行 `/api/v1/usage/stream` | `404`。現行APIはgateway未配備で、誤って`101`を返していない |

Phase 0の入口・認証・使用ポートの一部は確認できたが、broker／listener／ACLはまだ存在しないため、Mosquitto構成・WSS listener・gateway unitの実効値は未確認である。設定変更・再起動・ネットワーク公開は行っていない。`8444`の既存`/api`中継は第一候補経路の前提を満たす可能性があるが、gatewayを有効化してWebSocket upgradeを実測するまでは成立と判定しない。

### 10.3 現在の判定

追加試験後も、実brokerのQoS／retain／LWT／PUBACK timeout、Mosquitto listener／ACL、Tailscale Serveのupgrade・認証ヘッダー、Fire WebViewのWSS、24／72時間試験は未完了である。したがって本番配備判定は引き続き **不可** とする。

## 11. 再監査 — 修正版の実コード・実ソケット確認（2026-10-15）

§10までの修正を反映した作業ツリーを再監査した。コード（`gateway.ts`、`publisher.ts`、`usage-stream.ts`、`usage-state.ts`、`App.tsx`、`store.ts`）を読み、以下を実行した。broker・Serve・Fire実機は対象外。

| 検証 | 結果 |
| --- | --- |
| focused test（usage-delivery／usage-stream／mqtt-gateway、追試追加前） | 3 files、21 tests passed |
| `npm run typecheck` | 成功 |
| `npm run build` | 成功。本体JS 374.28 kB（gzip 115.60 kB）、mqttは別chunk 335.62 kB（gzip 99.90 kB）。HEADの本体は366.97 kB |
| 実ソケット試験（実Fastify＋`registerMqttGateway`＋ローカルwsサーバーを上流brokerの代役に使用） | 正常接続: `mqtt` サブプロトコル選択と双方向転送を確認。不正 `Sec-WebSocket-Version` のupgrade: 400応答後も上流接続が残留（下記11.2-1） |

### 11.1 修正を確認できた点

1. 端末単位の有効化: 既定は無効、`?usageMqtt=1` の端末だけ購読し、mqttは動的importで読み込む。
2. backpressure: 各方向とも送信先ソケットで判定する。実ソケットでも転送は正常。
3. 意図した再接続でretained `offline` を送らない。端末はinstanceIdを照合し、他instanceのofflineを無視する。
4. `too_large` 時にpending stateを破棄する。heartbeatのrevisionが表示中より新しければHTTPで照合する。
5. 旧状態ファイルのstreamIdはプロセス内で固定（`migratedStreamId`）。`deployment.md` の有効化条件、フッターの日本語表示も修正済み。

### 11.2 残る指摘

1. **【解決】upgrade失敗時の上流接続cleanup。** 初回の実ソケット試験では、preHandlerで上流を開いた後に `ws.handleUpgrade` が不正なWebSocket versionを400で拒否すると上流が残留した。`request.raw.socket` の `close`／`error` 監視へcleanup経路を拡張し、実Fastify＋loopback上流で「400応答後に上流が閉じる」回帰試験を追加して確認した。`injectWS` だけでは再現しないため、実ソケット試験を必須の証拠として扱う。
2. **【解決】HTTP専用端末のmqtt chunk事前取得。** `scripts/build-sw.mjs` で`/assets/mqtt...`をService Workerの事前キャッシュから除外した。`offline-build.test.ts` で生成結果にMQTT chunkが含まれないことを確認した。MQTT opt-in端末はオンライン時のdynamic importで取得する。
3. **【解決】配備直後に試験端末のMQTTが止まり得る問題。** 旧状態ファイルまたは未作成状態でもStoreがrevision `0`、安定したstreamId、生成時刻のmetadataを返すようにした。`usage-delivery.test.ts` で複数readのmetadata安定性を確認した。metadata自体は最初のusage書き込みまで状態ファイルへ永続化されないため、プロセス再起動前のstreamId安定性はStoreインスタンス内の保証である。
4. **【解決】状態表示のheartbeat status上書き。** `usage-stream.ts` は通常heartbeatの`connected`通知を`onHeartbeat`より先に行うようにし、heartbeat callbackが`error`へ変更した状態を後続通知で上書きしない。`usage-stream.test.ts` で通知順序を固定した。
5. **【低】前回から残る点。** 表示が変わらない受信でrevisionを進める挙動、publisher秘密の配置、gateway接続数制限。これらは§16で実装・試験済みとし、実broker／運用導入時の確認は残す。

### 11.3 判定

11.2-1は解決済み。実broker、ACL、Serve、Fire実機、長時間試験は未完了のため、本番配備判定は引き続き **不可**。

## 12. 追試 — upgrade拒否時cleanupの修正確認（2026-10-15）

### 12.1 修正内容

- `connectUpstream` は保留中のupstreamと解放処理をrequestに紐付ける。
- 下流のupgradeが成功する前は、`request.raw` と `request.raw.socket` の終了・エラーを監視し、保留upstreamを`terminate`する。
- 下流upgradeが成功した場合は保留監視を解除し、通常の双方向close処理へ引き渡す。
- upstream自身の`close`も接続待ちPromiseを終了させ、上流拒否・切断時に503へ収束させる。

### 12.2 実ソケット回帰試験

実Fastifyサーバー、実`ws`上流、loopback TCPクライアントで次を確認した。

1. 下流は`Sec-WebSocket-Version: 12`を送信し、`ws`のupgrade拒否によりHTTP 400を受信する。
2. preHandlerで先に確立したupstreamの`close`イベントを受信する。
3. gateway／上流のlistenを試験終了時に閉じ、プロセスが残留しない。

この試験は `tests/integration/mqtt-gateway.test.ts` の `closes an upstream when ws rejects the downstream upgrade` に固定した。broker、Tailscale Serve、Fire WebViewを使う本番相当試験ではないため、§10.3の未完了項目は維持する。

## 13. 第3回再監査 — §12の独立確認（2026-10-15）

§11以降に変わった `gateway.ts`、`tests/integration/mqtt-gateway.test.ts` を読み、§11と同じ実ソケット試験（実Fastify＋`registerMqttGateway`＋ローカルwsサーバーを上流brokerの代役に使用）を、修正者とは別に再実行した。

| 検証 | 結果 |
| --- | --- |
| 正常接続 | `mqtt` サブプロトコル選択と双方向転送を確認 |
| 不正 `Sec-WebSocket-Version` のupgrade | 400で拒否。上流接続は残らない（§11では1本残留） |
| クライアント切断後 | 上流接続0本 |
| focused test | 3 files、22 tests passed |
| `npm run typecheck`／`npm run build:api` | 成功 |

コード確認: 下流のupgrade前は `request.raw` と `request.raw.socket` の `close`／`error` で保留upstreamを `terminate` し、成功時は `release` で監視を外して通常の切断処理へ引き渡す。監視は上流の接続確立後に付けるが、それ以前の下流切断は `destroyed` の確認で拾うため、取りこぼしは無い。

判定: §12の記述は実測と一致し、11.2-1は解決とする。新規の重要指摘は無い。11.2-2〜4は§14で解決を確認し、11.2-5の設計・設定課題は残る。§10.3の未完了項目（実broker、ACL、Serve、Fire実機、長時間試験）により、本番配備判定は引き続き **不可**。

## 14. 第4回再監査 — 低優先課題の修正確認（2026-10-15）

§11.2-2〜4に対する修正を実装し、回帰試験を実行した。

| 対象 | 修正 | 検証 |
| --- | --- | --- |
| Service Worker | `scripts/build-sw.mjs` がMQTT dynamic-import chunkを事前キャッシュ対象から除外 | `offline-build.test.ts` 5/5 |
| 旧状態／revision `0` | `createFileStore` が旧状態・未作成状態へ安定したstreamIdとrevision `0` metadataを提供 | `usage-delivery.test.ts` 移行試験を含む |
| heartbeat status | 通常heartbeatの`connected`通知をcallback前へ移動 | `usage-stream.test.ts` 通知順序試験 |

関連する focused test は `offline-build`、`usage-delivery`、`usage-stream`、`mqtt-gateway` の4 files、28 testsが成功した。型検査・buildの再確認後も、本番配備判定は実broker／ACL、Serve、Fire実機、長時間試験が未完了のため **不可** とする。残る低優先課題は§11.2-5だったが、実装課題は§16で対応した。

## 15. 第5回再監査 — §14の独立確認（2026-10-15）

§14で変わった `scripts/build-sw.mjs`、`services/aggregator/src/store.ts`、`apps/dashboard/src/data/usage-stream.ts` と関連試験を読み、修正者とは別に検証を再実行した。

| 検証 | 結果 |
| --- | --- |
| focused test（offline-build／usage-delivery／usage-stream／mqtt-gateway） | 4 files、28 tests passed |
| `npm run typecheck` | 成功 |
| `npm run build` | 成功。本体JS 374.31 kB（gzip 115.60 kB）、mqtt chunk 335.62 kB（gzip 99.90 kB）。事前キャッシュ59 assets |
| `dist/sw.js` のmqtt参照 | 0件（chunk自体は `dist/assets` に存在） |

コード確認:

- Service Workerはキャッシュに無い資産をネットワークから取得する（`cache.match(...) || fetch(...)`）。`?usageMqtt=1` の端末はオンライン時に通常どおりmqtt chunkを読み込める。
- Storeは旧状態・未作成状態でもrevision `0` のmetadataを返し、streamIdと時刻はプロセス内で固定する。最初の保存前にプロセスが再起動するとstreamIdは変わるが、端末は認証済みHTTPで新系列へ切り替えるため問題ない。
- `usage-stream.ts` は通常heartbeatの `connected` 通知を `onHeartbeat` より前に行う。Appが設定した `error` は上書きされない。

判定: §14の記述は実測と一致し、11.2-2〜4は解決とする。新規の重要指摘は無い。11.2-5の実装課題は§16で解決した。§10.3の未完了項目（実broker、ACL、Serve、Fire実機、長時間試験）により、本番配備判定は引き続き **不可**。

## 16. 第6回再監査 — 残りのコード課題（2026-10-15）

§15で残っていた実装可能な3課題を、計画の明記に合わせて修正した。

### 16.1 revision採番

- `ingestUsage` は保存された`usageValues`のうち、表示中の`dashboard.usage`が変化した場合だけ`usageRevision`と`publishedAt`を更新する。
- 表示中sourceのduplicateは`receivedAt`が変わるためrevision対象である。別sourceのacceptedが表示選択を変えない場合は、sourceの履歴・受信時刻だけを保存し、revisionを進めない。
- `usage-delivery.test.ts` に、表示中sourceのduplicateと非表示sourceのacceptedを分けて確認する試験を追加した。

### 16.2 publisher資格情報

- `services/aggregator/src/mqtt/credentials.ts` を追加し、`mqtt.credentialsFile` のJSONを読み込む。
- MQTT publisher有効時は資格情報ファイルを必須とし、通常ファイルかつgroup／otherのPOSIX権限ビットが無いことを検査する。内容はログへ出さない。
- `FIRE_MQTT_USERNAME`／`FIRE_MQTT_PASSWORD` はpublisher設定経路から削除した。実環境の資格情報ファイルはこの作業では作成・読取していない。
- `mqtt-credentials.test.ts` でowner-onlyファイルの読取と`0640`拒否を確認した。

### 16.3 gateway接続数

- `gateway.maxConnections` を追加し、既定8、最大256とした。予約中のupstreamも接続枠として数えるため、upstream接続待ちの並列upgradeで上限を迂回できない。
- 上限到達時はupgrade前に503と`Retry-After: 5`を返し、下流・上流のclose／errorまたはupstream接続失敗で枠を解放する。
- `mqtt-gateway.test.ts` で上限拒否と切断後の枠再利用を確認した。実Serve・Mosquitto経路の同時接続負荷は未確認である。

### 16.4 検証結果と判定

| 検証 | 結果 |
| --- | --- |
| revision／資格情報／gateway上限 focused test | 成功（追加分を含む） |
| `npm run typecheck` | 成功 |
| offline-build／実TCPソケット試験 | この環境では子プロセス／TCP listen制限により再実行時の失敗あり。既存の成功記録は§15・§13を参照 |
| 実broker、Mosquitto ACL、Tailscale Serve、Fire実機、24／72時間試験 | 未完了 |

コード上の残り3課題は解消したが、外部依存の受入証拠が無いため、本番配備判定は引き続き **不可** とする。

## 17. 第7回再監査 — §16の独立確認（2026-10-15）

§16で変わった `mqtt/credentials.ts`、`config.ts`、`start.ts`、`usage/ingest.ts`、`mqtt/gateway.ts`、`config.example.json`、`docs/deployment.md` と関連試験を読み、修正者とは別に検証を再実行した。

| 検証 | 結果 |
| --- | --- |
| focused test＋既存usage試験（mqtt-credentials／offline-build／usage-delivery／usage-stream／mqtt-gateway／usage／usage-replay／opencode-go-ingestion） | 8 files、51 tests passed |
| `npm run typecheck`／`npm run build:api` | 成功 |
| 実ソケット試験（§11と同じ手順） | 正常接続は双方向転送、不正upgrade後に上流残留なし、切断後の上流0本 |

### 17.1 解決を確認した点（11.2-5）

- 資格情報ファイル: `readMqttCredentials` は通常ファイル・owner-only（`mode & 0o077 === 0`）・厳格なJSON形式を検証し、エラー内容をログに出さない。計画§9.3に沿う。
- revision: 表示中のusageが変わった場合だけ進める。表示を変えない早期returnでは進めず、表示中sourceの重複受信で `receivedAt` が変わる場合は進む。計画§7.1と一致する。
- gateway接続数: 既定8・最大256、上限で503と `retry-after: 5`。確保した枠は、上流接続失敗、upgrade失敗（`dispose` → `onDisposed`）、上流なし、通常切断（`closeBoth`）のいずれでも一度だけ解放される。

### 17.2 新規の指摘

1. **【低〜中】資格情報ファイルの不備でHTTPS API全体が起動しない。** `prepareServer` 内の `readMqttCredentials` が例外を出すと `main` が終了コード1で終わる。ファイル欠落・0640などの権限・JSON不正のいずれでも、ダッシュボードAPIと収集受付が止まり、systemdが再起動を繰り返す。計画§5.2「MQTT停止によってusage受信APIを失敗させない」と食い違う。publisherだけ無効化して分類ログを出し起動を続けるか、fail-fastを意図した仕様として `deployment.md` と計画に明記し、有効化前のファイル確認手順を加える。
2. **【低】設定例に個人環境の絶対パス。** `config.example.json` の `credentialsFile` が `/home/otsune/.config/fire-dashboard/mqtt-credentials.json`。汎用的なパスか説明に置き換える。
3. **【低】同じrevisionの再送。** `server.ts` は受信が `older` 以外なら毎回 `notify()` を呼ぶため、revisionが進まない受信でも同じrevisionのstateを再publishする。payloadと `publishedAt` は同一で端末は重複として捨てるが、revision変化時だけ通知すればretained更新を減らせる。

### 17.3 判定

§16の記述は実測と一致し、11.2-5は解決とする。17.2-1は有効化前に方針を決める。§10.3の未完了項目（実broker、ACL、Serve、Fire実機、長時間試験）により、本番配備判定は引き続き **不可**。

## 18. 第8回再監査 — §17の指摘対応（2026-10-15）

§17.2で残った3点を実装・試験し、監査本文を現行コードへ更新した。

### 18.1 MQTT資格情報不備時の起動分離

- `loadMqttPublisherOptions` が資格情報ファイルを検証し、欠落・権限不備・JSON不正時はpublisher設定を`undefined`として返す。
- `prepareServer` はその場合もgatewayとHTTP APIを起動し、`Fire Dashboard MQTT publisher disabled: <分類コード>` の1行だけをstderrへ出す。資格情報の値や接続文字列は出力しない。
- `mqtt-credentials.test.ts` で資格情報欠落時にpublisherを無効化することを確認した。HTTP収集の継続は同テストの設定経路と既存API試験で確認し、実systemd再起動は未実施である。

### 18.2 設定例の汎用化

- `services/aggregator/config.example.json` の資格情報パスを個人ホームディレクトリから`/etc/fire-dashboard/mqtt-credentials.json`へ変更した。
- 実環境のパス、所有者、modeはGMKtecへ配備するときに確定する。本作業では資格情報ファイルを作成・読取していない。

### 18.3 同revision再publishの抑止

- usage POST前後の保存済みrevisionを比較し、revisionが変化した場合だけ`usagePublisher.notify()`を呼ぶ。
- 表示を変えないaccepted／duplicateでは同じstateをretained更新しない。表示中duplicateなどrevisionが進む受信は従来どおり通知する。
- `usage-delivery.test.ts` に表示revisionが変わらないaccepted受信でnotifyしない試験を追加した。

### 18.4 検証結果と判定

| 検証 | 結果 |
| --- | --- |
| §17対応focused test | 8 files、54 tests passed |
| `npm run typecheck` | 成功 |
| `npm run build`／`npm run build:api` | 成功 |
| 全体test | 679件中645 passed、34件失敗。既存weather／RSS／chime系でMQTT失敗なし |
| 実broker、Mosquitto ACL、Tailscale Serve、Fire実機、24／72時間試験 | 未完了 |

§17.2のコード・設定例上の指摘は解消した。実環境の資格情報配置と外部依存の受入証拠が無いため、本番配備判定は引き続き **不可** とする。

## 19. 第9回再監査 — §18の独立確認（2026-10-15）

§18で変わった `start.ts`、`server.ts`、`config.example.json`、`docs/deployment.md` と関連試験を読み、修正者とは別に検証を再実行した。

| 検証 | 結果 |
| --- | --- |
| focused test＋既存usage試験（mqtt-credentials／offline-build／usage-delivery／usage-stream／mqtt-gateway／usage／usage-replay／opencode-go-ingestion） | 8 files、54 tests passed |
| `npm run typecheck`／`npm run build:api` | 成功 |

### 19.1 解決を確認した点（17.2）

1. 資格情報の不備: `loadMqttPublisherOptions` が例外を受け止め、publisherだけを無効化して、資格情報を含まない分類コード（`mqtt_credentials_*`）をstderrへ出す。APIとHTTP usage収集は起動する。試験2件と `deployment.md` に反映済み。計画§5.2と一致する。
2. 設定例の個人パス: `/etc/fire-dashboard/mqtt-credentials.json` に置き換えた（19.2-1を参照）。
3. 同一revisionの再送: `server.ts` が受信前後のrevisionを比べ、変化時だけ `notify()` を呼ぶ。revisionは単調増加のため、自身の受信で進めば必ず差が出て、通知漏れは無い。並行受信で余分な通知が1回出得るが、内容が同一のため無害。試験で固定済み。

### 19.2 新規の指摘（いずれも低）

1. **設定例の `/etc/...` がGMKtecのuser層サービスと合わない。** サービスユーザーのファイルを `/etc` 下に作るにはsudoが要り、change-controlの承認対象になる。root所有の0600ではサービスから読めない。設定例はサービスユーザー配下の絶対パスのプレースホルダーとし、配置先は `deployment.md` で説明する。
2. **読めないファイルが `invalid` に分類される。** `stat` は通るが読めない（他ユーザー所有の0600など、`EACCES`）場合、分類が `mqtt_credentials_invalid` になる。実際は `unavailable`／`permissions` で、障害時の切り分けを誤らせる。
3. **publisher無効化に気づきにくい。** 通知はstderrの1行だけで、OnFailureは発火しない。gatewayが有効のままだと、端末はheartbeatを受けられず「停止検知」になるだけ。journal監視か、状態を確認する手段を用意する。
4. **POSTごとに読み込みが2回増える（無視できる程度）。** 受信前後の `store.inspect` により、ファイルStoreでは読み込みが2回増える。現在の約1回/分の受信では問題ない。ingestがrevision変化を返せば不要になる。

### 19.3 判定

§18の記述は実測と一致し、17.2の3件は解決とする。コード上の指摘は低優先のみとなった。§10.3の未完了項目（実broker、ACL、Serve、Fire実機、長時間試験）により、本番配備判定は引き続き **不可**。残りはPhase 0／3以降の実環境作業である。

## 20. 第10回再監査 — §19の低優先指摘対応（2026-10-15）

§19.2の4点をコード・設定例・配備説明へ反映し、focused testと全体testを再実行した。

### 20.1 設定例と資格情報エラー分類

- `services/aggregator/config.example.json` の資格情報パスを `/home/<service-user>/.config/fire-dashboard/mqtt-credentials.json` とし、userサービスの実行ユーザーへ置き換えるプレースホルダーにした。`/etc` 配下への配置は運用側のsudo変更として設定例から外した。
- `readMqttCredentials` は`stat`／`readFile`の`EACCES`・`EPERM`を `mqtt_credentials_permissions`、欠落・競合を `mqtt_credentials_unavailable` と分類する。JSON内容の不正だけを `mqtt_credentials_invalid` とする。

### 20.2 publisher状態の可視化

- 認証済みreader向け `GET /api/v1/mqtt-status` を追加し、`publisher`（`ready`／`disabled`）と秘密を含まない分類コードを返す。
- `prepareServer` は資格情報不備時もHTTP APIとusage収集を起動し、stderrとuserサービスのjournalに分類コードを残す。OnFailureやFire側のMQTT停止検知だけに依存しない確認経路を用意した。

### 20.3 ingest通知の単一更新化

- `createUsageIngestorWithRevision` が`status`と`revisionChanged`を同じstore updateから返すようにし、usage POSTごとの前後`store.inspect`を廃止した。
- `createUsageIngestor`の既存戻り値（`accepted`／`duplicate`／`older`）は互換維持し、revision変更結果の試験を追加した。

### 20.4 検証結果と判定

| 検証 | 結果 |
| --- | --- |
| §19対応focused test | 8 files、56 tests passed |
| `npm run typecheck` | 成功 |
| `npm run build`／`npm run build:api` | 成功 |
| 全体test | 681件中647 passed、34件失敗。既存weather／RSS／chime系でMQTT失敗なし |
| Prettier／`git diff --check` | 成功 |
| 実broker、Mosquitto ACL、Tailscale Serve、Fire実機、24／72時間試験 | 未完了 |

§19.2のコード・設定・可視化・二重読込の指摘は解消した。実環境の資格情報配置と外部依存の受入証拠が無いため、本番配備判定は引き続き **不可** とする。

## 21. 第11回再監査 — §20の独立確認（2026-10-15）

§20で変わった `credentials.ts`、`start.ts`、`server.ts`、`usage/ingest.ts`、`config.example.json`、`docs/deployment.md` と関連試験を読み、修正者とは別に検証を再実行した。

| 検証 | 結果 |
| --- | --- |
| focused test＋既存usage試験（mqtt-credentials／offline-build／usage-delivery／usage-stream／mqtt-gateway／usage／usage-replay／opencode-go-ingestion） | 8 files、56 tests passed |
| `npm run typecheck`／`npm run build:api` | 成功 |
| 全体テスト（`npx vitest run`、通常シェル） | 681件中34件失敗（8ファイル、647 passed）。失敗ファイルはHEAD `07cc993` の既存失敗と同じ8ファイル（weather-settings-api、cards、compact-dashboard、rss-focus-lifecycle、rss-resume、selected-chime、weather-catalog、weather-status-style）。MQTT関連の失敗なし |

### 21.1 解決を確認した点（19.2）

1. 設定例のパス: `/home/<service-user>/.config/fire-dashboard/mqtt-credentials.json` のプレースホルダーになり、sudo不要のuser層配置と一致する。
2. 読めないファイルの分類: `stat`／`readFile` のどちらでも、`EACCES`／`EPERM` は `mqtt_credentials_permissions`、それ以外は `unavailable`、JSON不正は `invalid` に分類する。
3. publisher無効化の可視化: `GET /api/v1/mqtt-status` が `ready`／`disabled` と理由の分類コードを返す。共通onRequestによりGETはreader認証が必要で、資格情報は含まない。`deployment.md` と試験に反映済み。
4. POSTごとの読み込み: ingestが `{status, revisionChanged}` を返し、`server.ts` は `revisionChanged` のときだけ通知する。受信前後の `store.inspect` は削除された。`revisionChanged` の判定式はrevisionを進める条件と同じで、表示を変えない早期returnでは `false` を返す。

### 21.2 新規の指摘（低）

1. **`mqtt-status` は設定状態であり、接続状態ではない。** `ready` は「資格情報を読めてpublisherを作成した」ことしか示さない。brokerへ届かない、PUBACKが返らない、再接続を繰り返す状態でも `ready` のままである。計画§13の監視項目（最終publish成功時刻、現在revision、MQTT接続状態、再接続回数、payload超過）はまだ観測できず、pull型のため自動通知にもならない。Phase 2のbroker統合試験までに、publisherの実状態をこのエンドポイントへ載せる。

### 21.3 判定

§20の記述は実測と一致し、19.2の4件は解決とする。前回までの低優先指摘はすべて解決し、コード上の課題は21.2-1のみとなった。§10.3の未完了項目（実broker、ACL、Serve、Fire実機、長時間試験）により、本番配備判定は引き続き **不可**。残りはPhase 0／3以降の実環境作業である。

## 22. 第12回再監査 — §21.2対応（2026-10-15）

§21.2の指摘に対応し、設定状態だけでなくpublisherの実行時状態を `GET /api/v1/mqtt-status` へ追加した。認証済みreaderは、次の `runtime` 項目を秘密情報なしで取得できる。

- `state`: `stopped`／`connecting`／`connected`／`reconnecting`
- `connected`: 現在のbroker接続状態
- `reconnectCount`: 初回接続後の再接続回数
- `currentRevision`: publisherが現在扱っているusage revision
- `lastPublishAt`／`lastPublishRevision`: stateまたはheartbeatの直近PUBACK成功時刻とstate revision
- `lastError`: `publish_error`／`ack_timeout`、または`null`
- `deliveryStatus`: `ok`／`too_large`

接続、切断、offline、再接続、state／heartbeatのPUBACK成功、publishエラー、ACK timeout、payload超過の各経路でruntime stateを更新する。古いstateのACKは現行revisionの`too_large`状態を`ok`へ戻さない。従来の `publisher`（`ready`／`disabled`）と`reason`は資格情報の設定状態を表すため、接続状態を示す`runtime`と分けて扱う。

### 22.1 検証結果

| 検証 | 結果 |
| --- | --- |
| §21.2対応focused test＋既存usage試験 | 8 files、57 tests passed。runtimeの接続状態、再接続回数、ACK timeout、最終publish、payload超過、古いACKの状態保護を含む |
| `npm run typecheck`／`npm run build`／`npm run build:api` | 成功。本体buildはMQTT chunkを分離し、Service Worker事前キャッシュは59 assetsでMQTT chunkを除外 |
| Prettier確認／`git diff --check` | Prettierは実装・監査文書に整形差分あり（自動整形は未適用）。`git diff --check`は成功 |
| 全体テスト（権限制約なしの通常シェル） | 682件中648 passed、34件失敗。失敗は既存weather／RSS／chime系8ファイルで、MQTT focused testの失敗なし |
| 実broker、Mosquitto ACL、Tailscale Serve、systemd、Fire実機、24／72時間試験 | 未完了 |

### 22.2 判定

§21.2-1のコード上の指摘は解消した。`mqtt-status` は設定状態と接続状態を別フィールドで返し、監視側が接続断、再接続増加、publish停止、ACK timeout、payload超過をpull型で確認できる。自動通知、実brokerでのPUBACK／LWT／retained順序、ACL・Serve経路、Fire実機の到着順と長時間安定性は未検証である。したがって、本番配備判定は引き続き **不可** とし、Phase 0／3以降の実環境作業を残タスクとする。

## 23. 第13回再監査 — §22の独立確認（2026-10-15）

§22で変わった `services/aggregator/src/mqtt/publisher.ts`、`server.ts`、`docs/deployment.md` と関連試験を読み、修正者とは別に検証を再実行した。

| 検証 | 結果 |
| --- | --- |
| focused test＋既存usage試験（mqtt-credentials／offline-build／usage-delivery／usage-stream／mqtt-gateway／usage／usage-replay／opencode-go-ingestion） | 8 files、57 tests passed |
| `npm run typecheck`／`npm run build:api` | 成功 |

### 23.1 解決を確認した点（21.2-1）

- publisherの `status()` と `GET /api/v1/mqtt-status` の `runtime` が、`state`（`stopped`／`connecting`／`connected`／`reconnecting`）、`connected`、`reconnectCount`、`currentRevision`、`lastPublishAt`、`lastPublishRevision`、`lastError`、`deliveryStatus` を返す。計画§13の監視項目（接続状態、再接続回数、現在revision、最終publish、payload超過）を一通り観測できる。publisher無効時は `runtime: null`。
- `deliveryStatus` を `ok` に戻すのは、最新revisionを配信できた場合だけになった。
- 再接続回数は初回接続を数えず、2回目以降の `connect()` だけを数える。

### 23.2 新規の指摘（いずれも低）

1. **`lastError` が消えない。** 値を入れるのは `failPublish()` だけで、その後の成功でも戻らず、時刻も無い。ACKタイムアウトが1回起きると、長期間正常でも `ack_timeout` のまま表示される。`deployment.md` は「直近エラー種別」と書くが、実際は「起動後に最後に起きたエラー」である。成功時に消すか、`lastErrorAt` を付ける。
2. **`lastPublishAt` と `lastPublishRevision` が同じ時点を指さない。** `lastPublishAt` はheartbeatのPUBACKでも更新されるが、`lastPublishRevision` はstateでしか更新されない。`deployment.md` は「最後にPUBACKを確認した時刻とrevision」と一組で説明している。state配信が止まっても時刻だけは毎分進み、配信できていると読み違え得る。stateとheartbeatで時刻を分けるか、意味を明記する。
3. **接続自体の失敗が `lastError` に残らない。** broker拒否や認証失敗（CONNACKエラー）では、`state` が `reconnecting`、`reconnectCount` が増えるだけで、`lastError` は `null` のまま。資格情報の誤りとbroker停止を区別できない。`connect_error` などの分類を加える。

### 23.3 判定

§22の記述は実測と一致し、21.2-1は解決とする。新たな指摘は観測項目の意味づけに関する低優先3件。§10.3の未完了項目（実broker、ACL、Serve、Fire実機、長時間試験）により、本番配備判定は引き続き **不可**。
