# すしすきー メモリ肥大・夜間不調メモ

最終更新: 2026-08-07 23:35（JST）  
対象: sushi.ski / Misskey 2026.7.0（sushiski） / **本番 Node v26.7.0**（#63574 修正入り・AB 傾きほぼ消滅）

## 結論（いま言えること）

- **主犯は `sushiski-web` の Misskey worker**。Meilisearch / Redis キュー本体 / ホスト全体の別プロセスではない。
- worker の肥大の大半は **V8 heap（JS オブジェクト）ではなく ArrayBuffer（生バイナリ）**。
  - 例（2026-08-06）: anon/RSS 増分の約 **86%** が `arrayBuffers` 増分。`heapUsed` は約 9% 程度。
- 伸び方はおおよそ **時間に対して単調増加**（だいたい 0.1〜0.2 GiB/h）。連合が忙しい時間帯ほど速い。ほぼ戻らない。
- 夜間の体感悪化は、多くの場合 **一次原因というより二次被害**:
  worker 肥大 → ホスト RAM/swap 逼迫 → major fault / iowait → API も `healthz` も一時的に鈍る。
- delayed キュー件数そのものは **Redis 上の待ち**であり、worker RAM とは別物。

- ヒープ比較で特定: 増分の本体は **`Node / BackingStore`**。付随は **Blob / BlobReader / ReadableStream / DataQueue**。
  JS キャッシュではない。ランタイムは Node **26.4.0** + **node-fetch 3.3.2**。

### 有力仮説（2026-08-07）: Node 本体の Blob.stream リーク → **ほぼ確定**

