/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// sushi.ski: 絵文字申請

import { Inject, Injectable } from '@nestjs/common';
import type { EmojiRequestsRepository } from '@/models/_.js';
import { emojiRequestStatuses } from '@/models/EmojiRequest.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { DI } from '@/di-symbols.js';
import { QueryService } from '@/core/QueryService.js';
import { EmojiRequestService } from '@/core/EmojiRequestService.js';

export const meta = {
	tags: ['admin', 'emoji-requests'],

	// モデレーター以上か canApproveEmojiRequests を持つ人。meta では表せないので処理の中で判定する
	requireCredential: true,
	kind: 'read:admin:emoji',

	errors: {
		notAllowed: {
			message: 'You are not allowed to review emoji requests.',
			code: 'NOT_ALLOWED',
			id: 'eed42e23-c183-4572-968b-8698d177517f',
		},
	},

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'SushiskiEmojiRequest',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		status: { type: 'string', enum: emojiRequestStatuses },
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.emojiRequestsRepository)
		private emojiRequestsRepository: EmojiRequestsRepository,

		private queryService: QueryService,
		private emojiRequestService: EmojiRequestService,
	) {
		super(meta, paramDef, async (ps, me) => {
			if (!await this.emojiRequestService.canApprove(me)) throw new ApiError(meta.errors.notAllowed);

			const query = this.queryService.makePaginationQuery(this.emojiRequestsRepository.createQueryBuilder('request'), ps.sinceId, ps.untilId);
			if (ps.status != null) {
				query.andWhere('request.status = :status', { status: ps.status });
			}

			const requests = await query.limit(ps.limit).getMany();
			return await this.emojiRequestService.packMany(requests, me);
		});
	}
}
