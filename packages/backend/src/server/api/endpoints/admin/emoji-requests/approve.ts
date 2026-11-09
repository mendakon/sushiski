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
		busy: {
			message: 'Another operation on the same emoji name is in progress. Please try again.',
			code: 'TRY_AGAIN',
			id: '91a71e4e-2101-42bf-8146-20e202dbae13',
		},
		notAllowed: {
			message: 'You are not allowed to review emoji requests.',
			code: 'NOT_ALLOWED',
			id: '4cbb8c80-9243-4038-b32b-ff9c630b1f67',
		},
		noSuchRequest: {
			message: 'No such request.',
			code: 'NO_SUCH_REQUEST',
			id: '2464a4d6-1244-4dc1-bee9-879599c4bad9',
		},
		notPending: {
			message: 'This request has already been reviewed or canceled.',
			code: 'NOT_PENDING',
			id: 'd255036a-0c33-4a9f-9e35-528e45c45ac2',
		},
		duplicateName: {
			message: 'An emoji with the same name already exists.',
			code: 'DUPLICATE_NAME',
			id: '2202fbe6-e7e4-4917-9dc2-5a0fe334199a',
		},
		fileGone: {
			message: 'The requested image has been deleted.',
			code: 'FILE_GONE',
			id: '13663789-598e-4626-a781-6d35244688ae',
		},
		copyFailed: {
			message: 'Failed to copy the requested image.',
			code: 'COPY_FAILED',
			id: 'ba1734df-591a-401e-9877-bb68b59e9342',
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
		// 以下は、申請の内容を直してから登録したいときに指定する
		name: { type: 'string', pattern: '^[a-zA-Z0-9_]+$', minLength: 1, maxLength: 128 },
		category: { type: 'string', nullable: true, maxLength: 128 },
		aliases: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 128 } },
		license: { type: 'string', nullable: true, maxLength: 1024 },
		isSensitive: { type: 'boolean' },
		localOnly: { type: 'boolean' },
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
				const request = await this.emojiRequestService.approve(me, ps.requestId, {
					name: ps.name,
					category: ps.category === undefined ? undefined : (ps.category || null),
					aliases: ps.aliases,
					license: ps.license === undefined ? undefined : (ps.license || null),
					isSensitive: ps.isSensitive,
					localOnly: ps.localOnly,
				});
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
