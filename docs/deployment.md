# 運用先への接続

画面・集約APIの公開配信や収集元PCへの導入は、このリポジトリだけでは自動設定されません。

本番は信頼されたHTTPSで画面とAPIを同一オリジンに置きます。readerはHttpOnly / Secure / SameSite=Strictの読み取り専用セッションで検証し、collectorは別の資格情報とサーバー側で関連付けたsourceAliasを検証します。セッション発行・ログイン管理はこのアプリに含みません。認証連携が未設定ならAPIを起動しません。

APIは127.0.0.1へバインドします。Originは明示したHTTPSオリジンだけ許可します。資格情報をURL、Vite環境変数、ブラウザー、RSS設定やログへ置かないでください。localhostでのUI試用は未設定カードのまま動き、実APIへのアクセス権は与えません。

config.example.jsonの天気・RSS・優先取得元を、実環境の管理者が確認して設定します。地域がnull、feedsが空なら外部取得しません。JMAはWeb用JSONのため構造変更の可能性があり、安定したAPI契約として扱いません。

認可モジュールの実装・配備、信頼済みHTTPS、Fire側の閲覧許可、収集元への配置は別途承認が必要です。公開ポート、自己署名証明書の警告回避、無認証運用は手順に含みません。

## 起動契約

環境変数は `FIRE_AUTH_MODULE`（既存の承認済みESM認可モジュールのパス）、`FIRE_PUBLIC_ORIGIN`（HTTPSオリジン）、任意の `FIRE_CONFIG` と `FIRE_STATE_FILE` です。認可モジュールは `authorize(request, role)` と `sourceAlias(request)` を公開します。roleはreader／collector、sourceAliasは認証済み主体からサーバー側で解決してください。リクエスト本文やクライアント指定ヘッダーをそのまま信用する実装にしないでください。

認可された配置後に `npm run start:api` を実行します。127.0.0.1:8787の背後に信頼された同一オリジンのHTTPS配信が必要です。システムサービス登録やリバースプロキシの設定はこの成果物では変更していません。

weather.officeは気象庁の予報ファイルコード、regionはそのファイル内の予報地域コード、stationは明示的に選んだ気温地点コードです。RSSは正確なHTTPS URL（ホスト、経路、クエリー）だけ許可します。別URLへのリダイレクトは、新しい宛先が許可リストにない限り拒否します。取得器はDNS解決後に安全なIPへ接続先を固定し、TLSのホスト名検証を維持します。HTTP取得、認証付きURL、私設IP、メタデータ、外部実体、2MiB超の展開データを拒否します。

スナップショットは最新のみ、mode 0600で作成した一時ファイルからrenameします。このmodeによる所有者限定の保護はPOSIX向けであり、Windowsのアクセス制御を保証しません。Windowsでは下記のNTFS ACL設定が別途必要です。認証ヘッダー、生エラー、会話のログは出しません。データを失った場合は最後の正常値とエラー状態を残し、未観測値を0％へ作り替えません。

## 画面配信のクリックジャッキング対策

