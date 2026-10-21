# AI Usage Service Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fire Dashboardを起動せずにAI usageを計測・集約・MQTT配信でき、他の表示機器から再利用できるようにする。

**Architecture:** 同一リポジトリ内にusage専用契約と独立サービスを置く。収集器はその契約へ依存し、Fire向けAPIはusageサービスの認証付きHTTP APIを読む。Mosquittoは外部プロセスのまま利用する。

**Tech Stack:** TypeScript、Node.js 24推奨、Fastify、Zod、MQTT.js、ws、Vitest、Playwright、esbuild。既存の固定依存を使う。

**Spec:** [承認済み設計](../../plans/2026-10-22-usage-service-separation-design.md)

## Global Constraints

- usageバックエンドのソース・成果物はFireアプリ、天気、RSS、画面設定へ依存しない。
- `POST /api/v1/usage` と既存envelope、sourceAlias制限、sequence検査を維持する。
- 読取HTTPとMQTTは同じusage・streamId・revision・publishedAtを返す。
- stateはQoS 1・retain、heartbeatは非retain、availabilityはretain・LWTを維持する。
- 移行時は現在の `fire-dashboard/v1/main` を明示設定する。新規設定例は `ai-usage/v1/main`。
- 旧状態ファイルは上書きせず、移行先の既存ファイルへの上書きも拒否する。
- 新旧publisherを同一トピックで同時起動しない。
- 認証情報や会話内容を配信データへ含めない。listenerを自動でLAN公開しない。
- 本番のlistener・ACL・Serve・systemd変更、別リポジトリへの移動、他機器用UIの実装は範囲外。
- シェルコマンドは `rtk` を付ける。各タスクのfocused testを通し、最後に全体検証を行う。

## Review Focus

- FireのHTTP要求が同時発生・逆順完了しても、usageのrevisionを巻き戻さない（Task 5）。
- usage取得失敗後に保存値を表示するとき、観測時刻・成功時刻を更新せず停止を示す（Task 5）。
- 配備前からの環境変数・トピックと新規設定の混在を黙って別保存先への起動にしない（Task 4）。
- 破損した旧ファイル・既存移行先で移行が失敗しても、双方のファイルを変更しない（Task 6）。
- readerからcollectorへの権限昇格、クライアント由来の認証ヘッダーの無差別中継を許さない（Task 4・5）。

## File Structure and Interfaces

- `packages/usage-contracts/src/common.ts`：usageと天気・RSSが共有する状態スキーマと空値。
- `packages/usage-contracts/src/index.ts`：provider、usage、envelope、配信metadata・snapshot。
- `packages/usage-contracts/src/delivery.ts`：heartbeat、availability、revision比較。
- `packages/contracts/src/index.ts`、`usage-delivery.ts`：Fire固有契約を維持し、usage関連の旧exportは新パッケージの再exportにする。循環importは作らない。
- `services/usage/src/store.ts`：usage専用の永続化と直列更新。
- `services/usage/src/ingest.ts`：既存の取得元選択とsequence検査を移動する。
- `services/usage/src/mqtt/{publisher,gateway,credentials}.ts`：既存実装を移動し、usage専用storeへ変更する。
- `services/usage/src/{auth,auth-tailscale,auth-tailscale-module,config,server,start}.ts`：認証、設定、独立APIと起動処理。
- `services/aggregator/src/usage/client.ts`：固定設定のバックエンドへの読取・状態確認クライアント。
- `services/aggregator/src/usage/relay.ts`：既存collector入口とWSS入口の認証済み中継。publisherと集約処理は持たない。
- `services/usage/src/migrate.ts`、`scripts/migrate-usage-state.ts`：旧形式からのオフライン移行と切り戻し用変換。
- `scripts/build-usage.mjs`：独立成果物とesbuild metafileを出力する。
- `docs/usage-service.md`：独立起動、データ契約、購読、移行、切り戻し。

`UsageState` は `{ schemaVersion: 1, delivery: UsageDelivery, usageSequences: Record<string, UsageEnvelope>, usageValues: Record<string, Usage>, usageObservedAt: Record<string, string> }`。

`UsageStore` は `inspect<T>(fn: (state: UsageState) => T): Promise<T>`、`readState(): Promise<UsageState>`、`readDelivery(): Promise<UsageDelivery>`、`update<T>(fn: (state: UsageState) => { state: UsageState; result: T }): Promise<T>`。

`createUsageIngestorWithRevision(store: UsageStore, preferredSources: Partial<Record<UsageProvider, string | readonly string[]>>)` は既存と同じ引数のingest関数と `UsageIngestResult` を返す。

