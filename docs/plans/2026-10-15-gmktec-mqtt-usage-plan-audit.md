# GMKtec母艦 usage集約・MQTT配信 計画書の監査記録

本ファイルは `2026-10-14-gmktec-mqtt-usage-plan.md`（設計案）に対する監査記録の正本。設計の正本は同計画書側にあり、本書はその妥当性・実装との整合・実装前の必須修正を記録する。
いつ見るか: 同計画の実装着手前、Phase 0 の確認項目を固めるとき、`tailscale serve` や認証経路を触る前に必ず参照する。
関連（計画・正本）: `docs/plans/2026-10-14-gmktec-mqtt-usage-plan.md`、`~/docs/notes/fire-dashboard-deployment.md`、`~/docs/services.md`、`~/docs/notes/restore-runbook.md`、`~/docs/notes/network-exposure-audit.md`。
関連（規約）: `~/AGENTS.md`、`gmktec-change-control`、`gmktec-docs-and-memory`、`gmktec-validation-and-evidence`、`gmktec-backup-and-restore`、`gmktec-config-catalog`。
状態: 監査完了（2026-10-15）。同日、指摘への計画修正を反映。実装・実機検証・本番変更は未実施。初回対応表は§9、再監査は§10、再監査への対応は§11、再々監査は§12、その対応は§13、第4回監査は§14、任意補足への対応は§15、第5回監査は§16、第6回監査は§17、両監査への対応は§18、第7回監査は§19、その対応は§20。実装の監査は `2026-10-15-gmktec-mqtt-implementation-audit.md`。

## 1. 監査の方法

対象計画の主張を、リポジトリの実コードとこの母艦（GMKtec）の読み取り専用実測値に突き合わせた。実測は `ss -ltnp`、`tailscale serve status`、`systemctl --user list-units`、`~/docs/*` の参照のみで、変更操作は行っていない。

## 2. 結論

初回監査では、設計の骨格・既存実装との整合は妥当と評価し、実装前に解消すべき3点を指摘した。これらを含む初回指摘は計画へ反映済み（§9・§10）。再監査の追加指摘への対応は§11を参照。

1. reader 認証モデルの前提が実装と食い違う（計画 §9.1 / §16）。
2. `tailscale serve` の変更（=`/mqtt` 追加）が system 層 / sudo / 露出変更である点が軽く扱われている（計画 §4 / §9 / §13）。
3. 配信サイズ上限 256 KiB の根拠が、既存の 3 つの上限（受信 64 KiB / 表示 2 MiB / 契約最大）と不整合（計画 §7）。

初回指摘には中程度・軽微の項目も含む。§7は初回の推奨順序であり、現在の文書対応状況は§9・§11で管理する。

## 3. 実装と突き合わせて確認できた点（正しい）

| 計画の主張                                                                                                  | 検証結果                                    | 根拠                                                                          |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| 収集は Claude/Codex/Antigravity/OpenCode Go/Hermes-Nous のアダプターあり                                    | 一致                                        | `collectors/*`、`usageProviders` は 5 件                                      |
| PC→母艦は `POST /api/v1/usage`、PC ごと認証 + sourceAlias                                                   | 一致                                        | `services/aggregator/src/server.ts:167-188`、`src/auth-tailscale.ts:31-53`    |
| sequence 検査・重複照合・取得元選択・最後の正常値保持                                                       | 一致                                        | `src/usage/ingest.ts:33-125`                                                  |
| 状態はファイル保存、原子的 rename                                                                           | 一致                                        | `src/store.ts:33-47,98-169`                                                   |
| 保存確定後の整合読み出しに使える `inspect` が存在                                                           | 一致（計画§7.1にinspect利用を追記済み）     | `src/store.ts:24-32`                                                          |
| 表示は 30 秒ごとに `/api/v1/dashboard`                                                                      | 一致                                        | `apps/dashboard/src/App.tsx:208-211`                                          |
| IndexedDB 保存・復元がある                                                                                  | 一致                                        | `apps/dashboard/src/data/cache.ts`、`src/data/db.ts`                          |
| Zod による検証                                                                                              | 一致                                        | `packages/contracts/src/index.ts:199-246`                                     |
| MQTT クライアント依存は無い                                                                                 | 一致（`mqtt`/`mosquitto` 参照ゼロ）         | `package.json`、grep                                                          |
| 鮮度表（受信 5 分超=取得元に未接続、枠リセット過ぎ=更新待ち、`sourceObservedAt=null` を配信時刻で埋めない） | 一致                                        | `apps/dashboard/src/data/status.ts:22-47`                                     |
| heartbeat が `capturedAt/sourceObservedAt/lastSuccessAt` を更新しない                                       | 一致                                        | `src/usage/ingest.ts:52-88`                                                   |
| OnFailure→`failure-notify@`、user/system 層をまたぐ順序保証をしない                                         | 一致                                        | `~/docs/services.md:99-104,121-127`                                           |
| rootless Podman quadlet を第一候補                                                                          | 一致（ntfy/searxng/tdai が同方式）          | `~/docs/services.md:69,87,129`                                                |
| 既知 provider を各 1 件・最大 5 件                                                                          | 一致（`dashboard.usage` は常に 1/provider） | `packages/contracts/src/index.ts:7-13,183-190`、`src/usage/ingest.ts:115-118` |

参照リンク（`../../README.md`、`../collectors.md`、`../../services/aggregator/src/usage/ingest.ts` 等）は全て実在パスに解決する。§3 の方式比較、§4 の構成図、§12 のフェーズ分割、§15 の切り戻し・復元手順は妥当。特に「streamId/revision を HTTP と MQTT の共通 reducer で採否」「重複 heartbeat でも receivedAt が変わるなら revision を進める」は、既存の受信 5 分判定（`status.ts:23`）を壊さないために必要な設計で妥当。

## 4. 初回の重大指摘 — 計画への対処済み（2026-10-15）

以下は初回監査時の記述を保持する。各項目は計画修正済みであり、実装・配備の検証済みを意味しない。

### 4.1 reader 認証モデルの前提が実装と食い違う（計画 §9.1 / §16）

計画は「Cookie／既存入口の認証済み情報」「既存 reader セッションの期限」「最大 15 分ごとの再接続・再認証」を前提にする。しかし本ホストで実装済みの唯一の認可は **`Tailscale-User-Login` ヘッダー方式**で、セッション発行も Cookie も存在しない。

- `src/auth-tailscale.ts:47-53`: reader は `tailscale-user-login` ヘッダーと `FIRE_READER_LOGINS` の照合のみ。
- `docs/deployment.md:5` の「HttpOnly / Secure / SameSite=Strict の読み取り専用セッション」は**未実装の理想像**。同 `docs/deployment.md:15` も「セッション発行・ログイン管理はこのアプリに含みません」と明記。

影響: 「セッション期限で切断」は本構成では成立しない。実装すべきは「upgrade 時に `authorize(req,"reader")` を再利用し、以後はセッションが無いため tailnet 側のログイン変更が WS を強制切断しない」という**性質の明文化**。`authorize(request, role)` が upgrade 要求でもそのまま使える、という計画の見立て自体は正しい（Fastify の request を通すため）。

推奨: §9.1 の step 5 を「セッション期限」ではなく「(a) upgrade 時のヘッダー検証、(b) 任意で N 分ごとの強制再接続、(c) 認可変更が即時反映されないことを受容」に書き換える。`docs/deployment.md` の Cookie 記述との乖離も計画に注記する。

### 4.2 `/mqtt` 追加は `tailscale serve` 変更＝system 層 / sudo / 露出変更（計画 §4 / §9.1 / §13）

実測した現行入口（読み取り専用）:

```text
https://gmktec.taila8b10.ts.net:8444 (tailnet only)
|-- /     path  /home/otsune/fire-dashboard/apps/dashboard/dist
|-- /api  proxy http://127.0.0.1:18787/api
```

- 根拠: `tailscale serve status`、`ss` で `127.0.0.1:18787` = node、`100.106.71.32:8444` が待受、`~/docs/notes/fire-dashboard-deployment.md:6`。

