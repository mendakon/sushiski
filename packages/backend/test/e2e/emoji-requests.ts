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

	beforeAll(async () => {
		root = await signup({ username: 'root' });
		alice = await signup({ username: 'alice' });
		bob = await signup({ username: 'bob' });
		approver = await signup({ username: 'approver' });
		// 'moderator' は予約済みのユーザー名なので使わない
		moderator = await signup({ username: 'mod1' });

		const requesterRole = await role(root, {}, { canRequestEmojis: { priority: 0, useDefault: false, value: true } });
		await api('admin/roles/assign', { roleId: requesterRole.id, userId: alice.id }, root);

		const approverRole = await role(root, {}, { canApproveEmojiRequests: { priority: 0, useDefault: false, value: true } });
		await api('admin/roles/assign', { roleId: approverRole.id, userId: approver.id }, root);

		const moderatorRole = await role(root, { isModerator: true });
		await api('admin/roles/assign', { roleId: moderatorRole.id, userId: moderator.id }, root);
	}, 1000 * 60 * 2);

	function errorCode(res: { body: unknown }): string | undefined {
		return (res.body as { error?: { code?: string } } | null)?.error?.code;
	}

	async function upload(user: misskey.entities.SignupResponse): Promise<string> {
		const res = await uploadFile(user);
		assert.strictEqual(res.status, 200);
		return res.body!.id;
	}

	test('ポリシーが無い人は申請できない', async () => {
		const fileId = await upload(bob);
		const res = await api('emoji-requests/create', { fileId, name: 'bob_emoji' }, bob);
		assert.strictEqual(res.status, 403);
	});

	test('申請して、自分の申請一覧に出る', async () => {
		const fileId = await upload(alice);
		const res = await api('emoji-requests/create', { fileId, name: 'alice_emoji', category: 'test', comment: 'よろしく' }, alice);
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

	test('申請中と同じ名前では申請できない', async () => {
		const fileId = await upload(alice);
		await api('emoji-requests/create', { fileId, name: 'dup_name' }, alice);
		const res = await api('emoji-requests/create', { fileId, name: 'dup_name' }, alice);
		assert.strictEqual(res.status, 400);
		assert.strictEqual(errorCode(res), 'DUPLICATE_NAME');
	});

	test('他人のファイルでは申請できない', async () => {
		const fileId = await upload(bob);
		const res = await api('emoji-requests/create', { fileId, name: 'others_file' }, alice);
		assert.strictEqual(res.status, 400);
		assert.strictEqual(errorCode(res), 'NO_SUCH_FILE');
	});

	test('取り下げると、もう一度は取り下げられない', async () => {
		const fileId = await upload(alice);
		const created = await api('emoji-requests/create', { fileId, name: 'to_cancel' }, alice);

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
		const created = await api('emoji-requests/create', { fileId, name: 'not_allowed' }, alice);

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
		const byApprover = await api('admin/emoji-requests/list', { status: 'pending' }, approver);
		assert.strictEqual(byApprover.status, 200);
		assert.ok(byApprover.body.length > 0);
		assert.ok(byApprover.body.every(r => r.status === 'pending'));

		const byModerator = await api('admin/emoji-requests/list', {}, moderator);
		assert.strictEqual(byModerator.status, 200);
	});

	test('名前を直して承認すると絵文字が登録され、元のファイルを消しても残る', async () => {
		const fileId = await upload(alice);
		const created = await api('emoji-requests/create', { fileId, name: 'before_fix' }, alice);

		const res = await api('admin/emoji-requests/approve', { requestId: created.body.id, name: 'after_fix', category: 'approved' }, approver);
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.status, 'approved');
		assert.strictEqual(res.body.name, 'after_fix');
		assert.ok(res.body.emojiId != null);

		const emoji = await api('emoji', { name: 'after_fix' });
		assert.strictEqual(emoji.status, 200);
		assert.strictEqual(emoji.body.category, 'approved');

		// 申請者のファイルではなく、システム所有のファイルに複製されている
		await api('drive/files/delete', { fileId }, alice);
		const after = await api('emoji', { name: 'after_fix' });
		assert.strictEqual(after.status, 200);
		assert.strictEqual(after.body.url, emoji.body.url);

		const again = await api('admin/emoji-requests/approve', { requestId: created.body.id }, approver);
		assert.strictEqual(again.status, 400);
		assert.strictEqual(errorCode(again), 'NOT_PENDING');
	});

	test('既にある絵文字と同じ名前では承認できず、申請は確認待ちのまま', async () => {
		const fileId = await upload(alice);
		const created = await api('emoji-requests/create', { fileId, name: 'will_collide' }, alice);

		const res = await api('admin/emoji-requests/approve', { requestId: created.body.id, name: 'after_fix' }, moderator);
		assert.strictEqual(res.status, 400);
		assert.strictEqual(errorCode(res), 'DUPLICATE_NAME');

		const list = await api('admin/emoji-requests/list', { status: 'pending' }, moderator);
		assert.ok(list.body.some(r => r.id === created.body.id));
	});

	test('申請した画像が消えていると承認できない', async () => {
		const fileId = await upload(alice);
		const created = await api('emoji-requests/create', { fileId, name: 'file_gone' }, alice);
		await api('drive/files/delete', { fileId }, alice);
		// ファイルの削除は非同期で進むので少し待つ
		await new Promise(resolve => setTimeout(resolve, 1000));

		const res = await api('admin/emoji-requests/approve', { requestId: created.body.id }, approver);
		assert.strictEqual(res.status, 400);
		assert.strictEqual(errorCode(res), 'FILE_GONE');
	});

	test('却下すると状態と理由が残り、申請者に通知が届く', async () => {
		const fileId = await upload(alice);
		const created = await api('emoji-requests/create', { fileId, name: 'to_reject' }, alice);

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
		assert.ok(notifications.body.some(n => n.type === 'app' && n.body.includes(':to_reject:')));
	});
});