上流: [nodejs/node#63574](https://github.com/nodejs/node/issues/63574) / 修正 [PR #63577](https://github.com/nodejs/node/pull/63577)

| 項目 | 内容 |
|------|------|
| 症状 | `arrayBuffers` 単調増・heap は平坦・GC しても戻らない |
| リテーナ | `BackingStore → InMemoryEntry → DataQueue → Blob` → **Global / Eternal handles** |
| 影響版 | **24.16+** と **26.x**（コメント表で **26.4.0 = LEAK**） |
| 修正入り | **26.6.0**〜 / 本番は **2026-08-07 09:45 頃に 26.7.0 へ切替** |
| 効果（切替後 ~14h） | AB 傾き **約 +117 MB/h → 約 +0.5 MB/h**。いま AB ≈ **27 MiB**（旧軌跡なら ~1.4 GiB 級）。RSS も 0.3–0.6 GiB 帯で頭打ち |

**判定:** 「治ったと言っていい」レベル。アプリ側 `discardBody` だけでは止まらなかった主因は Node #63574 で、ランタイム上げで消えた。  
なお完全終息の最終確認として、あと半日〜1日の夜間帯も傾きが単調増に戻らないことだけ見ておけば十分。

### アプリ側修正（実施済み・効き不足）

当初仮説: 「未読 Response body を捨てていない」→ `discardBody()`（主に `body.cancel()`）＋ deliver/webhook 等に `discardBody: true`。  
**2026-08-07 02:28 頃デプロイ済み。** 直後は平坦に見えたが、約 6.7h 後に AB **~48MB → ~530MB**（後半 ~100MB/h 級）で **再発＝主因は止められていない**。

解釈の整理:

1. **未読 body 問題自体は実在**（古い undici/node-fetch の定番）で、discard は正しい保険。
2. ただし今回のスナップ形状は「生きてる Response が溜まっている」ではなく、**Global handles にピン留めされた Blob/BackingStore**。
3. これは #63574 の説明（`Reader::wakeup_` が強参照のまま残る）と一致し、**cancel では直らない**のも同じ。

## シロ（この件の主犯ではない）

| 疑い | 判定 |
|------|------|
| Meilisearch | 安定寄り。主犯ではない |
| Bull delayed 件数 | Redis 側。worker RSS と比例しない |
| MemoryKVCache 単体 | heap 増が小さすぎて multi-GB を説明できない |
| 単発の重い API（charts/drive 等） | 体感の一部にはなり得るが、メモリ単調増加の主因ではない |
| Grafana の「ホスト全体 5GiB」線 | しばしば root cgroup。コンテナ比較は `sushiski-.+` で見る |

## 症状の典型パターン

1. worker RSS/anon が半日〜1日で 1GiB → 3〜5GiB へ
2. `MemAvailable` 低下、swap 満杯、`pgmajfault` 増加
3. nginx 上の経路別レイテンシ悪化（TL 等）。逼迫時は `healthz` も秒単位になり得る
4. 巨体すぎると worker が落ちて起き直す（証拠プロセスが消える）

## 入れた監視

| 要素 | 内容 |
|------|------|
| Prometheus / Grafana / cAdvisor / node-exporter / blackbox | ホスト・コンテナ・外形監視 |
| `misskey-queue-exporter` | Bull 深さ、Process、失敗理由、host 別 delayed、`/proc` RSS/anon |
| `misskey-node-preload`（`NODE_OPTIONS=--require ...`） | worker:9102 / master:9103。heap / **arrayBuffers** / external / GC / event loop lag |
| `nginx-log-exporter` | パスバケット別 `request_time` / `upstream_response_time` |
| Grafana | Host / Containers / Uptime / Federation Queue / Leak Hunt / **API Latency** |

Grafana: Tailscale Serve（`sushiski.tail9eac04.ts.net` 等）経由。

### 見るべき指標（Leak Hunt）

- `misskey_v8_array_buffers_bytes{role="worker"}` … 本命
- `misskey_nodejs_rss_bytes` / `misskey_nodejs_anon_bytes`
- `misskey_v8_heap_used_bytes` … 小さいままなら JS ヒープ主犯説は弱い
- deliver/inbox の completed rate（相関用）
- `node_memory_MemAvailable_bytes` / swap / iowait
- nginx: `nginx_misskey_upstream_seconds`（route 別 p95）

## ヒープスナップショット（比較結果あり）

目的: メトリクスでは見えない **「誰が ArrayBuffer を握っているか」（retainer）** を出す。

方針:

- **巨体すぎると落ちる／撮るとホストが沈む**ので、落ちない程度の太りで 2 点比較する。
- snap1 = ほぼ空腹（基準・旧プロセス）
- snap2 = 成長後（**discard 修正後プロセスで 2026-08-07 09:09 頃取り直し**）

場所:

- `files/_heap_snapshots/snap1-baseline.heapsnapshot`（75MB）
- `files/_heap_snapshots/snap2-after-growth-20260807-000907.heapsnapshot`（137MB）← 現行
- 旧 snap2（修正前）は削除済み
- レポート: `files/_heap_snapshots/heap-diff-report.txt`
- 補助: `probe-bs-out.txt` / `probe-blob-out.txt`
- ツール: `monitoring/heap-tools/take-snapshot.mjs` / `compare-heaps.py`

### Comparison（修正後 snap2・2026-08-07 09:09）

撮った瞬間の worker: AB ≈ **532MB** / RSS ≈ **0.90 GiB** / uptime ≈ **6.7h**

| 増分 | 件数増 | 名前 |
|------|--------|------|
| **+497 MB** | **+3690** | **`native Node / BackingStore`**（いま 516MB × 3824） |
| 同数級 | +3690 | `Blob` / `BlobReader` / `ReadableStream` / `ReadableByteStreamController` |

- サイズ: だいたい **40–200 KB** 片（平均 roughly 135 KB）。
- 保持: BackingStore → InMemoryEntry → DataQueue。JS `Blob` は **Global handles / GC roots** に約 3824 個ピン留め。
- 生きてる `Response` は **~86** のみ → 「アプリが Response を溜めている」像ではない。
- **#63574 の retainer 図と一致。**

## Node バージョンメモ

| 版 | 位置づけ | 備考 |
|----|----------|------|
| **26.4.0** | 本番（いま） | #63574 **未修正** |
| **26.6.0** | Current | #63577 初収録（2026-08-03） |
| **26.7.0** | Current 最新（2026-08-05） | 26 系の最新パッチ。**LTS ではない** |
| **24.19.0** | **Active LTS** | 同 Blob.stream 修正あり。本番向けに「安定」と言いやすい線 |

- **26 系全体はいま Current**（Active LTS 予定は 2026-10-28 頃）。  
  → **26.7 は「公式の最新 Current」であって、LTS の意味での stable ではない。**  
  公式方針では本番は Active/Maintenance LTS 推奨。ただし Misskey 公式が Node 26 を前提にしているなら、Current 上でパッチ追従する判断もあり得る。
- 実験として上げるなら **26.7.0**（修正入り最新）か、安定優先なら **24.19 LTS**（Misskey の engines 要確認）。

## 運用上の注意

- **`web` / `sushiski-web` の再起動・再作成は明示承認なしでやらない**（サイトダウン）。ルール: `.cursor/rules/web-restart-approval.mdc`
- nginx reload/再作成は web とは別（ただし無闇にはしない）
- queue-exporter は `pid: service:web` のため、**承認後に web を作り直したら exporter も追従再作成が必要**
- ヒープスナップショットは worker を一時停止させる。RAM 逼迫中の強行は危険（撮ると一時 503 になり得る）

## 設定メモ（関連）

- `.config/default.yml`: `deliverJobConcurrency` / `inboxJobConcurrency`（調査時点で各 64。高いと連合バッファ圧が増えやすい）
- NSFW は sensitive-detector 外出し済み
- VPN: Tailscale = 管理、WireGuard = DB 用途、という棲み分け
- アプリ側 `discardBody` は保険として残す価値あり（未読 body / 接続リーク系）。ただし #63574 の本体はこれでは直らない

## 次の一手

1. ~~Node 26.7 切替~~ **済み・効果確認済み**（AB +117→+0.5 MB/h）
2. 念のためもう半日〜1日、夜間の `arrayBuffers` / RSS が単調増に戻らないか見る
3. アプリ側 `discardBody` は保険として残してよい（別系統の未読 body 対策）
4. 安定運用の長期選択肢として、将来 LTS（26 が LTS 入り、または 24.19）への寄せは任意

## 関連パス

- `monitoring/prometheus.yml`
- `monitoring/misskey-node-preload/preload.cjs`
- `monitoring/misskey-queue-exporter/`
- `monitoring/nginx-log-exporter/`
- `monitoring/grafana/provisioning/dashboards/`
- `nginx/conf.d/00-log-format.conf` / `sushi.ski.conf`
- `compose.yml`（web / nginx / exporters）
