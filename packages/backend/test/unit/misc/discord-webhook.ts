/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { buildDiscordWebhookBody, isDiscordWebhookUrl } from '@/misc/discord-webhook.js';
import { SystemWebhookDeliverProcessorService } from '@/queue/processors/SystemWebhookDeliverProcessorService.js';

const SERVER = 'https://example.com';
const DISCORD_URL = 'https://discord.com/api/webhooks/123/token';

describe('isDiscordWebhookUrl', () => {
	test.each([
		DISCORD_URL,
		'https://discordapp.com/api/webhooks/123/token',
		'https://canary.discord.com/api/v10/webhooks/123/token',
	])('%s は対象', (url) => {
		expect(isDiscordWebhookUrl(url)).toBe(true);
	});

	test.each([
		'https://misskey-to-discord.example.workers.dev/',
		'https://discord.com/api/webhooks/123/token/slack',
		'https://discord.com/api/webhooks/123/token/github',
		'https://discord.com.evil.example/api/webhooks/123/token',
		'http://discord.com/api/webhooks/123/token',
		'not a url',
	])('%s は対象外', (url) => {
		expect(isDiscordWebhookUrl(url)).toBe(false);
	});
});

describe('buildDiscordWebhookBody', () => {
	test('通報文のメンションを発動させない', () => {
		const body = buildDiscordWebhookBody('abuseReport', { targetUser: null, targetUserId: 'id1', comment: '@everyone' }, SERVER);
		expect(body.content).toContain('@everyone');
		expect(body.allowed_mentions).toEqual({ parse: [] });
	});

	test('Discordの2000文字制限に収める', () => {
		const body = buildDiscordWebhookBody('abuseReport', { targetUser: null, targetUserId: 'id1', comment: '🍣'.repeat(3000) }, SERVER);
		expect(body.content.length).toBeLessThanOrEqual(2000);
		expect(body.content.endsWith('…')).toBe(true);
		expect(body.content).not.toMatch(/[\uD800-\uDBFF]…$/);
	});

	test('通報は対象・通報者・内容・確認先を載せる', () => {
		const body = buildDiscordWebhookBody('abuseReport', {
			targetUser: { username: 'bob', host: 'remote.example' },
			targetUserId: 'id1',
			reporter: { username: 'alice', host: null },
			reporterId: 'id2',
			comment: '絵の無断転載\nhttps://example.com/notes/abc',
		}, SERVER);
		expect(body.content).toBe([
			'🚨 新しい通報があります。',
			`対象: @bob@remote.example  <${SERVER}/@bob@remote.example>`,
			`通報者: @alice  <${SERVER}/@alice>`,
			'内容:',
			'> 絵の無断転載',
			'> https://example.com/notes/abc',
			`確認: <${SERVER}/admin/abuses>`,
			'',
		].join('\n'));
	});

	test('通報の処理は結果・処理者・ノートを載せる', () => {
		const base = {
			targetUser: { username: 'bob', host: null },
			targetUserId: 'id1',
			reporter: null,
			reporterId: 'id2',
			assignee: { username: 'mod', host: null },
			assigneeId: 'id3',
			forwarded: true,
			moderationNote: '凍結しました',
			comment: '',
		};
		const accepted = buildDiscordWebhookBody('abuseReportResolved', { ...base, resolvedAs: 'accept' }, SERVER).content;
		expect(accepted).toBe([
			'✅ 通報が処理されました。',
			'結果: 是認（通報の内容を認めて対応した）',
			`対象: @bob  <${SERVER}/@bob>`,
			'通報者: id2',
			`処理者: @mod  <${SERVER}/@mod>`,
			'転送: 相手のサーバーに転送済み',
			'モデレーションノート:',
			'> 凍結しました',
			'内容:',
			'> （なし）',
			'',
		].join('\n'));

		const rejected = buildDiscordWebhookBody('abuseReportResolved', { ...base, resolvedAs: 'reject', assigneeId: null, assignee: null, forwarded: false, moderationNote: '' }, SERVER).content;
		expect(rejected).toContain('結果: 否認（問題なしと判断した）');
		expect(rejected).not.toContain('処理者');
		expect(rejected).not.toContain('転送');
		expect(rejected).not.toContain('モデレーションノート');
	});

	test('リンクプレビューを出さず、サーバーの行も付けない', () => {
		for (const [type, content] of [
			['userCreated', { username: 'alice', email: null }],
			['abuseReport', { targetUser: null, targetUserId: 'id1', reporter: null, reporterId: 'id2', comment: 'x' }],
			['inactiveModeratorsInvitationOnlyChanged', {}],
		] as const) {
			const body = buildDiscordWebhookBody(type, content, SERVER);
			expect(body.flags).toBe(4);
			expect(body.content).not.toContain('server:');
		}
	});

	test('新規登録はメールアドレスとユーザーページのURLを載せる', () => {
		const body = buildDiscordWebhookBody('userCreated', { username: 'alice_1', email: 'a_b*c@example.com' }, SERVER);
		expect(body.content).toBe([
			'新規ユーザー登録がありました。',
			'name: alice\\_1',
			'mail: a\\_b\\*c@example.com',
			`url: <${SERVER}/@alice_1>`,
			'',
		].join('\n'));
	});

	test('メールアドレスがない新規登録は（なし）と表示する', () => {
		const body = buildDiscordWebhookBody('userCreated', { username: 'alice', email: null }, SERVER);
		expect(body.content).toContain('mail: （なし）');
	});

	test('モデレーター不在の通知も本文になる', () => {
		const warning = buildDiscordWebhookBody('inactiveModeratorsWarning', { remainingTime: { time: 1, asDays: 2, asHours: 48 } }, SERVER);
		expect(warning.content).toContain('あと2日');
		const lastDay = buildDiscordWebhookBody('inactiveModeratorsWarning', { remainingTime: { time: 1, asDays: 0, asHours: 5 } }, SERVER);
		expect(lastDay.content).toContain('あと5時間');
		expect(buildDiscordWebhookBody('inactiveModeratorsInvitationOnlyChanged', {}, SERVER).content).toContain('招待制に変更されました');
	});

	test('メールのブロックと記録のみを区別する', () => {
		const content = { maskedEmail: 'a***@catcat.uk', domain: 'catcat.uk', via: 'signup', source: 'mx', matched: 'recv405.erinn.biz' };
		const blocked = buildDiscordWebhookBody('emailBlocked', { ...content, enforced: true }, SERVER).content;
		expect(blocked).toContain('ブロックしました');
		expect(blocked).toContain('判定: MX一致（recv405.erinn.biz）');
		expect(blocked).toContain('経路: 新規登録');
		expect(buildDiscordWebhookBody('emailBlocked', { ...content, enforced: false }, SERVER).content).toContain('記録のみ');
	});
});