`createUsageClient(options: { baseUrl: string; readerToken: string; timeoutMs?: number; maxBytes?: number; fetch?: typeof fetch })` は `{ readDelivery(): Promise<UsageDelivery>; readMqttStatus(): Promise<unknown> }` を返す。既定timeoutは2000ms、最大応答は2MiB、redirectは禁止する。

## Task 1: Fireから独立したusage契約

**Files:** 上記 `packages/usage-contracts`、既存contracts、`collectors/**/*.ts`、`tests/unit/usage-contracts.test.ts`。

**Interfaces:** 既存の `Usage`、`UsageEnvelope`、`UsageDelivery`、`emptyUsage`、`commonSchema`、配信関連exportを同名で提供する。

- [ ] **Step 1:** `usage-contracts.test.ts` を追加。既存fixtureのparse結果が旧exportと同一、`usedPercent: null` を維持、同一provider重複を拒否、異なるstreamIdの比較はnull、39桁revisionを比較可能とassertする。
- [ ] **Step 2:** `rtk npm test -- tests/unit/usage-contracts.test.ts` を実行し、新規import不在によるFAILを確認する。
- [ ] **Step 3:** usageと共通状態の定義を移動し、旧exportは互換再exportにする。収集器の契約importを新パッケージに切り替える。表示設定・天気スキーマを新パッケージへ持ち込まない。
- [ ] **Step 4:** 同テストに加え `rtk npm test -- tests/unit/contracts.test.ts tests/unit/provider-contracts.test.ts tests/unit/usage-delivery.test.ts tests/unit/provider-collectors.test.ts` と型検査を通す。
- [ ] **Step 5:** Task 1の対象だけをstageし、`refactor: extract standalone usage contracts` でcommitする。

## Task 2: usage専用保存と集約

**Files:** `services/usage/src/{store,ingest}.ts`、`tests/unit/usage-store.test.ts`、`tests/unit/usage-ingest.test.ts`。参照元は既存 `store.ts` と `usage/ingest.ts`。

**Interfaces:** File Structureの `UsageState`、`UsageStore`、ingestor。`createMemoryUsageStore(): UsageStore`、`createFileUsageStore(path: string, options?: { beforeRename?: () => Promise<void> }): UsageStore`。

- [ ] **Step 1:** 永続化の再起動でstreamId・revision・取得元状態が一致する、rename前の失敗で旧ファイルが保全される、並列受信が失われないテストを追加する。既存 `multi-source`、`usage-replay` の主要ケースを新storeに対して実行し、旧sequence・重複heartbeat・別PC失敗で最新正常値を失わないとassertする。
- [ ] **Step 2:** `rtk npm test -- tests/unit/usage-store.test.ts tests/unit/usage-ingest.test.ts` でFAILを確認する。
- [ ] **Step 3:** 直列queue・atomic保存・ingestをusage専用stateへ適用する。初期deliveryはrevision `"0"`、一意streamId、生成時刻と6 providerの空値を持たせる。破損した保存ファイルは初期化せず起動失敗にする。
- [ ] **Step 4:** Task 2のテストを通す。保存後の `readDelivery()` がschemaに適合し、JSONに `dashboard`・`weather`・`rss` が含まれないとassertする。
- [ ] **Step 5:** `feat: add independent usage storage and ingestion` で対象をcommitする。

## Task 3: MQTT配信とgatewayの独立化

**Files:** `services/usage/src/mqtt/*.ts`、旧MQTTファイル、`tests/unit/usage-publisher.test.ts`、`tests/integration/usage-gateway.test.ts`。

**Interfaces:** 既存 `MqttPublisherOptions`、`UsagePublisher`、`registerMqttGateway` を維持し、publisherのstore引数だけ `UsageStore` にする。旧publisherはTask 5まで旧storeを変換するadapter経由で新実装を呼ぶ。

- [ ] **Step 1:** 保存されたdeliveryと同じpayloadをQoS 1・retainで送信、切断中は最新値だけ保持、再接続時再送、LWT、PUBACK timeoutで逆順配信しないテストを新storeに対して追加する。
- [ ] **Step 2:** `rtk npm test -- tests/unit/usage-publisher.test.ts tests/integration/usage-gateway.test.ts` でFAILを確認する。
- [ ] **Step 3:** 実装を新サービスへ移し、publisherを `store.readDelivery()` に接続する。gatewayのOrigin、subprotocol、接続上限、101前の上流確認、上流解放を維持する。旧パスには一時的な互換adapterを残す。
- [ ] **Step 4:** 新テストと既存 `mqtt-gateway`・`mqtt-credentials` テストを通す。broker停止がstore更新を妨げないことをassertする。
- [ ] **Step 5:** `refactor: isolate usage MQTT delivery` で対象をcommitする。

