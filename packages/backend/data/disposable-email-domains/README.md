# disposable-email-domains

[disposable/disposable-email-domains](https://github.com/disposable/disposable-email-domains) の `domains.txt` のスナップショット（MIT License、[LICENSE](LICENSE) を参照）。

取得日: 2026-11-07 / commit: `ed77cf9f5c54a83e6be34215db5f5c06ca16171a`

自動生成のリストで実在のプロバイダーも含まれるため、更新時は差分を確認すること。誤検知は管理画面の除外ドメインで外す。

誰でもサブドメインを作れるサフィックスが増えたら、`EmailService.ts` の `DISPOSABLE_LIST_SHARED_SUFFIXES` に追加する（[Public Suffix List](https://publicsuffix.org/list/) との突き合わせが目安）。

```sh
curl -fsSL https://raw.githubusercontent.com/disposable/disposable-email-domains/master/domains.txt | LC_ALL=C sort -u > domains.txt
```