describe('SystemWebhookDeliverProcessorService', () => {
	function deliver(to: string) {
		const send = vi.fn().mockResolvedValue({ status: 204 });
		const processor = new SystemWebhookDeliverProcessorService(
			{ url: SERVER, host: 'example.com' } as never,
			{ update: vi.fn() } as never,
			{ send } as never,
			{ logger: { createSubLogger: () => ({ debug: vi.fn(), error: vi.fn() }) } } as never,
		);
		const job = { data: { to, type: 'userCreated', content: { username: 'alice', email: null }, webhookId: 'w', secret: 'shh', eventId: 'e', createdAt: 0 } };
		return processor.process(job as never).then(() => send.mock.calls[0][1]);
	}

	test('Discord宛は変換して送り、secretを送らない', async () => {
		const request = await deliver(DISCORD_URL);
		expect(JSON.parse(request.body).content).toContain('name: alice');
		expect(request.headers).not.toHaveProperty('X-Misskey-Hook-Secret');
	});

	test('それ以外の宛先は従来の形式のまま送る', async () => {
		const request = await deliver('https://hook.example/');
		expect(request).toEqual({
			method: 'POST',
			headers: {
				'User-Agent': 'Misskey-Hooks',
				'X-Misskey-Host': 'example.com',
				'X-Misskey-Hook-Id': 'w',
				'X-Misskey-Hook-Secret': 'shh',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ server: SERVER, hookId: 'w', eventId: 'e', createdAt: 0, type: 'userCreated', body: { username: 'alice', email: null } }),
		});
	});
});
