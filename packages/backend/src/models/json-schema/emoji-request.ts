/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// sushi.ski: 絵文字申請
export const packedEmojiRequestSchema = {
	type: 'object',
	properties: {
		id: {
			type: 'string',
			optional: false, nullable: false,
			format: 'id',
		},
		createdAt: {
			type: 'string',
			optional: false, nullable: false,
			format: 'date-time',
		},
		userId: {
			type: 'string',
			optional: false, nullable: false,
			format: 'id',
		},
		user: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'UserLite',
		},
		file: {
			type: 'object',
			optional: false, nullable: true,
			ref: 'DriveFile',
		},
		name: {
			type: 'string',
			optional: false, nullable: false,
		},
		category: {
			type: 'string',
			optional: false, nullable: true,
		},
		aliases: {
			type: 'array',
			optional: false, nullable: false,
			items: {
				type: 'string',
				optional: false, nullable: false,
			},
		},
		license: {
			type: 'string',
			optional: false, nullable: true,
		},
		isSensitive: {
			type: 'boolean',
			optional: false, nullable: false,
		},
		localOnly: {
			type: 'boolean',
			optional: false, nullable: false,
		},
		comment: {
			type: 'string',
			optional: false, nullable: true,
		},
		status: {
			type: 'string',
			optional: false, nullable: false,
			enum: ['pending', 'approved', 'rejected', 'canceled'],
		},
		reviewedAt: {
			type: 'string',
			optional: false, nullable: true,
			format: 'date-time',
		},
		rejectReason: {
			type: 'string',
			optional: false, nullable: true,
		},
		emojiId: {
			type: 'string',
			optional: false, nullable: true,
			format: 'id',
		},
	},
} as const;
