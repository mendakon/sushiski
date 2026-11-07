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

	test('通報対象はユーザー名で表示する', () => {
		const body = buildDiscordWebhookBody('abuseReport', { targetUser: { username: 'bob', host: 'remote.example' }, targetUserId: 'id1', comment: 'x' }, SERVER);
		expect(body.content).toContain('name: @bob@remote.example');
	});

	test('新規登録はメールアドレスとユーザーページのURLを載せる', () => {
		const body = buildDiscordWebhookBody('userCreated', { username: 'alice_1', email: 'a_b*c@example.com' }, SERVER);
		expect(body.content).toBe([
			'新規ユーザー登録がありました。',
			`server: <${SERVER}>`,
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
