/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';
import { MiDriveFile } from './DriveFile.js';
import { MiEmoji } from './Emoji.js';

// sushi.ski: 絵文字申請
export const emojiRequestStatuses = ['pending', 'approved', 'rejected', 'canceled'] as const;
export type EmojiRequestStatus = typeof emojiRequestStatuses[number];

@Entity('sushiski_emoji_request')
@Index(['status', 'id'])
export class MiEmojiRequest {
	@PrimaryColumn(id())
	public id: string;

	@Index()
	@Column({
		...id(),
	})
	public userId: MiUser['id'];

	@ManyToOne(() => MiUser, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public user: MiUser | null;

	/**
	 * 申請者のドライブにある画像。承認時にシステム所有のファイルへ複製する
	 */
	@Column({
		...id(),
		nullable: true,
	})
	public fileId: MiDriveFile['id'] | null;

	@ManyToOne(() => MiDriveFile, {
		onDelete: 'SET NULL',
	})
	@JoinColumn()
	public file: MiDriveFile | null;

	@Column('varchar', {
		length: 128,
	})
	public name: string;

	@Column('varchar', {
		length: 128, nullable: true,
	})
	public category: string | null;

	@Column('varchar', {
		array: true, length: 128, default: '{}',
	})
	public aliases: string[];

	@Column('varchar', {
		length: 1024, nullable: true,
	})
	public license: string | null;

	@Column('boolean', {
		default: false,
	})
	public isSensitive: boolean;

	@Column('boolean', {
		default: false,
	})
	public localOnly: boolean;

	/**
	 * 申請者からのひとこと
	 */
	@Column('varchar', {
		length: 2048, nullable: true,
	})
	public comment: string | null;

	@Column('varchar', {
		length: 16, default: 'pending',
	})
	public status: EmojiRequestStatus;

	@Column({
		...id(),
		nullable: true,
	})
	public reviewerId: MiUser['id'] | null;

	@ManyToOne(() => MiUser, {
		onDelete: 'SET NULL',
	})
	@JoinColumn()
	public reviewer: MiUser | null;

	@Column('timestamp with time zone', {
		nullable: true,
	})
	public reviewedAt: Date | null;

	@Column('varchar', {
		length: 2048, nullable: true,
	})
	public rejectReason: string | null;

	/**
	 * 承認して登録された絵文字
	 */
	@Column({
		...id(),
		nullable: true,
	})
	public emojiId: MiEmoji['id'] | null;

	@ManyToOne(() => MiEmoji, {
		onDelete: 'SET NULL',
	})
	@JoinColumn()
	public emoji: MiEmoji | null;
}
