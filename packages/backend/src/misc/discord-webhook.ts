/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { AbuseReportPayload, EmailBlockedPayload, EmojiRequestCreatedPayload, SystemWebhookPayload } from '@/core/SystemWebhookService.js';
import type { SystemWebhookEventType } from '@/models/SystemWebhook.js';

const DISCORD_HOSTS = ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'];
const DISCORD_CONTENT_MAX_LENGTH = 2000;
/** メッセージのフラグ SUPPRESS_EMBEDS。本文中のURLにリンクプレビューを付けない */
const DISCORD_FLAG_SUPPRESS_EMBEDS = 1 << 2;
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
	flags: number;
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

/**
 * メールアドレスやユーザー名の _ や * でDiscordの書式が崩れないようにする
 */
function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_~|>[\]()#]/g, '\\$&');
}

function acct(user: { username: string; host: string | null } | null, fallback: string): string {
	if (user == null) return fallback;
	return user.host == null ? `@${user.username}` : `@${user.username}@${user.host}`;
}

/**
 * ユーザーの表示とユーザーページへのリンク
 */
function userLine(label: string, user: { username: string; host: string | null } | null, fallbackId: string, server: string): string {
	if (user == null) return `${label}: ${fallbackId}`;
	const name = acct(user, fallbackId);
	return `${label}: ${escapeMarkdown(name)}  <${server}/${name.split('@').map(encodeURIComponent).join('@')}>`;
}

/**
 * 複数行の本文を引用にする。空なら（なし）
 */
function quote(text: string): string {
	const trimmed = text.trim();
	if (trimmed === '') return '> （なし）';
	return trimmed.split(/\r?\n/).map(line => `> ${line}`).join('\n');
}

const ABUSE_REPORT_RESOLVED_TITLES: Record<NonNullable<AbuseReportPayload['resolvedAs']> | 'unknown', string> = {
	accept: '🪓 通報が処理されました。（是認）',
	reject: '🫠 通報が処理されました。（否認）',
	unknown: '🧹 通報が処理されました。',
};

const ABUSE_REPORT_RESOLVED_LABELS: Record<NonNullable<AbuseReportPayload['resolvedAs']> | 'unknown', string> = {
	accept: '是認（通報の内容を認めて対応した）',
	reject: '否認（問題なしと判断した）',
	unknown: '解決済み',
};

type RenderedBody = Omit<DiscordWebhookBody, 'allowed_mentions' | 'flags'> & {
	/** true なら、本文中で <> に囲んでいない URL にリンクプレビューを付ける */
	preview?: boolean;
};

function render(type: SystemWebhookEventType, content: unknown, server: string): RenderedBody {
	switch (type) {
		case 'userCreated': {
			const user = content as SystemWebhookPayload<'userCreated'>;
			return {
				username: '新規登録',
				content: [
					'🦑 新規ユーザー登録がありました。',
					`name: ${escapeMarkdown(user.username)}`,
					`mail: ${user.email != null ? escapeMarkdown(user.email) : '（なし）'}`,
					`url: <${server}/@${encodeURIComponent(user.username)}>`,
					'',
				].join('\n'),
			};
		}
		case 'abuseReport':
		case 'abuseReportResolved': {
			const report = content as SystemWebhookPayload<'abuseReport'>;
			const lines = type === 'abuseReport'
				? [
					'🧌 新しい通報があります。',
					userLine('対象', report.targetUser, report.targetUserId, server),
					userLine('通報者', report.reporter, report.reporterId, server),
					'内容:',
					quote(report.comment),
					`確認: <${server}/admin/abuses>`,
				]
				: [
					ABUSE_REPORT_RESOLVED_TITLES[report.resolvedAs ?? 'unknown'],
					`結果: ${ABUSE_REPORT_RESOLVED_LABELS[report.resolvedAs ?? 'unknown']}`,
					userLine('対象', report.targetUser, report.targetUserId, server),
					userLine('通報者', report.reporter, report.reporterId, server),
					...(report.assigneeId != null ? [userLine('処理者', report.assignee, report.assigneeId, server)] : []),
					...(report.forwarded ? ['転送: 相手のサーバーに転送済み'] : []),
					...(report.moderationNote.trim() !== '' ? ['モデレーションノート:', quote(report.moderationNote)] : []),
					'内容:',
					quote(report.comment),
				];
			return {
				username: '通報',
				avatar_url: ABUSE_REPORT_AVATAR_URL,
				content: [...lines, ''].join('\n'),
			};
		}
		case 'inactiveModeratorsWarning': {
			const { remainingTime } = content as SystemWebhookPayload<'inactiveModeratorsWarning'>;
			const time = remainingTime.asDays === 0 ? `${remainingTime.asHours}時間` : `${remainingTime.asDays}日`;
			return {
				username: 'モデレーター',
				content: `🦥 モデレーターが一定期間非アクティブです。あと${time}で招待制に変更されます。\n`,
			};
		}
		case 'inactiveModeratorsInvitationOnlyChanged': {
			return {
				username: 'モデレーター',
				content: '🪦 モデレーターが一定期間非アクティブだったため、招待制に変更されました。\n',
			};
		}
		case 'emailBlocked': {
			const { maskedEmail, via, source, matched, enforced } = content as EmailBlockedPayload;
			const label = EMAIL_BLOCK_SOURCE_LABELS[source];
			return {
				username: 'メールブロック',
				content: [
					enforced ? '🪤 メールアドレスをブロックしました。' : '🫣 公開リストに該当しました（記録のみ、拒否はしていません）。',
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
					'🍣 絵文字の申請がありました。',
					`名前: :${escapeMarkdown(name)}:`,
					userLine('申請者', user, user.id, server),
					'メッセージ:',
					quote(comment ?? ''),
					`確認: <${server}/emoji-requests/review>`,
					// 承認する人が画像を見られるよう、画像の URL だけは <> で囲まずプレビューを出す
					...(fileUrl != null ? [fileUrl] : []),
					'',
				].join('\n'),
				preview: fileUrl != null,
			};
		}
		default: {
			const _exhaustiveAssertion: never = type;
			return { content: `${String(type)}\n` };
		}
	}
}

/**
 * SystemWebhookのイベントをDiscordが受け取れる形式に変換する。
 * 通報文などの入力値で @everyone 等が発動しないよう、メンションは常に無効にする。
 * 通報文中のノートのURLなどにサイト全体の紹介カードが付いて場所を取るので、リンクプレビューも出さない
 */
export function buildDiscordWebhookBody(type: SystemWebhookEventType, content: unknown, server: string): DiscordWebhookBody {
	const { preview, ...body } = render(type, content, server);
	return { ...body, content: truncate(body.content), allowed_mentions: { parse: [] }, flags: preview ? 0 : DISCORD_FLAG_SUPPRESS_EMBEDS };
}
