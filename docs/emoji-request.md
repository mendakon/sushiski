# 絵文字申請機能の調査と設計案

- 作成: 2026-11-07
- 状態: 設計案（未実装。「未決事項」が決まってから着手する）

## 概要

ユーザーがカスタム絵文字を申請し、承認できる人がそれを確認して承認・却下する機能を追加する。

- 申請の入口は、ナビゲーションの「もっと！」メニューの 1 項目にする
- 申請できるのは、新しいロールポリシー `canRequestEmojis` を持つ人
- 承認できるのは、モデレーター以上の人と、新しいロールポリシー `canApproveEmojiRequests` を持つ人
- 承認できる人は、コントロールパネルから申請中の絵文字の一覧を見られる

## 現状の調査結果（master `4a297d715f` 時点）

絵文字を申請する機能はない。`packages/backend/src`、`packages/frontend/src`、`locales/ja-JP.yml` を request / draft / apply / 申請 などの語で検索したが、該当する実装はなかった。

絵文字に関係する既存の仕組みは次のとおり。

| 仕組み | 場所 | 内容 |
|---|---|---|
| 絵文字管理 API | `packages/backend/src/server/api/endpoints/admin/emoji/*` | 追加・更新・削除・コピーなど。すべて `requiredRolePolicy: 'canManageCustomEmojis'` |
| ロールポリシー `canManageCustomEmojis` | `packages/backend/src/core/RoleService.ts` | 絵文字管理の権限。既定値は `false` |
| 絵文字の登録処理 | `CustomEmojiService.add()`（`packages/backend/src/core/CustomEmojiService.ts`） | 名前、カテゴリ、エイリアス、ライセンスなどを受け取って登録する |
| 画像のコピー | `admin/emoji/copy.ts` | `driveService.uploadFromUrl({ url, user: null, force: true })` でシステム所有のファイルとして複製する |
| モデレーターでない人向けの管理ページ | `packages/frontend/src/ui/_common_/common.ts` | `canManageCustomEmojis` を持つ人に、メニューから `/custom-emojis-manager` へのリンクを出す |

## 実装上の制約

### コントロールパネルにはモデレーターしか入れない

`/admin` はモデレーター以上しか開けない（`packages/frontend/src/router.definition.ts` の `iAmModerator` で分岐）。ポリシーだけを持つ一般ユーザーは、コントロールパネルに置いたページを開けない。

コントロールパネル全体をポリシー保持者に開放すると、ほかの管理ページまで見えてしまうので、開放はしない。代わりに、同じ一覧ページを 2 か所から開けるようにする。

- モデレーターは、コントロールパネル（`/admin/emoji-requests`）から開く
- ポリシーだけを持つ人は、メニューのリンク（`common.ts` に追加）から開く

これは `canManageCustomEmojis` と `/custom-emojis-manager` の関係と同じやり方である。

### 「モデレーター以上、またはポリシー保持者」は meta だけでは表せない

`requiredRolePolicy` を指定すると、ポリシーを持つ人と管理者だけが通る。モデレーターは通らない（`packages/backend/src/server/api/ApiCallService.ts` の判定）。そのため承認系の API は `requireCredential: true` だけを指定し、処理の中で「モデレーター、またはポリシーあり」を判定する。

## 設計案

### 権限

| 操作 | できる人 |
|---|---|
| 申請する | `canRequestEmojis` を持つ人 |
| 自分の申請を見る・取り下げる | 申請者本人（ポリシーを外されたあとも、過去の申請は見られる） |
| 申請の一覧を見る・承認する・却下する | モデレーター以上、または `canApproveEmojiRequests` を持つ人 |

追加するロールポリシーは 2 つ。

| ポリシー | 既定値 | 判定 |
|---|---|---|
| `canRequestEmojis` | `false`（管理者がロールで許可した人だけが申請できる） | `requiredRolePolicy: 'canRequestEmojis'` で判定できる |
| `canApproveEmojiRequests` | `false` | モデレーターも通す必要があるので、処理の中で判定する（上の「実装上の制約」） |

どちらも既定値が `false` なので、実装を本番に出しただけでは誰も申請できない。使い始めるには、管理者がベースロールやほかのロールで `canRequestEmojis` を有効にする。

