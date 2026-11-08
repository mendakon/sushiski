/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// sushi.ski: 絵文字申請
// 本家の更新に追従しやすいよう、絵文字申請の処理はこのファイルにまとめる

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository, EmojiRequestsRepository } from '@/models/_.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import type { MiEmojiRequest } from '@/models/EmojiRequest.js';
import type { MiLocalUser, MiUser } from '@/models/User.js';
import type { Packed } from '@/misc/json-schema.js';
import { FILE_TYPE_IMAGE } from '@/const.js';
import { bindThis } from '@/decorators.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { IdService } from '@/core/IdService.js';
import { RoleService } from '@/core/RoleService.js';
import { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { DriveService } from '@/core/DriveService.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';
import { NotificationService } from '@/core/NotificationService.js';
import { SystemWebhookService } from '@/core/SystemWebhookService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';

export const EMOJI_REQUEST_ERRORS = {
	noSuchFile: '6f85016f-1c74-4a55-9e7c-a22b1b8d6419',
	unsupportedFileType: '915d3898-2587-4824-adfe-9481240b00c5',
	duplicateName: 'aac5475e-0841-458e-812b-ecffb39ac2aa',
	tooManyPending: '45386699-b4d1-4f3f-889a-9aae6a7e0337',
	noSuchRequest: '8f5b991e-0929-49e8-8f6f-3b2cba745c72',
	notPending: '607a6773-d10c-487f-bcea-b6ccffcb01dc',
	fileGone: 'b8136e03-7928-4cf5-a0de-22da06a4cc48',
	copyFailed: 'bd10128a-7f56-4207-9c54-38420a7873ff',
} as const;

export type EmojiRequestErrorKey = keyof typeof EMOJI_REQUEST_ERRORS;

/**
 * サービスが投げた IdentifiableError を、エンドポイントの meta.errors のキーに変換する
 */
export function toEmojiRequestErrorKey(err: unknown): EmojiRequestErrorKey | null {
	if (!(err instanceof IdentifiableError)) return null;
	const entry = Object.entries(EMOJI_REQUEST_ERRORS).find(([, id]) => id === err.id);
	return entry ? entry[0] as EmojiRequestErrorKey : null;
}

/** 1 人が同時に出せる申請中の数 */
const MAX_PENDING_PER_USER = 10;

export type EmojiRequestDetails = {
	name: string;
	category: string | null;
	aliases: string[];
	license: string | null;
	isSensitive: boolean;
	localOnly: boolean;
};

@Injectable()
export class EmojiRequestService {
	constructor(
		@Inject(DI.emojiRequestsRepository)
		private emojiRequestsRepository: EmojiRequestsRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		private idService: IdService,
		private roleService: RoleService,
		private customEmojiService: CustomEmojiService,
		private driveService: DriveService,
		private internalStorageService: InternalStorageService,
		private notificationService: NotificationService,
		private systemWebhookService: SystemWebhookService,
		private userEntityService: UserEntityService,
		private driveFileEntityService: DriveFileEntityService,
	) {
	}

	/**
	 * 申請を承認・却下できるか。モデレーター以上か、canApproveEmojiRequests を持つ人
	 */
	@bindThis
	public async canApprove(user: { id: MiUser['id'] }): Promise<boolean> {
		if (await this.roleService.isModerator(user)) return true;
		const policies = await this.roleService.getUserPolicies(user.id);
		return policies.canApproveEmojiRequests;
	}

	/**
	 * 既存の絵文字と申請中の絵文字に同じ名前があるか
	 */
	@bindThis
	public async isNameTaken(name: string, exceptRequestId?: MiEmojiRequest['id']): Promise<boolean> {
		if (await this.customEmojiService.checkDuplicate(name)) return true;
		const pending = await this.emojiRequestsRepository.findOneBy({ name, status: 'pending' });
		return pending != null && pending.id !== exceptRequestId;
	}

	@bindThis
	public async create(user: MiLocalUser, fileId: MiDriveFile['id'], details: EmojiRequestDetails, comment: string | null): Promise<MiEmojiRequest> {
		const file = await this.driveFilesRepository.findOneBy({ id: fileId, userId: user.id });
		if (file == null) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.noSuchFile);
		if (!FILE_TYPE_IMAGE.includes(file.type)) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.unsupportedFileType);

		const pendingCount = await this.emojiRequestsRepository.countBy({ userId: user.id, status: 'pending' });
		if (pendingCount >= MAX_PENDING_PER_USER) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.tooManyPending);

		if (await this.isNameTaken(details.name)) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.duplicateName);

		const request = await this.emojiRequestsRepository.insertOne({
			id: this.idService.gen(),
			userId: user.id,
			fileId: file.id,
			...details,
			comment,
			status: 'pending',
		});

		this.systemWebhookService.enqueueSystemWebhook('emojiRequestCreated', {
			requestId: request.id,
			name: request.name,
			comment: request.comment,
			user: { id: user.id, username: user.username, host: null },
			fileUrl: file.webpublicUrl ?? file.url,
		});

		return request;
	}

	/**
	 * pending の申請だけを、別の状態へ 1 回だけ移す。同時に承認・却下・取り下げをされても、通るのは 1 人だけになる
	 */
	@bindThis
	private async claim(request: MiEmojiRequest, values: Partial<Pick<MiEmojiRequest, 'status' | 'reviewerId' | 'reviewedAt' | 'rejectReason'>>): Promise<void> {
		const result = await this.emojiRequestsRepository.update({ id: request.id, status: 'pending' }, values);
		if (result.affected !== 1) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.notPending);
	}

	@bindThis
	public async cancel(user: MiLocalUser, requestId: MiEmojiRequest['id']): Promise<void> {
		const request = await this.emojiRequestsRepository.findOneBy({ id: requestId, userId: user.id });
		if (request == null) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.noSuchRequest);

		await this.claim(request, { status: 'canceled' });
	}

	/**
	 * 申請者があとでファイルを消しても絵文字が壊れないよう、システム所有のファイルに複製する。
	 * ローカルに保存されたファイルは、自分の URL を取りに行くとプライベート IP として弾かれることがあるので、パスから直接複製する
	 */
	@bindThis
	private async copyToSystem(file: MiDriveFile): Promise<MiDriveFile> {
		try {
			if (file.storedInternal && file.accessKey != null) {
				return await this.driveService.addFile({
					user: null,
					path: this.internalStorageService.resolvePath(file.accessKey),
					name: file.name,
					force: true,
				});
			}
			return await this.driveService.uploadFromUrl({ url: file.url, user: null, force: true });
		} catch {
			// 申請者が画像を消している途中だと、ファイルの実体だけが先に消えていることがある
			const exists = await this.driveFilesRepository.existsBy({ id: file.id });
			throw new IdentifiableError(exists ? EMOJI_REQUEST_ERRORS.copyFailed : EMOJI_REQUEST_ERRORS.fileGone);
		}
	}

	/**
	 * 承認して絵文字を登録する。details を渡すと、申請の内容を直してから登録する
	 */
	@bindThis
	public async approve(reviewer: MiLocalUser, requestId: MiEmojiRequest['id'], details: Partial<EmojiRequestDetails>): Promise<MiEmojiRequest> {
		const request = await this.emojiRequestsRepository.findOneBy({ id: requestId });
		if (request == null) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.noSuchRequest);
		if (request.status !== 'pending') throw new IdentifiableError(EMOJI_REQUEST_ERRORS.notPending);

		const merged: EmojiRequestDetails = {
			name: details.name ?? request.name,
			category: details.category !== undefined ? details.category : request.category,
			aliases: details.aliases ?? request.aliases,
			license: details.license !== undefined ? details.license : request.license,
			isSensitive: details.isSensitive ?? request.isSensitive,
			localOnly: details.localOnly ?? request.localOnly,
		};

		if (await this.customEmojiService.checkDuplicate(merged.name)) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.duplicateName);

		const file = request.fileId != null ? await this.driveFilesRepository.findOneBy({ id: request.fileId }) : null;
		if (file == null) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.fileGone);

		// 先に状態を移して、同じ申請を 2 人が同時に承認できないようにする。失敗したら pending に戻す
		await this.claim(request, { status: 'approved', reviewerId: reviewer.id, reviewedAt: new Date() });

		let copied: MiDriveFile | null = null;
		try {
			copied = await this.copyToSystem(file);

			const emoji = await this.customEmojiService.add({
				originalUrl: copied.url,
				publicUrl: copied.webpublicUrl ?? copied.url,
				fileType: copied.webpublicType ?? copied.type,
				name: merged.name,
				category: merged.category,
				aliases: merged.aliases,
				host: null,
				license: merged.license,
				isSensitive: merged.isSensitive,
				localOnly: merged.localOnly,
				roleIdsThatCanBeUsedThisEmojiAsReaction: [],
			}, reviewer);

			await this.emojiRequestsRepository.update(request.id, { ...merged, emojiId: emoji.id });
		} catch (err) {
			await this.emojiRequestsRepository.update({ id: request.id, status: 'approved' }, { status: 'pending', reviewerId: null, reviewedAt: null });
			if (copied != null) {
				await this.driveService.deleteFile(copied).catch(() => {});
			}
			// 名前の確認のあとに、別の承認で同じ名前の絵文字が登録された場合
			if (!(err instanceof IdentifiableError) && await this.customEmojiService.checkDuplicate(merged.name)) {
				throw new IdentifiableError(EMOJI_REQUEST_ERRORS.duplicateName);
			}
			throw err;
		}

		this.notificationService.createNotification(request.userId, 'app', {
			appAccessTokenId: null,
			customHeader: '絵文字申請',
			customBody: `申請した絵文字 :${merged.name}: が承認されました。`,
			customIcon: copied.webpublicUrl ?? copied.url,
		});

		return await this.emojiRequestsRepository.findOneByOrFail({ id: request.id });
	}

	@bindThis
	public async reject(reviewer: MiLocalUser, requestId: MiEmojiRequest['id'], reason: string | null): Promise<MiEmojiRequest> {
		const request = await this.emojiRequestsRepository.findOneBy({ id: requestId });
		if (request == null) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.noSuchRequest);

		await this.claim(request, {
			status: 'rejected',
			reviewerId: reviewer.id,
			reviewedAt: new Date(),
			rejectReason: reason,
		});

		const file = request.fileId != null ? await this.driveFilesRepository.findOneBy({ id: request.fileId }) : null;
		this.notificationService.createNotification(request.userId, 'app', {
			appAccessTokenId: null,
			customHeader: '絵文字申請',
			customBody: reason != null && reason !== ''
				? `申請した絵文字 :${request.name}: は見送りになりました。理由: ${reason}`
				: `申請した絵文字 :${request.name}: は見送りになりました。`,
			customIcon: file != null ? (file.thumbnailUrl ?? file.webpublicUrl ?? file.url) : null,
		});

		return await this.emojiRequestsRepository.findOneByOrFail({ id: request.id });
	}

	@bindThis
	public async packMany(requests: MiEmojiRequest[], me: { id: MiUser['id'] } | null): Promise<Packed<'SushiskiEmojiRequest'>[]> {
		if (requests.length === 0) return [];

		const userIds = [...new Set(requests.map(r => r.userId))];
		const fileIds = [...new Set(requests.map(r => r.fileId).filter((id): id is string => id != null))];
		const [users, files] = await Promise.all([
			this.userEntityService.packMany(userIds, me),
			fileIds.length > 0 ? this.driveFilesRepository.findBy({ id: In(fileIds) }).then(fs => this.driveFileEntityService.packMany(fs)) : Promise.resolve([]),
		]);
		const userMap = new Map(users.map(u => [u.id, u]));
		const fileMap = new Map(files.map(f => [f.id, f]));

		return requests.map(r => ({
			id: r.id,
			createdAt: this.idService.parse(r.id).date.toISOString(),
			userId: r.userId,
			user: userMap.get(r.userId)!,
			file: r.fileId != null ? fileMap.get(r.fileId) ?? null : null,
			name: r.name,
			category: r.category,
			aliases: r.aliases,
			license: r.license,
			isSensitive: r.isSensitive,
			localOnly: r.localOnly,
			comment: r.comment,
			status: r.status,
			reviewedAt: r.reviewedAt?.toISOString() ?? null,
			rejectReason: r.rejectReason,
			emojiId: r.emojiId,
		}));
	}
}