計画の図で `E[既存HTTPS入口]` と抽象化しているのは **tailscale serve** であり、`/mqtt` を足すには `sudo tailscale serve`（system 層）の変更が必須。これは計画自身が引用する `gmktec-change-control` の「system 層 / sudo・ネットワーク露出を増やす変更＝人間承認必須」に該当するが、§9.1 では「アプリ内 gateway モジュール」の話に見えてしまい、ゲートが前面に出ていない。

推奨: Phase 5 に「`tailscale serve --set-path=/mqtt` の差分・承認・タイムスタンプ付きバックアップ・切り戻し（serve 元設定の復元）」を独立項目として明記。§15.2 の切り戻し対象に serve 設定そのものを含める。

### 4.3 配信サイズ上限 256 KiB が既存の 3 つの上限と不整合（計画 §7）

- 受信: Fastify の `bodyLimit: 65536`（`src/server.ts:58`）→ 1 エンベロープは 64 KiB 上限、超過は 413 `too_large`。
- 表示（HTTP）: クライアントは 2 MiB まで許容（`apps/dashboard/src/data/client.ts:14`）。
- 契約上の最大: `usage` は buckets 32 × windows 16 × `text`(2048) で 1 provider が数百 KiB〜MB 級になり得る。5 provider 合算は理論上 〜320 KiB 以上（各 64 KiB で bound されても 5×64 KiB ≈ 320 KiB）。

256 KiB を採ると、HTTP では表示できるが MQTT だけ拒否するデータが生じ得る。

推奨: 上限は「実収集 fixture の実測」で決める、と明記。加えて (a) 受信側 `bodyLimit` を引き上げる必要があるか、(b) HTTP の 2 MiB と一致させるか、を Phase 1 の決定事項に。少なくとも 256 KiB は 64 KiB×5 に対して低すぎる可能性を明記する。

## 5. 初回の中程度指摘 — 計画への対処済み（2026-10-15）

1. CSP（計画 §9.1 で未言及）: ダッシュボード HTML の CSP は `apps/dashboard/index.html` の meta にあり `connect-src 'self'`。CSP3 では `'self'` は同一オリジンの `wss:` にマッチするため Chromium 138 では通る見込みだが、**Fire WebView 実機確認**を Phase 3/4 の受け入れに入れる。CSP は API（`src/server.ts:59-66`）ではなく **HTML 側**にある点も計画に無い。
2. publish 頻度 = 収集 heartbeat 頻度: §7.1 の「重複受信でも receivedAt が変わる場合は revision 対象」は正しいが、その結果 publish レートは送信側ハートビート（60 秒/PC）とほぼ等しくなる（`collectors/shared/send-service.ts:15` は 15 秒ポーリング・内容不変なら 60 秒 heartbeat）。実測した総 publish 数・retained 更新回数の見積りを §13 の監視に追加。
3. Fire 到達性は既に検証済み: `docs/acceptance.md:13` で Fire は `https://gmktec.taila8b10.ts.net:8444/` を Fully Kiosk で表示済み。§9.3 / §16 の「アクセスできるかは導入前確認事項」は過小評価。ただし `:8444` は tailnet only のため「Fire が tailnet ノード（または subnet router 経由）であること」を明示確認項目に（計画の「tailnet 未参加なら LAN 公開へ自動変更しない」は正しい）。
4. ホストのポート衝突の具体化（Phase 0）: 実測で `127.0.0.1:8787` = headroom-proxy、`127.0.0.1:18787` = fire-dashboard API、`100.106.71.32:8444` = serve、`0.0.0.0:20128` = 9router、`0.0.0.0:8888` = searxng、`127.0.0.1:8255` = ntfy、そして `8080 は xurl OAuth2 用に常時空け`（`~/docs/services.md:70`）。`src/config.ts:37` の既定 `FIRE_PORT` は 8787 で headroom-proxy と衝突するため、計画の「8787 を流用しない」は正しいが、根拠として「8787 は headroom-proxy が使用中、既定値も 8787 で危険」と明記すべき。8787 の出典は README ではなく `docs/deployment.md:17` と `src/config.ts`（計画 §12 の帰属が誤り）。
5. `mqtt.js` のバンドル摩擦を具体化（計画 §11）: API は esbuild 単一ファイルで CJS 依存を `createRequire` banner で吸収済み（`scripts/build-api.mjs:5-23`）なので CJS の mqtt/ws は載せられる。一方ブラウザ側は Buffer / `readable-stream` polyfill とサイズ増、`scripts/build-sw.mjs` が dist 全資産をハッシュ登録するため **SW 版数と offline 資産数が変わる**。Vite `build.target:'es2020'`（`apps/dashboard/vite.config.ts:4`）、Fire WebView Chromium 138 での実機確認を Phase 4 の受け入れに。
6. SW 更新フローの相互作用（計画 §10 で未言及）: 「更新して再読み込み」（`App.tsx:250-265`）でページが reload すると WS は張り直し。`apps/dashboard/src/sw.ts` は `/api/` を bypass し fetch 以外は介入しないので WS 自体は問題ないが、reload 直後の retained + heartbeat 回復を Phase 4 の回帰に含める。

## 6. 初回の軽微指摘 — 計画への対処済み（2026-10-15）

- 先頭 7 行ルール違反: `~/AGENTS.md` は `docs/plans/` に対し「L1 タイトル、L2–7 に何の正本か・いつ見るか・関連パス」を要求。対象計画は L2–7 が 作成日 / 対象 / 状態 のみで、正本・関連パスが無い。
- `docs/services.md` は既に不整合: `fire-dashboard-api.service`(`127.0.0.1:18787`) と serve の `:8444` マッピングが台帳に無い（deployment note と実測が正）。計画は「導入時に services.md へ記録」とするので方向は正しいが、現状すでに台帳が古い旨も注記に値する。
- §11 の変更箇所に不足: `apps/dashboard/src/data/client.ts`（metadata 読み出し）と `apps/dashboard/index.html`（CSP）を追加。`fetchDashboard` は `parseDashboard` で返すため、`usageDelivery` は client 側で先に取り出す必要あり（`parseDashboard` は既定で未知キーを strip、`packages/contracts/src/index.ts:200-207`）。
- §13 バックアップ: 新規ブローカー設定 / ACL / 常駐設定を既存 restic の `includes.txt` に追加する作業を明記（現状は列挙のみ）。
- 参照すべき正本の追加: §13 / §15 に `~/docs/notes/fire-dashboard-deployment.md`、`~/docs/notes/restore-runbook.md`、`~/docs/notes/network-exposure-audit.md`、`gmktec-backup-and-restore`、`gmktec-validation-and-evidence`、`gmktec-config-catalog` を追加。
- 相違点の注記: 計画 §12 は「README の例の 8787」とするが、8787 の出典は README ではなく `docs/deployment.md:17` と `src/config.ts:37`。

## 7. 初回の推奨アクション（計画反映済み、対応表は§9）

1. §9.1 を実認証（Tailscale ヘッダー、セッション無し）に合わせて書き直す（→ 4.1）。
2. Phase 0 に実ポート / 台帳 / serve 構成の実測結果を固定する（→ 5.4、6）。
3. Phase 5 に `tailscale serve` 変更の承認・タイムスタンプ付きバックアップ・切り戻しを独立項目化（→ 4.2）。
4. §7 のサイズ上限を実測で再定義し、受信 `bodyLimit` との整合を決める（→ 4.3）。
5. CSP（`apps/dashboard/index.html`）と SW 更新時の WS 回復を Phase 3/4 の受け入れに追加（→ 5.1、5.6）。

## 8. 初回監査時の総評（改訂後の評価は§10）

| 観点                           | 評価                                                          |
| ------------------------------ | ------------------------------------------------------------- |
| 既存実装との整合               | 良好（主要主張はほぼ全て実コードで裏取り可）                  |
| 順序制御・鮮度・切り戻しの設計 | 良好（streamId/revision、receivedAt を鮮度に使う判断は妥当）  |
| 母艦側の運用ゲート認識         | 部分（change-control を引くが、serve 変更と認証モデルは過小） |
| 数値根拠（サイズ上限）         | 要修正（256 KiB の根拠が既存上限と不整合）                    |
| ドキュメント規約               | 要修正（先頭 7 行ルール、参照台帳の現状乖離）                 |

