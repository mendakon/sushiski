/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { domainToASCII } from 'node:url';

export class InvalidHostError extends Error {
	constructor(public host: string) {
		super(`Invalid host: ${host}`);
		this.name = 'InvalidHostError';
	}
}

/**
 * 管理画面から入力されたホストの一覧を、判定に使える形に揃える。
 * メールのドメインは punycode で届くので、日本語ドメインも ASCII に変換する。
 * 無効な行を黙って捨てると設定が効かないことに気づけないので、エラーにする
 *
 * @throws {InvalidHostError} ホストとして解釈できない行があるとき
 */
export function normalizeHostList(hosts: string[]): string[] {
	return hosts
		.map(x => x.normalize('NFKC').replaceAll('。', '.').trim())
		.filter(x => x !== '')
		.map(x => {
			// domainToASCII はURLとして解釈するので、パスなどは取り除かれ、エンコードは復号されてしまう
			if (/[/?#\\%]/.test(x)) throw new InvalidHostError(x);

			const host = domainToASCII(x.replace(/^\*?\.+/, '').replace(/\.+$/, ''));
			if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(host) || /^[\d.]+$/.test(host)) throw new InvalidHostError(x);
			return host;
		});
}
