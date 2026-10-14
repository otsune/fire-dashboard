# GMKtec MQTT usage配信 実装監査記録

本ファイルは、`2026-10-14-gmktec-mqtt-usage-plan.md` に基づく未コミット実装（作業ツリー、HEAD `07cc993` 上）に対する監査記録の正本。
いつ見るか: MQTT実装のコミット・レビュー前、Phase 2／3の試験を書く前、本番でgateway／publisherを有効化する前。
関連: 計画 `2026-10-14-gmktec-mqtt-usage-plan.md`、計画監査 `2026-10-15-gmktec-mqtt-usage-plan-audit.md`、配備 `../deployment.md`。
対象: `services/aggregator/src/mqtt/{publisher,gateway}.ts`、`store.ts`、`usage/ingest.ts`、`server.ts`、`start.ts`、`config.ts`、`packages/contracts/src/{index,usage-delivery}.ts`、`apps/dashboard/src/{App.tsx,data/usage-state.ts,data/usage-stream.ts,data/cache.ts}`。
方法: コードの通読、`@fastify/websocket` 11.3.4の実装（`node_modules`）の確認、`npm test`／`typecheck`／`build`／`build:api` の実行、HEADのクリーンworktreeとの比較。broker・実機・ホスト設定は未検証。
状態: 監査完了（2026-10-15）。指摘への修正は未実施。

## 1. 結論

骨格は計画に沿っている。具体的には、revisionの永続化、HTTPとMQTTで共通のrevision判定、単一in-flightと最新一件への合流、接続世代による古いcallbackの無効化、30秒のACK期限と5秒の切断期限、upgrade前のreader認可・Origin必須判定・`mqtt` サブプロトコル確認、上流の `mqtt` 選択を確認してから101を返す順序、loopbackに限定したURL検証が揃っている。ただし、**段階導入と切り戻しの手段が無いこと**と、**gatewayのbackpressure判定が逆向きであること**は、有効化前に直す必要がある。publisher／gateway／ブラウザー側の購読処理には試験が無い。

| 検証 | 結果 |
| --- | --- |
| `npm run typecheck` | 成功 |
| `npm run build:api` | 成功（mqtt／wsを含む単一ファイル） |
| `npm run build` | 成功。JSは367 KB → 709 KB（gzip 113 → 215 KB）、500 KB超の警告 |
| `npm test` | 652件中34件失敗。**34件ともHEADのクリーンworktreeでも同じく失敗**（RSSティッカー、天気カタログ、weather-settings API）。本変更による退行ではない |

## 2. 指摘（重い順）

### 中

1. **ブラウザーが常にMQTTへ接続し、端末単位の有効化もHTTP専用モードも無い。** `App.tsx` はマウント時に無条件で `createUsageStream()` を呼ぶ。購読を止めるのは「HTTP応答に `usageDelivery` が無い」場合だけである。一方、`ingest.ts` は `mqtt.enabled` に関係なく毎回metadataを書く。このため、gateway無効のまま配備しても全端末が `/api/v1/usage/stream` へ最大60秒間隔で接続を試み続け、フッターに `MQTT error`／`disconnected` が常時出る。計画Phase 5（Fire 1台のみ有効）と§15.1（端末をHTTP専用モードへ戻す）を実現できない。端末側に明示的な有効化フラグ（例: URLパラメーターや設定の保存値）を設け、既定は無効とする。mqtt.jsは動的importにし、無効な端末は約340 KBを読み込まないようにする。
2. **gatewayのbackpressure判定が逆向き。** `gateway.ts` の `socket.on("message")` は送信先の `upstream` ではなく受信元 `socket` の `bufferedAmount` を、`upstream.on("message")` は送信先の `socket` ではなく `upstream` の `bufferedAmount` を見ている。重要なのはbroker→Fireの経路で、遅い端末へは最大2 MiBのretained stateが無制限に積まれる。判定をそれぞれ送信先のソケットへ入れ替え、試験を追加する。
3. **意図した再接続のたびに、retainedの `offline` をpublishしている。** `disconnectAndReconnect()` は正常切断の前に `availability: offline`（retain）を明示的に送る。計画§7.1は、正常切断でLWTを出さずにflappingを避ける設計である。端末側（`App.tsx` の `onAvailability`）はinstanceIdを照合せず、すべての `offline` を `error` 表示にする。そのため、30秒タイムアウトのたびに配信停止が表示され、接続直後に古いretained offlineを受けても `error` になる（計画§8「古いofflineやretained onlineだけで現在の生存を断定しない」に反する）。再接続時の明示的なofflineは削除し、`stop()` だけに残す。端末側ではinstanceIdと、接続後のheartbeatで判定する。
4. **`too_large` のときに古いpending stateを捨てていない。** `queueCurrentState()` はサイズ超過時に早期returnするが、既にある `pendingState`（上限内の旧revision）は残る。再接続時などにそれがretainedとして送られ、成功すると `deliveryStatus` が `ok` へ戻る。端末は `onHeartbeat` を処理しておらず、heartbeatのrevisionとstateのrevisionを照合しない。結果として、古い値を最新扱いで表示し得る（計画§7「以前のretained値を最新として扱わせない」）。超過時は `pendingState` を破棄する。端末ではheartbeatのrevisionが表示中のrevisionより新しい場合、HTTPで照合する。
5. **publisher・gateway・usage-streamに試験が無い。** 新規試験は `tests/unit/usage-delivery.test.ts` の3件（契約、revision、reducer）だけである。計画Phase 2／3の合格条件にある、PUBACK遅延時の合流、タイムアウト時の再接続、古いcallbackの無効化、heartbeatがstateに阻まれないこと、Origin欠落・collector・サブプロトコル不一致の拒否、上限超過、15分での切断のいずれにも試験が無い。`clientFactory` の注入点はあるため、publisherはfake clientで単体試験できる。gatewayは `injectWS` と、ローカルのws server（Mosquittoの代役）で試験できる。

