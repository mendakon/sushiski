<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- sushi.ski: 絵文字申請の承認ダイアログ。申請の内容を直してから登録できる -->
<template>
<MkModalWindow
	ref="dialogEl"
	:width="440"
	:height="600"
	:withOkButton="true"
	:okButtonDisabled="nameError != null || name === '' || submitting"
	@ok="ok"
	@close="dialogEl?.close()"
	@esc="dialogEl?.close()"
	@closed="emit('closed')"
>
	<template #header>{{ i18n.ts._sushiskiEmojiRequest.approveConfirm }}</template>

	<div class="_spacer" style="--MI_SPACER-min: 20px; --MI_SPACER-max: 28px;">
		<div class="_gaps_m">
			<div v-if="request.file != null" :class="$style.preview">
				<img :src="request.file.url" :class="$style.img" :alt="request.name"/>
			</div>

			<MkInput v-model="name" autocapitalize="off" required>
				<template #label>{{ i18n.ts.name }}</template>
				<template v-if="nameError != null" #caption><span :class="$style.error" role="alert">{{ nameError }}</span></template>
			</MkInput>
			<XChipsInput v-model="category" :max="1" :splitBySpace="false" :suggestions="categoryCandidates">
				<template #label>{{ i18n.ts.category }}</template>
				<template #caption>{{ i18n.ts._sushiskiEmojiRequest.categoryCaption }}</template>
			</XChipsInput>
			<XChipsInput v-model="aliases">
				<template #label>{{ i18n.ts.tags }}</template>
				<template #caption>{{ i18n.ts._sushiskiEmojiRequest.tagsCaption }}</template>
			</XChipsInput>
			<MkInput v-model="license">
				<template #label>{{ i18n.ts.license }}</template>
			</MkInput>
			<MkSwitch v-model="isSensitive">
				<template #label>{{ i18n.ts.sensitive }}</template>
			</MkSwitch>
			<MkSwitch v-model="localOnly">
				<template #label>{{ i18n.ts.localOnly }}</template>
			</MkSwitch>
		</div>
	</div>
</MkModalWindow>
</template>

<script lang="ts" setup>
import { computed, ref, useTemplateRef } from 'vue';
import * as Misskey from 'misskey-js';
import XChipsInput from './emoji-requests.chips-input.vue';
import { emojiNameError } from './emoji-requests.name.js';
import MkModalWindow from '@/components/MkModalWindow.vue';
import MkInput from '@/components/MkInput.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import { customEmojiCategories } from '@/custom-emojis.js';

const props = defineProps<{
	request: Misskey.entities.SushiskiEmojiRequest;
}>();

const emit = defineEmits<{
	(ev: 'done', updated: Misskey.entities.SushiskiEmojiRequest): void;
	(ev: 'closed'): void;
}>();

const dialogEl = useTemplateRef('dialogEl');

const name = ref(props.request.name);
const category = ref<string[]>(props.request.category != null ? [props.request.category] : []);
const aliases = ref<string[]>([...props.request.aliases]);
const license = ref(props.request.license ?? '');
const isSensitive = ref(props.request.isSensitive);
const localOnly = ref(props.request.localOnly);
const submitting = ref(false);

const nameError = computed(() => emojiNameError(name.value));
const categoryCandidates = computed(() => customEmojiCategories.value.filter((x): x is string => x != null));

async function ok() {
	submitting.value = true;
	try {
		const updated = await os.apiWithDialog('admin/emoji-requests/approve', {
			requestId: props.request.id,
			name: name.value,
			category: category.value[0] ?? null,
			aliases: aliases.value,
			license: license.value === '' ? null : license.value,
			isSensitive: isSensitive.value,
			localOnly: localOnly.value,
		});
		emit('done', updated);
		dialogEl.value?.close();
	} catch {
		// エラーは apiWithDialog が表示する
	} finally {
		submitting.value = false;
	}
}
</script>

<style lang="scss" module>
.preview {
	display: flex;
	justify-content: center;
}

.img {
	display: block;
	height: 64px;
	width: 64px;
	object-fit: contain;
}

.error {
	color: var(--MI_THEME-error);
}
</style>
