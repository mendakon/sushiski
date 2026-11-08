/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';

const __dirname = import.meta.dirname;

const packageJsonPath = __dirname + '/../package.json'
// sushi.ski: 独自機能のバージョン。本家のバージョンと「+sushi.」でつなぐ (例: 2026.10.0+sushi.1.0.0)
const sushiskiJsonPath = __dirname + '/../sushiski.json'

function build() {
	try {
		const json = fs.readFileSync(packageJsonPath, 'utf-8')
		const meta = JSON.parse(json);
		const sushiski = JSON.parse(fs.readFileSync(sushiskiJsonPath, 'utf-8'));
		fs.mkdirSync(__dirname + '/../built', { recursive: true });
		fs.writeFileSync(__dirname + '/../built/meta.json', JSON.stringify({ version: `${meta.version}+sushi.${sushiski.version}` }), 'utf-8');
	} catch (e) {
		console.error(e)
	}
}

build();

if (process.argv.includes("--watch")) {
	for (const path of [packageJsonPath, sushiskiJsonPath]) {
		fs.watch(path, (event, filename) => {
			console.log(`update ${filename} ...`)
			build()
		})
	}
}