## Task 4: 独立API・設定・ビルド

**Files:** `services/usage/src/{auth,auth-tailscale,auth-tailscale-module,config,server,start}.ts`、`services/usage/{package.json,config.example.json}`、`scripts/build-usage.mjs`、ルートpackageとlock、`tests/integration/usage-api.test.ts`、`tests/unit/usage-build.test.ts`。

**Interfaces:** `createUsageServer({ store, authorize, sourceAlias, allowedOrigins, preferredSources, mqtt?, gateway? })` はFastifyInstance。認証型は既存と互換。サービス間reader向けに `readerTokenHashes: readonly string[]` を認証設定へ追加し、collectorトークンと役割を分離する。

- [ ] **Step 1:** POST受信後のGET delivery、無認証401、異なる役割403、不正Origin403、sourceAlias偽装403、body超過413をテストする。reader tokenはGETのみ許可し、POSTと管理操作には使えないとassertする。
- [ ] **Step 2:** `rtk npm test -- tests/integration/usage-api.test.ts` でFAILを確認する。
- [ ] **Step 3:** `/api/v1/usage` のGET/POST、health、mqtt-status、WSSだけを提供する。認証モジュール必須、loopback bind、秘密は外部ファイル、認証エラーは非機密の定型応答とする。新環境変数は `USAGE_AUTH_MODULE`、`USAGE_PUBLIC_ORIGIN`、`USAGE_CONFIG`、`USAGE_PORT`、`USAGE_STATE_FILE`、`USAGE_READER_LOGINS`、`USAGE_READER_TOKENS_FILE`、`USAGE_COLLECTOR_TOKENS_FILE`。旧 `FIRE_*` は自動継承せず、旧設定だけ指定されている場合は移行案内を出して起動拒否する。既定ポート8788、state `.runtime/usage-state.json`、新規topic `ai-usage/v1/main`。
- [ ] **Step 4:** `build:usage` と `start:usage` を追加。`dist/usage/start.mjs`、`auth-tailscale.mjs`、metafileを生成する。metafileのinputsに `apps/`、`services/aggregator/`、`packages/contracts/` がないことをbuild testでassertする。新APIテストと `rtk npm run build:usage` を通す。
- [ ] **Step 5:** `feat: provide standalone usage API and build` で対象をcommitする。

## Task 5: Fireをusageサービスの利用側へ変更

**Files:** `services/aggregator/src/{server,start,config,store}.ts`、`services/aggregator/src/usage/{client,relay}.ts`、旧ingest・MQTTファイル、`services/aggregator/config.example.json`、`tests/integration/usage-separation.test.ts`、既存API・startup・MQTTテスト。

**Interfaces:** 上記 `createUsageClient`。Fire設定に `usageService: { baseUrl: string; readerCredentialsFile: string; timeoutMs: number; maxBytes: number }` を追加。URLは資格情報・query・fragmentなしのloopback HTTP、または明示設定したHTTPS originだけを許可する。reader資格情報ファイルは0600 JSON `{ token: string }`。

- [ ] **Step 1:** 独立usage APIとFire APIを起動し、Fire停止中もPOST→GETが継続する、Fire dashboardのusageとmetadataがbackendに一致することをassertする。並列HTTP完了の逆順でも同streamIdの小さいrevisionを採用しないテストを追加する。
- [ ] **Step 2:** backend timeout、不正JSON、2MiB超過、redirect、401時にFireの天気・RSSが返り、最後のusage値と時刻が保全されるテストを追加してFAILを確認する。
- [ ] **Step 3:** clientにtimeout・stream読み取りのbyte上限・schema検査・redirect拒否を実装する。直近deliveryはメモリーcacheとし、同streamIdはrevision比較、新streamIdは単一の共有in-flight取得で切替する。障害時はFire応答のコピーにだけ `status: stale` と適切なerrorCodeを付け、数値・観測時刻・lastSuccessAt・revisionを変えない。起動後未取得なら空usageとし、旧storeのusageを正本として再利用しない。
- [ ] **Step 4:** Fireのingest・publisher起動を除去する。旧POST入口はcollector認証とalias確認後に、設定済み固定URLへ元collector bearerと検証済みenvelopeだけを中継する。読取とmqtt-statusは専用reader tokenで中継する。WSS入口はFire reader認可後にusageサービスのWSSへ接続し、設定されたOriginと専用reader tokenだけを付与する。クライアントが指定した接続先やTailscale認証ヘッダーを転送しない。新サービス側でも役割とsourceAliasを再検査する。
- [ ] **Step 5:** Fireの保存ファイルからusage受信状態を更新する処理を除去し、旧ファイルの余分なフィールドは読取互換で許容する。互換経路を試験し、旧MQTT・ingestモジュールの一時adapterを削除する。既存テストを新境界へ更新し、Task 5のfocused testを通す。
- [ ] **Step 6:** `refactor: consume independent usage service from Fire dashboard` で対象をcommitする。

