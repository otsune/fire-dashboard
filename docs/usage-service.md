# AI usageバックエンド

AIサービスの利用状況を収集・集約し、HTTPとMQTTで数値を提供する独立サービスです。Fire Dashboardは利用先の一つです。他の表示機器は、Fireの画面・天気・RSSを起動せず購読できます。

## 成果物と起動

Node.js 24を推奨します。リポジトリで依存を準備し、用途ごとにビルドします。

```sh
rtk npm ci
rtk npm run build:usage
rtk npm run build:collectors
```

バックエンドは `dist/usage/start.mjs`、認証モジュールは `dist/usage/auth-tailscale.mjs`、移行ツールは `dist/usage/migrate.mjs` です。これらはバンドル済みで、実行先にFireのソース、React、天気・RSSの設定、node_modulesは不要です。設定と秘密は別途配置します。`dist/collectors` はログイン済み収集元PCで実行します。

```sh
rtk proxy env \
  USAGE_AUTH_MODULE=/srv/ai-usage/auth-tailscale.mjs \
  USAGE_PUBLIC_ORIGIN=https://usage.example.net \
  USAGE_CONFIG=/srv/ai-usage/config.json \
  USAGE_STATE_FILE=/srv/ai-usage/state.json \
  USAGE_READER_LOGINS=reader@example.net \
  USAGE_COLLECTOR_TOKENS_FILE=/srv/ai-usage/collector-hashes.json \
  USAGE_READER_TOKENS_FILE=/srv/ai-usage/reader-hashes.json \
  USAGE_PORT=8788 \
  node /srv/ai-usage/start.mjs
```

パス・ドメイン・ログイン名は例です。待受けは `127.0.0.1:8788`。HTTPS配信、Tailscale Serve、Mosquitto、常駐登録は別途設定します。サービスの環境に `FIRE_*` がある場合は起動を拒否します。旧変数を自動継承して別の状態ファイルを作ることを防ぐため、usageサービス用の環境を用意してください。

同梱の認証モジュールは信頼されたTailscale ServeからのreaderログインとBearerトークンを検証します。外部から偽装された `Tailscale-User-Login` を入口が除去・上書きすることと、同居プロセスを信頼できることが前提です。他の認証方式では `authorize(request, role)` と `sourceAlias(request)` をexportするESMモジュールを指定します。

## 設定と資格情報

`services/usage/config.example.json` を元に作成します。MQTTを有効にする例：

```json
{
  "preferredSources": {
    "claude": ["desk", "note"],
    "codex": ["desk"]
  },
  "mqtt": {
    "enabled": true,
    "url": "mqtt://127.0.0.1:1883",
    "topicPrefix": "ai-usage/v1/main",
    "credentialsFile": "/srv/ai-usage/publisher.json"
  },
  "gateway": {
    "enabled": true,
    "url": "ws://127.0.0.1:9001/mqtt",
    "maxConnections": 8
  }
}
```

- `preferredSources` は受入れ可能なPCのalias。同一アカウントの値は合算せず、正常値保持・観測時刻の比較で選びます。
- `collector-hashes.json` は `{"desk":"<SHA-256 hex>"}`。`rtk node scripts/new-collector-token.mjs desk` で発行した生トークンは収集元PCだけに置きます。
- `reader-hashes.json` は `["<SHA-256 hex>"]`。Fire中継やネイティブHTTP利用側の専用トークンのハッシュです。readerトークンはcollectorと別に発行します。同じハッシュの兼用は起動時に拒否します。readerトークン発行にも上のスクリプトを別aliasで使えますが、保存形式はキー付きobjectではなくハッシュの配列にしてください。
- Fire側のreader資格情報は `{"token":"<生readerトークン>"}`。サービスユーザー所有・0600のファイルに置きます。ブラウザーには渡しません。
- `publisher.json` は `{"username":"<publisher>","password":"<MQTT password>"}`。サービスユーザー所有・0600で置きます。欠落・不正時はpublisherだけを無効化し、HTTP収集は続けます。