本書は計画の実装・配備の完了を意味しない。上記は監査時点の所見として保持し、その後の計画修正状況を§9で追跡する。

## 9. 計画への反映（2026-10-15）

リポジトリの認可実装、Store、受信上限、HTTPクライアント、HTMLのCSP、Vite設定、Fire受け入れ記録、およびホストの配備記録・サービス台帳と照合して計画を修正した。本対応では監査のホスト実測を再実行しておらず、実装や配備の完了を表さない。

| 指摘                      | 計画の反映先                | 文書対応と今後の確認                                                                                                                                             |
| ------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §4.1 認証前提             | 計画§9.1、Phase 3、§14、§16 | Cookie・セッション期限を前提から除外。Tailscaleヘッダー照合、最大15分再接続、起動時許可集合の再読込／再起動を明記。upgradeで認可関数を明示的に呼ぶ実装を今後検証 |
| §4.2 Serve変更            | 計画§4、Phase 5、§15.2      | system／sudo変更として差分・承認・設定バックアップ・Serve復元を独立項目化。コマンド構文は実バージョンで確定                                                      |
| §4.3 サイズ上限           | 計画§7、Phase 1             | 256 KiBを撤回。UTF-8の2 MiBを候補とし、64 KiB受信・5 provider・境界fixtureの測定で確定。既存HTTP制限は文字列長でありバイト数と同一でない点も補足                 |
| §5.1 CSP                  | 計画§9.3、Phase 3           | HTML metaのCSPとFireの同一配信元WSS実機試験を追加。ワイルドカードで広げない                                                                                      |
| §5.2 publish頻度          | 計画§13                     | 収集元系統数に応じたstate更新見積りと、publish／retained更新回数の測定を追加                                                                                     |
| §5.3 Fire到達性           | 計画§2、§9.3、§16           | 既存HTTPS試験済みとWSS未検証を区別。実際のtailnet到達経路を再確認                                                                                                |
| §5.4 ポート               | 計画§2、Phase 0             | 監査時の18787／8444／8787、8080予約、台帳記載漏れを反映。8787の出典をconfig.ts／deployment.mdへ訂正                                                              |
| §5.5 バンドル             | 計画§11、Phase 4            | createRequire、polyfill、ES2020、Chrome 138、SW資産数・版数・サイズの確認を追加                                                                                  |
| §5.6 SW更新               | 計画§10、Phase 4            | 更新後のWS再接続、retained・heartbeat・HTTP・キャッシュの回復試験を追加                                                                                          |
| §6 冒頭規約・参照正本     | 計画冒頭、§13、§15          | 先頭7行に正本・参照時期・関連パスを記載。配備・復旧・監査記録と関連スキルの参照を追加                                                                            |
| §6 metadata保持・変更対象 | 計画§10、§11                | client.tsとindex.htmlを追加。metadataはclient側で先に取り出す案に限定せず、Dashboard型とparseDashboardを拡張し検証済み値を保持する方針に具体化                   |
| §6 バックアップ           | 計画§13                     | restic includes.txtの確認・新規資産追加・収録確認・復元試験を明記                                                                                                |

補足:

- Storeの既存 `inspect` を利用し、HTTP／MQTT向けに同じ確定状態を読み出す方針を計画§7.1へ追加した。
- 64 KiB×5は集約表示値の厳密な最大値とは扱わない。エラー時の正常値引継ぎ・再直列化後のサイズも測る。
- 15分再接続はアプリケーション側の再評価周期であり、tailnet変更の反映時間を含む即時失効保証ではない。

文書段階の修正は反映済み。サイズ上限の確定、Serve upgrade経路、認可変更の反映、CSP・Fire・SWの動作、バックアップ収録は各Phaseの実測・実装時受け入れ条件として残す。

## 10. 改訂版の再監査（2026-10-15）

§9で指摘を反映した計画を再度監査した。ディスク上の計画・本書、およびホストの実ユニット（`~/.config/systemd/user/fire-dashboard-*.service`、`.d/*.conf`）と実測で裏取りした。

結論: 前回の重大3・中6・軽微6 = 15指摘はすべて改訂で反映済みで、§9の対応表も実際の記述と一致する。新たに生じた問題は1件（WSサブプロトコル転送）、残存の軽微が数件、ドキュメント整合が1件。Phase 0着手前の新規ブロッカーは無い（サブプロトコルはPhase 3実装時に必ず踏む設計点のため計画への追記を推奨）。

### 10.1 指摘の反映確認（15件）

| 前回指摘                           | 改訂先                      | 検証                                                                                                                                                                                               |
| ---------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §4.1 認証前提（Cookie/セッション） | 計画§9.1、Phase 3、§14、§16 | 一致。`auth-tailscale.ts:47-53` のヘッダー方式に整合。セッション/期限を排除し、15分再接続はアプリ側の再評価周期で失効保証でないと明記。`FIRE_READER_LOGINS` は起動時許可集合で再起動が必要とも明記 |
| §4.2 Serve変更（system/sudo）      | 計画§4、Phase 5、§15.2      | 一致。`sudo tailscale serve` を伴うと明記、差分・承認・設定バックアップ・Serve復元を独立項目化                                                                                                     |
| §4.3 サイズ上限256 KiB             | 計画§7、Phase 1             | 一致。撤回し2 MiB候補＋実測確定。受信64 KiB・表示文字列長・Zod各制約を区別                                                                                                                         |
| §5.1 CSP                           | 計画§9.3、Phase 3           | 一致。`index.html` のmeta、`connect-src 'self'`、Fire実機、ワイルドカード禁止                                                                                                                      |
| §5.2 publish頻度                   | 計画§13                     | 一致。系統数見積りと実測比較                                                                                                                                                                       |
| §5.3 Fire到達性                    | 計画§2、§9.3、§16           | 一致。HTTPS試験済みとWSS未検証を区別                                                                                                                                                               |
| §5.4 ポート                        | 計画§2、Phase 0             | 一致。18787／8444／8787、8080予約、8787の出典訂正                                                                                                                                                  |
| §5.5 バンドル                      | 計画§11、Phase 4            | 一致。createRequire／polyfill／ES2020／Chrome 138／SW資産                                                                                                                                          |
| §5.6 SW更新                        | 計画§10、Phase 4            | 一致。更新後のWS再接続と回復試験                                                                                                                                                                   |
| §6 冒頭規約・参照正本              | 計画冒頭、§13、§15          | 一致。先頭7行ルールを満たし、参照正本・スキルを追加                                                                                                                                                |
| §6 metadata保持・変更対象          | 計画§10、§11                | 一致。`client.ts`・`index.html` 追加。`Dashboard`型と`parseDashboard`拡張で未知キーstripを正しく認識                                                                                               |
| §6 バックアップ                    | 計画§13                     | 一致。`includes.txt` 確認・追加・収録確認・復元試験                                                                                                                                                |

ホスト実測との整合: `fire-dashboard-api.service` は `FIRE_PORT=18787`、`FIRE_PUBLIC_ORIGIN=https://gmktec.taila8b10.ts.net:8444`、`FIRE_READER_LOGINS=otsune@gmail.com`、drop-in に `FIRE_ADMIN_LOGINS`。計画の記述と一致する。

### 10.2 改訂で新たに生じた指摘 — 計画への対処済み（2026-10-15、§11）

**（中）gatewayはMQTT-over-WebSocketのサブプロトコル転送が必要（計画§5.4／§9.2）**

計画はgatewayを「reader認証付きWebSocket中継」とだけ書き、単純なWSプロキシを想定する。しかしMQTT.jsはWS接続に `Sec-WebSocket-Protocol: mqtt` を付け、ネゴシエート結果が `mqtt` であることを検証する。MosquittoのWS listenerも同subprotocolを要求する。subprotocolを転送しない透過プロキシでは購読が成立しない。

推奨: 「gatewayはupgrade時に `Sec-WebSocket-Protocol` を検証・Mosquittoへ転送する、またはMQTTを終端して再発行する」を計画§5.4／§9.2／Phase 3に明記。あわせて `@fastify/websocket` の `maxPayload`（既定1 MiB）が§7の2 MiB候補より小さいため、§7の「gatewayの上限を合わせる」がこの既定の引き上げを含むことを注記。

