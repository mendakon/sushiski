# cloudflare-firewall

オリジン (nginx コンテナの 80/443) への接続を Cloudflare の IPv4 レンジからだけに制限する。

Docker が publish したポートは FORWARD チェーンを通るため ufw の許可ルールが効かない。
そこで `DOCKER-USER` から `sushiski-cf` チェーンに飛ばし、Cloudflare 以外の新規接続を DROP する。
eth0 以外 (Tailscale / WireGuard / eth1 / コンテナ間) と確立済み接続は対象外。

| ファイル | 置き場所 | 内容 |
|---|---|---|
| `sushiski-cf-update` | `/usr/local/sbin/` | Cloudflare API からレンジを取得し、稼働中ルールと `/etc/ufw/after.rules` の `# BEGIN/END sushiski-cf` ブロックを更新 |
| `sushiski-cf-update.service` / `.timer` | `/etc/systemd/system/` | 1 日 1 回実行 |
| `rollback.sh` | 任意 | 稼働中のルールを即解除 (after.rules には残る) |

取得失敗・不正な CIDR・レンジ数 10 未満のときは何も変えない。

## 導入

```sh
install -m 755 sushiski-cf-update /usr/local/sbin/
install -m 644 sushiski-cf-update.service sushiski-cf-update.timer /etc/systemd/system/
sushiski-cf-update --dry-run   # 差分確認
sushiski-cf-update             # 初回は after.rules の末尾にブロックを追記
systemctl daemon-reload
systemctl enable --now sushiski-cf-update.timer
```

外部の端末から直接届かないことを確認する:

```sh
curl -vk --resolve sushi.ski:443:<オリジンIP> https://sushi.ski/ -m 5   # タイムアウトすれば OK
```

## 運用

- ログ: `journalctl -u sushiski-cf-update`
- 停止: `systemctl disable --now sushiski-cf-update.timer`
- 即解除: `rollback.sh` (恒久的に外すなら after.rules からブロックを消して `ufw reload`)
- 外向きインターフェースは `eth0` 固定。変わったらスクリプト内のルール生成部を直す。
