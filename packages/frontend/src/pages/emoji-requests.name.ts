/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// sushi.ski: 絵文字申請の名前をその場で確かめる (申請ページと承認ダイアログで共用)

import { customEmojis } from '@/custom-emojis.js';
import { i18n } from '@/i18n.js';

/**
 * 名前に問題があれば表示する文言を返す。空のときと問題がないときは null
 */
export function emojiNameError(name: string): string | null {
	if (name === '') return null;
	if (!/^[a-zA-Z0-9_]+$/.test(name)) return i18n.ts._sushiskiEmojiRequest.nameInvalid;
	// API の上限 (128 文字) に合わせる
	if (name.length > 128) return i18n.ts._sushiskiEmojiRequest.nameTooLong;
	// computed の中で呼んだとき、絵文字一覧の更新にも追随するよう、リアクティブな一覧を直接見る
	if (customEmojis.value.some(emoji => emoji.name === name)) return i18n.ts._sushiskiEmojiRequest.nameTaken;
	return null;
}