### 10.3 再監査時の残存指摘 — 計画・監査記録への対処済み（2026-10-15、§11）

1. （ドキュメント整合）本書§2は「解消すべき3点がある」、§4は「重大な指摘（実装前に解消必須）」のまま。`gmktec-docs-and-memory` の作法（解決済みは取り消し線＋対処済み(日付)）に合わせ、§4〜§6に **対処済み(2026-10-15)** を付けるか状態列を追加し、§2の一文を§9・§10参照に合わせる。§3表の「（計画は明示していない）」も§7.1追記により食い違う。
2. （残存）サイズ上限の向き: `client.ts:14` は `response.text()` の文字列長（UTF-16コード単位）で2 MiB。日本語主体ではUTF-8換算で最大~6 MiB相当のため、MQTTの2 MiBバイト上限はHTTPより厳しい側。「HTTP許容⇒MQTT許容」を保証するならMQTTバイト上限をHTTP実効最大以上にする、または「MQTTを厳しくしHTTPフォールバック前提」と方針明記する、のいずれかを計画§7で確定する。
3. （残存）publisherの単調性機構が未指定: §7.1は目標のみ。単一in-flight（次を送る前に前の送信完了を待つ）＋最新上書きの合流を明記すると解釈差が消える。
4. （軽微）heartbeatが2種類で混同しやすい: 収集元→APIの60秒heartbeat（revisionを進める）と、publisher→brokerのheartbeatトピック（§5.3）は別物。§13の見積りは前者のみ。
5. （軽微）認可変更手順とgatewayの実効価値: 変更対象は `fire-dashboard-api.service`（userユニット）で、`FIRE_READER_LOGINS` 変更は「ユニット編集＋`systemctl --user daemon-reload`＋再起動」。sudoではないが設定ファイル編集＝タイムスタンプ付きバックアップ対象。また単一ログインをFireと収集PCが共有するため（`docs/deployment.md:26,34`）、gatewayのreader判定は実質tailnet限定と同等で、追加価値はcollector資格情報のreader転用不可が主。過大評価しない一文を推奨。
6. （軽微）Phase 0の実ユニット目録: `fire-dashboard-codex.service`（`FIRE_POLL_SECONDS=240`）、`fire-dashboard-usage-sender.service`（`FIRE_SNAPSHOT_PATHS=hermes-nous.json:antigravity.json`、15秒ポーリング＋内容不変なら60秒heartbeat）、`fire-dashboard-{antigravity,opencode-go,hermes-nous}.timer`。§13の「約N回/分」は上限見積りとして妥当だが、Phase 0でこの目録を確定すればN≈3の実値で置換可能。`fire-dashboard-api.service.d/admin-logins.conf` も台帳化に含める。

### 10.4 再監査の総評

| 観点                     | 前回   | 今回                                             |
| ------------------------ | ------ | ------------------------------------------------ |
| 既存実装との整合         | 良好   | 良好（改訂で実測値・実ユニットとも一致）         |
| 順序制御・鮮度・切り戻し | 良好   | 良好                                             |
| 母艦運用ゲート認識       | 部分   | 良好（Serve変更をsystem/sudoゲートとして独立化） |
| 数値根拠                 | 要修正 | ほぼ解消（上限の向きの明記を推奨）               |
| ドキュメント規約         | 要修正 | 良好（計画冒頭は準拠。本書の状態表現のみ要調整） |

改訂は忠実で、設計として実装着手可能な水準。再監査時の次アクションは (a) 本書の対処済みマーキング、(b) 計画§5.4／§9.2／Phase 3にWSサブプロトコル転送要件を追記、(c) 計画§7でサイズ上限の向きを確定、の3点。本書は計画の実装・配備完了を意味しない。この再監査時点では§10の指摘は未対処だった。その後の対応は§11に記録する。

## 11. 再監査指摘への対応（2026-10-15）

§10の追加指摘を計画へ反映した。認可実装、HTTPクライアント、共有sender実装、収集unit／timerの設定ファイル、OpenCode Goの起動wrapperを読み取り専用で確認した。設定ファイルを見たことと実効設定・稼働状態の確認を区別し、後者はPhase 0へ残す。MQTT／WS依存はまだ導入しておらず、ライブラリのバージョン別挙動を検証済みとはしない。

| 指摘                   | 対応先                       | 反映内容・残る受け入れ試験                                                                                                                 |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| §10.2 WSサブプロトコル | 計画§5.4、§9.2、Phase 3、§14 | 両側で `mqtt` を選択し、上流確認後に下流101を返す中継を指定。要求なし・別名・上流不一致を拒否する試験を追加                                |
| §10.2 gatewayサイズ    | 計画§7、Phase 3、§14         | `maxPayload` を明示し、2 MiB候補に対して小さい既定値が残らないこと、再構成メッセージの上限も確認する。採用ライブラリの既定値には依存しない |
| §10.3-1 文書状態       | 本書§2〜§8、§10、§11         | 初回所見を履歴として残し、対処済みの日付と現状への参照を追加。inspectの記載も改訂後へ合わせた                                              |
| §10.3-2 サイズ方針     | 計画§7、Phase 1、§14         | MQTTをHTTPより厳しくし、超過時はHTTPへ戻す方針に確定。UTF-16とUTF-8を区別し、HTTPのみ許容／両方拒否の境界試験を追加                        |
| §10.3-3 publish単調性  | 計画§7.1、Phase 2、§14       | 単一in-flightでPUBACKを待ち、待機中は最新一件へ合流。タイムアウトでは接続を終了し、古いcallback・ライブラリ再送との競合を試験              |
| §10.3-4 heartbeat区別  | 計画§8、§13                  | 収集元→APIとpublisher→brokerを別定義。前者のみusage更新でrevisionを進め、後者は生存確認として別計数                                        |
| §10.3-5 認可変更・価値 | 計画§9.1                     | user unit設定をバックアップ・編集後、daemon-reload／再起動する手順を明記。同一ログインではFireとPCを識別できない限界も記載                 |
| §10.3-6 unit目録       | 計画Phase 0、§13             | service・timer・admin drop-inの目録と確認範囲を追記。実効設定と稼働状態は再確認対象                                                        |

サイズ超過時に古いretained値が残る場合も計画§7へ補足した。小さなheartbeatに配信エラーと現在revisionを載せ、HTTPによる照合へ切り替える。これはusageの観測時刻・revisionを進めるheartbeatではない。

~~頻度の補足: 共有senderは2ファイル各約1回/分、Codexは240秒、OpenCode Goはtimer／wrapperによる4分ごとの単発送信という設定を確認した。変化時の追加送信・再接続・失敗がない仮定ならstate約2.5回/分にpublisher heartbeat約1回/分を加える計算となる。§10.3のN≈3は実測レートとして採用せず、Phase 0で実効設定・送信数と照合する。~~

訂正・対処済み（2026-10-15）: 上記は停止中の共有senderを稼働経路として数えた誤り。現状の正は§12.2と§13。3つのwrapperの4分単発送信とCodexの240秒送信から、受信約1回/分、導入後のstate約1回/分＋publisher heartbeat約1回/分を目安とする。MQTTの実測レートではない。

§10への文書対応は対処済み（2026-10-15）。サイズ上限値の測定確定、サブプロトコル・上限・再送のライブラリ統合試験、認可・Fire実機・本番経路の検証は未実施であり、各Phaseの完了条件として管理する。

## 12. 第3版の再々監査（2026-10-15）

§11で§10の指摘を反映した計画（第3版）を再度監査した。リポジトリ実装に加え、ホストの収集 wrapper（`~/.local/libexec/fire-dashboard-*`）と unit の有効化・稼働状態を読み取り専用で確認した。

結論: §10の8指摘は第3版へ正確に反映され、新規の設計ブロッカーは無い。ただしPhase 0の送信経路目録と§13の頻度見積りに、ホスト実測と食い違う事実誤認が1件ある（→12.2）。設計変更は不要で、目録と見積りの訂正のみ。

### 12.1 §10指摘の反映確認（8件）

