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
	tags: ['admin', 'emoji-requests'],

	// モデレーター以上か canApproveEmojiRequests を持つ人。meta では表せないので処理の中で判定する
	requireCredential: true,
	kind: 'write:admin:emoji',

	errors: {
		notAllowed: {
			message: 'You are not allowed to review emoji requests.',
			code: 'NOT_ALLOWED',
			id: '777b198e-2ded-418b-b399-bbd9f4f17d28',
		},
		noSuchRequest: {
			message: 'No such request.',
			code: 'NO_SUCH_REQUEST',
			id: '7443a5a2-55f0-4e11-be36-12ea02b287b7',
		},
		notPending: {
			message: 'This request has already been reviewed or canceled.',
			code: 'NOT_PENDING',
			id: '5e7299b5-89d6-4c3f-9af7-16efd92ee04f',
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		ref: 'SushiskiEmojiRequest',
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		requestId: { type: 'string', format: 'misskey:id' },
		reason: { type: 'string', nullable: true, maxLength: 2048 },
	},
	required: ['requestId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private emojiRequestService: EmojiRequestService,
	) {
		super(meta, paramDef, async (ps, me) => {
			if (!await this.emojiRequestService.canApprove(me)) throw new ApiError(meta.errors.notAllowed);

			try {
				const request = await this.emojiRequestService.reject(me, ps.requestId, ps.reason || null);
				const [packed] = await this.emojiRequestService.packMany([request], me);
				return packed;
			} catch (err) {
				const key = toEmojiRequestErrorKey(err);
				if (key != null && key in meta.errors) throw new ApiError(meta.errors[key as keyof typeof meta.errors]);
				throw err;
			}
		});
	}
}
