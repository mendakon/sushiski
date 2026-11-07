/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import ms from 'ms';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { EmailService } from '@/core/EmailService.js';

export const meta = {
	tags: ['users'],

	requireCredential: false,

	// 検証でDNSを引くので、未認証で連打されないように制限する。
	// 同じIPを共有する人の登録を止めないよう、通常の入力では届かない程度の値にする
	limit: {
		duration: ms('1hour'),
		max: 300,
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			available: {
				type: 'boolean',
				optional: false, nullable: false,
			},
			reason: {
				type: 'string',
				optional: false, nullable: true,
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		emailAddress: { type: 'string' },
	},
	required: ['emailAddress'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private emailService: EmailService,
	) {
		super(meta, paramDef, async (ps, me) => {
			return await this.emailService.validateEmailForAccount(ps.emailAddress);
		});
	}
}
