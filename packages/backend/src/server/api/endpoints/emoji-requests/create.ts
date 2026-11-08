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
	requiredRolePolicy: 'canRequestEmojis',
	kind: 'write:account',
	prohibitMoved: true,

	limit: {
		duration: 1000 * 60 * 60,
		max: 20,
	},

	errors: {
		noSuchFile: {
			message: 'No such file.',
			code: 'NO_SUCH_FILE',
			id: 'd3eb1f26-e3a1-44ed-b273-de4f6cfbe427',
		},
		unsupportedFileType: {
			message: 'Unsupported file type.',
			code: 'UNSUPPORTED_FILE_TYPE',
			id: '6ba271c0-5e7e-4025-b7fd-35317596bb21',
		},
		duplicateName: {
			message: 'An emoji or a pending request with the same name already exists.',
			code: 'DUPLICATE_NAME',
			id: 'c2085be2-c5c0-4d8e-b2d9-f188822febee',
		},
		tooManyPending: {
			message: 'You have too many pending requests.',
			code: 'TOO_MANY_PENDING',
			id: '83984c68-6d3d-4b43-9acd-7a082855c7ae',
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
		fileId: { type: 'string', format: 'misskey:id' },
		name: { type: 'string', pattern: '^[a-zA-Z0-9_]+$', minLength: 1, maxLength: 128 },
		category: { type: 'string', nullable: true, maxLength: 128 },
		aliases: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 128 } },
		license: { type: 'string', nullable: true, maxLength: 1024 },
		isSensitive: { type: 'boolean' },
		localOnly: { type: 'boolean' },
		comment: { type: 'string', nullable: true, maxLength: 2048 },
	},
	required: ['fileId', 'name'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private emojiRequestService: EmojiRequestService,
	) {
		super(meta, paramDef, async (ps, me) => {
			try {
				const request = await this.emojiRequestService.create(me, ps.fileId, {
					name: ps.name,
					category: ps.category || null,
					aliases: ps.aliases ?? [],
					license: ps.license || null,
					isSensitive: ps.isSensitive ?? false,
					localOnly: ps.localOnly ?? false,
				}, ps.comment || null);
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
