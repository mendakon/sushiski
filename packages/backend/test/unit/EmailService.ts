/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { EmailService } from '@/core/EmailService.js';
import { UtilityService } from '@/core/UtilityService.js';
import AvailableEndpoint, { meta as availableMeta } from '@/server/api/endpoints/email-address/available.js';
import type { Config } from '@/config.js';
import type { MiMeta, UserProfilesRepository } from '@/models/_.js';
import type { LoggerService } from '@/core/LoggerService.js';
import type { HttpRequestService } from '@/core/HttpRequestService.js';
import type { SystemWebhookService } from '@/core/SystemWebhookService.js';
import type * as Redis from 'ioredis';

const dnsError = (code: string) => Object.assign(new Error(code), { code });

describe('EmailService', () => {
	let rootDir: string;
	let meta: Partial<MiMeta>;
	let redisSet: ReturnType<typeof vi.fn>;
	let redisMulti: { set: ReturnType<typeof vi.fn>; incr: ReturnType<typeof vi.fn>; exec: ReturnType<typeof vi.fn> };
	let enqueueSystemWebhook: ReturnType<typeof vi.fn>;
	let warn: ReturnType<typeof vi.fn>;
	let resolveMxHosts: ReturnType<typeof vi.fn>;
	let service: EmailService;

	beforeAll(async () => {
		rootDir = await fs.mkdtemp(join(tmpdir(), 'misskey-email-service-'));
		const dir = join(rootDir, 'packages/backend/data/disposable-email-domains');
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(join(dir, 'domains.txt'), 'listed.example\nybb.ne.jp\nddns.net\nbad.ddns.net\n');
	});

	afterAll(async () => {
		await fs.rm(rootDir, { recursive: true, force: true });
	});

	function createService(root = rootDir) {
		const instance = new EmailService(
			{ rootDir: root } as unknown as Config,
			{ set: redisSet, multi: () => redisMulti } as unknown as Redis.Redis,
			meta as MiMeta,
			{ countBy: vi.fn().mockResolvedValue(0) } as unknown as UserProfilesRepository,
			{ getLogger: () => ({ warn }) } as unknown as LoggerService,
			new UtilityService({} as Config, meta as MiMeta),
			{} as HttpRequestService,
			{ enqueueSystemWebhook } as unknown as SystemWebhookService,
		);
		vi.spyOn(instance as unknown as { resolveMxHosts: () => Promise<string[]> }, 'resolveMxHosts').mockImplementation(resolveMxHosts as never);
		return instance;
	}

	const flush = () => new Promise(resolve => setImmediate(resolve));

	beforeEach(() => {
		meta = {
			enableActiveEmailValidation: false,
			bannedEmailDomains: [],
			bannedEmailMxHosts: ['erinn.biz'],
			enableDisposableEmailDomainList: false,
			disposableEmailDomainListExclusions: [],
		};
		redisSet = vi.fn().mockResolvedValue('OK');
		redisMulti = { set: vi.fn().mockReturnThis(), incr: vi.fn().mockReturnThis(), exec: vi.fn().mockResolvedValue([[null, 'OK'], [null, 1]]) };
		enqueueSystemWebhook = vi.fn().mockResolvedValue(undefined);
		warn = vi.fn();
		resolveMxHosts = vi.fn().mockResolvedValue(['aspmx.l.google.com']);
		service = createService();
	});

	describe('MX', () => {
		test('一致するMXのサブドメインを拒否する', async () => {
			resolveMxHosts.mockResolvedValue(['recv405.erinn.biz']);
			expect(await service.validateEmailForAccount('a@catcat.uk')).toEqual({ available: false, reason: 'disposable' });
		});

		test('大文字や末尾のドットがあっても一致する', async () => {
			resolveMxHosts.mockResolvedValue(['RECV-KYWAUK.ERINN.BIZ.']);
			expect((await service.validateEmailForAccount('a@kywa.uk')).available).toBe(false);
		});

		test('似た名前のホストには一致しない', async () => {
			resolveMxHosts.mockResolvedValue(['notreally-erinn.biz', 'xerinn.biz']);
			expect((await service.validateEmailForAccount('a@example.com')).available).toBe(true);
		});

		test('未設定ならDNSを引かない', async () => {
			meta.bannedEmailMxHosts = [];
			expect((await service.validateEmailForAccount('a@catcat.uk')).available).toBe(true);
			expect(resolveMxHosts).not.toHaveBeenCalled();
		});

		test('MXが無いドメインは静かに通す', async () => {
			resolveMxHosts.mockRejectedValue(dnsError('ENODATA'));
			expect((await service.validateEmailForAccount('a@example.com')).available).toBe(true);
			expect(warn).not.toHaveBeenCalled();
		});

		test('DNS障害時はログを残して通す', async () => {
			resolveMxHosts.mockRejectedValue(dnsError('ETIMEOUT'));
			expect((await service.validateEmailForAccount('a@example.com')).available).toBe(true);
			expect(warn).toHaveBeenCalledOnce();
		});
	});

	describe('公開リスト', () => {
		test('OFFなら拒否しない', async () => {
			expect((await service.validateEmailForAccount('a@listed.example')).available).toBe(true);
		});

		test('ONなら拒否し、DNSは引かない', async () => {
			meta.enableDisposableEmailDomainList = true;
			expect(await service.validateEmailForAccount('a@listed.example')).toEqual({ available: false, reason: 'disposable' });
			expect(resolveMxHosts).not.toHaveBeenCalled();
		});

		test('サブドメインも親ドメインで一致する', async () => {
			meta.enableDisposableEmailDomainList = true;
			expect((await service.validateEmailForAccount('a@foo.LISTED.example')).available).toBe(false);
		});

		test('除外ドメインは拒否しない', async () => {
			meta.enableDisposableEmailDomainList = true;
			meta.disposableEmailDomainListExclusions = ['ybb.ne.jp'];
			expect((await service.validateEmailForAccount('a@ybb.ne.jp')).available).toBe(true);
		});

		test('除外ドメインでもMXが一致すれば拒否する', async () => {
			meta.enableDisposableEmailDomainList = true;
			meta.disposableEmailDomainListExclusions = ['listed.example'];
			resolveMxHosts.mockResolvedValue(['recv300.erinn.biz']);
			expect((await service.validateEmailForAccount('a@listed.example')).available).toBe(false);
		});

		test('共有サフィックスは親ドメインとして照合しない', async () => {
			meta.enableDisposableEmailDomainList = true;
			expect((await service.validateEmailForAccount('a@mine.ddns.net')).available).toBe(true);
			expect((await service.validateEmailForAccount('a@ddns.net')).available).toBe(false);
			expect((await service.validateEmailForAccount('a@bad.ddns.net')).available).toBe(false);
		});

		test('読み込みに失敗しても登録を止めず、次回に読み直す', async () => {
			const root = await fs.mkdtemp(join(tmpdir(), 'misskey-email-service-'));
			meta.enableDisposableEmailDomainList = true;
			service = createService(root);
			expect((await service.validateEmailForAccount('a@listed.example')).available).toBe(true);
			expect(warn).toHaveBeenCalledOnce();

			const dir = join(root, 'packages/backend/data/disposable-email-domains');
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(join(dir, 'domains.txt'), 'listed.example\n');
			expect((await service.validateEmailForAccount('a@listed.example')).available).toBe(false);
			await fs.rm(root, { recursive: true, force: true });
		});

		test('同梱のリストを読める', async () => {
			meta.enableDisposableEmailDomainList = true;
			service = createService(fileURLToPath(new URL('../../../..', import.meta.url)));
			expect((await service.validateEmailForAccount('a@catcat.uk')).available).toBe(false);
			expect((await service.validateEmailForAccount('a@gmail.com')).available).toBe(true);
		});
	});

	describe('email-address/available', () => {
		test('通知しない検証を使い、レート制限を持つ', async () => {
			const notify = vi.fn();
			const validate = vi.fn().mockResolvedValue({ available: true, reason: null });
			const endpoint = new AvailableEndpoint({ validateEmailForAccount: validate, validateEmailForAccountAndNotify: notify } as unknown as EmailService);
			await endpoint.exec({ emailAddress: 'a@catcat.uk' }, null, null);
			expect(validate).toHaveBeenCalledOnce();
			expect(notify).not.toHaveBeenCalled();
			expect(availableMeta.limit.max).toBeGreaterThan(0);
		});
	});

	describe('通知', () => {
		test('validateEmailForAccount は通知せず、判定の根拠も返さない', async () => {
			resolveMxHosts.mockResolvedValue(['recv405.erinn.biz']);
			const result = await service.validateEmailForAccount('a@catcat.uk');
			await flush();
			expect(Object.keys(result).sort()).toEqual(['available', 'reason']);
			expect(enqueueSystemWebhook).not.toHaveBeenCalled();
		});

		test('拒否時はローカル部を伏せて通知する', async () => {
			resolveMxHosts.mockResolvedValue(['recv405.erinn.biz']);
			const result = await service.validateEmailForAccountAndNotify('alice@CatCat.uk', 'signup');
			await flush();
			expect(result).toEqual({ available: false, reason: 'disposable' });
			expect(enqueueSystemWebhook).toHaveBeenCalledWith('emailBlocked', {
				maskedEmail: 'a***@catcat.uk',
				domain: 'catcat.uk',
				via: 'signup',
				source: 'mx',
				matched: 'recv405.erinn.biz',
				enforced: true,
			});
		});

		test('禁止ドメインも通知する', async () => {
			meta.bannedEmailDomains = ['banned.example'];
			await service.validateEmailForAccountAndNotify('a@banned.example', 'updateEmail');
			await flush();
			expect(enqueueSystemWebhook).toHaveBeenCalledWith('emailBlocked', expect.objectContaining({ source: 'bannedDomain', via: 'updateEmail' }));
		});

		test('リストがOFFのときは通しつつ、記録のみとして通知する', async () => {
			const result = await service.validateEmailForAccountAndNotify('a@listed.example', 'signup');
			await flush();
			expect(result.available).toBe(true);
			expect(enqueueSystemWebhook).toHaveBeenCalledWith('emailBlocked', expect.objectContaining({ source: 'disposableList', enforced: false }));
		});

		test('リストがOFFでもMXが一致すれば拒否として通知する', async () => {
			resolveMxHosts.mockResolvedValue(['recv300.erinn.biz']);
			await service.validateEmailForAccountAndNotify('a@listed.example', 'signup');
			await flush();
			expect(enqueueSystemWebhook).toHaveBeenCalledWith('emailBlocked', expect.objectContaining({ source: 'mx', enforced: true }));
		});

		test('問題のないアドレスは通知しない', async () => {
			await service.validateEmailForAccountAndNotify('a@example.com', 'signup');
			await flush();
			expect(redisSet).not.toHaveBeenCalled();
			expect(enqueueSystemWebhook).not.toHaveBeenCalled();
		});

		test('同じドメインの通知は間引く', async () => {
			resolveMxHosts.mockResolvedValue(['recv405.erinn.biz']);
			redisSet.mockResolvedValue(null);
			await service.validateEmailForAccountAndNotify('a@catcat.uk', 'signup');
			await flush();
			expect(redisSet).toHaveBeenCalledWith('emailBlockedNotified:mx:catcat.uk', '1', 'EX', 600, 'NX');
			expect(enqueueSystemWebhook).not.toHaveBeenCalled();
		});

		test('ランダムなサブドメインでも一致した値で間引く', async () => {
			meta.bannedEmailDomains = ['banned.example'];
			await service.validateEmailForAccountAndNotify('a@r1.listed.example', 'signup');
			await service.validateEmailForAccountAndNotify('a@r2.banned.example', 'signup');
			await flush();
			expect(redisSet).toHaveBeenCalledWith('emailBlockedNotified:disposableList:listed.example', '1', 'EX', 600, 'NX');
			expect(redisSet).toHaveBeenCalledWith('emailBlockedNotified:bannedDomain:banned.example', '1', 'EX', 600, 'NX');
		});

		test('全体の上限を超えたら通知しない', async () => {
			resolveMxHosts.mockResolvedValue(['recv405.erinn.biz']);
			redisMulti.exec.mockResolvedValue([[null, null], [null, 31]]);
			await service.validateEmailForAccountAndNotify('a@catcat.uk', 'signup');
			await flush();
			expect(enqueueSystemWebhook).not.toHaveBeenCalled();
		});

		test('全体の件数はTTL付きで初期化する', async () => {
			resolveMxHosts.mockResolvedValue(['recv405.erinn.biz']);
			await service.validateEmailForAccountAndNotify('a@catcat.uk', 'signup');
			await flush();
			expect(redisMulti.set).toHaveBeenCalledWith('emailBlockedNotifiedCount', '0', 'EX', 600, 'NX');
			expect(enqueueSystemWebhook).toHaveBeenCalledOnce();
		});

		test('Redisのトランザクションが失敗したら通知せず、判定は変えない', async () => {
			resolveMxHosts.mockResolvedValue(['recv405.erinn.biz']);
			redisMulti.exec.mockResolvedValue(null);
			const result = await service.validateEmailForAccountAndNotify('a@catcat.uk', 'signup');
			await flush();
			expect(result.available).toBe(false);
			expect(enqueueSystemWebhook).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledOnce();
		});

		test('通知に失敗しても判定結果は変わらない', async () => {
			resolveMxHosts.mockResolvedValue(['recv405.erinn.biz']);
			enqueueSystemWebhook.mockRejectedValue(new Error('redis down'));
			const result = await service.validateEmailForAccountAndNotify('a@catcat.uk', 'signup');
			await flush();
			expect(result).toEqual({ available: false, reason: 'disposable' });
			expect(warn).toHaveBeenCalledOnce();
		});
	});
});