## Task 6: オフライン移行と切り戻し

**Files:** `services/usage/src/migrate.ts`、`scripts/migrate-usage-state.ts`、`scripts/build-usage.mjs`、`tests/unit/usage-migration.test.ts`。

**Interfaces:** `extractLegacyUsage(input: unknown): UsageState`、`mergeUsageIntoLegacy(legacy: unknown, usage: UsageState): unknown`、CLI `node dist/usage/migrate.mjs --from <old.json> --to <new.json>` と `--restore-legacy <old.json> --from <usage.json> --to <rollback.json>`。

- [ ] **Step 1:** 既存deliveryあり／metadataなしの旧形式、別PC保持値、破損ファイル、既存出力、書込失敗をfixtureで試験する。元ファイルのbyte一致、既存出力のbyte一致、成功時の値・sequence・streamId・revision維持をassertする。
- [ ] **Step 2:** `rtk npm test -- tests/unit/usage-migration.test.ts` でFAILを確認する。
- [ ] **Step 3:** 旧storeの移行規則を参考に、Dashboard依存なしのオフライン変換を実装する。metadataがない形式は新streamId・revision0を生成する。出力はtemp file完成後に排他的な公開操作で配置し、既存ファイルをrenameで置換しない。切り戻しでは最新usageを旧形式に戻し天気・RSSを維持する。CLIは停止済み状態の入力を必要条件として案内する。
- [ ] **Step 4:** テストを通し、移行→新サービス読取→切り戻しのround tripで最新観測が失われないことをassertする。
- [ ] **Step 5:** `feat: migrate usage state without overwriting legacy data` で対象をcommitする。

## Task 7: 独立利用の証明・ドキュメント・全体検証

**Files:** `docs/usage-service.md`、`README.md`、`docs/{deployment,collectors,acceptance}.md`、`tests/integration/usage-broker.test.ts`、`tests/acceptance/provider-usage.spec.ts`。

- [ ] **Step 1:** 一時領域の専用ポート・トピックで隔離Mosquittoを使い、Fire未起動でPOST→MQTT購読、retained取得、broker再起動後の最新配信、reader publish拒否を試験する。本番brokerには接続しない。開発brokerが用意できない場合は未検証項目として明記し、mock成功で代替しない。
- [ ] **Step 2:** `docs/usage-service.md` にNode成果物単独起動、collector設定、HTTP/JSON/MQTTの仕様・単位・null・鮮度・順序・streamId変更、認証付きCLI購読とWSS購読例を記載する。例示値は架空と明記する。READMEで2製品の責務と別build/startコマンドを説明する。
- [ ] **Step 3:** 運用文書に旧受信停止→publisher停止→backup→移行→旧topic明示で新サービス起動→Fire切替→collector直送への段階変更を記載する。読取relay用token作成・保存先・権限を明記する。切り戻しは新受信停止後の最新状態を逆変換し、新旧publisherを同時起動しない。本番のsystemd・Serve・ACL例は適用せず差分案として示す。
- [ ] **Step 4:** `rtk npm test`、`rtk npm run typecheck`、`rtk npm run build`、`rtk npm run build:api`、`rtk npm run build:usage`、`rtk npm run build:collectors`、`rtk npm run test:e2e` を実行し、全てのexit codeと結果を確認する。失敗箇所だけを修正し再検証する。
- [ ] **Step 5:** acceptance文書へ実行済み検証と未実施のFire実機・本番移行を区別して記録し、`docs: document standalone usage service and verified separation` でcommitする。

## Execution Handoff

この計画はレビュー待ち。Task 1〜7は同じ契約・保存形式を順に利用するため、実装方式はこのチャットで担当者が順に進めるNativeを推奨する。ユーザーが計画を確認して実行方式を選んだ後に実装を開始する。