### 低

6. **upgradeが失敗すると上流接続が残る。** preHandlerで上流WSを開いた後、`ws.handleUpgrade` が失敗した場合（不正なSec-WebSocket-Keyやバージョン、待機中のクライアント切断）はハンドラーが呼ばれない。その結果、上流ソケットが15分タイマーも付かずに残る。reader認証済みの要求に限られるが、`onResponse`／`request.raw` の `close` で `upstreams` の該当ソケットを閉じる処理を加える。
7. **旧状態ファイルの移行が不安定。** `createFileStore` の読み込みは、`streamId` もmetadataも無い旧ファイルに対して、読むたびに `randomUUID()` を返す。最初の書き込みまで、heartbeatのstreamIdが毎分変わる。またrevisionが `"0"` の間、HTTPはmetadataを返さない。そのため、移行直後〜最初の受信（最大約4分）の間に開いた端末は、指摘1の停止条件によって、そのセッション中MQTTを止めてしまう。移行時に一度保存するか、revision 0でもmetadataを返す。
8. **表示が変わらない受信でもrevisionが進む。** `ingest.ts` は、表示判定（`shown` の比較で早期return）より前でrevisionを進める。非表示の取得元や、古いcaptureの受信でも、同じusageのstateがpublishされる。計画§7.1は「表示用状態が変化する保存で増やす」としている。害は送信数の増加だけだが、計画か実装のどちらかに揃える。
9. **文書・設定のずれ。** `docs/deployment.md` は「`mqtt.enabled` と `gateway.enabled` がともに `true` のときだけ有効」と書くが、コードでは両者が独立して有効になる。publisherの秘密は環境変数（`FIRE_MQTT_USERNAME`／`PASSWORD`）から読むが、計画§9.3は権限を制限したファイルを指定している（`EnvironmentFile=` か資格情報ファイルにする）。§9.3の接続数制限はgatewayに無い。
10. **表示の文言。** フッターがgatewayの英語状態名（`MQTT connecting` など）をそのまま出し、既存の「実機試験前」表示を消している。他の状態表示と同じく日本語の文言へ対応付ける。

## 3. 確認できた点（問題なし）

- `@fastify/websocket` 11.3.4は、Fastifyのルーティング（onRequest→preHandler）を経てから、ルートハンドラー内で `handleUpgrade` を呼ぶ。このため、既存onRequestのGET→reader認可とpreHandlerの上流接続はいずれも101より前に完了し、計画§9.2の順序を満たす。hookが応答した場合は `onResponse` がソケットを破棄する。
- Origin欠落・不一致の拒否、`mqtt` を含まない提案の拒否、上流 `socket.protocol === "mqtt"` の確認、両側の `maxPayload` は実装済み。
- publisherのstate／heartbeatは、それぞれ独立したin-flightとタイマーを持つ。`active !== client` で古い接続のcallbackを無視し、`reconnectPeriod: 0` によりライブラリの自動再送とアプリの再送が競合しない。
- `applyUsageDelivery` は、同じstreamIdでの逆順・重複・同revisionで内容が異なる場合を拒否し、streamIdの切替はHTTPだけに許す。キャッシュ復元はネットワーク受信値を上書きしない（`liveUsage`）。
- `store.inspect` を使い、usageとmetadataを同じ確定状態から読む。ネットワーク送信をStoreのキュー内で待たない。

## 4. 推奨順序

1→2→3→4を直し、5の試験で固定してからPhase 2／3（開発用brokerでの統合試験）へ進む。6〜10はその過程で対応する。既存の34件の失敗は本変更とは別件として、先に、または並行して解消する。