認証ハッシュファイルもサービスユーザーだけが読める0600で配置してください。collectorが1つ以上、readerログインまたはreaderトークンが1つ以上必要です。全プロバイダーのアカウント資格情報は収集元PCに留めます。

## 収集器

[収集手順](collectors.md)と[プロバイダー別手順](provider-usage.md)を使います。既存CLIとの互換のため、収集器の環境変数名は `FIRE_ENDPOINT`、`FIRE_COLLECTOR_TOKEN_FILE`、`FIRE_SNAPSHOT_PATHS` などを維持しています。`FIRE_ENDPOINT` をusageサービスのHTTPS `POST /api/v1/usage` に変更します。これらはusage API自身の起動環境へ渡しません。

旧Fire APIのPOST入口は、認証とalias検査後にusageサービスへ中継できます。切替中の互換経路です。Fire停止中にも収集を継続したいPCは、新サービスのHTTPS入口へ直接送信してください。

## HTTP API

| 経路                       | 権限               | 内容                                                   |
| -------------------------- | ------------------ | ------------------------------------------------------ |
| `POST /api/v1/usage`       | collector          | 既存のsnapshotId、sequence、sourceAlias、payloadを受信 |
| `GET /api/v1/usage`        | reader             | MQTT stateと同一の配信snapshot                         |
| `GET /api/v1/mqtt-status`  | reader             | publisher設定状態と接続・PUBACK・エラー分類            |
| `GET /api/v1/health`       | reader             | サービス生存確認                                       |
| WSS `/api/v1/usage/stream` | reader＋許可Origin | MQTT v3.1.1購読用、subprotocol `mqtt`                  |

HTTPは `Authorization: Bearer <role専用token>`、または同梱認証のreader用Tailscaleログインで認証します。collectorはPOST専用、readerは読取専用です。受信payloadは64KiB上限。生レスポンスや認証失敗の詳細を利用機器へ転送しません。

## MQTTとJSON契約

新規接頭辞は `ai-usage/v1/main`。既存Fire環境の移行では `fire-dashboard/v1/main` を明示設定して購読を維持します。

| 接頭辞からの相対トピック | QoS / retain | 内容                                             |
| ------------------------ | ------------ | ------------------------------------------------ |
| `usage/state`            | 1 / true     | 最新のusage全体                                  |
| `usage/heartbeat`        | 1 / false    | 60秒ごとの配信生存確認、revision、deliveryStatus |
| `usage/availability`     | 1 / true     | online／offline。異常終了時はLWT                 |

stateの例（すべて架空の値）：

```json
{
  "schemaVersion": 1,
  "streamId": "example-stream",
  "revision": "12",
  "publishedAt": "2026-10-22T00:00:00.000Z",
  "usage": [
    {
      "schemaVersion": 1,
      "provider": "claude",
      "status": "ok",
      "sourceAlias": "desk",
      "sourceObservedAt": null,
      "capturedAt": "2026-10-21T23:59:00.000Z",
      "receivedAt": "2026-10-22T00:00:00.000Z",
      "freshness": "unknown",
      "lastSuccessAt": "2026-10-22T00:00:00.000Z",
      "errorCode": null,
      "buckets": [
        {
          "id": "rate",
          "label": "利用枠",
          "windows": [
            {
              "id": "five",
              "label": "5時間",
              "usedPercent": 30,
              "windowMinutes": 300,
              "resetsAt": null
            }
          ]
        }
      ]
    }
  ]
}
```

完全なスキーマは `packages/usage-contracts/src/index.ts` と `delivery.ts`。providerはclaude、codex、antigravity、opencode_go、hermes_nous、grok。`usedPercent` は0〜100の百分率、`windowMinutes` は分。任意のbalanceはUSD残高で、百分率へ変換しません。`null` は不明であり0ではありません。providerごとに最大1件です。

