/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// sushi.ski: 絵文字申請。間違って見送ったときに、確認待ちへ戻す

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
		busy: {
			message: 'Another operation on the same emoji name is in progress. Please try again.',
			code: 'TRY_AGAIN',
			id: '2e1405d0-c7b2-405a-a6e4-fafe1375d928',
		},
		notAllowed: {
			message: 'You are not allowed to review emoji requests.',
			code: 'NOT_ALLOWED',
			id: '53316b29-150c-4e27-8d34-b4136022e0c7',
		},
		noSuchRequest: {
			message: 'No such request.',
			code: 'NO_SUCH_REQUEST',
			id: '874add8c-4d53-4ce7-b638-4392764fdc04',
		},
		notRejected: {
			message: 'This request is not rejected.',
			code: 'NOT_REJECTED',
			id: 'c0c20b2c-6ae1-4f10-8510-696970e7433f',
		},
		tooManyPending: {
			message: 'The applicant already has too many pending requests.',
			code: 'TOO_MANY_PENDING',
			id: '99e5c5dc-938e-4bc5-8883-7bfa47829eda',
		},
		duplicateName: {
			message: 'Another request or emoji with the same name already exists.',
			code: 'DUPLICATE_NAME',
			id: '8ae5feaf-a563-4000-bb64-62a51a4a5e35',
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
				const request = await this.emojiRequestService.unreject(ps.requestId);
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
