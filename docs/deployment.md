# 運用先への接続

画面・集約APIの公開配信や収集元PCへの導入は、このリポジトリだけでは自動設定されません。

本番は信頼されたHTTPSで画面とAPIを同一オリジンに置きます。readerはHttpOnly / Secure / SameSite=Strictの読み取り専用セッションで検証し、collectorは別の資格情報とサーバー側で関連付けたsourceAliasを検証します。セッション発行・ログイン管理はこのアプリに含みません。認証連携が未設定ならAPIを起動しません。

APIは127.0.0.1へバインドします。Originは明示したHTTPSオリジンだけ許可します。資格情報をURL、Vite環境変数、ブラウザー、RSS設定やログへ置かないでください。localhostでのUI試用は未設定カードのまま動き、実APIへのアクセス権は与えません。

config.example.jsonの初期天気地域・RSS・優先取得元を、実環境の管理者が確認して設定します。天気地域は初回読み込み後、後述の保存済み地域設定を優先します。有効な地域設定がnull、feedsが空ならそれぞれの外部取得は行いません。JMAはWeb用JSONのため構造変更の可能性があり、安定したAPI契約として扱いません。

認可モジュールの実装・配備、信頼済みHTTPS、Fire側の閲覧許可、収集元への配置は別途承認が必要です。公開ポート、自己署名証明書の警告回避、無認証運用は手順に含みません。

## 起動契約

環境変数は `FIRE_AUTH_MODULE`（既存の承認済みESM認可モジュールのパス）、`FIRE_PUBLIC_ORIGIN`（HTTPSオリジン）、任意の `FIRE_CONFIG` と `FIRE_STATE_FILE` です。認可モジュールは `authorize(request, role)` と `sourceAlias(request)` を公開します。roleはreader／collector、sourceAliasは認証済み主体からサーバー側で解決してください。リクエスト本文やクライアント指定ヘッダーをそのまま信用する実装にしないでください。

認可された配置後に `npm run start:api` を実行します。常駐させる場合は `npm run build:api` で単一ファイルにまとめ、`node dist/aggregator/start.mjs` を使います。`FIRE_AUTH_MODULE` には `dist/aggregator/auth-tailscale.mjs` を指定します。npm や tsx のプロセスが残らないので、常駐中のメモリが減ります。待ち受けは127.0.0.1の8787番です。他のサービスと重なる場合は `FIRE_PORT` で変更します。この背後に信頼された同一オリジンのHTTPS配信が必要です。システムサービス登録やリバースプロキシの設定はこの成果物では変更していません。

`preferredSources` の各値は1つのsourceAliasか、その配列です。利用上限はアカウント単位なので、配列に挙げた全PCから受け付け、最も新しい観測を表示します。比較には収集時刻を使い、受信時刻より未来の収集時刻は受信時刻に丸めます。表示中ではないPCのエラーは、正常な表示値を上書きしません。

## Tailscale serve での配置例

常時稼働のLinux機で、tailnet内だけに公開する構成です。`FIRE_AUTH_MODULE` に `services/aggregator/src/auth-tailscale-module.ts` を指定します。

- reader: `tailscale serve` が付与する `Tailscale-User-Login` を `FIRE_READER_LOGINS`（カンマ区切り）と照合します。`Authorization` ヘッダー付きの閲覧は拒否します。
- collector: PCごとのBearerトークンで認証し、sourceAliasはトークンから決めます。同じユーザーのtailnet端末はログイン名が同じなので、ログイン名ではタブレットとPCを区別できません。
- トークンは `node scripts/new-collector-token.mjs <sourceAlias>` で発行します。表示されたトークンはPC側だけに置きます。サーバーにはハッシュだけを `FIRE_COLLECTOR_TOKENS_FILE` のJSON（`{"<sourceAlias>": "<sha256>"}`）として置き、権限を600にします。

入口はtailnet内専用のポートにします。Funnelを有効にしたポートやパスへ相乗りすると、画面とAPIがインターネットへ公開されます。画面の配信元（ビルド済み `apps/dashboard/dist`）と `/api` を同じオリジンにまとめ、`FIRE_PUBLIC_ORIGIN` をそのオリジン（例: `https://<host>.<tailnet>.ts.net:8444`）にします。

