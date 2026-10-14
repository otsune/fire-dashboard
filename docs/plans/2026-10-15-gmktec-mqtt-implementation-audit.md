# GMKtec MQTT usage配信 実装監査記録

本書は `docs/plans/2026-10-14-gmktec-mqtt-usage-plan.md` に基づくMQTT実装の監査の正本。実装ソースと本番artifactの対応commitは `384acfe`（`feat: publish usage over MQTT`）で固定した。本書の監査追記はこのcommitより後の記録である。
いつ見るか: MQTT実装の変更・再配備前、Phase 2／3の試験記録、長期運用試験の更新時。
関連: 計画 `docs/plans/2026-10-14-gmktec-mqtt-usage-plan.md`、計画監査 `docs/plans/2026-10-15-gmktec-mqtt-usage-plan-audit.md`、配備 `docs/deployment.md`、`gmktec-change-control`、`gmktec-validation-and-evidence`。
状態: **コード修正・focused test、開発broker、GMKtec本番broker／API／Serve、Fire HD 10の短時間MQTT実機試験まで完了。Wi-Fi切替、Service Worker更新後の再接続、Fully Kiosk再起動後のStart URL保持も短時間確認済み。24／72時間連続運転、複数端末同時試験、実ネットワーク負荷は保留**（2026-10-15、Asia/Tokyo）。
範囲: §10以前は本番反映前の履歴である。§27で隔離broker、§29で本番Mosquitto／API／Serve／Fireを検証し、§31でdigest固定、台帳更新、artifact hashを追記した。現行artifactはcommit `384acfe` から生成し、API artifact SHA256 prefixは `2010671506a2358c`。

## 1. 結論

契約、永続 `streamId`／`usageRevision`、HTTP／MQTT共通の順序判定、MQTT publisher、reader認証付きWSS gateway、DashboardのHTTPフォールバックという骨格は実装されている。loopback broker URL、UTF-8 payload上限、Origin必須、`mqtt` サブプロトコル、上流のネゴシエーション確認後に下流101を返す順序もコードと実WebSocketで確認できる。

初回監査で指摘した端末単位のMQTT無効化、gatewayのbackpressure向き、再接続時のretained `offline`、`too_large` 時の古いpending state、publisherの接続状態可視化はコード修正済みで、native timerと高速接続raceの修正を含むfocused test 58件が成功している。MQTT opt-in端末だけがchunkを実行時に読み込み、HTTP専用端末のService Worker事前キャッシュからはMQTT chunkを除外した。

隔離brokerと本番brokerの双方でpublisher、ACL、gateway、MQTT.js reader、LWT、broker停止後の再接続を確認し、Fire HD 10ではTailscale Serve経由のWSS、CONNECT/CONNACK、SUBSCRIBE、retained state、heartbeat、HTTP fallbackを確認した。本番Mosquittoはdigest固定、台帳は更新済みである。Wi-Fi切替、Service Worker更新後の再接続、Fully Kiosk再起動後のStart URL保持は短時間試験で確認済みだが、24／72時間連続運転、複数表示端末同時試験、実ネットワーク負荷は残っているため、最終配備判定は **保留** とする。

## 2. 検証結果

### 2.1 成功した検証

| コマンド | 結果 | 証拠・範囲 |
| --- | --- | --- |
| `rtk npm run typecheck` | 成功 | TypeScript型検査完了 |
| `rtk npm run build` | 成功 | Vite build完了。本体JS 374.37 kB（gzip 115.64 kB）、mqtt chunk 335.62 kB（gzip 99.90 kB）。Service Worker事前キャッシュは59 assetsでMQTT chunkを除外 |
| `rtk npm run build:api` | 成功 | `mqtt`／`ws`を含むAPI bundle生成 |
| `rtk npm run build:collectors` | 成功 | collector bundle生成 |
| `rtk npm test -- --run tests/unit/mqtt-credentials.test.ts tests/unit/offline-build.test.ts tests/unit/usage-delivery.test.ts tests/unit/usage-stream.test.ts tests/integration/mqtt-gateway.test.ts tests/unit/usage.test.ts tests/unit/usage-replay.test.ts tests/unit/opencode-go-ingestion.test.ts` | 成功 | 8 files、58 tests passed。Service WorkerのMQTT chunk除外、表示状態に基づくrevision、資格情報ファイル権限と不備時のHTTP継続、資格情報読取権限エラーの分類、publisher状態API、publisher runtime状態（接続・再接続回数・最終publish・エラー・payload超過）、同revision再送抑止、旧状態のrevision 0 metadata、heartbeat status順序、publisherのoffline単独再接続、PUBACK timeout、LWT、gatewayの認証・Origin・subprotocol・双方向転送・接続数上限・実ソケットupgrade拒否cleanup、Fire向けnative timer・高速接続race対策を含む |
| `rtk git diff --check` | 成功 | 空白エラーなし |

### 2.2 全体テストの失敗

全体テストは実行環境によって結果が異なる。今回の確認では権限制約なしで `rtk npm test` を実行し、682件中34件失敗を観測した。失敗は既存のweather／RSS／chime系で、MQTT focused testの失敗は無い。sandbox内の再実行では子プロセス起動・TCP listenのEPERMが追加されるため、以下は権限制約なしの結果を採用する。

| 実行環境 | 結果 | 内訳 |
| --- | --- | --- |
| 今回の確認環境（権限制約なしの `rtk npm test`） | 682件中34件失敗（8ファイル、648 passed） | RSS関連（jsdomの `window.matchMedia` 不足など）、weather catalog、weather settings API、weather status、card、chime。MQTT focused testは成功 |
| focused test追加前の通常環境比較記録 | 652件中34件失敗（8ファイル） | RSS関連、weather catalog、weather settings API、weather status、card、chime。focused test追加後の同条件比較は未実施 |

focused test追加前の34件は、HEAD `07cc993` のクリーンなworktree（`git worktree` + 同じ `node_modules`）でも同じ8ファイル・34件が失敗したという比較記録がある。今回の環境ではその比較を再実行していないため、ここでは過去の証拠として扱う。全体テストの成功をMQTT実装の正しさの根拠にもしない。今回のMQTT固有focused testは58件である。

## 3. 計画との対応

| 計画の領域 | 実装 | 判定 |
| --- | --- | --- |
| Phase 1 契約・保存・順序 | `packages/contracts/src/usage-delivery.ts`、`store.ts`、`usage/ingest.ts` | 部分完了。基本契約とrevisionはあるが、旧状態移行・サイズ境界・バックアップ復元の受け入れ試験がない |
| Phase 2 publisher | `services/aggregator/src/mqtt/publisher.ts` | 本番brokerまで完了。QoS 1、retain、LWT、heartbeat、ACK期限、coalesce、offline単独時の再接続、`mqtt-status.runtime`をfocused test、隔離broker、本番broker停止／復旧で確認 |
| Phase 3 WSS認証・ACL | `services/aggregator/src/mqtt/gateway.ts`、`server.ts` | 本番Serveまで完了。実WebSocketのreader認証、Origin、subprotocol、ACL、上流確認、拒否時cleanup、loopback公開範囲を確認。実ネットワーク負荷は保留 |
| Phase 4 表示端末 | `usage-state.ts`、`usage-stream.ts`、`cache.ts`、`App.tsx` | 短時間実機まで完了。Fire HD 10／Fully KioskでWSS、retained state、heartbeat、native timer、HTTP fallback、Wi-Fi切替、SW更新後の再接続、Fully再起動後のStart URL保持を確認。24／72時間の安定性、複数端末同時試験は保留 |
| Phase 5 GMKtec段階導入 | 外部設定 | 短時間導入完了。broker、API config／credentials、user service、Serve経路を反映し、Quadletはdigest固定。台帳も更新済み。artifactはcommit `384acfe` に固定 |
| Phase 6 常設運用 | 運用・長時間試験 | 保留。24／72時間試験、複数端末、実ネットワーク負荷の証拠待ち |

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

実broker試験で確認した点:

- publisherのfocused testに加え、§27のMosquitto 2.1.2と§29の本番brokerでstate／availabilityのretain、heartbeatの非retain、PUBACK、強制終了時のLWT offline、broker停止後の `connect_error`／再接続／復旧を確認した。

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

実broker試験で確認した点:

- `injectWS` と注入上流に加え、§27で実WebSocketの `mqtt` upgrade、gateway経由のretained state、Origin／reader／subprotocol拒否を確認し、§29でTailscale Serve経路をFireから確認した。payload上限・backpressure・接続数上限の実ネットワーク負荷と長時間資源挙動は未確認である。

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
- MQTT clientをdynamic importし、buildでメインJS 374.37 kB（gzip 115.64 kB）、MQTT chunk 335.62 kB（gzip 99.90 kB）へ分割した。Service Workerの事前キャッシュにはMQTT chunkを含めない。

