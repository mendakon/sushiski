/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// sushi.ski: 絵文字申請
// 本家の更新に追従しやすいよう、絵文字申請の処理はこのファイルにまとめる

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { In, IsNull, Not } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository, EmojiRequestsRepository, EmojisRepository } from '@/models/_.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import type { MiEmojiRequest } from '@/models/EmojiRequest.js';
import type { MiLocalUser, MiUser } from '@/models/User.js';
import type { Packed } from '@/misc/json-schema.js';
import { FILE_TYPE_IMAGE } from '@/const.js';
import { bindThis } from '@/decorators.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { acquireDistributedLock } from '@/misc/distributed-lock.js';
import type Logger from '@/logger.js';
import { LoggerService } from '@/core/LoggerService.js';
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
	notRejected: '9d689c9e-fb8c-4772-a82c-36c4d35e85ea',
	busy: 'c2b38271-f529-42d6-9439-2b72441fcef5',
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
	private logger: Logger;

	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.emojisRepository)
		private emojisRepository: EmojisRepository,

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
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('emoji-request');
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
	 * 同じ名前についての「名前が空いているかの確認」から「登録」までを、ほかの申請・承認と重ならないようにする。
	 * 絵文字テーブルの (name, host) の一意制約は、host が NULL のローカル絵文字には効かないので、ここで排他する。
	 * DB の接続を握らないよう Redis のロックを使い、複数の名前は順番を決めて取る (デッドロックを避けるため)。
	 * 中の確認は DB のレプリケーションを使わない前提 (使うとレプリカの古いデータを読むことがある)。
	 * 本家の管理画面からの絵文字の登録・改名はこのロックを通らないので、それとの同時実行は防げない (許容している)
	 */
	@bindThis
	private async withNameLock<T>(names: string[], fn: () => Promise<T>): Promise<T> {
		const unlocks: (() => Promise<void>)[] = [];
		const ttl = 30 * 1000;
		let lockedAt: number | null = null;
		try {
			for (const name of [...new Set(names)].sort()) {
				// TTL で自然に解ける。取れなければ 100ms おきに 10 秒まで待つ
				const unlock = await acquireDistributedLock(this.redisClient, `sushiski-emoji-name:${name}`, ttl, 100, 100)
					.catch(err => {
						// 取れなかったときだけ「もう一度試して」にする。Redis の障害などはそのまま投げて調べられるようにする
						if (err instanceof Error && err.message.startsWith('Failed to acquire lock')) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.busy);
						throw err;
					});
				unlocks.push(unlock);
				// 最初のロックを取った時点から測る (待った時間は含めない)
				lockedAt ??= Date.now();
			}
			return await fn();
		} finally {
			// TTL を超えると、途中から排他が効いていなかったことになる。延長の仕組みはないので、気づけるようログに出す
			if (lockedAt != null && Date.now() - lockedAt > ttl) this.logger.warn(`Emoji name lock was held longer than its TTL: ${names.join(', ')}`);
			for (const unlock of unlocks.reverse()) {
				await unlock().catch(err => this.logger.warn(`Failed to release emoji name lock: ${err}`));
			}
		}
	}

	/**
	 * 既存の絵文字と申請中の絵文字に同じ名前があるか
	 */
	@bindThis
	public async isNameTaken(name: string, exceptRequestId?: MiEmojiRequest['id']): Promise<boolean> {
		if (await this.customEmojiService.checkDuplicate(name)) return true;
		return await this.emojiRequestsRepository.existsBy({
			name,
			status: 'pending',
			...(exceptRequestId != null ? { id: Not(exceptRequestId) } : {}),
		});
	}

	@bindThis
	public async create(user: MiLocalUser, fileId: MiDriveFile['id'], details: EmojiRequestDetails, comment: string): Promise<MiEmojiRequest> {
		const file = await this.driveFilesRepository.findOneBy({ id: fileId, userId: user.id });
		if (file == null) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.noSuchFile);
		if (!FILE_TYPE_IMAGE.includes(file.type)) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.unsupportedFileType);

		const pendingCount = await this.emojiRequestsRepository.countBy({ userId: user.id, status: 'pending' });
		if (pendingCount >= MAX_PENDING_PER_USER) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.tooManyPending);

		const request = await this.withNameLock([details.name], async () => {
			if (await this.isNameTaken(details.name)) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.duplicateName);

			return await this.emojiRequestsRepository.insertOne({
				id: this.idService.gen(),
				userId: user.id,
				fileId: file.id,
				...details,
				comment,
				status: 'pending',
			});
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
		} catch (err) {
			this.logger.warn(`Failed to copy file ${file.id} for an emoji request: ${err}`);
			// 申請者が画像を消している途中だと、ファイルの実体だけが先に消えていることがある
			// 確認の問い合わせ自体が失敗したら、複製の失敗として返す (DB のエラーで 500 にしない)
			const exists = await this.driveFilesRepository.existsBy({ id: file.id }).catch(() => true);
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

		const file = request.fileId != null ? await this.driveFilesRepository.findOneBy({ id: request.fileId }) : null;
		if (file == null) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.fileGone);

		// 重い複製の前に、名前がぶつかっていないかを先に見ておく (最終の確認はロックの中でする)
		if (await this.isNameTaken(merged.name, request.id)) {
			// 別の人がちょうどこの申請を承認して名前が使われた場合は、「承認済み」と伝える
			const current = await this.emojiRequestsRepository.findOneBy({ id: request.id });
			if (current == null) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.noSuchRequest);
			throw new IdentifiableError(current.status === 'pending' ? EMOJI_REQUEST_ERRORS.duplicateName : EMOJI_REQUEST_ERRORS.notPending);
		}

		// 画像の複製は時間がかかることがあるので、ロックの外で先にする。
		// そのあいだ申請は pending のままなので、元の名前はほかの申請に取られない
		const copied = await this.copyToSystem(file);

		try {
			// 元の名前と直した名前の両方をロックし、状態の切り替え・登録・失敗時の巻き戻しまで、このロックの中で済ませる
			await this.withNameLock([request.name, merged.name], async () => {
				// 先に状態を移して、同じ申請を 2 人が同時に承認できないようにする
				await this.claim(request, { status: 'approved', reviewerId: reviewer.id, reviewedAt: new Date() });

				let addAttempted = false;
				try {
					// 承認時に名前を直した場合も、ほかの申請中の名前とはぶつからないようにする
					if (await this.isNameTaken(merged.name, request.id)) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.duplicateName);

					addAttempted = true;
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
					await this.rollbackApprove(request, merged, reviewer, copied, addAttempted);
					throw err;
				}
			});
		} catch (err) {
			// 複製したファイルが絵文字に使われていなければ消す (claim の前で止まった、または巻き戻しで絵文字を消せた)。
			// ここでの失敗で元のエラーを隠さないよう、ログに出すだけにする
			try {
				if (!(await this.emojisRepository.existsBy({ originalUrl: copied.url, host: IsNull() }))) {
					await this.driveService.deleteFileSync(copied);
				}
			} catch (e) {
				this.logger.error(`Failed to clean up copied file ${copied.id}: ${e}`);
			}
			throw err;
		}

		this.notificationService.createNotification(request.userId, 'app', {
			appAccessTokenId: null,
			// フロントの MkNotification.vue は、この見出しでアイコンが無い通知を絵文字申請の通知と見なす。
			// 実績の解除などと同じく自分のアバターを出し、押すと本文の :名前: から申請ページのその申請を開く
			customHeader: '絵文字申請',
			customBody: `申請した絵文字 :${merged.name}: が承認されました。`,
			customIcon: null,
		});

		return await this.emojiRequestsRepository.findOneByOrFail({ id: request.id });
	}

	/**
	 * 承認の途中で失敗したとき、登録した絵文字を消して、申請を確認待ちに戻す。名前のロックの中で呼ぶこと。
	 * 複製したファイルは、呼び出し元が絵文字に使われていないことを確かめてから消す。
	 * ここでの失敗は元のエラーを隠さないよう、ログに出すだけにする
	 */
	@bindThis
	private async rollbackApprove(request: MiEmojiRequest, merged: EmojiRequestDetails, reviewer: MiLocalUser, copied: MiDriveFile, addAttempted: boolean): Promise<void> {
		if (addAttempted) {
			// add の途中 (登録後の処理) で失敗すると、結果を受け取れないまま登録だけ済んでいることがある。
			// 複製したファイルの URL はこの承認だけのものなので、それで探せば別の承認の絵文字と取り違えない
			let emoji;
			try {
				// host で絞ると index が効く。複製した URL はローカルの絵文字にしか使われない
				emoji = await this.emojisRepository.findOneBy({ originalUrl: copied.url, host: IsNull() });
			} catch (err) {
				// 登録済みかどうか分からないまま確認待ちに戻すと、申請とつながらない絵文字が残りうる。承認済みのまま止める
				this.logger.error(`Failed to look up emoji while rolling back request ${request.id}; leaving it approved: ${err}`);
				return;
			}
			if (emoji != null) {
				const deleted = await this.customEmojiService.delete(emoji.id, reviewer).then(() => true, async err => {
					this.logger.error(`Failed to delete emoji ${emoji.id} while rolling back request ${request.id}: ${err}`);
					// delete は行を消したあとの配信などで失敗することもある。行が消えていれば消せたものとして扱う
					return !(await this.emojisRepository.existsBy({ id: emoji.id }).catch(() => true));
				});
				if (!deleted) {
					// 絵文字が残ったなら、申請も承認済みのまま絵文字とつなげておく (確認待ちに戻すと、名前が使われていて承認できなくなる)
					await this.emojiRequestsRepository.update(request.id, { ...merged, emojiId: emoji.id })
						.catch(err => this.logger.error(`Failed to link request ${request.id} to emoji ${emoji.id}: ${err}`));
					return;
				}
			}
		}

		// 申請の内容 (承認時に直した名前など) も元に戻す
		await this.emojiRequestsRepository.update({ id: request.id, status: 'approved' }, {
			status: 'pending',
			reviewerId: null,
			reviewedAt: null,
			emojiId: null,
			name: request.name,
			category: request.category,
			aliases: request.aliases,
			license: request.license,
			isSensitive: request.isSensitive,
			localOnly: request.localOnly,
		}).catch(err => this.logger.error(`Failed to revert request ${request.id} to pending: ${err}`));
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

		// 見送りは申請者に通知しない。結果は申請ページで確認できる

		return await this.emojiRequestsRepository.findOneByOrFail({ id: request.id });
	}

	/**
	 * 間違って見送ったときのために、見送りを取り消して確認待ちに戻す
	 */
	@bindThis
	public async unreject(requestId: MiEmojiRequest['id']): Promise<MiEmojiRequest> {
		const request = await this.emojiRequestsRepository.findOneBy({ id: requestId });
		if (request == null) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.noSuchRequest);
		if (request.status !== 'rejected') throw new IdentifiableError(EMOJI_REQUEST_ERRORS.notRejected);

		// 申請者が出せる申請中の数の上限は、戻すときも守る
		const pendingCount = await this.emojiRequestsRepository.countBy({ userId: request.userId, status: 'pending' });
		if (pendingCount >= MAX_PENDING_PER_USER) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.tooManyPending);

		await this.withNameLock([request.name], async () => {
			// 見送っているあいだに、同じ名前で別の申請が出ていることがある
			if (await this.isNameTaken(request.name, request.id)) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.duplicateName);

			const result = await this.emojiRequestsRepository.update({ id: request.id, status: 'rejected' }, {
				status: 'pending',
				reviewerId: null,
				reviewedAt: null,
				rejectReason: null,
			});
			if (result.affected !== 1) throw new IdentifiableError(EMOJI_REQUEST_ERRORS.notRejected);
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