配備時に次の2点を確認します。

- 外部から偽の `Tailscale-User-Login` を付けて送り、serve が上書きまたは削除することを確認します。この確認が済むまで、このヘッダーを信頼しないでください。
- APIは127.0.0.1で待ち受けるため、同じ機械の他プロセスはヘッダーを偽装できます。管理者を有効にする場合は地域設定の書き込み権限も得られるため、同居プロセスを信頼でき、入口が確認済みの Tailscale Serve に限定されていることが前提です。ログイン名はユーザーを識別するもので、Fire と同一ユーザーの別端末を区別しません。

## usage の MQTT 配信

MQTT 配信は `FIRE_CONFIG` で指定する設定ファイル（例
`services/aggregator/config.example.json`）の `mqtt.enabled` と
`gateway.enabled` を個別に有効化できます。どちらも既定値は無効で、両方を無効に
した場合は従来どおり HTTPS の usage 集約だけを行います。publisherだけ、または
gatewayだけを有効にした状態は開発・検証用とし、本番ではbrokerとWSS経路の両方を
確認してから有効化してください。

`mqtt.url` は母艦の loopback MQTT listener（例 `mqtt://127.0.0.1:1883`）、
`gateway.url` は MQTT over WebSocket listener（例
`ws://127.0.0.1:9001/mqtt`）を指定します。publisher の資格情報は
`mqtt.credentialsFile` に指定したJSONファイルから読み込み、ブラウザーへ渡しません。
設定例の `/home/<service-user>/.config/fire-dashboard/mqtt-credentials.json` は
userサービスの実行ユーザーへ置き換えるプレースホルダーです。`/etc` 配下はsudoを
要するため、このuser層サービスの既定配置には使いません。このファイルはサービスユーザー
だけが読めるmode 0600相当で配置し、形式は
`{"username":"…","password":"…"}` とします。MQTT publisherを有効にする場合は
このファイルを必ず指定します。ファイルが欠落・不正な場合はpublisherだけを無効化して
APIとHTTP usage収集を起動し、サーバーログへ資格情報を含まない分類コードを出します。
認証済みreaderから `GET /api/v1/mqtt-status` を確認すると、publisherの状態（`ready`／
`disabled`）と安全な分類コードを取得できます。`runtime` には接続状態、接続回数、現在の
usage revision、stateの最後のPUBACK時刻とrevision、heartbeatの最後のPUBACK時刻、直近エラー種別（`publish_error`／`ack_timeout`／`connect_error`）と時刻、payload超過状態を
含めます。systemd userサービスでは同じ分類コードをjournalでも確認できます。読取権限エラーは
`mqtt_credentials_permissions` として分類します。
gatewayの同時接続数は `gateway.maxConnections`（既定8、最大256）で制限し、上限到達時は
WebSocket upgrade前に503を返します。切断後は枠を解放します。トピック接頭辞は
`fire-dashboard/v1/main` です。state と availability は QoS 1・retain、heartbeat は
QoS 1・非 retain で送信します。

表示端末は同一オリジンの `wss://<origin>/api/v1/usage/stream` へ `mqtt` サブプロトコルを
要求します。gateway は Tailscale の reader 認証と許可済み Origin を upgrade 前に検証し、
loopback broker の `mqtt` ネゴシエーションを確認してから下流へ 101 を返します。既存の
Tailscale Serve や Mosquitto の listener／ACL はこのリポジトリから変更しません。導入時は
publisher 用 write listener と gateway 用 read listener を分離し、reader が state 以外を
購読・publish できないことを確認してください。gateway は MQTT の username／password を
上流へ注入せず raw WebSocket frame を中継するため、read listener は loopback からだけ到達
できる匿名 read-only listener とし、ACLファイル先頭の匿名用 topic 行を state／availability／
heartbeat の read に限定します。TCP listener は `allow_anonymous false`、publisher用資格情報、
write ACLにします。ホストのport mappingもloopbackに限定し、`ss` と localhost／LANの正負疎通を
別々に取得してください。Mosquitto 2.1以降の listener別設定はバージョンの非推奨項目を確認し、
採用版の `listener_allow_anonymous` またはACL pluginの手順に合わせます。