短時間の実機試験:

- §29でFully KioskのMQTT/WSS、retained availability／state、heartbeat、HTTP fallback、Fire WebViewのCSP回避を確認した。残るのはWi-Fi切替、Service Worker更新後の長時間安定性、複数タブ／複数端末の同時試験である。

### 4.5 設定・配備

- `configSchema` はpublisherとgatewayを独立した `enabled` で制御し、既定値は双方false。
- publisher／gatewayの接続先はloopback URLに限定する。
- publisher資格情報は `mqtt.credentialsFile` のowner-only JSONファイルからサーバー側だけで読む。ブラウザーへ渡していない。
- 変更された設定例と依存追加はリポジトリ内にある。

`docs/deployment.md` のpublisher／gateway独立制御、資格情報ファイル、gateway接続数上限の説明は実装に合わせて修正した。listener別ACLは隔離brokerと本番brokerの双方で確認し、host listenerのloopback限定も `ss` とLAN側陰性疎通で確認した。
`/api/v1/mqtt-status` の `publisher`／`reason` は資格情報の設定状態、`runtime` はbroker接続とpublishの実行状態を表す。runtimeはpull型の確認経路で、自動通知の代替ではない。

## 5. セキュリティ・公開範囲監査

コード上の防御:

- reader認証は既存Fastify onRequestを経由する。
- Originは欠落も拒否し、許可済みOriginとの完全一致を要求する。
- `Sec-WebSocket-Protocol` に `mqtt` がなければ拒否する。
- publisherのusername／passwordはowner-onlyのサーバー資格情報ファイルからのみ読む。
- MQTT／WSSのURLはloopbackに制限し、ブラウザーへpublisher write credentialを渡さない。
- payload byte上限をpublisher、gateway、Dashboardで持つ。

残る未証明の範囲:

- 24／72時間連続運転、Wi-Fi切替、Service Worker更新後の長時間安定性、複数端末同時接続。
- 実ネットワークでのgateway接続数上限・backpressure・長時間資源挙動。単一端末のServe経路、認証、Origin、subprotocol、loopback listenerは確認済み。
- 本番artifactのソースcommit固定。現在は未コミット作業ツリー由来で、§31にartifact hashと生成時刻を記録する。

これらは短時間の型検査・疎通だけでは証明できず、継続観測と複数端末の実測が必要である。

## 6. 外部変更と本番配備の状態

§28の承認後、次の本番変更を実施した。設定変更前のバックアップは `/home/otsune/.config/fire-dashboard/backups/mqtt-20261015-063022/`、Quadlet変更前のバックアップは `~/.config/containers/systemd/fire-dashboard-mosquitto.container.bak-20261015_065314` である。Tailscale Serveの設定自体は変更していない。

- rootless Podman Quadlet `fire-dashboard-mosquitto.service` を起動し、host listenerを `127.0.0.1:1883`／`127.0.0.1:9001` に限定した。
- `FIRE_CONFIG` と資格情報ファイルを本番パスへ配置し、`fire-dashboard-api.service` を再起動してpublisher／gatewayを有効化した。
- Fire HD 10のFully Kioskを `?usageMqtt=1` へ切り替え、Tailscale Serve経由WSSを確認した。
- QuadletはMosquitto digest固定へ更新し、`AutoUpdate=registry` を削除した。反映後もservice active、固定digest、API connectedを確認した。

本番artifactは未コミット作業ツリーから生成したため、設定rollbackだけではコードを元へ戻せない。API／frontend artifact hashとrollback方針は§31に記録する。ネットワーク露出を増やす変更ではなく、listenerをloopbackに限定した構成であるため、承認済みの変更ゲートと正負検証を適用した。

## 7. 切り戻し監査

端末側のURL opt-inを除去すればHTTP専用へ戻せる。§29でbroker停止中のHTTP health／画面保持と復旧後の再接続を確認した。通常の切り戻しは次の順序とする。

1. FireのURLから `?usageMqtt=1` を除去し、HTTP pollingへ戻す。
2. `systemctl --user stop fire-dashboard-mosquitto.service` でbrokerを停止する。APIを先に停止する必要はない。
3. `/home/otsune/.config/fire-dashboard/backups/mqtt-20261015-063022/config.json` を本番configへ原子的に戻し、`fire-dashboard-api.service` を再起動する。
4. Quadlet、Mosquitto設定、資格情報は削除せず、同じバックアップディレクトリへ退避してから状態を確認する。
5. コードを元版へ戻す必要がある場合は、§31のartifact hashに一致する保管済みartifactまたは対応commitを指定して再buildする。現在のhashだけではソースの完全復元を保証しない。

## 8. 推奨する修正・検証順序

1. 変更後のfocused tests、typecheck、各build、`git diff --check`を再実行する（§31で実施結果を更新する）。
2. 毎日の観測でAPI `mqtt-status`、broker unit、loopback listener、Fire footerを記録し、24／72時間連続運転の正負証拠を蓄積する。
3. Wi-Fi切替、Service Worker更新後の再接続、複数表示端末同時接続を段階的に実施する。失敗時はFire URLからqueryを除去してHTTPへ戻す。
4. source commit固定またはartifact保管を決め、次回配備時に未コミット作業ツリーからの生成を避ける。

## 9. 監査判定

| 判定項目 | 判定 |
| --- | --- |
| 実装コードが存在する | 合格 |
| 型検査・主要buildが通る | 合格（focused修正後に再確認） |
| 共通契約とrevision順序がある | 合格（表示用usage変化時のみ進行、旧移行安定化を反映） |
| 端末単位のMQTT opt-in・HTTP切り戻しがある | 合格（Fire HD 10で短時間確認） |
| gatewayの送信先backpressure・異常upgrade cleanup | 合格（実装、focused test、実TCPソケット、Serve経路を確認。長時間負荷は保留） |
| gatewayの接続数上限・切断後の枠再利用 | 合格（既定8／最大256、upgrade前503、切断後再利用を確認。実ネットワーク負荷は保留） |
| publisherの再接続offline・too_large pending処理 | 合格（focused test、本番broker停止／復旧で確認） |
| publisherのQoS／LWT／再接続がbrokerで実証された | 合格（隔離broker＋本番brokerで確認） |
| gatewayの認証・ACL・公開範囲が実機で実証された | 合格（reader認証、Origin、subprotocol、ACL、loopback／Serveの正負疎通） |
| FireのMQTT over WSS表示が実証された | 合格（Fire HD 10、retained state、heartbeat、footer、HTTP fallback） |
| 端末単位の段階導入・HTTP切り戻しが可能 | 合格（query除去とbroker停止時のHTTP継続を確認） |
| 24／72時間、Wi-Fi切替、複数端末、長時間負荷 | 保留 |
| 本番配備してよい | **短時間受入は合格、最終判定は保留** |

本書は実装と本番反映の監査記録であり、24／72時間の長期運用成功をまだ意味しない。

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
| `npm run typecheck`／`npm run build`／`npm run build:api` | 成功 |

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

## 24. 第14回再監査 — §23対応（2026-10-15）

§23のruntime観測項目に関する3件を修正し、§23と同じfocused test群で独立確認した。

### 24.1 修正を確認した点（23.2）

1. `lastError` に `lastErrorAt` を追加した。`lastError` は起動後に最後に観測したエラー種別、`lastErrorAt` はその発生時刻として意味を明示できる。接続失敗は `connect_error`、publish失敗は `publish_error`、PUBACK期限超過は `ack_timeout` に分類する。
2. stateとheartbeatの成功時刻を分離した。`lastPublishAt`／`lastPublishRevision` はusage stateのPUBACK成功だけを示し、`lastHeartbeatAt` はheartbeatのPUBACK成功を示す。heartbeatだけが継続してもstate配信時刻は進まない。
3. broker接続前のMQTT `error` イベントも `connect_error` として記録してから、既存の再接続処理へ進む。`state`／`connected`／`reconnectCount` と併読することで、接続失敗とpublish失敗を区別できる。

### 24.2 検証結果

| 検証 | 結果 |
| --- | --- |
| §23対応focused test＋既存usage試験 | 8 files、57 tests passed。state／heartbeat時刻分離、`lastErrorAt`、`connect_error`、再接続を含む |
| `npm run typecheck`／`npm run build`／`npm run build:api` | 成功 |
| 全体テスト（権限制約なしの通常シェル） | 682件中648 passed、34件失敗。既存weather／RSS／chime系8ファイルで、MQTT focused testの失敗なし |
| `git diff --check` | 成功 |
| 実broker、Mosquitto ACL、Tailscale Serve、systemd、Fire実機、24／72時間試験 | 未完了 |

### 24.3 判定

