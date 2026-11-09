<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- sushi.ski: 絵文字申請のタグ・カテゴリ入力。入力した語を本家の MkTagItem で 1 つずつ囲んで表示し、× で消せるようにする -->
<template>
<div>
	<label :id="labelId" :for="inputId" :class="$style.label"><slot name="label"></slot></label>
	<div
		ref="boxEl"
		:class="$style.box"
		role="group"
		:aria-labelledby="labelId"
		@click="inputEl?.focus()"
	>
		<MkTagItem
			v-for="(item, i) in model"
			:key="`${i}:${item}`"
			:content="item"
			exButtonIconClass="ti ti-x"
			:exButtonLabel="`${i18n.ts.remove}: ${item}`"
			@exButtonClick="removeAt(i)"
		/>
		<!-- 上限に達したら隠す。v-if で消すとフォーカスが迷子になるので v-show にする -->
		<input
			v-show="model.length < max"
			:id="inputId"
			ref="inputEl"
			v-model="text"
			:class="$style.input"
			autocapitalize="off"
			:list="suggestions != null ? listId : undefined"
			:aria-describedby="captionId"
			@keydown="onKeydown"
			@input="onInput"
			@blur="commit"
			@paste="onPaste"
		/>
		<datalist v-if="suggestions != null" :id="listId">
			<option v-for="s in suggestions" :key="s" :value="s"></option>
		</datalist>
	</div>
	<div :id="captionId" :class="$style.caption"><slot name="caption"></slot></div>
</div>
</template>

<script lang="ts" setup>
import { nextTick, ref, useId } from 'vue';
import MkTagItem from '@/components/MkTagItem.vue';
import { i18n } from '@/i18n.js';

const props = withDefaults(defineProps<{
	max?: number;
	/** 入力中に候補として出す語 */
	suggestions?: string[];
	/** false にすると区切らず、入力した文字列をまるごと 1 つにする (スペースや読点を含むカテゴリ名のため) */
	splitBySpace?: boolean;
}>(), {
	max: 32,
	splitBySpace: true,
});

const model = defineModel<string[]>({ required: true });

const labelId = useId();
const inputId = useId();
const captionId = useId();
const listId = useId();
const boxEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
const text = ref('');

// 読点やカンマはタグ・カテゴリの一部として使える (API も本家の管理画面も許している) ので、区切りにはしない。
// タグは本家と同じくスペースで区切る。カテゴリは区切らず、入力した文字列をまるごと 1 つにする
function separator(): RegExp | null {
	return props.splitBySpace ? /\s+/ : null;
}

function addItems(raw: string) {
	const next = [...model.value];
	const sep = separator();
	for (const part of sep != null ? raw.split(sep) : [raw]) {
		const item = part.trim();
		if (item === '' || next.includes(item) || next.length >= props.max) continue;
		next.push(item);
	}
	model.value = next;
}

function commit() {
	if (text.value.trim() !== '') addItems(text.value);
	text.value = '';
}

/** Enter などで確定したあと。上限に達して入力欄が隠れたら、最後のチップの × にフォーカスを移す */
function commitByKey() {
	commit();
	if (model.value.length >= props.max) {
		nextTick(() => {
			const buttons = boxEl.value?.querySelectorAll('button');
			buttons?.[buttons.length - 1]?.focus();
		});
	}
}

function removeAt(index: number) {
	model.value = model.value.filter((_, i) => i !== index);
	// 押した × ボタンは消えるので、入力欄にフォーカスを戻す
	nextTick(() => inputEl.value?.focus());
}

function onKeydown(ev: KeyboardEvent) {
	// 日本語入力の変換を確定する Enter では区切らない (Safari は isComposing が false のまま来るので、本家の MkInput と同じ条件で見る)
	if (ev.isComposing || ev.key === 'Process' || ev.keyCode === 229) return;

	if (ev.key === 'Enter' || (props.splitBySpace && ev.key === ' ')) {
		ev.preventDefault();
		commitByKey();
	} else if (ev.key === 'Backspace' && text.value === '' && model.value.length > 0) {
		removeAt(model.value.length - 1);
	}
}

function onInput(ev: Event) {
	// 候補から選んだときは、その場で囲む。候補が無い欄では、スペルチェックの訂正などで囲まないようにする
	if (props.suggestions == null) return;
	if (!(ev instanceof InputEvent) || ev.inputType === 'insertReplacementText') {
		if (props.suggestions.includes(text.value)) commitByKey();
	}
}

function onPaste(ev: ClipboardEvent) {
	const pasted = ev.clipboardData?.getData('text') ?? '';
	const sep = separator();
	if (sep == null || !sep.test(pasted)) return;
	ev.preventDefault();
	// カーソルの位置 (選択範囲は置き換え) に貼り付けてから区切る
	const el = ev.target as HTMLInputElement;
	const start = el.selectionStart ?? text.value.length;
	const end = el.selectionEnd ?? text.value.length;
	addItems(text.value.slice(0, start) + pasted + text.value.slice(end));
	text.value = '';
}
</script>

<style lang="scss" module>
.label {
	display: block;
	font-size: 0.85em;
	padding: 0 0 8px 0;
	user-select: none;

	&:empty {
		display: none;
	}
}

.caption {
	font-size: 0.85em;
	padding: 8px 0 0 0;
	color: color(from var(--MI_THEME-fg) srgb r g b / 0.75);

	&:empty {
		display: none;
	}
}

.box {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px;
	min-height: 38px;
	padding: 4px 8px;
	background: var(--MI_THEME-panel);
	border: solid 1px var(--MI_THEME-panel);
	border-radius: 6px;
	box-sizing: border-box;
	cursor: text;
	transition: border-color 0.1s ease-out;

	&:hover {
		border-color: var(--MI_THEME-inputBorderHover);
	}

	&:focus-within {
		border-color: var(--MI_THEME-accent);
	}
}

.input {
	flex: 1;
	min-width: 80px;
	height: 28px;
	padding: 0 4px;
	font: inherit;
	color: var(--MI_THEME-fg);
	background: transparent;
	border: none;
	outline: none;
}
</style>
