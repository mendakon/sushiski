/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// sushi.ski: 絵文字申請

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { EmojiRequestService, toEmojiRequestErrorKey } from '@/core/EmojiRequestService.js';

export const meta = {
	tags: ['emoji-requests'],

	requireCredential: true,
	kind: 'write:account',

	limit: {
		duration: 1000 * 60 * 60,
		max: 60,
	},

	errors: {
		noSuchRequest: {
			message: 'No such request.',
			code: 'NO_SUCH_REQUEST',
			id: '2d7626f1-f410-471d-8d89-e75a13e9e123',
		},
		notPending: {
			message: 'This request has already been reviewed or canceled.',
			code: 'NOT_PENDING',
			id: '6e5a3c03-149c-435a-9c1d-efe7cf604651',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		requestId: { type: 'string', format: 'misskey:id' },
	},
	required: ['requestId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private emojiRequestService: EmojiRequestService,
	) {
		super(meta, paramDef, async (ps, me) => {
			try {
				await this.emojiRequestService.cancel(me, ps.requestId);
			} catch (err) {
				const key = toEmojiRequestErrorKey(err);
				if (key != null && key in meta.errors) throw new ApiError(meta.errors[key as keyof typeof meta.errors]);
				throw err;
			}
		});
	}
}
