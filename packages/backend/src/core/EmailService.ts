/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as dns from 'node:dns';
import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTransport } from 'nodemailer';
import juice from 'juice';
import sanitizeHtml from 'sanitize-html';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { UtilityService } from '@/core/UtilityService.js';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type Logger from '@/logger.js';
import type { MiMeta, UserProfilesRepository } from '@/models/_.js';
import { LoggerService } from '@/core/LoggerService.js';
import { bindThis } from '@/decorators.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { escapeHtml } from '@/misc/escape-html.js';
import { SystemWebhookService } from '@/core/SystemWebhookService.js';
import type { EmailBlockedPayload } from '@/core/SystemWebhookService.js';

type EmailValidationReason = 'used' | 'format' | 'disposable' | 'mx' | 'smtp' | 'banned' | 'network' | 'blacklist';

type EmailValidationResult = {
	available: boolean;
	reason: null | EmailValidationReason;
};

/** 判定の根拠。MXの登録内容などが漏れないよう、APIのレスポンスには含めない */
type EmailBlockDetail = {
	source: EmailBlockedPayload['source'];
	matched: string | null;
	enforced: boolean;
};

const DISPOSABLE_EMAIL_DOMAIN_LIST_PATH = 'packages/backend/data/disposable-email-domains/domains.txt';
// 登録中の利用者を待たせる処理なので、Resolver側の再試行とは別に全体の上限を設ける
const MX_LOOKUP_DEADLINE_MS = 3000;
const EMAIL_BLOCKED_NOTIFY_INTERVAL_SEC = 60 * 10;
const EMAIL_BLOCKED_NOTIFY_MAX_PER_INTERVAL = 30;

/**
 * 誰でもサブドメインを作れるサフィックス。リストに載っていても配下すべてが捨てアドとは限らないので、
 * 親ドメインとしては照合しない（完全一致なら拒否する）
 */
const DISPOSABLE_LIST_SHARED_SUFFIXES = new Set([
	'3utilities.com', 'biz.st', 'ch.tc', 'cloudns.asia', 'cloudns.cc', 'cloudns.cf', 'cloudns.cx', 'cloudns.gq',
	'cloudns.org', 'co.cc', 'ddns.net', 'ddnsfree.com', 'dnsiskinky.com', 'dyn.ddnss.de', 'dyn.home-webserver.de',
	'dyndns.ddnss.de', 'dyndns.org', 'dynu.net', 'gleeze.com', 'hopto.org', 'it.com', 'kozow.com', 'mooo.com',
	'msk.ru', 'no-ip.net', 'noip.me', 'onthewifi.com', 'or.ru', 'pp.ua', 'servebeer.com', 'serveexchange.com',
	'servegame.com', 'sytes.net', 'us.to', 'webhop.me', 'za.com',
]);