時刻はISO 8601。`sourceObservedAt` は元サービスが示す観測時刻、`capturedAt` は収集時刻、`receivedAt` は母艦受信時刻、`lastSuccessAt` は最後の正常受信。送信heartbeatは元観測時刻を進めません。`publishedAt` はその配信revisionの確定時刻です。retained値を受け取った時刻で観測時刻を置き換えないでください。

利用側は次を守ります。

1. UTF-8 payload上限（既定2MiB）とschemaVersionを検査し、不正値では最後の正常値を保持する。
2. 同じstreamIdのrevisionは10進文字列として比較する。最大39桁なのでJavaScriptのNumberに変換せずBigInt等を使う。重複は無視、小さいrevisionを採用しない。
3. streamIdが変わったら、認証付きHTTP GETで新系列を確認してから切り替える。MQTTだけでキャッシュ系列を入れ替えない。
4. 最後のheartbeatから180秒を超えたら配信停止を示す。retainedのonlineだけを生存の証拠にしない。availabilityのsentAtはLWT作成時刻の場合がある。
5. 取得元のreceivedAtが5分以上前なら収集停止を示す。枠リセットを過ぎた値は更新待ちとして扱う。配信停止と収集元停止は区別する。
6. heartbeatのdeliveryStatusがtoo_largeなら、上限を満たすHTTP応答を照合する。MQTT未送信の旧retained値を最新と扱わない。

## 別の表示機器で購読する

ネイティブクライアントは、配備環境で許可されたMQTT／MQTTS入口とread専用資格情報を使います。mosquitto_subの既定設定ファイル（通常は `~/.config/mosquitto_sub`、XDG_CONFIG_HOME指定時はその配下）に `-u display` と `-P <MQTT password>` を別行で保存し、0600にします。`display` は事前作成した購読専用ユーザーです。

```sh
rtk proxy mosquitto_sub -h 127.0.0.1 -p 1883 \
  -t 'ai-usage/v1/main/usage/+' -q 1 -v
```

ブラウザーは認証済みHTTPSとWSSを使い、MQTT.js等でsubprotocol `mqtt`、clean session、QoS 1、接続ごとに一意のclientIdを指定して同じ3トピックを購読します。Tailscale reader認証ならブラウザーへAPI用BearerやMQTT publisherの資格情報を埋め込む必要はありません。Fireは同一オリジンの既存WSS中継を使えます。

同じHTTPSオリジンで認証済みのブラウザー向け接続例です。MQTT.jsは利用側でバンドルします。

