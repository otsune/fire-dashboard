# AI usageサービスとFire Dashboardの分離設計案

作成: 2026-10-22（Asia/Tokyo）。状態: ユーザーレビュー前の提案。実装・本番配備は未実施。

## 目的

ユーザーの要件は、次の2つを分離し、前者を他の表示機器でも再利用できるようにすること。

1. AI usageの計測・集約と、MQTTブローカーによる数値の提供。
2. Fire HD 10でのダッシュボード表示。

Fire Dashboardを起動・ビルドせずにusageの収集・保存・配信が動作することを成功条件とする。別の表示機器は、公開されたデータ仕様と購読権限だけで数値と更新状態を取得できる。

## 現状

- `collectors/` に各プロバイダーの収集処理がある。
- `services/aggregator` がusage受信、取得元選択、永続化、MQTT publisher、WSS gateway、天気、RSSを担う。
- usageの永続化とpublisherは、天気・RSSも含む `Dashboard` を参照する。
- MQTTにはstate、heartbeat、availabilityがあり、revisionとstreamIdによる順序情報もある。
- 設定・トピックの初期値・起動メッセージがFire Dashboardの名称に依存する。

## 方式比較

| 方式 | 利点 | 制約 |
| --- | --- | --- |
| 同一リポジトリで独立サービス化（推奨） | 既存テストと収集器を利用しながら、別ビルド・起動・配備を検証できる | 依存とビルド成果物の境界を明示する必要がある |
| 最初から別リポジトリ化 | リリースと所有範囲が明確になる | 契約の配布・版管理と、両リポジトリをまたぐ移行が同時に必要になる |
| 既存サービスにusage専用起動フラグを追加 | 変更量が少ない | Dashboard型と保存形式への依存が残り、再利用の境界が曖昧になる |

## 推奨する構成

論理的な製品を「AI usageバックエンド」と「Fire Dashboard」に分ける。前者の内部には収集器、集約API、MQTT publisher／WSS gateway、外部のMosquittoがある。Mosquitto自体を新規実装する必要はない。

```text
各PCの収集器 → HTTPS → AI usageサービス → MQTTブローカー
                           ↑ 読取HTTP API       ↓
                       Fire向けAPI       Fire画面・他の表示機器
```

- `services/usage`：usage受信・取得元選択・usage専用保存・読取API・MQTT配信・認証付きWSS gateway。
- `packages/usage-contracts`：usage、受信envelope、配信snapshot、heartbeat、availability、revision比較。React、天気、RSS、Fire用設定への依存を持たせない。
- `collectors/`：usage契約だけを利用し、送信先を設定で指定する。既存の認証方式と収集元PCでの秘密保持を維持する。
- `services/aggregator`：Fire向けの天気・RSS・設定と画面用APIを担当する。usageは新サービスの認証付き読取APIから取得し、既存画面用レスポンスに組み立てる。
- `apps/dashboard`：Fireの時計・時報・画面・キャッシュとusage表示を担当する。
- Mosquitto：別プロセスとして維持し、usageサービスと表示機器に各々必要なACLを与える。

名前と配置は提案。まず同一リポジトリで分離し、バックエンド成果物がFireのソースを必要としないことを検証する。別リポジトリへの移動は初期範囲に含めない。

## 公開インターフェース

- HTTPS `POST /api/v1/usage`：既存envelopeとcollector認証・sourceAlias制限を維持する。
- HTTPS `GET /api/v1/usage`：usage配信snapshotを返すreader用API。MQTTと同じstreamId・revision・publishedAt・usageを返す。
- WSS `/api/v1/usage/stream`：ブラウザー向けMQTT購読入口。reader認証・Origin検査・購読専用制限を維持する。
- MQTT：設定した接頭辞の `/usage/state`、`/usage/heartbeat`、`/usage/availability` を公開契約とする。
- 接頭辞は設定可能とし、移行時は現在の `fire-dashboard/v1/main` を明示設定して既存購読を維持する。独立サービスの新規設定例には `ai-usage/v1/main` を使う。
- stateはQoS 1・retain、heartbeatは非retain、availabilityはretain・LWTを維持する。利用側は観測時刻と配信時刻を区別し、欠損を0として扱わない。
- ブラウザー以外のMQTT接続は配備環境で許可された経路・ACLを使う。既存loopback listenerを自動でLAN公開しない。

他の表示機器向けに、トピック、JSONのフィールド・単位、欠損・更新停止判定、重複・逆順・streamId変更の扱い、認証付き購読例を文書化する。例示データは架空であることを明記する。

## 保存と移行

usageサービスだけがusageの正本を更新する。新しい保存形式にはusage値、取得元ごとのsequence・観測時刻、streamId・revision・publishedAtを持たせ、Dashboard型を含めない。

旧状態ファイルからusage部分を別ファイルへ移す明示的な移行コマンドを用意する。元ファイルは上書きせず、既存の出力ファイルへの上書きを拒否する。移行時は旧usage受信とpublisherを停止して最終状態を固定し、streamIdとrevisionを維持する。新旧publisherを同一トピックで同時起動しない。

Fire向けAPIはusage正本を保持せず、新サービス停止時は最後の成功値と取得失敗を区別して返す。新サービスへの通信にはタイムアウトを設け、天気・RSSの応答を無期限に待たせない。Fireから直接利用しているMQTT状態確認経路も、新サービスへの認証付き中継として維持する。

新サービス受信開始後に旧版へ戻す場合、移行前のバックアップだけでは新しい観測を失う。切り戻しには最新usageを旧形式へ戻す手順を含め、巻き戻った状態を使う場合は新しいstreamIdを発行して端末の照合を行う。

## 障害時の動作

- Fire向けサービス停止中も、usageの受信・保存・MQTT配信は継続する。
- MQTT停止中もusage受信・保存・読取APIは継続し、復帰後に最新状態を再配信する。
- usageサービス停止時、表示機器は最後の値と更新停止を表示する。時計・時報・天気・RSSはそれぞれ既存の経路で継続する。
- 認証情報や会話内容は配信データに含めない。

## 検証と受け入れ条件

1. usageサービスをFireのアプリ・天気・RSSモジュールなしでビルド・起動できる。
2. Fire向けサービスを停止しても、収集器から送った観測を独立したMQTTクライアントで受信できる。
3. HTTPとMQTTが同じusage値・streamId・revisionを返す。
4. 既存の取得元選択、正常値保持、sequence検査、重複・逆順防止が維持される。
5. 状態移行後も配信順序と取得元情報が維持され、旧ファイルが変更されない。
6. broker停止・再接続、readerのpublish拒否、認証失敗、Origin拒否を検証する。
7. FireのHTTP取得・MQTT購読・更新停止表示と、時計・時報・天気・RSSの回帰確認を行う。
8. usageサービス用のビルド・起動・設定例・購読手順が独立して文書化される。

## 初期範囲外

他の表示機器用UIの作成、プロバイダー追加、複数アカウントの合算、ブローカーの冗長化、本番のlistener・ACL・Serve・systemd変更は含めない。本番移行は検証済み成果物と設定差分・バックアップ・切り戻し手順を用意して扱う。