| §10指摘               | 改訂先                       | 検証                                                                                                 |
| --------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| 10.2 WSサブプロトコル | 計画§5.4、§9.2、Phase 3、§14 | 一致。端末側で `mqtt` 要求、gatewayが両側終端で上流確認後に下流101、要求なし／別名／上流不一致を拒否 |
| 10.2 gatewayサイズ    | 計画§7、Phase 3、§14         | 一致。`maxPayload` 明示、1 MiB既定を許容しない、再構成メッセージへ上限適用                           |
| 10.3-1 文書状態       | 本書§2〜§8、§10、§11         | 一致。対処済み見出しとinspect記載の更新                                                              |
| 10.3-2 サイズ方針     | 計画§7、Phase 1、§14         | 一致。MQTTをHTTPより厳しく、超過時HTTPフォールバック、UTF-16/UTF-8を区別                             |
| 10.3-3 publish単調性  | 計画§7.1、Phase 2、§14       | 一致。単一in-flight＋PUBACK待ち＋最新合流、タイムアウトで接続終了、接続世代で旧callback無効化        |
| 10.3-4 heartbeat区別  | 計画§8、§13                  | 一致。収集元→APIとpublisher→brokerを別定義・別計数                                                   |
| 10.3-5 認可変更・価値 | 計画§9.1                     | 一致。unit設定のバックアップ→編集→daemon-reload→再起動、単一ログインの限界も記載                     |
| 10.3-6 unit目録       | 計画Phase 0、§13             | 目録は追加されたが内容に事実誤認（→12.2）                                                            |

追加検証: timer間隔（`OnUnitActiveSec=4min`）とcodexの `FIRE_POLL_SECONDS=240` は一致。§9.2のdeferred-101は `ws`／`@fastify/websocket` の既定 `handleUpgrade` では即101を返すため、上流確認後に下流へ返すには独自ハンドシェイクか受理後の失敗クローズが必要。計画はライブラリ選定条件に含めており許容。

### 12.2 新規の指摘（中）: Phase 0の送信経路目録と§13頻度見積りが実測と食い違う — 計画への対処済み（2026-10-15、対応は本書§13）

証拠（読み取り専用）:

- 3つのwrapperは**すべて**収集後に `fire-dashboard-send-once.mjs` で**無条件POST**する。`~/.local/libexec/fire-dashboard-antigravity`（timer 4分）→ `send-once.mjs antigravity.json`、同 `fire-dashboard-hermes-nous` → `hermes-nous.json`、同 `fire-dashboard-opencode-go` → `opencode-go.json`。`send-once.mjs` は差分判定なしで `fetch` POSTする。
- `fire-dashboard-usage-sender.service` は **disabled／inactive**（`is-enabled=disabled`、`is-active=inactive`）。hermes-nous.json／antigravity.jsonを60秒ハートビートする経路は現状動いていない。
- 稼働中: `fire-dashboard-{antigravity,hermes-nous,opencode-go}.timer` = enabled／active、`fire-dashboard-codex.service` = enabled／active。

計画との差分:

- 計画Phase 0表は単発送信を `fire-dashboard-opencode-go` のwrapperにのみ帰属するが、実際はantigravity・hermes-nousのwrapperも単発送信する（§11はopencode-goのwrapperだけ確認したと記載）。
- 計画§13は「共有senderの2ファイルが各約1回/分 … stateは約2.5回/分 … publisher heartbeatを加えて約3.5回/分」「共有senderだけでN=2」と見積るが、共有senderは停止中のためこの2回/分の項は現状成立しない。

実測ベースの再計算:

| 経路                                           | 間隔  | 回/分   |
| ---------------------------------------------- | ----- | ------- |
| antigravity wrapper（capture→send-once）       | 4分   | 0.25    |
| hermes-nous wrapper（capture→send-once）       | 4分   | 0.25    |
| opencode-go wrapper（capture→send-once）       | 4分   | 0.25    |
| codex（`FIRE_POLL_SECONDS=240`）               | 240秒 | 0.25    |
| state計（各POSTがreceivedAtを更新→revision増） | —     | ≈1.0/分 |
| publisher heartbeatトピック                    | 60秒  | 1.0/分  |
| 合計目安                                       | —     | ≈2.0/分 |

現状は≈2.0/分で計画の≈3.5/分より小さい。容量は余裕側だが、「見込まれる」と断定した内訳と、Phase 0で確定するはずの稼働状態が既に矛盾する。共有senderはwrapperと重複するため停止されたと見られる。

推奨:

- 計画§13の頻度見積りを「設定ファイル由来の候補」と明示し、共有senderの有効化状態は未確定として具体値（2.5／3.5）を断定しない。Phase 0の実測値に置換する。
- Phase 0目録に「3 wrapperすべてがcapture後にsend-onceする」「`fire-dashboard-usage-sender.service` はdisabled／inactive（有効化するならwrapperと重複）」を追記。
- 本書§11の「state約2.5回/分」も同理由で訂正（履歴として保持し、本節を正とする）。

### 12.3 再々監査時の軽微な指摘 — 計画への対処済み（2026-10-15、本書§13）

1. §8の状態表に `too_large` 行が無い: §7は「サイズ超過時はheartbeatに `deliveryStatus: "too_large"`＋revisionを載せ、HTTP照合し、上限内state配信で解除」と定めるが、§8のcanonicalな状態表に対応行が無い。表へ追加すると表示仕様の正本が一貫する。
2. publish前のサイズ判定が未明記: §7は「publishできないとき」を前提にするが、`mqtt.js` へ投げてからではbroker切断・破棄になり得る。publish前にシリアライズ後バイト数を上限と比較する手順を一文追加。
3. `too_large` 用heartbeatはretain:false（§6）のため、新規接続端末はretained stateの古い値を見る。§7は「新規接続端末はHTTP初回取得でも確認」とするので実害は小さいが、§6／§7で明示すると親切。
4. §2の表現: 「本改訂でホストの実測は再実行していない」に対し§12目録は設定ファイル確認に基づくため、「設定ファイルは確認したが稼働状態は未再測定」と書き分けると12.2の誤認を避けやすい。

### 12.4 再々監査の総評

| 観点                     | 初回   | 再監査   | 再々監査                                   |
| ------------------------ | ------ | -------- | ------------------------------------------ |
| 既存実装との整合         | 良好   | 良好     | 良好                                       |
| 順序制御・鮮度・切り戻し | 良好   | 良好     | 良好（単一in-flight・too_large経路を追加） |
| 母艦運用ゲート認識       | 部分   | 良好     | 良好                                       |
| 数値根拠                 | 要修正 | ほぼ解消 | 送信経路の実測と齟齬（12.2）               |
| ドキュメント規約         | 要修正 | 良好     | 良好                                       |

第3版はWSサブプロトコル・サイズ方針・publish単調性まで含め実装着手可能な水準。残る実務上の是正は12.2の送信経路目録・頻度見積りの訂正のみで、設計変更は不要。修正後はPhase 0の実測でレートを確定する。本書は計画の実装・配備完了を意味せず、再々監査時点では§12の指摘は未対処だった。現在の対応状況は§13を参照。

## 13. 再々監査指摘への対応（2026-10-15）

§12の目録・頻度の誤認と軽微4点を計画へ反映した。今回、3つのwrapperとsend-onceスクリプトを確認し、5対象の有効化／稼働状態を読み取り専用で再測定した。環境変数全体や秘密情報を取得せず、unitのId・UnitFileState・ActiveState・SubStateのみを確認した。サービス停止・再起動・設定変更は行っていない。

