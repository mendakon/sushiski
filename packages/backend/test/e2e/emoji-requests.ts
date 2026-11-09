/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// sushi.ski: 絵文字申請

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { beforeAll, describe, test } from 'vitest';
import { api, role, signup, uploadFile } from '../utils.js';
import type * as misskey from 'misskey-js';

describe('絵文字申請', () => {
	let root: misskey.entities.SignupResponse;
	let alice: misskey.entities.SignupResponse;
	let bob: misskey.entities.SignupResponse;
	let approver: misskey.entities.SignupResponse;
	let moderator: misskey.entities.SignupResponse;
	// alice の申請中の数が上限に近づかないよう、上限や同時実行を試す申請者は分ける
	let carol: misskey.entities.SignupResponse;
	let dave: misskey.entities.SignupResponse;
	let erin: misskey.entities.SignupResponse;

	beforeAll(async () => {
		root = await signup({ username: 'root' });
		alice = await signup({ username: 'alice' });
		bob = await signup({ username: 'bob' });
		approver = await signup({ username: 'approver' });
		// 'moderator' は予約済みのユーザー名なので使わない
		moderator = await signup({ username: 'mod1' });
		carol = await signup({ username: 'carol' });
		dave = await signup({ username: 'dave' });
		erin = await signup({ username: 'erin' });

		const requesterRole = await role(root, {}, { canRequestEmojis: { priority: 0, useDefault: false, value: true } });
		await api('admin/roles/assign', { roleId: requesterRole.id, userId: alice.id }, root);
		await api('admin/roles/assign', { roleId: requesterRole.id, userId: carol.id }, root);
		await api('admin/roles/assign', { roleId: requesterRole.id, userId: dave.id }, root);
		await api('admin/roles/assign', { roleId: requesterRole.id, userId: erin.id }, root);

		const approverRole = await role(root, {}, { canApproveEmojiRequests: { priority: 0, useDefault: false, value: true } });
		await api('admin/roles/assign', { roleId: approverRole.id, userId: approver.id }, root);

		const moderatorRole = await role(root, { isModerator: true });
		await api('admin/roles/assign', { roleId: moderatorRole.id, userId: moderator.id }, root);
	}, 1000 * 60 * 2);

	function errorCode(res: { body: unknown }): string | undefined {
		return (res.body as { error?: { code?: string } } | null)?.error?.code;
	}

	/** 通知などの非同期の処理を、条件を満たすまで最大 5 秒待つ */
	async function waitFor<T>(fn: () => Promise<T | null | undefined>): Promise<T | null> {
		for (let i = 0; i < 50; i++) {
			const result = await fn();
			if (result != null) return result;
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		return null;
	}

	async function upload(user: misskey.entities.SignupResponse): Promise<string> {
		const res = await uploadFile(user);
		assert.strictEqual(res.status, 200);
		return res.body!.id;
	}

	test('ポリシーが無い人は申請できない', async () => {
		const fileId = await upload(bob);
		const res = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'bob_emoji' }, bob);
		assert.strictEqual(res.status, 403);
	});

	test('申請して、自分の申請一覧に出る', async () => {
		const fileId = await upload(alice);
		const res = await api('emoji-requests/create', { fileId, name: 'alice_emoji', category: 'test', comment: 'よろしくお願いします' }, alice);
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.status, 'pending');
		assert.strictEqual(res.body.name, 'alice_emoji');
		assert.strictEqual(res.body.user.id, alice.id);
		assert.strictEqual(res.body.file?.id, fileId);

		const my = await api('emoji-requests/my', {}, alice);
		assert.strictEqual(my.status, 200);
		assert.ok(my.body.some(r => r.id === res.body.id));

		const others = await api('emoji-requests/my', {}, bob);
		assert.strictEqual(others.status, 200);
		assert.ok(!others.body.some(r => r.id === res.body.id));
	});

	test('ひとことが無い、または空白だけだと申請できない', async () => {
		const fileId = await upload(alice);
		const missing = await api('emoji-requests/create', { fileId, name: 'no_comment' } as never, alice);
		assert.strictEqual(missing.status, 400);
		const blank = await api('emoji-requests/create', { fileId, name: 'no_comment', comment: '   ' }, alice);
		assert.strictEqual(blank.status, 400);
	});

	test('申請中と同じ名前では申請できない', async () => {
		const fileId = await upload(alice);
		const first = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'dup_name' }, alice);
		assert.strictEqual(first.status, 200);
		const res = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'dup_name' }, alice);
		assert.strictEqual(res.status, 400);
		assert.strictEqual(errorCode(res), 'DUPLICATE_NAME');
	});

	test('他人のファイルでは申請できない', async () => {
		const fileId = await upload(bob);
		const res = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'others_file' }, alice);
		assert.strictEqual(res.status, 400);
		assert.strictEqual(errorCode(res), 'NO_SUCH_FILE');
	});

	test('取り下げると、もう一度は取り下げられない', async () => {
		const fileId = await upload(alice);
		const created = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'to_cancel' }, alice);

		const byOther = await api('emoji-requests/cancel', { requestId: created.body.id }, bob);
		assert.strictEqual(byOther.status, 400);
		assert.strictEqual(errorCode(byOther), 'NO_SUCH_REQUEST');

		const res = await api('emoji-requests/cancel', { requestId: created.body.id }, alice);
		assert.strictEqual(res.status, 204);

		const again = await api('emoji-requests/cancel', { requestId: created.body.id }, alice);
		assert.strictEqual(again.status, 400);
		assert.strictEqual(errorCode(again), 'NOT_PENDING');
	});

	test('承認者でない人は一覧を見られず、承認・却下もできない', async () => {
		const fileId = await upload(alice);
		const created = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'not_allowed' }, alice);
		assert.strictEqual(created.status, 200);

		const list = await api('admin/emoji-requests/list', {}, bob);
		assert.strictEqual(list.status, 400);
		assert.strictEqual(errorCode(list), 'NOT_ALLOWED');

		const approve = await api('admin/emoji-requests/approve', { requestId: created.body.id }, alice);
		assert.strictEqual(approve.status, 400);
		assert.strictEqual(errorCode(approve), 'NOT_ALLOWED');

		const reject = await api('admin/emoji-requests/reject', { requestId: created.body.id }, bob);
		assert.strictEqual(reject.status, 400);
		assert.strictEqual(errorCode(reject), 'NOT_ALLOWED');
	});

	test('ポリシーを持つ人とモデレーターは一覧を見られる', async () => {
		const fileId = await upload(dave);
		const created = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'for_list' }, dave);
		assert.strictEqual(created.status, 200);

		const byApprover = await api('admin/emoji-requests/list', { status: 'pending' }, approver);
		assert.strictEqual(byApprover.status, 200);
		assert.ok(byApprover.body.length > 0);
		assert.ok(byApprover.body.every(r => r.status === 'pending'));

		const byModerator = await api('admin/emoji-requests/list', {}, moderator);
		assert.strictEqual(byModerator.status, 200);
	});

	test('名前を直して承認すると絵文字が登録され、元のファイルを消しても残る', async () => {
		const fileId = await upload(alice);
		const created = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'before_fix' }, alice);

		const res = await api('admin/emoji-requests/approve', { requestId: created.body.id, name: 'after_fix', category: 'approved' }, approver);
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.status, 'approved');
		assert.strictEqual(res.body.name, 'after_fix');
		assert.ok(res.body.emojiId != null);

		// 承認の通知が届く。フロントは本文の :名前: から申請ページのその申請を開く
		const approvedNotification = await waitFor(async () => {
			const notifications = await api('i/notifications', { includeTypes: ['app'] }, alice);
			return notifications.body.find(n => n.type === 'app' && n.body === '申請した絵文字 :after_fix: が承認されました。');
		});
		assert.ok(approvedNotification != null);
		// アイコンは付けない (フロントが見出しを見て、自分のアバターを出す)
		assert.ok(approvedNotification.type === 'app' && approvedNotification.header === '絵文字申請' && approvedNotification.icon == null);

		const emoji = await api('emoji', { name: 'after_fix' });
		assert.strictEqual(emoji.status, 200);
		assert.strictEqual(emoji.body.category, 'approved');

		// 申請者のファイルではなく、システム所有のファイルに複製されている
		const deletedFile = await api('drive/files/delete', { fileId }, alice);
		assert.strictEqual(deletedFile.status, 204);
		const after = await api('emoji', { name: 'after_fix' });
		assert.strictEqual(after.status, 200);
		assert.strictEqual(after.body.url, emoji.body.url);

		const again = await api('admin/emoji-requests/approve', { requestId: created.body.id }, approver);
		assert.strictEqual(again.status, 400);
		assert.strictEqual(errorCode(again), 'NOT_PENDING');
	});

	test('既にある絵文字と同じ名前では承認できず、申請は確認待ちのまま', async () => {
		const fileId = await upload(alice);
		// ほかのテストに頼らないよう、ぶつける相手の絵文字もここで登録する
		const daveFileId = await upload(dave);
		const existing = await api('emoji-requests/create', { fileId: daveFileId, comment: 'よろしく', name: 'existing_emoji' }, dave);
		const approved = await api('admin/emoji-requests/approve', { requestId: existing.body.id }, moderator);
		assert.strictEqual(approved.status, 200);

		const created = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'will_collide' }, alice);

		const res = await api('admin/emoji-requests/approve', { requestId: created.body.id, name: 'existing_emoji' }, moderator);
		assert.strictEqual(res.status, 400);
		assert.strictEqual(errorCode(res), 'DUPLICATE_NAME');

		const list = await api('admin/emoji-requests/list', { status: 'pending' }, moderator);
		assert.ok(list.body.some(r => r.id === created.body.id));
	});

	test('申請した画像が消えていると承認できない', async () => {
		const fileId = await upload(alice);
		const created = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'file_gone' }, alice);
		await api('drive/files/delete', { fileId }, alice);
		// ファイルの行は削除の後処理で消えるので、消えるまで待つ
		const deleted = await waitFor(async () => (await api('drive/files/show', { fileId }, alice)).status === 400 ? true : null);
		assert.ok(deleted, 'ファイルが消えなかった');

		const res = await api('admin/emoji-requests/approve', { requestId: created.body.id }, approver);
		assert.strictEqual(res.status, 400);
		assert.strictEqual(errorCode(res), 'FILE_GONE');
	});

	test('却下すると状態と理由が残り、申請者には通知しない', async () => {
		const fileId = await upload(alice);
		const created = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'to_reject' }, alice);

		const res = await api('admin/emoji-requests/reject', { requestId: created.body.id, reason: '似た絵文字があるため' }, approver);
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.status, 'rejected');
		assert.strictEqual(res.body.rejectReason, '似た絵文字があるため');
		assert.ok(res.body.reviewedAt != null);

		const again = await api('admin/emoji-requests/approve', { requestId: created.body.id }, approver);
		assert.strictEqual(again.status, 400);
		assert.strictEqual(errorCode(again), 'NOT_PENDING');

		// 通知は非同期で作られるので少し待つ
		await new Promise(resolve => setTimeout(resolve, 1000));
		const notifications = await api('i/notifications', { includeTypes: ['app'] }, alice);
		assert.strictEqual(notifications.status, 200);
		assert.ok(!notifications.body.some(n => n.type === 'app' && n.body.includes(':to_reject:')));
	});

	test('間違って見送ったものは、確認待ちに戻せる', async () => {
		const fileId = await upload(alice);
		const created = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'to_unreject' }, alice);
		await api('admin/emoji-requests/reject', { requestId: created.body.id, reason: '間違い' }, approver);

		const byOther = await api('admin/emoji-requests/unreject', { requestId: created.body.id }, bob);
		assert.strictEqual(byOther.status, 400);
		assert.strictEqual(errorCode(byOther), 'NOT_ALLOWED');

		const res = await api('admin/emoji-requests/unreject', { requestId: created.body.id }, approver);
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.status, 'pending');
		assert.strictEqual(res.body.rejectReason, null);
		assert.strictEqual(res.body.reviewedAt, null);

		const again = await api('admin/emoji-requests/unreject', { requestId: created.body.id }, approver);
		assert.strictEqual(again.status, 400);
		assert.strictEqual(errorCode(again), 'NOT_REJECTED');
	});

	test('見送っているあいだに同じ名前の申請が出ていると、確認待ちに戻せない', async () => {
		const fileId = await upload(alice);
		const first = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'unreject_dup' }, alice);
		const rejected = await api('admin/emoji-requests/reject', { requestId: first.body.id }, approver);
		assert.strictEqual(rejected.status, 200);
		const second = await api('emoji-requests/create', { fileId, comment: 'もう一度', name: 'unreject_dup' }, alice);
		assert.strictEqual(second.status, 200);

		const res = await api('admin/emoji-requests/unreject', { requestId: first.body.id }, approver);
		assert.strictEqual(res.status, 400);
		assert.strictEqual(errorCode(res), 'DUPLICATE_NAME');
	});

	test('画像以外のファイルでは申請できない', async () => {
		const res0 = await uploadFile(alice, { path: 'kick_gaba7.mp3' });
		assert.strictEqual(res0.status, 200);
		const res = await api('emoji-requests/create', { fileId: res0.body!.id, comment: 'よろしく', name: 'not_image' }, alice);
		assert.strictEqual(res.status, 400);
		assert.strictEqual(errorCode(res), 'UNSUPPORTED_FILE_TYPE');
	});

	test('申請中は 10 件まで。見送りを取り消して上限を超えることもできない', async () => {
		const fileId = await upload(carol);
		const ids: string[] = [];
		for (let i = 0; i < 10; i++) {
			const res = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: `carol_${i}` }, carol);
			assert.strictEqual(res.status, 200);
			ids.push(res.body.id);
		}
		const over = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'carol_over' }, carol);
		assert.strictEqual(over.status, 400);
		assert.strictEqual(errorCode(over), 'TOO_MANY_PENDING');

		// 1 件見送ると枠が空く。その枠を新しい申請で埋めたあとは、見送りを取り消せない
		await api('admin/emoji-requests/reject', { requestId: ids[0] }, approver);
		const refill = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'carol_refill' }, carol);
		assert.strictEqual(refill.status, 200);
		const unreject = await api('admin/emoji-requests/unreject', { requestId: ids[0] }, approver);
		assert.strictEqual(unreject.status, 400);
		assert.strictEqual(errorCode(unreject), 'TOO_MANY_PENDING');
	});

	test('モデレーターも承認できる', async () => {
		const fileId = await upload(dave);
		const created = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'by_moderator' }, dave);
		const res = await api('admin/emoji-requests/approve', { requestId: created.body.id }, moderator);
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.status, 'approved');
	});

	test('同じ申請を 2 人が同時に承認しても、通るのは 1 人だけ', async () => {
		const fileId = await upload(dave);
		const created = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'same_request' }, dave);
		const results = await Promise.all([
			api('admin/emoji-requests/approve', { requestId: created.body.id }, approver),
			api('admin/emoji-requests/approve', { requestId: created.body.id }, moderator),
		]);
		assert.deepStrictEqual(results.map(r => r.status).sort(), [200, 400]);
		assert.strictEqual(errorCode(results.find(r => r.status === 400)!), 'NOT_PENDING');
	});

	test('別々の申請を同じ名前に直して同時に承認しても、絵文字は 1 つしかできない', async () => {
		const fileId = await upload(dave);
		const first = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'race_a' }, dave);
		const second = await api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'race_b' }, dave);
		const results = await Promise.all([
			api('admin/emoji-requests/approve', { requestId: first.body.id, name: 'race_same' }, approver),
			api('admin/emoji-requests/approve', { requestId: second.body.id, name: 'race_same' }, moderator),
		]);
		assert.deepStrictEqual(results.map(r => r.status).sort(), [200, 400]);
		assert.strictEqual(errorCode(results.find(r => r.status === 400)!), 'DUPLICATE_NAME');

		const emojis = await api('emojis', {});
		assert.strictEqual(emojis.body.emojis.filter(e => e.name === 'race_same').length, 1);
	});

	test('別々の名前で同時に申請しても、詰まらずにすべて通る', async () => {
		const fileId = await upload(erin);
		const results = await Promise.all([0, 1, 2, 3, 4].map(i =>
			api('emoji-requests/create', { fileId, comment: 'よろしく', name: `parallel_${i}` }, erin)));
		assert.deepStrictEqual(results.map(r => r.status), [200, 200, 200, 200, 200]);
	});

	test('同じ名前で同時に申請しても、通るのは 1 件だけ', async () => {
		const fileId = await upload(erin);
		const results = await Promise.all([
			api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'parallel_same' }, erin),
			api('emoji-requests/create', { fileId, comment: 'よろしく', name: 'parallel_same' }, erin),
		]);
		assert.deepStrictEqual(results.map(r => r.status).sort(), [200, 400]);
		assert.strictEqual(errorCode(results.find(r => r.status === 400)!), 'DUPLICATE_NAME');
	});
});