```js
import mqtt from "mqtt";
const prefix = "ai-usage/v1/main";
const client = mqtt.connect(`wss://${location.host}/api/v1/usage/stream`, {
  protocolVersion: 4,
  clean: true,
  clientId: crypto.randomUUID(),
  timerVariant: "native",
});
client.on("connect", () => {
  client.subscribe(
    ["state", "heartbeat", "availability"].map(
      (name) => `${prefix}/usage/${name}`,
    ),
    { qos: 1 },
  );
});
// messageでは上記のサイズ・スキーマ・系列・revision・鮮度を検査してから表示する。
// 画面終了時は client.end(true) で接続を解放する。
```

Mosquittoは外部サービスです。TCPのpublisher listenerは認証必須・対象3トピックwrite専用、gateway側の匿名WS listenerはloopback限定・対象3トピックread専用にします。gatewayはMQTTフレームを中継し、ACLはbrokerが強制します。他機器からの直接接続には、許可されたTLS／VPN経路や認証付き中継を別途用意します。本ソフトはlistenerやLAN公開設定を自動変更しません。

## Fireの接続設定

Fire用 `FIRE_CONFIG` に追加します。usageサービスの `USAGE_PUBLIC_ORIGIN` はFire中継が付けるOriginと一致させます。

```json
{
  "weather": null,
  "feeds": [],
  "usageService": {
    "baseUrl": "http://127.0.0.1:8788",
    "readerCredentialsFile": "/srv/fire-dashboard/usage-reader.json",
    "timeoutMs": 2000,
    "maxBytes": 2097152,
    "gatewayEnabled": true,
    "maxConnections": 8
  }
}
```

FireのWSS中継はバックエンドの既定パス `/api/v1/usage/stream` を使います。Fireで利用する場合はusage側の `gateway.path` を変更しないでください。

接続先は明示設定したHTTPSオリジン、またはloopback HTTPだけです。URLに資格情報・query・fragmentを含めません。FireはGETに専用readerトークンを使い、collector中継には元collectorのBearerだけを使います。クライアントのTailscaleヘッダーや指定URLをバックエンドへ転送しません。

未設定なら時計・天気・RSSは動き、usageは未設定になります。バックエンド停止時は取得済み数値と時刻を保持し、`usageConnection: unavailable` を画面に示します。Fire再起動直後の未取得値は空で、端末側の保存値は既存キャッシュ規則で保持します。Fireはusage正本を更新しません。

既存Fireは `?usageMqtt=1`、旧接頭辞 `fire-dashboard/v1/main` を引き続き使います。新規接頭辞へ変える場合、Fire購読側も揃える必要があります。まず旧接頭辞のまま移行してください。旧Fire設定の `mqtt.enabled: true`／`gateway.enabled: true` は起動時に拒否し、黙って配信を停止しません。

## 状態移行と切り戻し

本番サービス・設定は今回変更していません。配備時には次の順に行います。

1. 旧usage受信と旧publisherを停止し、旧state・設定・起動環境をバックアップする。
2. 旧stateを、まだ存在しない新ファイルへ変換する。

```sh
rtk node dist/usage/migrate.mjs --from /backup/fire-state.json --to /srv/ai-usage/state.json
```

3. 新サービスにcollectorハッシュ・preferredSources・readerハッシュ・publisher資格情報を設定する。トピックは旧 `fire-dashboard/v1/main` を明示する。新旧publisherを同時起動しない。
4. 新usageサービスを起動し、認証付きGETと独立MQTT購読で値・streamId・revisionを照合する。
5. Fireを新 `usageService` 設定へ切り替える。旧mqtt/gateway有効設定を除き、Fireをビルド・起動する。
6. collectorのHTTPS送信先を段階的に新サービスへ直接変更する。旧Fire中継は移行期間だけ利用する。

変換は元ファイルを変更せず、既存の出力先を拒否します。streamId・revision・各PCのsequence・保持値を移します。配信metadataがない古い形式では、新streamId・revision0を生成します。変換時は書き手を止め、変換途中の受信を失わないようにします。

切り戻し時も新サービスの受信・publisherを停止し、**最新**usageを旧形式へ戻します。移行前backupだけへの復帰は、新しい観測を失います。

```sh
rtk node dist/usage/migrate.mjs --from /srv/ai-usage/state.json \
  --restore-legacy /backup/fire-state.json --to /srv/fire-dashboard/rollback-state.json
```

最新usage・revisionと、指定した旧ファイルの天気・RSSを組み合わせます。分離後に変更した天気・RSSも維持する場合は、その最新Fire状態ファイルを `--restore-legacy` に指定します。旧コードと設定へ戻してから旧publisherだけを起動し、collectorの送信先も戻します。さらに古いusageへ戻す場合はstreamIdを更新し、HTTP照合で端末を新系列へ移してください。

## 検証

```sh
rtk npm test
rtk npm run typecheck
rtk npm run build:usage
rtk npm run build:api
rtk npm run build:collectors
rtk npm run test:e2e
```

任意の実broker試験は、ローカルの `docker.io/library/eclipse-mosquitto:2` イメージとrootless Podmanを使います。外部からpullせず、ランダムなloopbackポート・一時トピック・一時資格情報で作成し、終了時にそのコンテナだけを削除します。

```sh
rtk proxy env USAGE_BROKER_TEST=1 npm test -- tests/integration/usage-broker.test.ts
```

通常の全体テストではこの1件をskipします。実broker試験はFireなしの配信、retain、broker再起動、reader publish拒否、Fire→usage→brokerのWSS中継を検証します。実機長時間試験や本番の公開経路確認は別途行います。
