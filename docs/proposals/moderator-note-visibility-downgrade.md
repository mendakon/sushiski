# 案: モデレーターが投稿済みのパブリックノートをホームに変更する

- 状態: 案 (未実装)
- 作成: 2026-11-08

## やりたいこと

モデレーターが、投稿済みの `public` ノートを後から `home` に落とせるようにする。

## 現状 (2026-11-08 時点のコード調査)

今のコードではできない。

- ノートを書き換える API がない。`packages/backend/src/server/api/endpoints/notes/` に `update` はなく、`admin/` 以下にもノートの公開範囲を変えるエンドポイントはない。本家と同じく、ノートは投稿後に編集できない作り
- モデレーターが他人のノートにできるのは削除だけ (`server/api/endpoints/notes/delete.ts` の `isModerator` 判定)
- public→home に落とす処理は投稿時にしか動かない (`core/NoteCreateService.ts` の `data.visibility = 'home'` の箇所)。対象は次の 2 つで、どちらも既存の投稿には効かない
  - センシティブワードを含む投稿 (sushi.ski では CW も判定対象)
  - ロールの `canPublicNote === false` (サイレンス)
- リモートから届く Note の Update も処理しない (`core/activitypub/ApInboxService.ts` の `update()` が扱うのは Person と Question だけ)

## 案: admin API を新しく作る

例: `admin/notes/set-visibility` (モデレーター権限)

1 回の呼び出しで次をまとめて行う。

1. **DB を書き換える**: `note.visibility = 'home'`
2. **Redis の LTL から外す**: public のノートは投稿時に Redis の `localTimeline` / `localTimelineWithFiles` / `localTimelineWithReplies` / `localTimelineWithReplyTo:*` に積まれる (`NoteCreateService.ts` の `fanoutTimelineService.push`)。読み出す側の `FanoutTimelineEndpointService` は公開範囲を確かめ直さないので、DB を変えるだけでは LTL に表示され続ける。Redis から ID を消すか、フィルタに公開範囲のチェックを足す
3. **連合先へ Delete を配る** (下の「連合の扱い」を参照)
4. **モデレーションログに記録する** (`ModerationLogService`)

そのほか検討すること: ハッシュタグの集計、ストリーミングで配信済みの分、検索インデックス (`SearchService`) の扱い。

## 連合の扱い: Delete を配る

DB の公開範囲を変えても連合先には伝わらない。相手のサーバーには public として届いているため。そこで、ローカルは消さずに連合先へだけ Delete を送る。

### 流用できる処理

`core/NoteDeleteService.ts` の削除時の配送処理がそのまま使える。

- `apRendererService.renderDelete(apRendererService.renderTombstone(ノートのURL), user)` で Delete アクティビティを作る
- 純粋なリノートには `renderUndo(renderAnnounce(...))` を使う分岐がある
- `deliverToConcerned()` で配る。宛先はフォロワー、リレー、メンションされたリモートユーザー、そのノートをリノート・リプライしたリモートユーザー
- `localOnly` のノートには配らない

### 気をつけること

- **ノートの URL はまだ生きている**: home のノートも AP で配信され続ける (`server/ActivityPubServerService.ts` の `visibility: In(['public', 'home'])`)。相手がリプライや URL 検索でもう一度取りに来ると、今度は home (未収載) として取り込まれる。「home にする」という目的からすれば望ましい動き
- **Mastodon は一度消したものを受け付けない可能性がある**: Mastodon は削除した URI を Tombstone として覚えておき、同じ URI の作り直しを拒むはず (**要確認**)。そうなら、Mastodon 系では home として戻らず消えたままになる。Misskey 系は削除済みの URI を覚えていないので、取り直せば戻ると思われる
- **相手側の反応やリプライも消える**: 相手のサーバーでは普通の削除と同じ扱い。リアクションやブーストは消え、リプライは親のない状態になる。ローカル側のリアクションなどは残る
- **届く範囲は普通の削除と同じ**: 検索で取り込んだだけのサーバーなど、配送先リストに入っていないところには届かない

### 採らない案

- **Delete の直後に home として Create を送り直す**: Mastodon の Tombstone で弾かれることがあり、配送の順序も保証されない
- **Update で公開範囲を変える**: Mastodon は編集の Update で公開範囲の変更を受け付けないはず (**要確認**)

### 仕様として割り切ること

連合先では「home に変わる」のではなく、**「いったん消える (Misskey 系は取り直せば home で戻ることがある)」**という動きになる。

## 今ある機能でできる代わりの対応

- 投稿を削除して、本人に投稿し直してもらう
- 同じような投稿が続くユーザーにはサイレンスロール (`canPublicNote: false`) を付ける
- センシティブワードに追加して、今後の投稿を自動で home に落とす

## 実装するときに守ること

- `working-on-backend` スキルを参照する (endpoint-list への登録、`pnpm build-misskey-js-with-types` での再生成)
- 管理画面の UI を付けるなら `working-on-frontend` スキルも参照する
