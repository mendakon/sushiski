/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class DisposableEmailBlock1794022766334 {
    name = 'DisposableEmailBlock1794022766334'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "meta" ADD "bannedEmailMxHosts" character varying(1024) array NOT NULL DEFAULT '{}'`);
        await queryRunner.query(`ALTER TABLE "meta" ADD "enableDisposableEmailDomainList" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "meta" ADD "disposableEmailDomainListExclusions" character varying(1024) array NOT NULL DEFAULT '{}'`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "disposableEmailDomainListExclusions"`);
        await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "enableDisposableEmailDomainList"`);
        await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "bannedEmailMxHosts"`);
    }
}
