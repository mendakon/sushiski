/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { EmailBlockedPayload, EmojiRequestCreatedPayload, SystemWebhookPayload } from '@/core/SystemWebhookService.js';
import type { SystemWebhookEventType } from '@/models/SystemWebhook.js';

const DISCORD_HOSTS = ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'];
const DISCORD_CONTENT_MAX_LENGTH = 2000;
const ABUSE_REPORT_AVATAR_URL = 'https://media.sushi.ski/files/thumbnail-f369fc84-1e14-4e7c-900a-9d3ff70ff1cf.webp';

const EMAIL_BLOCK_SOURCE_LABELS: Record<EmailBlockedPayload['source'], string> = {
	activeValidation: 'Active Email Validation',
	bannedDomain: '禁止ドメイン',
	disposableList: '公開リスト',
	mx: 'MX一致',
};

const EMAIL_BLOCK_VIA_LABELS: Record<EmailBlockedPayload['via'], string> = {
	signup: '新規登録',
	updateEmail: 'メールアドレス変更',
};

export type DiscordWebhookBody = {
	content: string;
	username?: string;
	avatar_url?: string;
	allowed_mentions: { parse: never[] };
};

/**
 * Discordの標準形式のWebhook URLかどうか。
 * Slack互換の /slack や GitHub互換の /github は別の形式を受け取るので対象にしない
 */
export function isDiscordWebhookUrl(url: string): boolean {
	if (!URL.canParse(url)) return false;

	const { protocol, hostname, pathname } = new URL(url);
	return protocol === 'https:'
		&& DISCORD_HOSTS.includes(hostname)
		&& /^\/api(\/v\d+)?\/webhooks\/\d+\/[^/]+\/?$/.test(pathname);
}

/**
 * Discordの文字数の数え方に依存しないよう、長い方の数え方であるUTF-16単位で制限に収める
 */
function truncate(text: string): string {
	if (text.length <= DISCORD_CONTENT_MAX_LENGTH) return text;
	return `${text.slice(0, DISCORD_CONTENT_MAX_LENGTH - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

function acct(user: { username: string; host: string | null } | null, fallback: string): string {
	if (user == null) return fallback;
	return user.host == null ? `@${user.username}` : `@${user.username}@${user.host}`;
}

function render(type: SystemWebhookEventType, content: unknown, server: string): Omit<DiscordWebhookBody, 'allowed_mentions'> {
	switch (type) {
		case 'userCreated': {
			const user = content as SystemWebhookPayload<'userCreated'>;
			return {
				username: '新規登録',
				content: `新規ユーザー登録がありました。\nserver: <${server}>\nname: ${user.username}\n`,
			};
		}
		case 'abuseReport':
		case 'abuseReportResolved': {
			const report = content as SystemWebhookPayload<'abuseReport'>;
			const title = type === 'abuseReport' ? '通報がありました。' : '通報が処理されました。';
			return {
				username: '通報',
				avatar_url: ABUSE_REPORT_AVATAR_URL,
				content: `${title}\nserver: <${server}>\nname: ${acct(report.targetUser, report.targetUserId)}\ntext: ${report.comment}\n`,
			};
		}
		case 'inactiveModeratorsWarning': {
			const { remainingTime } = content as SystemWebhookPayload<'inactiveModeratorsWarning'>;
			const time = remainingTime.asDays === 0 ? `${remainingTime.asHours}時間` : `${remainingTime.asDays}日`;
			return {
				username: 'モデレーター',
				content: `モデレーターが一定期間非アクティブです。あと${time}で招待制に変更されます。\nserver: <${server}>\n`,
			};
		}
		case 'inactiveModeratorsInvitationOnlyChanged': {
			return {
				username: 'モデレーター',
				content: `モデレーターが一定期間非アクティブだったため、招待制に変更されました。\nserver: <${server}>\n`,
			};
		}
		case 'emailBlocked': {
			const { maskedEmail, via, source, matched, enforced } = content as EmailBlockedPayload;
			const label = EMAIL_BLOCK_SOURCE_LABELS[source];
			return {
				username: 'メールブロック',
				content: [
					enforced ? '🚫 メールアドレスをブロックしました。' : '👀 公開リストに該当しました（記録のみ、拒否はしていません）。',
					`メール: ${maskedEmail}`,
					`判定: ${matched != null ? `${label}（${matched}）` : label}`,
					`経路: ${EMAIL_BLOCK_VIA_LABELS[via]}`,
					'',
				].join('\n'),
			};
		}
		// sushi.ski: 絵文字申請
		case 'emojiRequestCreated': {
			const { name, comment, user, fileUrl } = content as EmojiRequestCreatedPayload;
			return {
				username: '絵文字申請',
				content: [
					'絵文字の申請がありました。',
					`server: <${server}>`,
					`name: :${name}:`,
					`from: ${acct(user, user.id)}`,
					...(comment != null && comment !== '' ? [`comment: ${comment}`] : []),
					...(fileUrl != null ? [`image: <${fileUrl}>`] : []),
					'',
				].join('\n'),
			};
		}
		default: {
			const _exhaustiveAssertion: never = type;
			return { content: `${String(type)}\nserver: <${server}>\n` };
		}
	}
}

/**
 * SystemWebhookのイベントをDiscordが受け取れる形式に変換する。
 * 通報文などの入力値で @everyone 等が発動しないよう、メンションは常に無効にする
 */
export function buildDiscordWebhookBody(type: SystemWebhookEventType, content: unknown, server: string): DiscordWebhookBody {
	const body = render(type, content, server);
	return { ...body, content: truncate(body.content), allowed_mentions: { parse: [] } };
}