### データ（新しいテーブル `emoji_request`）

| 列 | 内容 |
|---|---|
| `id` | ID |
| `userId` | 申請者 |
| `fileId` | 申請者のドライブにある画像 |
| `name` | 絵文字の名前（`:name:`） |
| `category`, `aliases`, `license`, `isSensitive`, `localOnly` | 登録時に `CustomEmojiService.add()` へ渡す値 |
| `comment` | 申請者からのひとこと |
| `status` | `pending` / `approved` / `rejected` |
| `reviewerId`, `reviewedAt`, `rejectReason` | 承認・却下した人、日時、却下の理由 |

新しいタイムスタンプで migration を作り、`up()` と `down()` の両方を実装する。

### API

| エンドポイント | 権限 | 内容 |
|---|---|---|
| `emoji-requests/create` | `canRequestEmojis` | 申請する。名前の重複（既存の絵文字と申請中のもの）を確認する。レート制限を付ける |
| `emoji-requests/my` | ログイン | 自分の申請と状態の一覧 |
| `emoji-requests/cancel` | 申請者本人 | `pending` の申請を取り下げる |
| `admin/emoji-requests/list` | 承認者 | 申請の一覧（状態で絞り込み） |
| `admin/emoji-requests/approve` | 承認者 | 承認する。名前やカテゴリを直してから登録できるようにする |
| `admin/emoji-requests/reject` | 承認者 | 却下する（理由は任意） |

承認するときは、申請者のドライブのファイルをそのまま使わず、`admin/emoji/copy.ts` と同じく `uploadFromUrl` でシステム所有のファイルに複製してから `CustomEmojiService.add()` を呼ぶ。申請者があとでファイルを消しても、絵文字が壊れないようにするためである。

### 画面

| 画面 | 場所 |
|---|---|
| 申請フォームと自分の申請一覧 | 新しいページ。`packages/frontend/src/navbar.ts` に項目を足し、「もっと！」から開けるようにする。項目は `$i.policies.canRequestEmojis` が `true` の人にだけ表示する |
| 承認用の一覧 | 新しいページ。`/admin` 配下（`pages/admin/index.vue` のメニュー）と、ポリシー保持者向けのリンク（`common.ts`）の両方から開く |
| ロール編集 | `pages/admin/roles.policy-editor.vue` に `canRequestEmojis` と `canApproveEmojiRequests` を追加する |

### 変更するファイル（予定）

- backend: entity、migration、`RoleService.ts`（ポリシーと既定値）、`models/json-schema/role.ts`、エンドポイント 6 本と endpoint-list への登録、テスト（`test/unit/RoleService.ts` ほか）
- misskey-js: `src/consts.ts` のポリシー一覧、`pnpm build-misskey-js-with-types` による `src/autogen/` の再生成
- frontend: `navbar.ts`、`router.definition.ts`、`ui/_common_/common.ts`、`pages/admin/index.vue`、`roles.policy-editor.vue`、新しいページ 2 つ
- locale: `locales/ja-JP.yml` のみ（ほかの言語のファイルは Crowdin が管理するので編集しない）

合計で 20 ファイル前後になる見込み。本家の更新を取り込むときに衝突しにくいよう、処理はできるだけ新しいファイルに分ける。

## 未決事項

1. 申請者への結果の連絡：承認・却下をアプリ内の通知で知らせるか。新しい通知の種類を足すと変更が増える
2. 承認者への連絡：新しい申請が来たことを知らせるか。PR #5 で入れた Discord 通知の仕組みを使い回せそうである

決定済み：

- 申請できる人もロールポリシー（`canRequestEmojis`）で管理する（2026-11-07）
- `canRequestEmojis` の既定値は `false`（2026-11-07）

## 実装時の注意

- 開発は Dev Container の中（Node 26 / pnpm 11）で行う
- backend を触る前に `working-on-backend`、frontend を触る前に `working-on-frontend` のスキルを読む
- 出す前の検証は `shipping-misskey-change` に従う。今回は特に、`pnpm --filter backend check-migrations` と `pnpm build-misskey-js-with-types` が必要