| 指摘                   | 反映先           | 対応内容                                                                                                                                                     |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §12.2 送信経路・目録   | 計画Phase 0      | 3 wrapperすべてのcapture→send-onceを記載。共有senderのdisabled／inactive、Codex・3 timerのenabled／activeを再確認し、ファイル内容と稼働状態を別欄に分けた    |
| §12.2 頻度             | 計画§13、本書§11 | 約2.5／3.5回/分を撤回。4経路各0.25回/分から、受信約1回/分、MQTT導入後はstate約1＋publisher heartbeat約1で計約2回/分と試算。POST数とpublish数の実測は今後実施 |
| §12.3-1 too_large状態  | 計画§8           | 状態表に配信サイズ超過、HTTP照合、失敗時の正常値維持、最新state配信後の解除を追加                                                                            |
| §12.3-2 publish前判定  | 計画§7           | JSON直列化後のUTF-8バイト数を検査し、超過payloadをMQTTクライアントへ渡さない手順を明記                                                                       |
| §12.3-3 非retained通知 | 計画§6・§7       | 接続前のtoo_large通知は再配信されないため、初回HTTP照合と次のheartbeatを待つ。未確認retained値を最新扱いしない                                               |
| §12.3-4 確認範囲       | 計画§2・Phase 0  | 今回再測定した5対象と、未再測定のポート・Serve・Fire・API状態を区別                                                                                          |

再測定結果:

| 対象                                  | UnitFileState | ActiveState／SubState |
| ------------------------------------- | ------------- | --------------------- |
| `fire-dashboard-usage-sender.service` | disabled      | inactive／dead        |
| `fire-dashboard-codex.service`        | enabled       | active／running       |
| `fire-dashboard-antigravity.timer`    | enabled       | active／waiting       |
| `fire-dashboard-hermes-nous.timer`    | enabled       | active／waiting       |
| `fire-dashboard-opencode-go.timer`    | enabled       | active／waiting       |

共有senderの停止理由は今回確認していない。将来これを有効化する場合はwrapperとの重複を確認・解消してから切り替える。timerのactiveは直近の収集・送信成功を証明しないため、Phase 0で実POSTと成功状態も確認する。

§12への文書対応は対処済み（2026-10-15）。実装、MQTT通信・負荷の実測、Fire実機検証、本番配備は未実施。

## 14. 第4回監査 — §12反映版（2026-10-15）

§13で§12の指摘を反映した計画（第4版）を再度監査した。ディスク上の計画本文と本書を読み、§13の再測定値を独立に `systemctl --user` の有効化・稼働状態と wrapper 実体で照合した。

結論: §12の指摘はすべて正確に反映され、新規の指摘は無い。設計・記述とも実装着手可能な水準で、残るのはPhase 0の実測確定のみ。任意の軽微な補足を2点挙げるが、いずれも設計判断を伴わず未対応でもPhase 0で解消可能。

### 14.1 §12指摘の反映確認

| §12指摘                      | 反映先                    | 検証                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12.2 送信経路目録（wrapper） | 計画§2、Phase 0本文・目録 | 一致。「3つの収集wrapperは、それぞれcapture後に `fire-dashboard-send-once.mjs` でPOSTする。同スクリプトに差分判定はない」へ訂正。wrapper実体（`~/.local/libexec/fire-dashboard-{antigravity,hermes-nous,opencode-go}` が `send-once.mjs` を無条件POST）と一致 |
| 12.2 共有sender              | 計画Phase 0・目録         | 一致。「共有senderはdisabled／inactiveで、この60秒再送経路を現在の頻度に含めない」「有効化する場合はwrapperとの重複送信を解消」へ訂正                                                                                                                         |
| 12.2 頻度見積り              | 計画§13                   | 一致。「4経路が各約0.25回/分 → 受信約1回/分 → state約1＋heartbeat約1で約2回/分」へ訂正し、旧2.5／3.5を明示撤回。算術も一致                                                                                                                                    |
| 12.3-1 too_large状態         | 計画§8（状態表）          | 一致。状態表に行を追加し、HTTP照合・失敗時の正常値維持・最新state配信後の解除を記載                                                                                                                                                                           |
| 12.3-2 publish前判定         | 計画§7                    | 一致。JSON直列化後のUTF-8バイト数を上限と比較してからpublishへ渡す旨を追加                                                                                                                                                                                    |
| 12.3-3 retain:false通知      | 計画§6・§7                | 一致。接続前のtoo_large通知は再配信されないため初回HTTP照合＋次のheartbeatを待ち、未確認retained値を最新扱いしない                                                                                                                                            |
| 12.3-4 確認範囲              | 計画§2・Phase 0           | 一致。再測定した5対象と未再測定（ポート・Serve・Fire・API状態）を区別                                                                                                                                                                                         |

再測定値の独立照合: 本書§13の表（usage-sender=disabled／inactive、codex=enabled／active、3 timer=enabled／active）は、監査側の `is-enabled`／`is-active` 実測と一致した。目録の「設定ファイル内容」と「稼働状態」の分離も妥当。

整合性チェック（第4版全体）: §6（retain:false注記）↔§7（too_large手順）↔§8（状態表の行）が一致。§7.1の単一in-flight ↔ Phase 2のPUBACK試験 ↔ §14の境界試験が一致。§13の頻度試算 ↔ Phase 0目録 ↔ §2の区別が一致。先頭7行規約・参照リンクも維持。

### 14.2 任意の軽微な補足（ブロッカーではない）— 計画への反映済み（2026-10-15、§15）

1. state publishのタイムアウト値をheartbeat 180秒より短く明記: §7.1は「publishタイムアウト時に接続終了→再接続」と定めるが値が未指定。180秒より長いと、publishが詰まる間に§8の「heartbeat 180秒なし＝配信停止」を誤検知し得る。あわせて、heartbeat送信がstateの単一in-flightから独立していること（詰まったstateでheartbeatが遅延しないこと）を一文で明記すると§7.1と§8の関係が閉じる。
2. quadletのloopback公開を明記: §13はrootless Podman quadletを第一候補とするが、loopback限定を保つには `PublishPort=127.0.0.1:<mqtt>:...` 形式が必要（既存ntfyの `PublishPort=127.0.0.1:8255:8255` と同作法）。Phase 0／§13に一文あると、`/mqtt` のloopback要件をquadlet側でも検証できる。

### 14.3 第4回監査の総評

| 観点                     | 初回   | 再監査   | 再々監査     | 第4回            |
| ------------------------ | ------ | -------- | ------------ | ---------------- |
| 既存実装との整合         | 良好   | 良好     | 良好         | 良好             |
| 順序制御・鮮度・切り戻し | 良好   | 良好     | 良好         | 良好             |
| 母艦運用ゲート認識       | 部分   | 良好     | 良好         | 良好             |
| 数値根拠                 | 要修正 | ほぼ解消 | 齟齬（12.2） | 解消（実測整合） |
| ドキュメント規約         | 要修正 | 良好     | 良好         | 良好             |

指摘は初回15件 → 再監査1件＋残存6件 → 再々監査 中1件 → 第4回 0件と収束した。計画はGMKtecの実構成（入口=tailscale serve :8444、API=127.0.0.1:18787、収集=3 wrapper＋codex、共有sender停止）と整合し、設計・ゲート・切り戻し・検証が揃う。次段階はPhase 0の読み取り専用確認とする。本書は計画の実装・配備完了を意味しない。

## 15. 第4回監査の任意補足への対応（2026-10-15）

§14の「新規必須指摘なし」を維持し、任意補足2点を計画へ反映した。今回は計画の該当節と既存ntfy quadletの `PublishPort=127.0.0.1:8255:8255` を読み取り専用で確認した。稼働状態やネットワークの追加実測は行っていない。

| 補足                               | 反映先                | 対応内容・今後の検証                                                                                                                                                                                 |
| ---------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §14.2-1 publish期限・heartbeat独立 | 計画§7.1、§8、Phase 2 | stateのPUBACK完了期限を30秒に指定。heartbeatの60秒タイマー・送信はstateのACK待ちから独立させ、自身も最大一件・30秒期限とする。state／heartbeatのACK停止、再接続、古いheartbeatの非再送を統合試験する |
| §14.2-2 quadletのloopback公開      | 計画Phase 0、§13      | MQTT／WSそれぞれのPublishPortに127.0.0.1を明示。コンテナ内bindとの違いを補足し、実効設定・loopback疎通・未許可LAN拒否を確認する                                                                      |

独立させるのはアプリケーションの待機・タイマー制御であり、同じ接続の通信障害まで分離できるという意味ではない。heartbeat受信と最新stateの配送成功は引き続き区別する。PublishPortの例は構文のみで、実ポートはPhase 0で確定する。