@Injectable()
export class EmailService {
	private logger: Logger;
	private disposableEmailDomains: Promise<Set<string>> | null = null;
	private resolver = new dns.promises.Resolver({ timeout: 1000, tries: 2 });

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		private loggerService: LoggerService,
		private utilityService: UtilityService,
		private httpRequestService: HttpRequestService,
		private systemWebhookService: SystemWebhookService,
	) {
		this.logger = this.loggerService.getLogger('email');
	}

	@bindThis
	public async sendEmail(to: string, subject: string, html: string, text: string) {
		if (!this.meta.enableEmail) return;

		const iconUrl = `${this.config.url}/static-assets/mi-white.png`;
		const emailSettingUrl = `${this.config.url}/settings/email`;

		const enableAuth = this.meta.smtpUser != null && this.meta.smtpUser !== '';

		const sanitizedHtml = sanitizeHtml(html);

		const transporter = createTransport({
			host: this.meta.smtpHost ?? undefined,
			port: this.meta.smtpPort ?? undefined,
			secure: this.meta.smtpSecure,
			ignoreTLS: !enableAuth,
			proxy: this.config.proxySmtp,
			auth: enableAuth ? {
				user: this.meta.smtpUser!,
				pass: this.meta.smtpPass ?? undefined,
			} : undefined,
		});

		const htmlContent = `<!doctype html>
<html>
	<head>
		<meta charset="utf-8">
		<title>${ escapeHtml(subject) }</title>
		<style>
			html {
				background: #eee;
			}

			body {
				padding: 16px;
				margin: 0;
				font-family: sans-serif;
				font-size: 14px;
			}

			a {
				text-decoration: none;
				color: #86b300;
			}
			a:hover {
				text-decoration: underline;
			}

			main {
				max-width: 500px;
				margin: 0 auto;
				background: #fff;
				color: #555;
			}
				main > header {
					padding: 32px;
					background: #86b300;
				}
					main > header > img {
						max-width: 128px;
						max-height: 28px;
						vertical-align: bottom;
					}
				main > article {
					padding: 32px;
				}
					main > article > h1 {
						margin: 0 0 1em 0;
					}
				main > footer {
					padding: 32px;
					border-top: solid 1px #eee;
				}

			nav {
				box-sizing: border-box;
				max-width: 500px;
				margin: 16px auto 0 auto;
				padding: 0 32px;
			}
				nav > a {
					color: #888;
				}
		</style>
	</head>
	<body>
		<main>
			<header>
				<img src="${ escapeHtml(this.meta.logoImageUrl ?? this.meta.iconUrl ?? iconUrl) }"/>
			</header>
			<article>
				<h1>${ escapeHtml(subject) }</h1>
				<div>${ sanitizedHtml }</div>
			</article>
			<footer>
				<a href="${ escapeHtml(emailSettingUrl) }">${ 'Email setting' }</a>
			</footer>
		</main>
		<nav>
			<a href="${ escapeHtml(this.config.url) }">${ escapeHtml(this.config.host) }</a>
		</nav>
	</body>
</html>`;

		const inlinedHtml = juice(htmlContent);

		try {
			const info = await transporter.sendMail({
				from: this.meta.name ? {
					name: this.meta.name,
					address: this.meta.email!,
				} : this.meta.email!,
				to: to,
				subject: subject,
				text: text,
				html: inlinedHtml,
			});

			this.logger.info(`Message sent: ${info.messageId}`);
		} catch (err) {
			this.logger.error(err as Error);
			throw err;
		}
	}

	@bindThis
	public async validateEmailForAccount(emailAddress: string): Promise<EmailValidationResult> {
		const { available, reason } = await this.checkEmailForAccount(emailAddress);
		return { available, reason };
	}

	/**
	 * 実際にメールアドレスを登録する操作向けの検証。判定に該当した場合はSystemWebhookで通知する。
	 * 未認証で呼べて入力中にも発火する email-address/available からは呼ばないこと。
	 */
	@bindThis
	public async validateEmailForAccountAndNotify(emailAddress: string, via: EmailBlockedPayload['via']): Promise<EmailValidationResult> {
		const { available, reason, detail } = await this.checkEmailForAccount(emailAddress);

		if (detail != null) {
			// 通知の失敗や遅延を登録処理に影響させない
			this.notifyEmailBlocked(emailAddress, via, detail).catch(err => {
				this.logger.warn(`Failed to notify blocked email: ${err}`);
			});
		}

		return { available, reason };
	}

	@bindThis
	private async checkEmailForAccount(emailAddress: string): Promise<EmailValidationResult & { detail?: EmailBlockDetail }> {
		if (!this.utilityService.validateEmailFormat(emailAddress)) {
			return {
				available: false,
				reason: 'format',
			};
		}

		const exist = await this.userProfilesRepository.countBy({
			emailVerified: true,
			email: emailAddress,
		});

		if (exist !== 0) {
			return {
				available: false,
				reason: 'used',
			};
		}

		let validated: {
			valid: boolean,
			reason?: string | null,
		} = { valid: true, reason: null };

		if (this.meta.enableActiveEmailValidation) {
			if (this.meta.enableVerifymailApi && this.meta.verifymailAuthKey != null) {
				validated = await this.verifyMail(emailAddress, this.meta.verifymailAuthKey);
			} else if (this.meta.enableTruemailApi && this.meta.truemailInstance && this.meta.truemailAuthKey != null) {
				validated = await this.trueMail(this.meta.truemailInstance, emailAddress, this.meta.truemailAuthKey);
			} else {
				const { validate: validateEmail } = await import('deep-email-validator');
				validated = await validateEmail({
					email: emailAddress,
					validateRegex: true,
					validateMx: true,
					validateTypo: false, // TLDを見ているみたいだけどclubとか弾かれるので
					validateDisposable: true, // 捨てアドかどうかチェック
					validateSMTP: false, // 日本だと25ポートが殆どのプロバイダーで塞がれていてタイムアウトになるので
				});
			}
		}

		if (!validated.valid) {
			const formatReason: Record<string, 'format' | 'disposable' | 'mx' | 'smtp' | 'network' | 'blacklist' | undefined> = {
				regex: 'format',
				disposable: 'disposable',
				mx: 'mx',
				smtp: 'smtp',
				network: 'network',
				blacklist: 'blacklist',
			};

			const reason = validated.reason ? formatReason[validated.reason] ?? null : null;

			return {
				available: false,
				reason,
				...(reason === 'disposable' || reason === 'blacklist' ? {
					detail: { source: 'activeValidation', matched: reason, enforced: true },
				} : {}),
			};
		}

		const emailDomain = this.getEmailDomain(emailAddress);
		const isBanned = this.utilityService.isBlockedHost(this.meta.bannedEmailDomains, emailDomain);

		if (isBanned) {
			return {
				available: false,
				reason: 'banned',
				detail: {
					source: 'bannedDomain',
					matched: this.meta.bannedEmailDomains.find(x => this.utilityService.isBlockedHost([x], emailDomain)) ?? emailDomain,
					enforced: true,
				},
			};
		}

		// MX判定はネットワークを使うので最後に行う。ただし公開リストが記録のみの場合はMXで拒否できる可能性が残る
		const listMatched = await this.matchDisposableEmailDomainList(emailDomain);

		if (listMatched != null && this.meta.enableDisposableEmailDomainList) {
			return {
				available: false,
				reason: 'disposable',
				detail: { source: 'disposableList', matched: listMatched, enforced: true },
			};
		}

		const mxMatched = await this.matchBannedMxHost(emailDomain);

		if (mxMatched != null) {
			return {
				available: false,
				reason: 'disposable',
				detail: { source: 'mx', matched: mxMatched, enforced: true },
			};
		}

		return {
			available: true,
			reason: null,
			...(listMatched != null ? {
				detail: { source: 'disposableList', matched: listMatched, enforced: false },
			} : {}),
		};
	}

	@bindThis
	private getEmailDomain(emailAddress: string): string {
		return emailAddress.slice(emailAddress.lastIndexOf('@') + 1).toLowerCase();
	}

	@bindThis
	private loadDisposableEmailDomains(): Promise<Set<string>> {
		this.disposableEmailDomains ??= fs.readFile(resolve(this.config.rootDir, DISPOSABLE_EMAIL_DOMAIN_LIST_PATH), 'utf-8')
			.then(text => new Set(text.split('\n').map(x => x.trim().toLowerCase()).filter(x => x !== '')))
			.catch(err => {
				// リストが読めなくても登録は止めない。次回の判定で読み直す
				this.disposableEmailDomains = null;
				this.logger.warn(`Failed to load disposable email domain list: ${err}`);
				return new Set<string>();
			});

		return this.disposableEmailDomains;
	}

	/**
	 * 公開捨てアドリストに一致したドメインを返す。サブドメインも親ドメインで判定する
	 */
	@bindThis
	private async matchDisposableEmailDomainList(emailDomain: string): Promise<string | null> {
		if (this.utilityService.isBlockedHost(this.meta.disposableEmailDomainListExclusions, emailDomain)) return null;

		const domains = await this.loadDisposableEmailDomains();

		const labels = emailDomain.split('.');
		for (let i = 0; i < labels.length - 1; i++) {
			const candidate = labels.slice(i).join('.');
			if (i > 0 && DISPOSABLE_LIST_SHARED_SUFFIXES.has(candidate)) continue;
			if (domains.has(candidate)) return candidate;
		}

		return null;
	}

	/**
	 * 拒否対象のMXホストに一致したホスト名を返す。
	 * DNSの障害で登録全体を止めないよう、解決に失敗した場合は不一致として扱う
	 */
	@bindThis
	private async matchBannedMxHost(emailDomain: string): Promise<string | null> {
		const bannedMxHosts = this.meta.bannedEmailMxHosts;
		if (bannedMxHosts.length === 0) return null;

		let mxHosts: string[];
		try {
			mxHosts = await this.resolveMxHosts(emailDomain);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== dns.NOTFOUND && code !== dns.NODATA) {
				this.logger.warn(`Failed to resolve MX of ${emailDomain}: ${code ?? err}`);
			}
			return null;
		}

		return mxHosts
			.map(x => x.toLowerCase().replace(/\.+$/, ''))
			.find(x => this.utilityService.isBlockedHost(bannedMxHosts, x)) ?? null;
	}

	@bindThis
	private async resolveMxHosts(emailDomain: string): Promise<string[]> {
		let timer: NodeJS.Timeout | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(Object.assign(new Error('MX lookup deadline exceeded'), { code: dns.TIMEOUT })), MX_LOOKUP_DEADLINE_MS);
		});

		try {
			const records = await Promise.race([this.resolver.resolveMx(emailDomain), deadline]);
			return records.map(x => x.exchange);
		} finally {
			clearTimeout(timer);
		}
	}

	@bindThis
	private maskEmailAddress(emailAddress: string): string {
		const at = emailAddress.lastIndexOf('@');
		return `${emailAddress.slice(0, 1)}***@${emailAddress.slice(at + 1).toLowerCase()}`;
	}

	/**
	 * 同じ判定の通知は一定時間に1回にまとめ、全体の件数にも上限を設ける（ワーカーをまたいで共有するためRedisを使う）。
	 * 公開リストと禁止ドメインはサブドメインでも一致するので、ランダムなサブドメインで間引きを回避されないよう一致した値で束ねる
	 */
	@bindThis
	private async notifyEmailBlocked(emailAddress: string, via: EmailBlockedPayload['via'], detail: EmailBlockDetail): Promise<void> {
		const domain = this.getEmailDomain(emailAddress);

		const groupedByMatch = detail.source === 'disposableList' || detail.source === 'bannedDomain';
		const key = groupedByMatch ? detail.matched ?? domain : domain;

		const acquired = await this.redisClient.set(`emailBlockedNotified:${detail.source}:${key}`, '1', 'EX', EMAIL_BLOCKED_NOTIFY_INTERVAL_SEC, 'NX');
		if (acquired == null) return;

		const countKey = 'emailBlockedNotifiedCount';
		// 初期化とTTLの設定を同時に行い、カウンターがTTLなしで残って通知が止まり続けることを防ぐ
		const results = await this.redisClient.multi()
			.set(countKey, '0', 'EX', EMAIL_BLOCKED_NOTIFY_INTERVAL_SEC, 'NX')
			.incr(countKey)
			.exec();
		const [incrError, count] = results?.[1] ?? [new Error('Redis transaction aborted'), null];
		if (incrError != null) throw incrError;
		if ((count as number) > EMAIL_BLOCKED_NOTIFY_MAX_PER_INTERVAL) return;

		await this.systemWebhookService.enqueueSystemWebhook('emailBlocked', {
			maskedEmail: this.maskEmailAddress(emailAddress),
			domain,
			via,
			...detail,
		});
	}

	private async verifyMail(emailAddress: string, verifymailAuthKey: string): Promise<{
		valid: boolean;
		reason: 'used' | 'format' | 'disposable' | 'mx' | 'smtp' | null;
	}> {
		const endpoint = 'https://verifymail.io/api/' + emailAddress + '?key=' + verifymailAuthKey;
		const res = await this.httpRequestService.send(endpoint, {
			method: 'GET',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Accept: 'application/json, */*',
			},
		});

		const json = (await res.json()) as Partial<{
			message: string;
			block: boolean;
			catch_all: boolean;
			deliverable_email: boolean;
			disposable: boolean;
			domain: string;
			email_address: string;
			email_provider: string;
			mx: boolean;
			mx_fallback: boolean;
			mx_host: string[];
			mx_ip: string[];
			mx_priority: { [key: string]: number };
			privacy: boolean;
			related_domains: string[];
		}>;

		/* api error: when there is only one `message` attribute in the returned result */
		if (Object.keys(json).length === 1 && Reflect.has(json, 'message')) {
			return {
				valid: false,
				reason: null,
			};
		}
		if (json.email_address === undefined) {
			return {
				valid: false,
				reason: 'format',
			};
		}
		if (json.deliverable_email !== undefined && !json.deliverable_email) {
			return {
				valid: false,
				reason: 'smtp',
			};
		}
		if (json.disposable) {
			return {
				valid: false,
				reason: 'disposable',
			};
		}
		if (json.mx !== undefined && !json.mx) {
			return {
				valid: false,
				reason: 'mx',
			};
		}

		return {
			valid: true,
			reason: null,
		};
	}

	private async trueMail<T>(truemailInstance: string, emailAddress: string, truemailAuthKey: string): Promise<{
		valid: boolean;
		reason: 'used' | 'format' | 'blacklist' | 'mx' | 'smtp' | 'network' | T | null;
	}> {
		const endpoint = truemailInstance + '?email=' + emailAddress;
		try {
			const res = await this.httpRequestService.send(endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json',
					Authorization: truemailAuthKey,
				},
				isLocalAddressAllowed: true,
			});

			const json = (await res.json()) as {
				email: string;
				success: boolean;
				error?: string;
				errors?: {
					list_match?: string;
					regex?: string;
					mx?: string;
					smtp?: string;
				} | null;
			};

			if (json.email === undefined || json.errors?.regex) {
				return {
					valid: false,
					reason: 'format',
				};
			}
			if (json.errors?.smtp) {
				return {
					valid: false,
					reason: 'smtp',
				};
			}
			if (json.errors?.mx) {
				return {
					valid: false,
					reason: 'mx',
				};
			}
			if (!json.success) {
				return {
					valid: false,
					reason: json.errors?.list_match as T || 'blacklist',
				};
			}

			return {
				valid: true,
				reason: null,
			};
		} catch (_) {
			return {
				valid: false,
				reason: 'network',
			};
		}
	}
}
