# メンテナンス表示と障害表示

sushi.ski につながらないとき、利用者に原因がわかるように表示を分ける。

| 状況 | 表示 | 返すもの |
|---|---|---|
| メンテナンス中 (`nginx/html/maintenance.on` がある) | メンテナンス中 | nginx が 503 + `nginx/html/maintenance.html` |
| web が応答しない (予定外の停止) | 障害 | nginx が 502 / 504 + `nginx/html/outage.html` |
| Cloudflare から nginx に届かない | 障害 | Service Worker が「サーバーで障害が起きています」と HTTP ステータス |
| 応答がタイムアウトした | 応答の遅れ | Service Worker が「サーバーの応答が遅れています」 |
| 端末がオフライン | ネットワークの確認 | Service Worker が「ネットワークに接続されていません」 |

nginx のページには `X-Sushiski-Status: maintenance` / `outage` を付ける。Service Worker はこのヘッダーがあればページをそのまま見せる。
ヘッダーがないと、これまでどおり Service Worker が自前の画面に置き換えるので、メンテナンスページが見えない。

## 初回の反映

1. `nginx/conf.d/sushi.ski.conf` を `ops/nginx/sushi.ski.conf.example` の内容にする (いまの設定は控えておく)
2. `docker compose exec nginx nginx -t`
3. `docker compose exec nginx nginx -s reload` (接続は切れない)
4. Service Worker の変更は web イメージに入るので、次の web の再起動から効く

`nginx/conf.d/sushi.ski.maintenance.conf.example` (設定を丸ごと差し替える旧方式) はこの仕組みで不要になる。
背景画像のパスを `/_sushiski/hero.webp` に変えたので、旧方式で使うと画像が出ない。

## デプロイのとき

```sh
ops/nginx/sushiski-maintenance on
docker compose up -d --no-deps web     # 起動時にマイグレーションが走る
# web が healthy になるのを待つ
ops/nginx/sushiski-maintenance off
docker compose up -d --no-deps queue
```

`on` の間は、web が動いていても全リクエストに 503 を返す。終わったら必ず `off` にする。
ページは 30 秒ごとに再読み込みするので、`off` にすると利用者の画面も自動で戻る。

文言を変えたいときは `nginx/html/*.html` を直接編集する。nginx の reload はいらない。
