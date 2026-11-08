/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// sushi.ski: 絵文字申請
export class SushiskiEmojiRequest1794136820144 {
    name = 'SushiskiEmojiRequest1794136820144'

    /**
     * @param {QueryRunner} queryRunner
     */
    async up(queryRunner) {
        await queryRunner.query(`CREATE TABLE "sushiski_emoji_request" ("id" character varying(32) NOT NULL, "userId" character varying(32) NOT NULL, "fileId" character varying(32), "name" character varying(128) NOT NULL, "category" character varying(128), "aliases" character varying(128) array NOT NULL DEFAULT '{}', "license" character varying(1024), "isSensitive" boolean NOT NULL DEFAULT false, "localOnly" boolean NOT NULL DEFAULT false, "comment" character varying(2048), "status" character varying(16) NOT NULL DEFAULT 'pending', "reviewerId" character varying(32), "reviewedAt" TIMESTAMP WITH TIME ZONE, "rejectReason" character varying(2048), "emojiId" character varying(32), CONSTRAINT "PK_b6cda3b78a28318de914730f54b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7ea34254a1627d4a05184d3a6f" ON "sushiski_emoji_request" ("userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_167bf672d48877f3adfb768f64" ON "sushiski_emoji_request" ("status", "id") `);
        await queryRunner.query(`ALTER TABLE "sushiski_emoji_request" ADD CONSTRAINT "FK_7ea34254a1627d4a05184d3a6f0" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "sushiski_emoji_request" ADD CONSTRAINT "FK_da4919c5ec138b7a6c6a31a93b2" FOREIGN KEY ("fileId") REFERENCES "drive_file"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "sushiski_emoji_request" ADD CONSTRAINT "FK_72b498c69016bc91a9fc1850edf" FOREIGN KEY ("reviewerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "sushiski_emoji_request" ADD CONSTRAINT "FK_503e136f7e52fc6f83c8ea562fb" FOREIGN KEY ("emojiId") REFERENCES "emoji"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    /**
     * @param {QueryRunner} queryRunner
     */
    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "sushiski_emoji_request" DROP CONSTRAINT "FK_503e136f7e52fc6f83c8ea562fb"`);
        await queryRunner.query(`ALTER TABLE "sushiski_emoji_request" DROP CONSTRAINT "FK_72b498c69016bc91a9fc1850edf"`);
        await queryRunner.query(`ALTER TABLE "sushiski_emoji_request" DROP CONSTRAINT "FK_da4919c5ec138b7a6c6a31a93b2"`);
        await queryRunner.query(`ALTER TABLE "sushiski_emoji_request" DROP CONSTRAINT "FK_7ea34254a1627d4a05184d3a6f0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_167bf672d48877f3adfb768f64"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7ea34254a1627d4a05184d3a6f"`);
        await queryRunner.query(`DROP TABLE "sushiski_emoji_request"`);
    }
}