ブラウザーのMQTT購読は既定で無効です。検証対象の端末だけURLに `?usageMqtt=1` を付けて
明示的に有効化します。指定がない端末は従来どおりHTTP pollingを使うため、gatewayを
無効化した状態でもMQTTへ再接続し続けません。

配信データの正本は `FIRE_STATE_FILE` の `streamId`／`usageRevision` です。MQTT state の
UTF-8 サイズ上限を超えた場合は state を途中送信せず、端末へ `too_large` heartbeat を通知し、
端末は HTTPS の revision を照合します。MQTT を有効化する前に開発用 broker で QoS、LWT、
切断復帰、reader 認証、Origin 欠落、`mqtt` 以外の subprotocol、上限超過を検証してください。

## Fully Kiosk 内での天気地域設定

天気カードまたは設定画面から、同じ画面内で予報地域と気温の代表地点を選びます。新しいタブ・位置情報権限・ブラウザーへの管理用秘密情報の保存は使いません。地域一覧は集約APIが気象庁の固定URLから取得し、ブラウザーは同一オリジンのAPIだけを利用します。

管理者の設定は既定で無効です。既存の `authorize(request, role)` の reader／collector 契約は変わりません。外部認可モジュールが任意の `authorizeAdmin(request)` を明示的に公開した場合だけ管理判定を行い、存在しなければ拒否します。Tailscale 用モジュールの `FIRE_ADMIN_LOGINS` は明示的な追加許可リストで、`FIRE_READER_LOGINS` にも含まれるログインだけが対象です。Authorization ヘッダーを伴う要求は、値が空でも管理者として扱いません。収集用トークンは管理用に転用できません。

このリポジトリ変更は実際の管理者指定、認可モジュールの配備、Tailscale や端末設定の変更を行いません。有効化は運用責任者が認可対象と入口の信頼性を確認した上で行う別の運用作業です。

- 閲覧者は現在のサーバー設定を確認できますが、地域一覧の取得・設定の保存は管理者専用です
- 保存は設定の revision が一致する場合だけ受け付けます。他の画面が先に変更した場合は再読み込みして確認してください
- 保存APIは許可された同一オリジンの Origin と JSON を必須にします。欠落・別オリジンの要求は拒否します
- 設定と新地域の予報待ち状態を一緒に保存し、古い地域の取得処理は新地域の結果を上書きできません。取得失敗時に前の地域の予報を新地域の予報として表示しません
- 一時的な通信切断では、要求がサーバーへ届いたか不明な場合があります。失敗表示だけを根拠に未保存と決めず、現在の設定を再読み込みして確認してください

地域設定は `FIRE_STATE_FILE` の既存の状態ファイルに原子的に保存します。同じ状態ファイルを複数のAPIプロセスから同時に書き込む運用は対応しません。初回だけ `config.weather` を読み込み、以降は保存済み地域設定を優先します。保存済みの `null` は明示的な天気無効化なので、config の値で再有効化しません。既存の状態ファイルを失った場合は初期設定へ戻るため、復旧時には地域と表示状態を確認してください。地域の保存後は、config ファイルの weather を変更するだけでは地域を切り替えられません。

weather.officeは気象庁の予報ファイルコード、regionはそのファイル内の予報地域コード、stationは明示的に選んだ気温地点コードです。RSSは正確なHTTPS URL（ホスト、経路、クエリー）だけ許可します。別URLへのリダイレクトは、新しい宛先が許可リストにない限り拒否します。取得器はDNS解決後に安全なIPへ接続先を固定し、TLSのホスト名検証を維持します。HTTP取得、認証付きURL、私設IP、メタデータ、外部実体、2MiB超の展開データを拒否します。

スナップショットは最新のみ、権限0600の一時ファイルからrenameします。認証ヘッダー、生エラー、会話のログは出しません。データを失った場合は最後の正常値とエラー状態を残し、未観測値を0％へ作り替えません。