§23.2の3件は解消した。`mqtt-status.runtime` の時刻とエラー項目は、state配信、heartbeat、接続失敗、publish失敗、ACK timeoutを混同しない意味になった。Prettierの整形差分は既存実装・監査文書に残っており自動整形していない。実broker、ACL、Serve、Fire実機、長時間試験が未完了のため、本番配備判定は引き続き **不可**。

## 25. 第15回再監査 — §24の独立確認（2026-10-15）

§24で変わった `services/aggregator/src/mqtt/publisher.ts`、`docs/deployment.md`、`tests/unit/usage-delivery.test.ts` を読み、修正者とは別に検証を再実行した。導入済みmqtt.js 5.16.1の `build/lib/client.js` も確認した。

| 検証 | 結果 |
| --- | --- |
| focused test＋既存usage試験（mqtt-credentials／offline-build／usage-delivery／usage-stream／mqtt-gateway／usage／usage-replay／opencode-go-ingestion） | 8 files、57 tests passed（`lastHeartbeatAt`／`lastErrorAt`／`connect_error` の確認を含む） |
| `npm run typecheck`／`npm run build:api` | 成功 |

### 25.1 解決を確認した点（23.2）

1. `lastError`: `lastErrorAt` を追加し、種別と時刻を一組で残す。種別は成功後も残るが、時刻と `lastPublishAt` 等を比べれば回復済みかを判断できる。`deployment.md` の「直近エラー種別と時刻」は実装と一致する。
2. 時刻の対応: `lastPublishAt` はstateのPUBACKだけで更新し、heartbeatは新設の `lastHeartbeatAt` に分けた。`lastPublishAt` と `lastPublishRevision` は同じstateを指し、state配信が止まればheartbeatが続いても `lastPublishAt` は進まない。
3. 接続失敗: 接続前の `error` を `connect_error` として記録する。mqtt.js 5.16.1の `streamErrorHandler` は `code` を持つソケットエラー（`ECONNREFUSED` など）も `error` として通知するため、broker停止と認証失敗（CONNACKエラー）の両方が記録される。`error` で切り離した後の `close` は別接続のイベントとして無視され、再接続の予約は `reconnectTimer` により一つに保たれる。

### 25.2 判定

§24の記述は実測と一致し、23.2の3件は解決とする。新規の指摘は無く、コード上の監査指摘はすべて解決した。§10.3の未完了項目（実broker、ACL、Serve、Fire実機、長時間試験）により、本番配備判定は引き続き **不可**。残りはPhase 0／3以降の実環境作業である。

## 26. 第16回再監査 — Fire HD 10・Fully Kiosk表示とHTTPS経路（2026-10-15）

ユーザー報告「接続完了」を受け、GMKtecのホスト側ADBからFire HD 10を読み取り確認した。現行の表示端末はSilkではなくFully Kiosk Browserで、`gmktec.taila8b10.ts.net:8444`を開いている。端末設定、broker、gateway、Serve、systemdは変更していない。

| 確認 | 結果 |
| --- | --- |
| `adb devices -l` | `G001NW06319100XT device`。`model=KFTRPWI`、`product=trona`、USB接続 |
| 前面アプリ | `de.ozerov.fully/.FullyActivity`（Fully Kiosk Browser） |
| 端末OS | Android 9／SDK 28。端末のFire OSは7.3.3.1（既取得値） |
| Fireのネットワーク | Wi-Fi `192.168.2.151`、`gmktec.taila8b10.ts.net` は `100.106.71.32` へ名前解決。端末からのpingは成功（約20.7 ms） |
| Fireから `100.106.71.32:8444` | TCP接続成功 |
| Fireから `:18787`／`:9001` | 接続拒否。APIとWSS上流をloopbackに限定している現行構成と整合 |
| FireのTailscale VPN | `tun0` がUP、`100.122.116.122/32`。VPN DNSのsearch domainに `taila8b10.ts.net` がある |
| ホストから `https://gmktec.taila8b10.ts.net:8444/` | `curl -k` のTLS 1.3接続とHTTP/2応答を確認、`200`、dashboard HTML 659 bytes |
| ホストから `/api/v1/health` | `200`、`{"status":"ok","schemaVersion":1}` |
| ホストから `/api/v1/dashboard` | `200`、保存済みdashboard JSONを取得 |
| Fire Silkで `/` と `/api/v1/health` | DevToolsで複数タブを確認。root／healthの一部は `ERR_TIMED_OUT`、別rootタブは `readyState=complete` だがDOMが空で、レスポンス／resource entryなし |
| Fire Silkで `https://example.com/` | 本文を正常表示。Silk全体の描画不能ではない |
| Fire Silkで `https://100.106.71.32:8444/` | 「安全に接続できません／無効な応答」。IP直指定ではTLS入口まで到達し、証明書名不一致を解決すればよい段階まで進む |
| Fully Kioskの現在画面 | ダッシュボードを正常表示。時計、天気、Claude／Codex／Antigravity／OpenCode Go／Hermesカード、RSS、音声操作を確認。ヘッダーは「集約サービス接続済み」 |
| Fully KioskのMQTT表示 | フッターは「MQTT 未接続」。現行画面はHTTP表示として動作しているが、MQTT購読の有効化・WSS経路は未試験 |

Fully Kioskの実画面により、Fire実機のHTTPS表示（HTTP polling経路）は合格とする。画面フッターが「MQTT 未接続」のため、これはMQTT/WSSの合格を意味しない。Silkで観測した `ERR_TIMED_OUT` とMagicDNS迂回仮説は補助ブラウザーの所見であり、現行のFully Kiosk表示障害とは扱わない。`?usageMqtt=1` の購読試験はgatewayとbrokerが未配備のため実施していない。

### 26.1 判定と次の実機確認

- Phase 0の端末識別、DNS、ping、8444到達性は確認済み。Fully KioskのHTTP表示も確認済み。
- Phase 3の隔離Mosquitto ACL／WSS upgradeは§27で完了した。本番Mosquitto／Serve経路、Phase 4のFire実機MQTT購読、24／72時間試験は未完了。
- 次は本番変更のバックアップとrollbackを用意し、承認後に1台だけFully Kioskで `?usageMqtt=1` を明示してWSS接続、retained state、heartbeat、切断後のHTTP fallbackを確認する。SilkのMagicDNS問題はFully Kioskとは別の任意対応とする。

本番配備判定は引き続き **不可**。実broker、ACL、gateway配備、Fire本文描画、WSS到着順、長時間安定性の証拠が揃うまで有効化しない。

## 27. 第17回再監査 — 隔離Mosquitto・実gateway統合試験（2026-10-15）

§26の未完了項目のうち、Fire実機を変更しない開発broker／gateway経路をGMKtec上で検証した。本番の `fire-dashboard-api.service`、Tailscale Serve、Fire HD 10、既存の1883／9001 listenerは変更していない。検証環境は次のとおり。