`frame-ancestors` はHTMLのmeta CSPでは有効になりません。APIのCSPも別レスポンスの画面を保護しないため、**HTMLを返す配信元**が実際のHTTPレスポンスに `Content-Security-Policy: frame-ancestors 'none'` と `X-Frame-Options: DENY` を付けてください。[CSP仕様](https://www.w3.org/TR/CSP3/#directive-frame-ancestors)

このリポジトリのVite dev / previewには両ヘッダーを設定しています。HTML内の既存の厳格なmeta CSPはそのまま維持し、追加のHTTP CSPと併せて適用します。`npm run build` は静的ファイルを生成するだけで、配信先のヘッダー設定は引き継ぎません。本番の静的ホスト/CDN/リバースプロキシでも独立に設定してください。[Vite server.headers](https://vite.dev/config/server-options.html#server-headers)、[preview.headers](https://vite.dev/config/preview-options.html#preview-headers)

次は管理者が確認したHTTPS用nginx `server` ブロック内に組み込む例です。TLS・認証連携を別途設定し、`root` は承認済みビルドの `apps/dashboard/dist` のみに向けます。リポジトリ全体や `.runtime` は配信しません。

```nginx
root /srv/fire-dashboard/apps/dashboard/dist;
index index.html;

# meta CSPと同じリソース制約を保ち、frame-ancestorsを追加する。
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;
add_header X-Frame-Options "DENY" always;

location / {
    try_files $uri $uri/ /index.html;
}
location /assets/ {
    try_files $uri =404;
}
location /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
}
```

`always` によりエラー応答にも付与し、SPAフォールバックの `/index.html` にも同じポリシーを適用します。既存のHTTP CSPがある場合は他のディレクティブを保持して `frame-ancestors 'none'` を追加するか、独立した追加CSPヘッダーとして設定してください。既存CSPやAPIのCSPを削除・緩和しないでください。nginxの子 `location` に別の `add_header` があると、標準の継承規則では親のヘッダーが継承されなくなります。その場合は両方のセキュリティヘッダーをその場所にも設定し、カスタムエラーページ・認証ゲートウェイ・CDNを含む最終レスポンスを確認してください。[nginx add_header](https://nginx.org/en/docs/http/ngx_http_headers_module.html#add_header)

配備後は実際のHTTPSオリジンに置き換え、通常HTML、SPAフォールバック、404、APIの認証エラーでヘッダーが残ることを確認します。認証が必要なHTMLは認証済みブラウザーのNetworkパネルでも確認してください。資格情報をコマンドやログへ書きません。

```sh
curl -sS -o /dev/null -D - https://dashboard.example/
curl -sS -o /dev/null -D - https://dashboard.example/nested/dashboard/route
curl -sS -o /dev/null -D - https://dashboard.example/assets/missing.js
curl -sS -o /dev/null -D - https://dashboard.example/api/v1/dashboard
```

### 既存オフラインキャッシュへの反映

Service WorkerはHTMLをレスポンスヘッダーごとキャッシュし、ナビゲーションでキャッシュ済み `/index.html` を優先します。配信設定だけを変更しても、既存端末の古いHTMLに後からヘッダーは付きません。この更新では `index.html` にヘッダー要件のコメントを残し、`scripts/build-sw.mjs` が計算するビルド成果物のハッシュも変わるようにしています。コメントがビルド済みHTMLに残ることはHTTPテストで確認します。

1. 配信元のヘッダーを設定し、CDNやHTTPキャッシュに古いHTMLが残らないよう、承認済みの更新・再検証手順で切り替えます。`index.html` と `sw.js` が再検証される配信設定にしてください
2. `npm run build` でHTMLとバージョン付き `sw.js` を一緒に再生成・配備します。旧 `sw.js` を再利用せず、新しいHTMLのネットワークレスポンスに両ヘッダーがあることを確認します
3. 既存端末をオンラインで開き、新しいオフラインシェルの取得完了後、画面の「更新して再読み込み」で適用します。新しいWorkerのactivate完了後に旧 `fire-shell-*` キャッシュが削除されます。通常の再読み込みだけで適用済みと判断しないでください
4. ブラウザーのCache StorageとNetworkパネルで、新しい `/index.html` にCSPとX-Frame-Optionsが保存され、Service Worker経由の再表示にも残ることを確認します。オフラインの端末や更新待ちの端末は、この確認が完了するまで対策反映済みと扱いません

## Windowsでのスナップショット保護

WindowsではNode.jsのmode 0600でowner/group/othersの区別を設定できません。NTFS上に専用の `.runtime` を事前作成し、実際のAPI実行アカウントだけに変更権限を与えます。管理用のSYSTEMとAdministrators以外の一般ユーザー・共有グループへは許可しません。一時ファイルもこのディレクトリのACLを継承する必要があります。[Node.jsのファイルmode](https://nodejs.org/api/fs.html#file-modes)

以下は管理者が承認してから実行するPowerShell例です。APIを停止し、親ディレクトリも一般ユーザーが置換・削除できない管理下のパスを選び、実行アカウントを実在する専用アカウントへ置き換えます。**新規ディレクトリ専用**であり、既存データにはそのまま実行しません。アプリ自身はACLを変更しません。

```powershell
$ErrorActionPreference = 'Stop'
$runtime = 'C:\FireDashboard\.runtime'
$serviceAccount = 'HOSTNAME\fire-dashboard' # 実際のAPI実行アカウント
$serviceSid = ([System.Security.Principal.NTAccount]::new($serviceAccount)).Translate(
    [System.Security.Principal.SecurityIdentifier]
).Value
if (Test-Path -LiteralPath $runtime) {
    throw '既存の.runtimeは内容と明示的なACLを管理者が確認してください'
}
New-Item -ItemType Directory -Path $runtime | Out-Null
# 数値SIDを使い、OSの表示言語に依存しない。先に必要な明示的許可を付与する。
icacls $runtime /grant:r "*${serviceSid}:(OI)(CI)(M)" '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-32-544:(OI)(CI)(F)'
if ($LASTEXITCODE -ne 0) { throw 'ACL grant failed; APIを起動しないでください' }
# 親からの広い許可をコピーせず削除する。
icacls $runtime /inheritance:r
if ($LASTEXITCODE -ne 0) { throw 'ACL inheritance failed; APIを起動しないでください' }
icacls $runtime
if ($LASTEXITCODE -ne 0) { throw 'ACL inspection failed' }
Get-Acl -LiteralPath $runtime | Format-List Owner, AreAccessRulesProtected, AccessToString
```

`(OI)(CI)` はファイルと子ディレクトリへの継承です。`/inheritance:r` は継承ACEだけを除去し、`/grant:r` は指定した主体の許可だけを置換するため、**既存の別主体の明示的ACEは除去されません**。既存の `.runtime` を使う場合はバックアップと管理者レビューを先に行い、許可対象を確認したうえで不要な明示的ACEも個別に整理してください。`Everyone` への拒否を追加すると正規の実行アカウントも拒否され得るため、広い拒否ACEで代用しません。[icacls](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls)

確認完了後に `FIRE_STATE_FILE=C:\FireDashboard\.runtime\state.json` を指定します。最初の保存と更新後に `icacls 'C:\FireDashboard\.runtime' /T` でスナップショット・一時ファイルを含む継承と主体を確認し、実行アカウントの読み書き・renameと一般ユーザーの読み取り拒否を実機で検証してください。FAT/exFATや共有ドライブへ移す場合はこのACL手順だけで保護されたと判断せず、その保存先のアクセス制御を別途検証します。

## 外部認可モジュールの配備前レビュー

`FIRE_AUTH_MODULE` の実装はリポジトリに含まれず、このコード・テストの監査対象外です。起動時のエクスポート検査は認証実装の安全性を保証しません。管理者がレビューしたモジュールを信頼できる絶対パスで指定し、一般ユーザーがそのモジュールや親ディレクトリを書き換えられないよう保護してください。配備前に少なくとも次を確認します。

- `authorize(request, role)` がリクエストごとにセッションを検証し、有効期限、失効・ログアウト、無効な資格情報、要求されたreader/collectorの権限を確認して失敗時は拒否すること。署名トークンなら署名・発行者・対象サービスなども検証し、Cookieやヘッダーの存在だけで許可しないこと
- readerのセッションCookieを認証基盤が `HttpOnly; Secure; SameSite=Strict` と適切な有効期限・適用範囲で発行し、更新・失効を管理すること。Cookie発行やログイン処理はこのAPIの責務ではありません
- collectorは別の資格情報を使い、`sourceAlias(request)` が認証済み主体からサーバー側で解決すること。利用者指定の本文・ヘッダーから役割やsourceAliasを採用しないこと
- Fastifyは `trustProxy: false` です。プロキシ背後の `request.ip` は通常そのプロキシのアドレスであり、利用者の識別に使えません。loopbackからの接続であること、`X-Forwarded-For` / `Forwarded` 等のクライアントが指定できる値を認証・認可の根拠にしないこと。IPベース認証を導入するために安易に `trustProxy` を有効化しないこと
- 期限切れ・失効済みセッション、役割の取り違え、sourceAliasの詐称、転送ヘッダーの偽装が拒否されることを外部認可モジュール側のテストと配備先で検証すること
