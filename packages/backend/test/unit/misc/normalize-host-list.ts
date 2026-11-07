/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { InvalidHostError, normalizeHostList } from '@/misc/normalize-host-list.js';

describe('normalizeHostList', () => {
	test('空白、大文字、末尾のドット、空行を取り除く', () => {
		expect(normalizeHostList(['  Erinn.BIZ.  ', '', '   '])).toEqual(['erinn.biz']);
	});

	test('ワイルドカードや先頭のドットを取り除く', () => {
		expect(normalizeHostList(['*.erinn.biz', '.erinn.biz'])).toEqual(['erinn.biz', 'erinn.biz']);
	});

	test('日本語ドメインは punycode にする', () => {
		expect(normalizeHostList(['例え.jp'])).toEqual(['xn--r8jz45g.jp']);
	});

	test('全角の記号も処理する', () => {
		expect(normalizeHostList(['example.com。', 'example.com．', '＊.example.com', '例え.jp。'])).toEqual(['example.com', 'example.com', 'example.com', 'xn--r8jz45g.jp']);
	});

	test.each([
		'https://erinn.biz',
		'user@erinn.biz',
		'erinn.biz:25',
		'*',
		'erinn.biz/path',
		'erinn.biz?x',
		'erinn.biz#note',
		'erinn.biz\\p',
		'exa%6dple.com',
		'123',
		'0x7f.1',
		'127.0.0.1',
	])('%s はエラーにする', (host) => {
		expect(() => normalizeHostList([host])).toThrow(InvalidHostError);
	});
});