- Mosquitto 2.1.2（`docker.io/library/eclipse-mosquitto:2`）を rootless Podman の一時コンテナ `fire-mqtt-listener-20261015` として起動した。
- ホスト側は `127.0.0.1:18883`（TCP MQTT）と `127.0.0.1:19001`（WebSocket）だけへport mappingした。rootless port mappingからコンテナへ到達させるため、コンテナ内部のlistener bindは `0.0.0.0` とした。これは本番の外部公開を意味せず、本番ではホスト側loopback、gatewayのloopback upstream、外部listener非公開を別々に確認する。
- ACLは匿名WebSocket用の先頭topic行（state／availability／heartbeatのreadのみ）と、認証済み `publisher`（write）／`reader`（readのみ）を分離した。admin topicには明示denyを置いた。Mosquitto公式のACL仕様どおり、匿名クライアントにはACLファイル先頭のtopic行が適用される（[ACL file plugin](https://mosquitto.org/documentation/plugins/acl-file/)）。
- 一時APIは `127.0.0.1:28787`、topic prefixは `fire-dashboard/v1/test`、reader認証は秘密を含まない試験用ヘッダー、broker資格情報は一時ファイルへ限定した。資格情報の内容は監査記録へ残さない。

### 27.1 実測結果

| 検証 | 結果 |
| --- | --- |
| ACLファイル読み込み | 不正行を意図的に入れた起動は失敗し、除去後はbrokerが起動した。ACLが実際に読み込まれていることを確認 |
| TCP publisher | 認証済み `publisher` が stateをQoS 1・retainでpublishできた |
| 認証済みreader ACL | `reader` は許可されたstate retainedを受信でき、admin topicは2秒待っても受信できなかった。reader publish後もstate retainedはpublisherの値から変化しなかった |
| 匿名WebSocket ACL | `mosquitto_sub --ws` がstate retainedを受信でき、匿名publish後もstate retainedは変化しなかった。WebSocket listenerからwrite権限を得られないことを確認 |
| gatewayの実WebSocket | gateway upstreamのbindを切り分け後、`ws` clientで下流が `101`、protocolが `mqtt` になった |
| gateway経由のMQTT.js | 許可Origin、reader認証、`mqtt` subprotocolで `fire-dashboard/v1/test/usage/state` のpayloadを `retain: true`、QoS 1で受信した。payloadはpublisherが送ったretain stateと一致した |
| 拒否条件 | 不許可OriginはHTTP 403、reader認証なしは401、`mqtt` 以外のsubprotocolは400で、いずれも101を返さなかった |
| LWT | 一時API publisherをSIGKILLで強制終了し、availability retainedが同じinstanceIdの `offline` へ変わることを確認した |
| broker停止／復旧 | broker停止中の `/api/v1/mqtt-status` は `state: reconnecting`、`connected: false`、`lastError: connect_error`。再起動後15秒の再取得では `state: connected`、`connected: true`、`reconnectCount: 4`、state／heartbeatのPUBACK時刻が更新された |
| broker復旧後のgateway | broker再起動後もgateway経由MQTT.js readerがrevision `0` の retained stateを受信した |

`mqtt-status` の一例（broker復旧後）は `publisher: ready`、`runtime.state: connected`、`deliveryStatus: ok` で、接続断の `connect_error` と発生時刻も残った。reader応答にusername、password、broker URLは含まれなかった。

### 27.2 判定と本番への含意

- Phase 2のpublisherについて、開発brokerでQoS／retain／PUBACK／LWT／停止復旧を受け入れ可能な証拠が揃った。
- Phase 3のgatewayについて、実WebSocket、reader認証、Origin、`mqtt` subprotocol、匿名read-only listener、ACL拒否、retained state転送を受け入れ可能な証拠が揃った。
- gatewayは上流へbroker資格情報を注入しないため、本番でもTCP publisher listenerと、loopbackからだけ到達できる匿名read-only WebSocket listenerを分離する必要がある。WebSocket listenerをTailscaleやLANへ直接公開してはならない。
- rootless Podmanのコンテナ内部bindとホストport mappingの挙動は実装環境依存である。本番採用時は `ss`、localhost疎通、LAN側の陰性疎通を取得し、loopback限定を証明する。
- Fire HD 10のFully Kioskで `?usageMqtt=1` を開く実機試験、Tailscale Serve経由のWSS、Service Worker更新、Wi-Fi切替、24／72時間連続試験は未完了である。

本番配備判定は **不可** のままとする。次の変更は、timestamped backup、rollback、systemd／Serveの正負疎通証拠を用意し、`gmktec-change-control` の承認ゲートを通してから実施する。

## 28. 第18回再監査 — Phase 5 本番反映ゲート（2026-10-15）

§27の開発broker統合後、GMKtecの本番状態を再取得した。artifact生成は完了したが、ライブサービスへはまだ反映していない。

| 確認 | 現在値 | 判定 |
| --- | --- | --- |
| `fire-dashboard-api.service` | user unitは `active/running`、`127.0.0.1:18787`。`FIRE_CONFIG=/home/otsune/.config/fire-dashboard/config.json` | 既存HTTP運用は継続 |
| 本番設定のMQTT | `mqtt.enabled`／`gateway.enabled` は未設定のためschema既定値false | MQTT未有効 |
| 本番資格情報 | `/home/otsune/.config/fire-dashboard/mqtt-credentials.json` は存在しない | publisher起動不可 |
| 本番broker | 1883／9001は未待受、PodmanにMosquittoコンテナなし | broker未配備 |
| Tailscale Serve | `:8444` tailnet-only、`/`はdashboard dist、`/api`は`127.0.0.1:18787/api`へproxy | 既存入口を維持可能 |
| Serve経由 `/api/v1/mqtt-status` | 現在は404 | 実行中APIは旧artifact |
| artifact | `npm run typecheck`、`npm run build`、`npm run build:api` 成功。生成 `dist/aggregator/start.mjs` はgateway／mqtt-statusを含む | 再起動後に反映可能 |
| Fire HD 10 | Fully Kioskで8444をHTTP表示中、MQTT opt-in未設定 | 実機MQTT試験待ち |

承認後に実行する変更を次の順序に固定する。

1. 対象設定、資格情報、quadlet／user unit、ACLを時刻付きバックアップし、rollbackコマンドを記録する。資格情報の値はログ・監査文書へ出さない。
2. rootless Podman Mosquittoを `127.0.0.1:1883`／`127.0.0.1:9001` のhost mappingで起動する。TCP listenerはpublisher認証・write ACL、WebSocket listenerはloopback到達のみ・匿名read-only ACLとする。
3. 本番 `config.json` に `mqtt.enabled=true`、`gateway.enabled=true`、loopback URL、credentials pathを追加し、最新artifactを読み込むuser serviceを再起動する。
4. `ss`、localhost疎通、LAN側の陰性疎通、`/api/v1/mqtt-status`、8444経由のWSS upgradeを正負両方で確認する。
5. Fire HD 10だけ `?usageMqtt=1` を付け、retained state、heartbeat、切断後HTTP fallbackを確認する。失敗時はqueryを除去してHTTPへ戻す。

本節の時点では承認・設定編集・秘密作成・service再起動・Serve変更・Fire URL変更を実施していない。`gmktec-change-control` の「ネットワーク露出を増やす変更は人間承認必須」により、本番配備判定は **不可** のままとする。

## 29. 第19回再監査 — 本番反映、Fire MQTT接続、端末race修正（2026-10-15）

ユーザー承認を受け、§28の手順を実行した。設定変更前に作成したバックアップは
`/home/otsune/.config/fire-dashboard/backups/mqtt-20261015-063022/` である。資格情報の値は
journal、監査記録、応答へ出していない。

### 29.1 本番配備

| 確認 | 実測結果 |
| --- | --- |
| broker | rootless Podman Quadlet `fire-dashboard-mosquitto.service`、`docker.io/library/eclipse-mosquitto:2`（Mosquitto 2.1.2）、active/running |
| host listener | `127.0.0.1:1883`（publisher認証TCP）、`127.0.0.1:9001`（匿名read-only WebSocket）。`ss`で外部アドレス待受なし |
| ACL | TCPは `publisher` の3 usage topic writeのみ。WebSocketは state／availability／heartbeat のreadのみ。host側 `100.106.71.32:1883/9001` は接続拒否 |
| 直接WebSocket ACL試験 | `127.0.0.1:9001/mqtt` の匿名clientが retained state（retain=true、QoS 1）を読めた。`fire-dashboard/v1/main/admin/audit-probe` publishは拒否された |
| publisher資格情報 | `/home/otsune/.config/fire-dashboard/mqtt-credentials.json` は owner-only mode 600。Mosquittoのhash fileはコンテナ権限降格のため mode 644で、平文パスワードを含まない |
| API config | `mqtt.enabled=true`、`gateway.enabled=true`、URLは `127.0.0.1`、topic prefixは `fire-dashboard/v1/main`。既存のweather/feed/preferredSourcesを保持 |
| API service | `fire-dashboard-api.service` は再起動後 active/running、`127.0.0.1:18787`。`/api/v1/health` は直接・Serve経由とも200 |
| runtime | Serve経由 `mqtt-status` は `publisher: ready`、`state: connected`、`connected: true`、`deliveryStatus: ok`。state／heartbeatのPUBACK時刻とrevisionを取得 |

Serve経路の実WebSocketは `wss://gmktec.taila8b10.ts.net:8444/api/v1/usage/stream` で101、MQTT protocol、retained state（retain=true、QoS 1）を受信した。直接APIの認証なしは401、Serve経由の不許可Originは403、loopback gatewayの誤subprotocolは400で、101を返さなかった。Tailscale Serveの8444は従来どおりtailnet-onlyで、Serve設定自体は変更していない。

brokerを一時停止した際、APIは `state: reconnecting`、`connected: false`、`lastError: connect_error` となり、HTTP healthは200を維持した。brokerを再起動すると、約20秒以内に `state: connected`、`reconnectCount` 増加、state／heartbeatのPUBACK更新へ復帰した。

### 29.2 Fire HD 10実機

ADB `G001NW06319100XT`（`KFTRPWI`、Android 9、Fully Kiosk 1.61.3）で、Fully Kioskを
`https://gmktec.taila8b10.ts.net:8444/?usageMqtt=1` へ遷移した。古いService Worker cacheを一度消去し、更新済みbundleを再取得した後、次を確認した。

- WebSocket 101、MQTT CONNECT/CONNACK、SUBSCRIBE、retained state、heartbeatのframeをFire WebView DevToolsで確認した。
- 画面footerは `Fire HD 10 Plus · 前面表示用 · MQTT 接続済み`。時計、天気、usageカード、RSSは従来どおり表示した。
- broker停止中もHTTP healthは200で、dashboard画面を保持した。broker復旧後、footerは `MQTT 接続済み` に戻った。

初回の本番bundleではFire footerが `MQTT 接続中` のままになった。DevToolsでCONNACK後の
`SecurityError: Failed to construct 'Worker'`（既存CSPがblob Workerを拒否）を特定したため、
ブラウザーMQTT clientに `timerVariant: "native"` を指定した。併せて、高速handshakeで
`connect` listener登録前に接続済みになるraceを `client.connected` の再照合で修正した。
focused suiteは8 files、58 tests passed（追加race／native timer試験を含む）。

### 29.3 判定と残タスク

Phase 0のFire識別・DNS・8444到達性、Phase 2 publisher、Phase 3 ACL／gateway、Phase 4の
Fire実機MQTT購読、Phase 5のloopback公開・Serve経路は合格とする。本番設定、broker、API、
Fire URLのrollbackには§29.1のバックアップと、`?usageMqtt=1` を除去してHTTP pollingへ戻す手順を使う。

24／72時間連続運転、Wi-Fi切替、Service Worker更新後の長時間安定性、複数表示端末の同時試験は
未完了である。したがって長期安定性を含む最終配備判定は **保留** とし、次回監査で連続運転の
証拠を追記する。

rollback時は、まず `systemctl --user stop fire-dashboard-mosquitto.service` でbrokerを停止し、
バックアップの `config.json` を元のパスへ原子的に戻して `fire-dashboard-api.service` を再起動する。
Quadlet、Mosquitto設定、資格情報は削除せず、同じバックアップディレクトリへ退避してから確認する。
FireはURLから `?usageMqtt=1` を除去してHTTP pollingへ戻す。

## 30. 第20回再監査 — §26〜§29の独立確認（2026-10-15）

§29の本番反映後、作業ツリーと稼働中のGMKtecを読み取りだけで再確認した。本番の設定、サービス、Fireは変更していない。

### 30.1 検証結果

| 確認 | 結果 |
| --- | --- |
| focused test＋既存usage試験（mqtt-credentials／offline-build／usage-delivery／usage-stream／mqtt-gateway／usage／usage-replay／opencode-go-ingestion） | 8 files、58 tests passed。§29の記載と一致 |
| `npm run typecheck`、`prettier --check usage-stream.ts` | 成功 |
| `timerVariant: "native"` | mqtt.js 5.16.1 の `get-timer.js` は、`auto` の場合にブラウザーで worker-timers を選ぶ。dashboardのCSP（`script-src 'self'`、`worker-src` なし）ではblob Workerを生成できないため、`native` 固定は妥当 |
| `client.connected` の再照合 | 実際の動的import経路では、`mqtt.connect()` からリスナー登録までがマイクロタスク内で完了するため、接続完了の通知が先に届くことはない。防御的な対策で、害はない。§29の「MQTT 接続中」で止まった原因はWorker生成失敗である |
| 待受 | `ss` で `127.0.0.1:1883`／`127.0.0.1:9001`（rootlessport）と `127.0.0.1:18787`（node）だけを確認 |
| サービス | `fire-dashboard-mosquitto.service` は active。`fire-dashboard-api.service` は 06:32:32 JST に再起動し、`node dist/aggregator/start.mjs` で稼働 |
| Mosquitto設定 | TCP 1883 は `allow_anonymous false`、パスワードファイル、publisher の3 topic write ACL。WebSocket 9001 は匿名で、state／availability／heartbeat の read だけを許可 |
| 設定ファイルの権限 | `~/.config/fire-dashboard/mosquitto/` 内のファイルは mode 644 だが、ディレクトリが mode 700 のため、他のユーザーからは読めない |

### 30.2 指摘

1. **【中】本書の冒頭と前半の記述が§29と食い違っている。** 次の箇所が本番反映前の「本番は変更していない」「未着手」のままで、§29の判定（短時間の実機試験は合格、長期安定性は保留）と一致しない。
   - L3の「対象は作業ツリー上の未コミット実装」
   - L6の状態「本番有効化不可」
   - L7の範囲「本番のMosquitto、gateway、systemd、FireのMQTT設定は変更していない」
   - §1の結論、§3のPhase 5「未着手」、§5の未証明の範囲、§6の配備状態、§8の推奨順序
2. **【中】本番で動いているのは、未コミットの作業ツリーからビルドした成果物である。**
   - 対象は、APIの `dist/aggregator/start.mjs` と画面側の `apps/dashboard/dist`。どの版のソースからビルドしたかを示すコミットやハッシュが記録されていない。
   - §29のrollbackは設定を戻す手順だけで、コードを前の版へ戻す手順がない。
   - 実装をコミットして配備したcommitを記録するか、成果物のsha256を記録する。
   - 本監査では `npm run build:api` を実行し、`start.mjs` を同じソースから作り直した。sha256の先頭16桁は `2010671506a2358c`。aggregatorのソースは06:32以降変わっていない。稼働中のプロセスはすでに読み込み済みのため影響しない。
3. **【中】ホスト台帳を更新していない（AGENTS.mdのself-healing docs規則に違反）。**
   - `~/docs/services.md` と `~/docs/notes/network-exposure-audit.md` に、次の記載がない。
     - `fire-dashboard-mosquitto.service`
     - 待受 `127.0.0.1:1883`／`127.0.0.1:9001`
     - 既存の `fire-dashboard-api.service`（`127.0.0.1:18787`）
   - 常駐サービスとネットワーク露出の正本へ、同じ変更として追記する。
4. **【低】Quadletのイメージがタグ固定のみで、自動更新の対象になっている。**
   - `Image=docker.io/library/eclipse-mosquitto:2` に `AutoUpdate=registry` が付いている。
   - 現在、`podman-auto-update.timer` はuser側が disabled、system側が enabled である。このrootlessコンテナは今は自動更新されない。
   - user側のtimerを有効にすると、確認しないままbrokerが更新され、`per_listener_settings` などのlistener別ACLの扱いが変わる恐れがある。
   - 現在のimage digest（`sha256:38c0da4f2ef84284d47b3b3eeea1cb3bdeabe81ee10caf0cd5c5ff61ee3ea408`）で固定するか、`AutoUpdate` を外す。

### 30.3 判定

コードに新しい指摘はない。運用面では、§29の判定（短時間の実機試験は合格、24／72時間連続運転は未完了のため最終判定は保留）は妥当である。

ただし、30.2の指摘1〜3が解消するまで、本番配備の記録・追跡性は不十分とする。次回監査では、連続運転の証拠とあわせて、これら3件の解消を確認する。

## 31. 第21回再監査 — 指摘1〜4の是正とdigest固定（2026-10-15）

§30の指摘に対して、承認済みの範囲で本番状態と記録を更新した。過去時点の記述（§28、§30.2）は履歴として残し、本節を最新状態の正本とする。

### 31.1 是正結果

| 指摘 | 対応 | 証拠 |
| --- | --- | --- |
| §30.2-1 冒頭・前半が本番反映前 | 冒頭、§1、§3、§4.4、§4.5、§5〜§9を、短時間の本番／Fire受入済み・長期試験保留へ更新 | 本番broker／API／Serve／Fireの実測は§29、現行判定は§31.3 |
| §30.2-2 未コミットartifactの追跡性 | 現行artifactのSHA256、生成時刻、未コミット作業ツリー由来であること、コードrollbackの制約を記録 | API `dist/aggregator/start.mjs` prefix `2010671506a2358c`、詳細は§31.2 |
| §30.2-3 ホスト台帳未更新 | `~/docs/services.md` と `~/docs/notes/network-exposure-audit.md` にunit、listener、API→broker→Serve→Fireの関係、正負疎通を追記 | 両台帳の最終更新は2026-10-15。変更前バックアップを作成済み |
| §30.2-4 Quadletタグ／自動更新 | Quadletの `Image=` を検証済みdigestへ固定し、`AutoUpdate=registry` を削除。daemon-reload後にbrokerを再起動 | fixed digest、active unit、実コンテナImageName、listenerを再確認 |

### 31.2 artifactと本番runtimeの対応

本番APIは `node dist/aggregator/start.mjs` として稼働し、画面artifactは `apps/dashboard/dist` からServeされる。次のSHA256は2026-10-15 06:56 JSTの再build後に取得した。ソースcommitは未固定のため、hashはこの生成物の同一性を示すが、ソース完全復元を保証しない。

| artifact | SHA256 |
| --- | --- |
| `dist/aggregator/start.mjs` | `2010671506a2358c0a3435ef005157ab9309a944c26bbeb27a843e9a6ad1003d` |
| `apps/dashboard/dist/index.html` | `478f206a199369973135d86e0f51b24aaff5ad5cd2248984d24e6ef8d642c6f4` |
| `apps/dashboard/dist/assets/index-DJEd_oPD.js` | `81b31b857a9fbd4e56ebc441dea9d2f65331e2e1f33cf9266e82dfe8087fcbe4` |
| `apps/dashboard/dist/assets/mqtt.esm-B8uQR_Hq.js` | `3c1e32d61041d718fe3d6fbf25024204ffef1ebba39e3d080080935b17651cba` |

実測runtimeは次のとおり。

- `fire-dashboard-mosquitto.service`: `active/running`、`ImageName=docker.io/library/eclipse-mosquitto@sha256:38c0da4f2ef84284d47b3b3eeea1cb3bdeabe81ee10caf0cd5c5ff61ee3ea408`。
- `fire-dashboard-api.service`: `active/running`、`127.0.0.1:18787`。reader相当の `GET /api/v1/mqtt-status` は `state=connected`、`connected=true`、`deliveryStatus=ok`。
- `ss`: `127.0.0.1:1883`、`127.0.0.1:9001`、`127.0.0.1:18787` のみ。`100.106.71.32` のbroker／API直結は拒否または000、未認証statusは401。
- 匿名WebSocket reader: `ws://127.0.0.1:9001/mqtt` から `fire-dashboard/v1/main/usage/state` の retained payload を `retain=true`、QoS 1、2998 bytesで受信。publisher write listenerとreader listenerの分離を再確認した。
- broker再起動後もAPIは再接続し、Fire footerは `MQTT 接続済み` へ復帰した。過去の `lastError=connect_error` は停止試験の履歴としてruntimeへ残る。

### 31.3 現在の判定と残タスク

短時間の本番導入、loopback公開、ACL、Tailscale Serve経由WSS、Fire HD 10実機購読、HTTP fallbackは合格。最終判定は次の残タスクが終わるまで **保留** とする。

1. 24／72時間連続運転で、`mqtt-status` の `connected`、PUBACK時刻、Fire footer、API healthを定点記録する。
2. FireのWi-Fi切替、Service Worker更新後の再接続、Fully Kiosk再起動を確認する。
3. 2台以上の表示端末を同時に `?usageMqtt=1` で接続し、gateway接続数・broker負荷・各端末のrevision収束を確認する。
4. 長期試験後にartifactをcommitまたは保管済みreleaseへ固定し、未コミット作業ツリー由来の本番配備を解消する。

rollback時は、まずFireのqueryを除去し、`systemctl --user stop fire-dashboard-mosquitto.service`、設定バックアップ復元、API再起動の順に行う。Quadletを元へ戻す場合は `cp -a ~/.config/containers/systemd/fire-dashboard-mosquitto.container.bak-20261015_065314 ~/.config/containers/systemd/fire-dashboard-mosquitto.container` の後に `systemctl --user daemon-reload` とbroker再起動を実施する。

## 32. 第22回再監査 — §31の独立確認（2026-10-15）

§30以降、実装コードに変更はない。変更は本書の§31だけである。そのため、focused testは再実行していない（前回は8 files、58 tests passed）。§31の是正内容は、GMKtecを読み取りだけで照合した。本番設定、サービス、Fireは変更していない。

### 32.1 §30.2指摘の照合

| 指摘 | 照合 | 判定 |
| --- | --- | --- |
| 1 冒頭・前半が本番反映前のまま | 先頭7行、§1、§3を確認。Phase 5は「完了」、Phase 6は「保留」。§10より前に「未着手」「変更していない」「有効化不可」は残っていない | 解消 |
| 2 本番artifactを追跡できない | 4ファイルのSHA256を再計算し、§31.2の表と一致した（`start.mjs` `2010671506a2358c`、`index.html` `478f206a19936997`、`index-DJEd_oPD.js` `81b31b857a9fbd4e`、`mqtt.esm-B8uQR_Hq.js` `3c1e32d61041d718`）。冒頭L3／L7に、artifactが未コミットの作業ツリー由来であることを明記している | 記録としては解消 |
| 3 ホスト台帳の未更新 | `~/docs/services.md` に構成図、unit表、依存関係、digest固定を記載し、最終更新を2026-10-15とした。`~/docs/notes/network-exposure-audit.md` にはloopback限定、陽性／陰性証拠、unit表を記載した。両台帳とも変更前のバックアップ（`.bak-20261015_065429`）がある | 解消 |
| 4 Quadletのタグ固定・自動更新 | `Image=` は `eclipse-mosquitto@sha256:38c0da4f…` に固定され、`AutoUpdate` 行はない。`podman inspect` のImageNameも同じdigestで、状態は `running`。変更前のバックアップ（`.bak-20261015_065314`）がある | 解消 |

稼働状況は次のとおり。

- `fire-dashboard-mosquitto.service` と `fire-dashboard-api.service` はどちらも active。
- reader相当の `mqtt-status` は `state=connected`、`connected=true`、`deliveryStatus=ok`、`currentRevision=61`。
- stateの最終PUBACKは 2026-10-14T22:02:53Z、heartbeatの最終PUBACKは 22:03:33Z で、どちらも更新が続いている。
- `lastError=connect_error`（21:41:44Z）は、§31に記録したbroker再起動試験の履歴である。

### 32.2 新規指摘

1. **【低】§31.2のハッシュは、稼働中のAPIが読み込んだファイルのものではない。**
   - APIは 06:32:32 JST に起動した。§31.2のハッシュは、06:56 JST の再build（§30の監査時）後のファイルから取った。
   - aggregatorのソースは変わっておらず、esbuildの出力は決定的なので、中身は同一とみられる。ただし、厳密にはこのハッシュは「次に再起動したときに読み込まれるartifact」を示す。§31.2にその旨を書くか、次回の再起動時にハッシュを取り直す。
   - dashboardのartifactも同じである。FireにService Workerの古いcacheが残っていれば、別の版が表示されている可能性がある。
2. **【低】§3と§31.3の表現が食い違っている。**
   - §3はPhase 5を「完了」としているが、§31.3の残タスク4には、未コミットの作業ツリーからの本番配備を解消することが残っている。
   - Phase 5を「完了（artifactのcommit固定は§31.3-4）」とするなど、表現をそろえる。

### 32.3 判定

コードに新しい指摘はない。§30.2の指摘1〜4は、記録・設定ともに解消した。

最終判定は **保留** のままとする。次の4点が残っている。

- 24／72時間の連続運転
- Wi-Fi切替とService Worker更新後の再接続
- 複数端末の同時試験
- artifactのcommit固定

## 33. 第23回再監査 — Fully Kiosk Start URL永続化とruntime再照合（2026-10-15）

§32の残タスクを進め、Fire HD 10のFully Kiosk設定を変更して再起動試験を行った。設定変更は
Fire実機のFully Kiosk UI（Web Content Settings → Start URL）だけで、GMKtecのネットワーク設定・
Serve・broker・API設定は変更していない。

### 33.1 稼働artifactとサービスの再照合

| 確認 | 実測結果 |
| --- | --- |
| API service | `fire-dashboard-api.service` は `active/running`、PID `676804`、起動 `2026-10-15 07:08:47 JST`。実行形式は `node dist/aggregator/start.mjs` |
| source / artifact固定 | commit `384acfe`（`feat: publish usage over MQTT`）へ実装・focused test・配備ドキュメントを固定。作業ツリー由来の未コミットartifactという§32.2-1の状態を解消 |
| API artifact | `dist/aggregator/start.mjs` SHA256 `2010671506a2358c0a3435ef005157ab9309a944c26bbeb27a843e9a6ad1003d`。§31.2の記録と一致し、§32.2-1の「次回再起動後のartifact」という曖昧さを解消した |
| Dashboard artifact | `index.html`、本体JS、MQTT chunk、`sw.js` のSHA256は§31.2の記録と一致。FireのService Worker取得物も `sw.js` として制御中 |
| runtime `mqtt-status` | Fire同一オリジンから `state=connected`、`connected=true`、`deliveryStatus=ok`、`currentRevision=107`、state PUBACK `2026-10-14T22:27:15.754Z`、heartbeat PUBACK `2026-10-14T22:26:48.176Z`、エラーなしを取得 |
| 検証状態 | commit後にfocused 8 files／58 tests、typecheck、Dashboard/API/collector build、`git diff --check` が成功。今回の端末設定変更による実装ソース差分はない |

### 33.2 Fully Kiosk再起動後のMQTT opt-in

ADB端末 `G001NW06319100XT`（Fire HD 10、Fully Kiosk `1.61.3-play`）で、まず従来のStart URLのまま
Fullyを再起動した。このときページは `https://gmktec.taila8b10.ts.net:8444/`（queryなし）へ戻り、
footerは `MQTT 未接続` になった。これは§32.2で指摘した、手動遷移だけではStart URLが永続化されない
事象の再現である。

Fullyの **Web Content Settings → Start URL** を次へ変更して保存した。

```text
https://gmktec.taila8b10.ts.net:8444/?usageMqtt=1
```

保存直後にURL、footer、Service Worker制御を確認し、さらに `am force-stop` → Fully起動 → 15秒待機の
再試験を行った。再起動後のWebView（PID `2111`）は次を返した。

| 確認 | 実測結果 |
| --- | --- |
| 表示URL | `https://gmktec.taila8b10.ts.net:8444/?usageMqtt=1`。queryが保持された |
| MQTT footer | `Fire HD 10 Plus · 前面表示用 · MQTT 接続済み` |
| Service Worker | `navigator.serviceWorker.controller.scriptURL` は `https://gmktec.taila8b10.ts.net:8444/sw.js` |
| 画面状態 | usage、weather、RSSを表示し、MQTT retained state／heartbeat受信後の通常画面を維持 |

これにより、Fully KioskのStart URL未設定が原因だった再起動後のopt-in消失は解消した。端末側の設定を
queryなしへ戻せば、従来どおりHTTP専用端末として動作する設計は維持される。Remote Adminの有効化や
外部ポート公開は行っていない。

### 33.3 現在の判定と残タスク

短時間の本番導入、Fire MQTT購読、Wi-Fi切替、Service Worker更新後の再接続、Fully Kiosk再起動後の
Start URL保持は確認済みとする。最終配備判定は次の残タスクが終わるまで **保留** とする。

1. 24／72時間連続運転で `mqtt-status` の接続状態、PUBACK時刻、Fire footer、API healthを定点記録する。
2. 2台以上の表示端末を同時に `?usageMqtt=1` で接続し、gateway接続数・broker負荷・revision収束を確認する。
3. 実ネットワーク負荷を含む長時間安定性を確認する。

## 34. 第24回再監査 — 72時間観測開始と並行reader試験（2026-10-15）

§33.3の残タスクを進め、Fire実機を含むruntime観測を開始した。観測プロセスはセッション `20454`、
5分間隔、72時間上限で、`/tmp/fire-dashboard-mqtt-observations-20261015.jsonl` に追記する。
各サンプルはFire WebView同一オリジンから取得し、URL、MQTT footer、Service Worker controller、
`mqtt-status`、healthを同じ時点で記録する。開始直後の有効なサンプルは次のとおりである。

| 確認 | 実測結果 |
| --- | --- |
| Fire URL | `https://gmktec.taila8b10.ts.net:8444/?usageMqtt=1` |
| Fire footer / Service Worker | `MQTT 接続済み`、controllerは `https://gmktec.taila8b10.ts.net:8444/sw.js` |
| `mqtt-status` | `state=connected`、`connected=true`、`deliveryStatus=ok`、`currentRevision=110`、`reconnectCount=0`、エラーなし |
| API health | `{"status":"ok","schemaVersion":1}` |

同時接続の確認として、母艦から2つのraw MQTT readerをServe経由で並行接続し、CONNECT、SUBSCRIBE、
retained state受信まで行った。reader A/Bともに接続成功、同じ`streamId`、revision `114`、payload
2999 bytesを受信し、revision／streamの一致を確認した。これはgatewayの複数接続・revision収束を示す
補助試験であり、物理的な表示端末2台の同時試験ではない。

最終配備判定は引き続き **保留** とする。72時間観測が24時間・72時間の各基準を満たすまで待機し、
別の物理表示端末を用意できた時点で同じreader収束試験を実端末2台でも行う。実ネットワーク負荷を
含む長時間安定性も観測ログで判定する。

## 35. 第25回再監査 — 4reader負荷試験と試験後のruntime確認（2026-10-15）

§34の並行reader確認を補強するため、母艦からTailscale Serve経由のWebSocket readerを4本、
60秒間同時接続した。試験スクリプトは `/tmp/fire-dashboard-mqtt-load-probe.mjs` で、各readerが
MQTT CONNECT、state topicへのSUBSCRIBE、retained state受信、20秒間隔のPING／PONGを行う。

### 35.1 試験結果

| 確認 | 実測結果 |
| --- | --- |
| 接続数・時間 | 4 reader、60秒、`/api/v1/usage/stream`（Serve経由） |
| CONNECT／retained state | 4／4が接続成功し、4／4が `fire-dashboard/v1/main/usage/state` のretained stateを受信 |
| keepalive | 各readerがPING応答を2回受信。試験中のエラーなし |
| 試験後 | 4 readerは正常切断。API、Mosquitto、Fire HD 10は試験後も稼働継続 |

Mosquittoのjournalには、07:31:56 JSTに `audit-load-1`〜`audit-load-4` の4クライアントが
port 9001へ接続し、07:33:26 JSTに4クライアントすべてが `connection closed by client` で
切断された記録がある。これはreader側の試験終了による切断であり、broker障害による切断ではない。
この試験は同一母艦からの4接続であり、物理表示端末4台の試験ではない。

### 35.2 試験後のruntime

- `fire-dashboard-api.service`: `active/running`、PID `676804`、`node dist/aggregator/start.mjs`。
- `fire-dashboard-mosquitto.service`: `active/running`、コンテナPID `664313`。listenerは
  `127.0.0.1:1883`／`127.0.0.1:9001`のまま。
- Fire HD 10はFully KioskのStart URLに `?usageMqtt=1` を保持し、MQTT接続済み表示を継続。
- 4reader試験終了後もAPI healthは `status=ok`、publisherは接続状態を維持し、最新確認の
  `currentRevision` は `118`。state／heartbeatのPUBACK更新も継続している。

### 35.3 判定と残タスク

4reader負荷試験は合格とする。ただし、同一母艦からのreader試験は物理的な複数表示端末の代替には
ならない。最終配備判定は **保留** のままとし、次を残す。

1. `/tmp/fire-dashboard-mqtt-observations-20261015.jsonl` の24時間・72時間時点の定点記録を確認する。
2. 可能な場合は2台目のFire等を `?usageMqtt=1` で接続し、両端末のrevision／streamId収束を確認する。
3. 観測終了後に、連続運転・複数端末・実ネットワーク負荷を含む最終判定を更新する。

## 36. 第26回再監査 — 長期試験のリソース基準値（2026-10-15）

Phase 6の「CPU・メモリ・通信量・再接続数を記録し、導入前と比較する」という条件に備え、
Fire定点観測を止めずにGMKtec側の読み取り専用スナップショットを取得した。取得時刻は
2026-10-15 07:36:41 JSTである。

| 対象 | 基準値 |
| --- | --- |
| `fire-dashboard-api.service` | `active/running`、PID `676804`、`NRestarts=0`、`MemoryCurrent=65,130,496` bytes、`CPUUsageNSec=2,238,180,000` |
| `fire-dashboard-mosquitto.service` | `active/running`、PID `664313`、`NRestarts=0`、`MemoryCurrent=11,067,392` bytes、`CPUUsageNSec=2,374,461,000` |
| Mosquittoコンテナ瞬時値 | CPU `0.08%`、memory `2.269MB / 8.058GB`、NetIO `770B / 430B`、PIDs `1` |
| loopback WS listener | `127.0.0.1:9001`に確立済み接続2本。接続数の24／72時間差分比較に使う |
| インターフェース累積値 | `enp3s0` RX `117,185,257,494`／TX `49,083,094,385` bytes、`tailscale0` RX `15,152,688`／TX `105,948,114` bytes |

認証なしの `GET /api/v1/health` は `401` となった。これは認証境界の負の検証であり、正のhealth値は
同時刻のFire同一オリジン観測（§34／§35のJSONL）で `status=ok` を確認する。API／Mosquittoの
`NRestarts=0` はこのスナップショット時点の値であり、観測終了時に再取得して比較する。

この基準値だけでは長期安定性は証明できない。24時間・72時間時点で同じ項目を再取得し、CPU／
メモリ／インターフェース通信量／接続数／`reconnectCount`の差分を記録する。GMKtec全体の再起動試験は
運用影響を伴うため、別途承認された実施機会がない限り未実施として扱う。

## 37. 第27回再監査 — GMKtec上のClaude usage計測を有効化（2026-10-15）

「Claudeの計測をgmktecで」の残作業として、GMKtecで実行中のClaude Code statuslineからusageを
収集し、既存のHTTPS collector、集約API、MQTT配信へ接続した。Claude Code自体のAPI呼び出しや
プロンプト取得は追加していない。

### 37.1 変更内容

| 対象 | 変更 |
| --- | --- |
| Claude Code | `/home/otsune/.claude/statusline-command.sh` の既存表示出力を維持し、stdinのrate limit JSONを `dist/collectors/claude-statusline.mjs` へ非同期で渡す処理を末尾に追加 |
| snapshot | `/home/otsune/.local/state/fire-dashboard/claude-snapshot.json`、`FIRE_SOURCE_ALIAS=gmktec` |
| 送信 | 新規 user unit `fire-dashboard-claude-sender.service`。15秒間隔でsnapshotを読み、変化時または60秒heartbeatで `https://gmktec.taila8b10.ts.net:8444/api/v1/usage` へ送信 |
| API表示選択 | `~/.config/fire-dashboard/config.json` の `preferredSources.claude` を `["gmktec","win-desktop"]` に更新。同一アカウントを合算しない |
| バックアップ | `~/.claude/statusline-command.sh.bak-20261015_074210`、`~/.claude/settings.json.bak-20261015_073949`、`~/.config/fire-dashboard/config.json.bak-20261015_073949` |

`~/.claude/settings.json` のstatusline commandは既存の `~/.claude/statusline-command.sh` に戻しているため、
既存セッションと新規セッションの両方が同じ拡張済みスクリプトを使う。スクリプト構文は `sh -n` で確認した。

### 37.2 実アカウント入力による受入

固定JSONでの表示回帰試験では、既存出力 `Sonnet ctx 42% ... 5h 17% wk 31%` を維持し、
snapshotにrate limit 2枠だけが保存されることを確認した。fixtureは本番送信前に退避し、実アカウントの
Claudeセッションから生成されたsnapshotとは混在させていない。

実セッションからは次を取得した。

| 確認 | 実測結果 |
| --- | --- |
| Claude CLI | `/home/otsune/.local/bin/claude`、version `2.1.300` |
| snapshot | `provider=claude`、`status=ok`、`sourceAlias=gmktec`、`sequence=2`、capturedAt `2026-10-14T22:42:21.433Z` |
| API受信 | GMKtec正本stateで `receivedAt=2026-10-14T22:42:33.936Z`、`usageRevision=137`、`errorCode=null` |
| sender | `fire-dashboard-claude-sender.service` は `enabled`／`active(running)`、PID `704040`、journalに送信エラーなし |
| API | `fire-dashboard-api.service` は設定反映後にPID `704002`で `active(running)`、`NRestarts=0` |
| MQTT／Fire | Fire同一オリジンでClaude値、`mqtt connected`、`deliveryStatus=ok`、health `ok` を同一サンプル（22:43:24Z）で確認。MQTT revision `137` |

Claude値を含む追加定点観測をセッション `7382`、5分間隔、72時間上限で開始した。ログは
`/tmp/fire-dashboard-mqtt-claude-observations-20261015.jsonl` へ保存し、URL、Service Worker、MQTT状態、
API health、Claudeのstatus／sourceAlias／capturedAt／receivedAt／bucketsを同時に記録する。既存セッション
`20454` は通常のMQTT観測として継続している。

### 37.3 判定と残タスク

GMKtecでのClaude計測、API受信、MQTT配信までの短時間受入は合格とする。残りは次のとおり。

1. セッション `7382` の24時間・72時間サンプルでClaude値、MQTT接続、health、再接続数の継続性を確認する。
2. 既存24／72時間MQTT観測とリソース基準値を含め、API設定反映後の長期安定性を最終判定する。
3. Claude Codeのstatuslineが再起動・更新後も計測処理を維持することを、次回の通常セッション開始時に再確認する。

最終配備判定は長期観測が終わるまで **保留** とする。

## 38. 第28回再監査 — ホスト通信量観測のNIC列解析を修正（2026-10-15）

§36の長期リソース観測を確認したところ、`/proc/net/dev` の正規表現がTX列を正しく取得せず、
`lo`、`enp3s0`、`tailscale0` の `txBytes` がすべて `0` になる記録不具合を見つけた。サービスの
動作不良ではなく、観測スクリプト `/tmp/fire-dashboard-mqtt-host-monitor.mjs` のパーサー不具合である。

### 38.1 是正

インターフェース名のコロン以後を空白区切りにし、Linuxの `/proc/net/dev` の定義どおり
`fields[0]` をRX、`fields[8]`をTXとして読む修正版を `/tmp/fire-dashboard-mqtt-host-monitor-v2.mjs`
に作成した。旧セッション `27951` は停止し、修正版を読み取り専用の長期観測セッション `79562`
として、`/tmp/fire-dashboard-mqtt-host-observations-20261015-v3.jsonl` に5分間隔・72時間上限で
開始した。API、Claude sender、Mosquittoの再起動、設定編集、ネットワーク公開変更は行っていない。

### 38.2 修正版の初回証拠

観測時刻は `2026-10-14T22:47:06.303Z`（JST 2026-10-15 07:47:06）である。

| 確認 | 実測結果 |
| --- | --- |
| `fire-dashboard-api.service` | `active/running`、PID `704002`、`NRestarts=0`、`MemoryCurrent=63,270,912` bytes |
| `fire-dashboard-claude-sender.service` | `active/running`、PID `704040`、`NRestarts=0`、`MemoryCurrent=28,557,312` bytes |
| MQTT reader接続 | `127.0.0.1:9001` の確立済み接続 `2` |
| NIC累積値 | `lo` RX `20,759,260,924`／TX `20,759,260,924`、`enp3s0` RX `117,240,715,227`／TX `49,109,159,768`、`tailscale0` RX `15,157,485`／TX `105,959,017` bytes |
| Claude snapshot | `provider=claude`、`status=ok`、`sourceAlias=gmktec`、`sequence=2` |

RX／TXの双方が非ゼロになったことが正の検証である。API／senderの状態、MQTT接続数、Claude snapshotも
同一サンプルで取得できた。旧ログの `txBytes=0` はパーサー不具合の証跡として残し、長期比較は修正版
JSONLの有効なサンプルだけを使う。24時間・72時間時点で同じ項目を再取得し、CPU／メモリ／NIC通信量、
接続数、Claude値、API health、`reconnectCount`を比較する。最終配備判定は引き続き **保留** とする。

## 39. 第29回再監査 — 観測JSONLの機械検査（2026-10-15）

長期観測ログをJSONとして全行読み込みし、初期ページ遷移などの未確定行と有効な定点サンプルを分けて
検査した。検査時点の有効範囲はまだ24時間未満である。

| ログ | 件数・範囲 | 機械検査結果 |
| --- | --- | --- |
| `/tmp/fire-dashboard-mqtt-claude-observations-20261015.jsonl` | 5行、22:43:24〜23:03:24 UTC | 全行JSON妥当、MQTT `connected`、health `ok`、Claude `status=ok`／`sourceAlias=gmktec`、MQTTエラーなし |
| `/tmp/fire-dashboard-mqtt-observations-20261015.jsonl` | 9行。先頭22:29:16 UTCはページURLだけの初期行、残り8行は22:29:40〜23:04:40 UTC | 有効8行すべてMQTT `connected`、health `ok`、footer接続済み、MQTTエラーなし。先頭の未確定行は失敗として数えない |
| `/tmp/fire-dashboard-mqtt-host-observations-20261015-v3.jsonl` | 4行、22:47:06〜23:02:06 UTC | 全行JSON妥当、API／Claude sender `active/running`、`NRestarts=0`、対象NICのTX非ゼロ、Claude `sourceAlias=gmktec` |

この検査は短時間のログ整合性と現在状態を確認するもので、24／72時間の連続運転を代替しない。長期観測の
最終判定では、有効サンプルの連続性、PUBACK／heartbeat、再接続数、CPU／メモリ／NIC差分を同じ基準で比較する。

## 40. 第30回再監査 — Claude statusline更新のAPI／MQTT伝播（2026-10-15）

通常稼働中のClaude Code statuslineから新しい入力を受け、snapshotが更新されたことをホスト観測で確認した。
その後、Claude付きFire観測で新しいusageがAPI正本とMQTT配信へ伝播したことを確認した。これは§37.3-3の
「Claude Codeのstatuslineが次回の通常セッションでも計測処理を維持する」の受入証拠である。

| 確認 | 実測結果 |
| --- | --- |
| Host snapshot | `sequence=3`、`capturedAt=2026-10-14T23:08:44.420Z`、`provider=claude`、`status=ok`、`sourceAlias=gmktec` |
| API／MQTT／Fire | 観測時刻 `2026-10-14T23:13:24.867Z`、MQTT revision `199`、`state=connected`、`deliveryStatus=ok`、health `ok` |
| Claude usage | 5時間枠 `8%`（reset `2026-10-15T02:30:00Z`）、7日枠 `27%`（reset `2026-10-18T04:00:00Z`） |
| 受信時刻 | API正本 `receivedAt=2026-10-14T23:12:56.316Z`。snapshot更新後にheartbeatだけでなく新しい値を受信した |
| 常駐サービス | API／Claude senderともに `active/running`、`NRestarts=0` |

旧snapshotの値を再送しただけではなく、statusline由来の `8%`／`27%` がAPIとMQTTへ届いたため、計測処理の
更新経路を陽性確認できた。長期観測の24／72時間判定はまだ保留である。
