# 運用先への接続

画面・集約APIの公開配信や収集元PCへの導入は、このリポジトリだけでは自動設定されません。

本番は信頼されたHTTPSで画面とAPIを同一オリジンに置きます。readerはHttpOnly / Secure / SameSite=Strictの読み取り専用セッションで検証し、collectorは別の資格情報とサーバー側で関連付けたsourceAliasを検証します。セッション発行・ログイン管理はこのアプリに含みません。認証連携が未設定ならAPIを起動しません。

APIは127.0.0.1へバインドします。Originは明示したHTTPSオリジンだけ許可します。資格情報をURL、Vite環境変数、ブラウザー、RSS設定やログへ置かないでください。localhostでのUI試用は未設定カードのまま動き、実APIへのアクセス権は与えません。

config.example.jsonの天気・RSS・優先取得元を、実環境の管理者が確認して設定します。地域がnull、feedsが空なら外部取得しません。JMAはWeb用JSONのため構造変更の可能性があり、安定したAPI契約として扱いません。

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
- APIは127.0.0.1で待ち受けるため、同じ機械の他プロセスはヘッダーを偽装できます。得られるのは閲覧権限だけですが、同居サービスの信頼度に応じて判断してください。

weather.officeは気象庁の予報ファイルコード、regionはそのファイル内の予報地域コード、stationは明示的に選んだ気温地点コードです。RSSは正確なHTTPS URL（ホスト、経路、クエリー）だけ許可します。別URLへのリダイレクトは、新しい宛先が許可リストにない限り拒否します。取得器はDNS解決後に安全なIPへ接続先を固定し、TLSのホスト名検証を維持します。HTTP取得、認証付きURL、私設IP、メタデータ、外部実体、2MiB超の展開データを拒否します。

スナップショットは最新のみ、権限0600の一時ファイルからrenameします。認証ヘッダー、生エラー、会話のログは出しません。データを失った場合は最後の正常値とエラー状態を残し、未観測値を0％へ作り替えません。