§14への文書対応は反映済み（2026-10-15）。追加の監査ブロッカーは報告されていない。次段階はPhase 0であり、MQTT実装・負荷測定・実機検証・本番設定変更は未実施。

## 16. 第5回監査 — §14補足反映版（2026-10-15）

§15で§14.2の補足を反映した計画（第5版）を監査した。ディスク上の計画本文を読み、§13のquadlet記述をホストの実quadlet（`~/.config/containers/systemd/{ntfy,searxng}.container`）と照合した。

結論: §14.2の補足2点は正確に反映され、新規の指摘は無い。設計は実装着手可能な水準で収束している。任意の文言補足を2点挙げるが、いずれも設計判断を伴わず未対応でもPhase 0／実装で解消可能。次段階はPhase 0。

### 16.1 §14.2補足の反映確認

| 第4回の補足                             | 反映先                | 検証                                                                                                                                                                                   |
| --------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14.2-1 state publish期限／heartbeat独立 | 計画§7.1、§8、Phase 2 | 一致。stateのPUBACK完了期限30秒、heartbeatをstateの単一in-flightから独立、heartbeat自身も最大一件・30秒期限・失敗時再接続。Phase 2にPUBACK遅延試験を追加。30<60<180の整合も維持        |
| 14.2-2 quadlet loopback公開             | 計画§13、Phase 0      | 一致。`PublishPort=127.0.0.1:<host>:<container>` 明示、既存ntfyと同じホスト側loopback指定、0.0.0.0公開・host networkで代用しない。Phase 0で実効設定・loopback疎通・未許可LAN拒否を確認 |

ホスト実測との照合: `ntfy.container` は `PublishPort=127.0.0.1:8255:8255`、`searxng.container` は `PublishPort=8888:8080`（意図的LAN公開）。計画の参照・警告は実体と一致。

整合性チェック（第5版）: §5.3「切断中は最新状態一つ」↔§7.1「未接続時はpublishせず最新一件を保持」↔§8「切断中のheartbeatを蓄積して復帰後にまとめて送らない」が一致。§7のtoo_large手順↔§8の状態表↔§7.1の期限が一致。矛盾は検出されなかった。

### 16.2 任意の文言補足（ブロッカーではない）— 計画への反映済み（2026-10-15、§18）

1. 30秒タイムアウトでの接続終了は正常切断にする: §7.1／§8は「接続を終了して再接続」と定めるが切断方法が未指定。LWTは非正常切断でのみ発火するため、意図した再接続で強制destroyすると `availability` が一時的に `offline` になり、§8の「publisherのoffline → 配信停止表示」が一瞬出得る。`mqtt.js` の `client.end()`（DISCONNECT送信）で正常切断しLWTを発火させない旨を一文追加すると、state／availabilityのflappingを防げる。§8は既に「heartbeat＝生存確認、retained onlineは生存の断定に使わない」と分離している。
2. コンテナ内listenerのbindをより明示: §13の「ポート転送を受けられるインターフェースへbind」は方向として正しいが、rootless Podmanのポート公開はコンテナ側IPへDNATするため、コンテナ内では0.0.0.0（またはコンテナIF）へbindする必要があり、コンテナ内で127.0.0.1にbindするとホストからの転送が届かない。host側loopback制限は `PublishPort=127.0.0.1:...` 側である、という対応関係を一文補うと誤解を防げる（Mosquittoの `listener <port> 0.0.0.0` 相当）。

いずれも設計・Phase分割・受け入れ条件を変えない補足。

### 16.3 第5回監査の総評

| 観点                     | 初回   | 再監査   | 再々監査 | 第4回 | 第5回                                  |
| ------------------------ | ------ | -------- | -------- | ----- | -------------------------------------- |
| 既存実装との整合         | 良好   | 良好     | 良好     | 良好  | 良好                                   |
| 順序制御・鮮度・切り戻し | 良好   | 良好     | 良好     | 良好  | 良好（publish／heartbeat期限を明文化） |
| 母艦運用ゲート認識       | 部分   | 良好     | 良好     | 良好  | 良好（quadlet loopbackを明文化）       |
| 数値根拠                 | 要修正 | ほぼ解消 | 齟齬     | 解消  | 解消                                   |
| ドキュメント規約         | 要修正 | 良好     | 良好     | 良好  | 良好                                   |

指摘は初回15件 → 再監査1件＋残存6件 → 再々監査 中1件 → 第4回0件 → 第5回0件と収束し、プラトーに達した。これ以上の反復監査は新規の設計上の発見を生む可能性が低く、実装前の残作業はPhase 0の読み取り専用確認のみ。計画はGMKtecの実構成（入口=tailscale serve :8444、API=127.0.0.1:18787、収集=3 wrapper＋codex、共有sender停止、quadlet＝ntfy方式）と整合する。本書は計画の実装・配備完了を意味しない。

## 17. 第6回監査 — 実コード再照合（2026-10-15）

計画本文（第5版）を、`services/aggregator/src/{server,auth-tailscale,store,config}.ts`、`apps/dashboard/{index.html,src/App.tsx,src/sw.ts,src/data/client.ts}`、`package.json` と読み取り専用で再照合した。ホストの稼働状態・Serve設定は再測定していない。

結論: 計画の事実記述（bodyLimit 65536、client.tsの `2 * 1024 * 1024`、`authorize(request, "reader")`、`FIRE_READER_LOGINS`、Store `inspect`、CSP `connect-src 'self'`、SWの `/api/` bypass、30秒ポーリング、既定ポート8787、MQTT依存なし）はすべてコードと一致する。設計の破綻は無い。ただし、これまでの監査で扱っていない簡素化案1件と、軽微な指摘2件がある。

### 17.1 指摘 — 計画への反映済み（2026-10-15、§18）

1. **【中・簡素化】`/mqtt` の追加ではなく、既存の `/api` 配下へ置けば sudo のServe変更を避けられる可能性がある。** 現行Serveは `/api` を `127.0.0.1:18787/api` へ中継しており、gatewayは同じaggregatorプロセスに置く計画（§11、§13）である。gatewayのパスを `/api/v1/usage/stream` などにすれば、Serveの経路追加（Phase 5のsystem／sudo変更、§15.2-1の復元）が不要になり得る。前提は、Serveが既存の `/api` 中継でWebSocket upgradeと `Tailscale-User-Login` を転送することで、これはPhase 0で確認できる。成立する場合は、§4・§9.1-1・Phase 5・§15.2・§16の該当箇所を書き換える。成立しない場合だけ `/mqtt` 案を残す。SWは `/api/` をbypassするが、WSはfetchイベントを通らないため影響しない。
2. **【低】既存のonRequestフックをupgradeへ流用する場合、Origin欠落を許可してしまう。** `server.ts:85` は `if (origin && !allowed.includes(origin))` のため、Originが無い要求を通す。計画§9.1-3の「欠落・不一致は拒否」はこれより厳しい。`@fastify/websocket` はupgradeでもFastifyのonRequestフックを実行するため、reader判定（GET→reader）は自動で効く。一方、Origin必須の判定はWSルート側に追加が必要である。§9.1の「自動で通るとは限らない」は、生の `ws` の `upgrade` イベントでは通らず、`@fastify/websocket` では通るが、Originの判定が緩い、と具体化する。
3. **【低・文書状態】第5回監査§16.2の任意補足2点が計画に未反映。** 計画L8は「監査§14の任意補足まで反映」のままである。§7.1には切断方法（`client.end()` による正常切断でLWTを発火させない）が無く、§13にはコンテナ内bind（0.0.0.0、ホスト側の制限は `PublishPort=127.0.0.1:…`）の明記が無い。

### 17.2 総評

事実整合は良好で、新規の設計ブロッカーは無い。17.1-1を採用すると、system層の変更と承認ゲートが1つ減り、§16で「プラトー」とした計画をさらに縮小できる。17.1-1の成否はPhase 0の読み取り専用試験（既存 `/api` 経路へのupgrade試行と、ヘッダー転送の確認）で判定できる。本書は計画の実装・配備完了を意味しない。

## 18. 第5回・第6回監査への対応（2026-10-15）

§16.2の任意補足と§17.1の指摘を計画へ反映した。今回、実コードのonRequestがOrigin欠落を通すことと、GETをreaderとして認可することを `server.ts` で再確認した。ホストのServe設定・稼働状態・通信は再測定していない。以下は設計・文書の対応であり、経路成立やライブラリ挙動の実証ではない。

| 指摘                 | 反映先                                  | 対応と未検証事項                                                                                                                                                       |
| -------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §16.2-1 正常切断     | 計画§7.1、§8、Phase 2                   | 意図した再接続では正常切断を最大5秒試行し、完了しなければ強制終了。採用MQTT.js版で未確認QoS 1待ちを検証し、DISCONNECT到達時のLWT非発火と強制終了時のoffline回復を試験  |
| §16.2-2 コンテナbind | 計画§13                                 | コンテナ内は0.0.0.0または転送先IF、ホスト公開はPublishPortの127.0.0.1という対応を明記。コンテナ内loopbackのみでは転送を受けられないと補足                              |
| §17.1-1 既存/api経路 | 計画§4、§9.1、Phase 0／3／5、§15.2、§16 | `/api/v1/usage/stream` を第一候補とし、成立時はServe変更・その復元を不要にした。`/mqtt` は不成立時だけの代替とし、その場合の承認・バックアップ規則を維持               |
| §17.1-2 Originとhook | 計画§9.1、Phase 3                       | 生wsのupgradeは認可・Originを明示実行。Fastifyプラグイン方式ではonRequestを再利用しつつ、WSルートでOrigin必須の厳密判定を追加。採用版のhook順序と101応答前の検査を確認 |
| §17.1-3 文書状態     | 計画冒頭、本書冒頭・§16.2・§17.1・§18   | 最新反映範囲と対応先を更新。過去の監査本文は当時の所見として維持                                                                                                       |

技術上の補足:

- `client.end()` 相当の正常終了は未確認QoS 1の完了待ちで停止し得るため、正常切断だけを必須とすると30秒タイムアウトの目的を失う。最大5秒の終了期限を設け、通信不通時のLWT非発火を保証しない。アプリケーションの再接続意図だけではブローカーに正常終了を伝えられない場合がある。
- 現在のgatewayルートは未実装である。既存 `/api` への非変更のupgrade試行だけで、Mosquittoまでの接続・ヘッダー・reader認可が成立すると証明できない。Phase 0は設定・仕様・可能な試行の結果を記録し、Phase 3で実装後の経路を最終確認する。調査のための本番ルート追加を読み取り専用操作として扱わない。
- 第一候補の成立を確認するまでは「Serve変更不要」を実測済み事実としない。成立後に使う経路を確定し、代替案を採用する場合だけ具体的なServe差分の承認へ進む。

§16・§17への文書対応は反映済み（2026-10-15）。次段階はPhase 0の確認。アプリケーション実装・本番設定変更は未実施。

## 19. 第7回監査 — §18反映版（2026-10-15）

§18で§16.2・§17.1を反映した計画（第6版）を監査した。計画全文を読み、`server.ts` のonRequest（L59〜）と `gmktec-change-control` §2.3・§4を読み取り専用で照合した。ホストのServe設定・稼働状態は再測定していない。

結論: §18の5項目は正確に反映され、§4図・§9.1・Phase 0／3／5・§15.2・§16の間で `/api/v1/usage/stream` 第一候補と `/mqtt` 代替の扱いが一貫している。5秒の正常切断期限は30秒publish期限・180秒停止判定と矛盾しない。新規の設計ブロッカーは無い。ただし、§17.1-1の採用に伴って生じた軽微な指摘が2点ある。

### 19.1 指摘 — 計画への反映済み（2026-10-15、§20）

1. **【低〜中・運用ゲート】「Serve変更なし＝承認ゲートなし」と読める。** 計画Phase 5（L398）は、`/api` 経路が成立すれば「Serve変更の承認ゲートは発生しない」とする。change-control §4の(d)は、sudoの要否ではなく「ネットワーク露出を増やす変更全般」を対象にしている。既存のtailnet-only listener・同じreader集合へのルート追加は、bindやLAN公開の拡大には当たらないと判断できる。一方で、tailnetからブローカーへ届く新しいプロトコル面が開く。判断を暗黙にせず、「露出拡大に該当しないと判断した根拠（listener・公開範囲・利用者集合が不変、readerのみ、ACLはread専用）」をPhase 5へ明記し、`network-exposure-audit.md` へ記録することを完了条件にする。判断に迷う場合は(d)として扱う。同じ理由で、L401の「公開経路の変更内容をレビュー」は `/api` 案では「新規WSSエンドポイントの露出判定をレビュー」とするのが正確である。
2. **【低・実装方式】`@fastify/websocket` で「上流確認後に下流101」を満たす位置が未指定。** 同プラグインは、ルートのフック（onRequest／preValidation／preHandler）の後で `handleUpgrade` を行い、101を返してからwebsocketハンドラーを呼ぶ。このため、ハンドラー内で上流Mosquittoへ接続すると§9.2の順序（上流で `mqtt` 選択を確認してから下流へ101）を満たせない。上流接続はpreHandlerなど101前のフックで確立してrequestへ受け渡し、subprotocolは `handleProtocols` で `mqtt` を選ぶ必要がある。生の `ws`（`noServer` と自前のupgrade処理）であれば、認可・Origin・上流接続の後に `handleUpgrade` を呼ぶだけで順序を作れる。§9.1末尾とL248の「採用版のhook順序を統合試験する」に、上流接続をどこで確立するかを1文加える。プラグインの挙動は採用版で確認する（現リポジトリには未導入）。

どちらも設計・Phase分割・受け入れ条件を変えない補足であり、Phase 0着手を妨げない。

### 19.2 総評

指摘は第4回以降、新規の必須事項が0件のまま推移している。§17.1-1でsystem層の承認ゲートを一つ外せる見込みになった。19.1-1はその反面として、露出判定を明示的に記録しておく注意点である。計画は実装着手可能な水準で収束している。これ以上の机上監査で得られるものは少なく、残る不確実性（Serveのupgrade転送、ヘッダー付与、Fire WebViewのWSS／CSP、Mosquittoのlistener別ACL）はPhase 0／3の実測でしか解消できない。本書は計画の実装・配備完了を意味しない。

## 20. 第7回監査への対応（2026-10-15）

§19.1の2点を計画へ反映した。計画の該当箇所と `gmktec-change-control` §4の露出拡大規則を確認した。今回はホストの設定・稼働状態・通信を再測定しておらず、WSライブラリも未導入。対応は文書段階であり、配備の露出判定やhook動作を検証済みとするものではない。

| 指摘                   | 反映先              | 対応と受け入れ条件                                                                                                                                                                                                                        |
| ---------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §19.1-1 露出判定       | 計画Phase 5         | Serve設定の変更要否と、新しいWSS面の露出判定を分離。非拡大とする場合はlistener・公開範囲・許可ログイン不変、reader／Origin検査、read専用ACL、管理・publish面を公開しないことを根拠としてレビュー。拡大または判断に迷う場合は(d)として扱う |
| §19.1-1 記録           | 計画Phase 5完了条件 | 採用経路の判定・根拠・正負の検証を `network-exposure-audit.md` へ記録。承認対象なら承認内容・差分も記録する。現時点で同ホスト文書は変更していない                                                                                         |
| §19.1-2 上流確立の位置 | 計画§9.1、Phase 3   | Fastify方式は検査後のpreHandlerで上流を確立してrequest経由で渡し、handleProtocolsでmqttを選択。生ws方式はnoServerの自前upgradeで検査・上流確認後にhandleUpgrade。101後のハンドラーで上流接続を始めない                                    |

接続ライフサイクルも計画に明記した。上流接続待ちには上限時間を設け、失敗・下流中断・upgrade拒否時に確保済み上流を解放する。Phase 3では上流確認より先に101を返さないことと、失敗時の非101応答・接続解放を採用ライブラリ版で試験する。

§18の「Serve変更不要」はServe設定変更そのものを避ける案についての記録であり、露出判定を省略できる意味ではない。§19への文書対応は反映済み（2026-10-15）。実装・本番設定変更は未実施。
