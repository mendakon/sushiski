<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- sushi.ski: 絵文字申請 (申請フォームと自分の申請一覧) -->
<template>
<PageWithHeader>
	<div class="_spacer" style="--MI_SPACER-w: 700px;">
		<div class="_gaps_m">
			<MkInfo v-if="!$i.policies.canRequestEmojis">{{ i18n.ts._sushiskiEmojiRequest.notAllowed }}</MkInfo>
			<MkFolder v-else :defaultOpen="true">
				<template #icon><i class="ti ti-icons"></i></template>
				<template #label>{{ i18n.ts._sushiskiEmojiRequest.title }}</template>

				<div class="_gaps_m">
					<MkInfo>{{ i18n.ts._sushiskiEmojiRequest.description }}</MkInfo>

					<div v-if="file != null" :class="$style.imgs">
						<div v-for="bg in previewBackgrounds" :key="bg" :class="$style.imgContainer" :style="{ background: bg }">
							<img :src="file.url" :class="$style.img" :alt="name"/>
						</div>
					</div>
					<MkButton rounded style="margin: 0 auto;" @click="chooseImage"><i class="ti ti-photo"></i> {{ i18n.ts._sushiskiEmojiRequest.selectImage }}</MkButton>

					<MkInput v-model="name" pattern="[a-zA-Z0-9_]+" autocapitalize="off">
						<template #label>{{ i18n.ts.name }}</template>
					</MkInput>
					<MkInput v-model="category">
						<template #label>{{ i18n.ts.category }}</template>
					</MkInput>
					<MkInput v-model="aliases" autocapitalize="off">
						<template #label>{{ i18n.ts.tags }}</template>
						<template #caption>
							{{ i18n.ts.theKeywordWhenSearchingForCustomEmoji }}<br/>
							{{ i18n.ts.setMultipleBySeparatingWithSpace }}
						</template>
					</MkInput>
					<MkInput v-model="license">
						<template #label>{{ i18n.ts.license }}</template>
					</MkInput>
					<MkSwitch v-model="isSensitive">
						<template #label>{{ i18n.ts.sensitive }}</template>
					</MkSwitch>
					<MkSwitch v-model="localOnly">
						<template #label>{{ i18n.ts.localOnly }}</template>
					</MkSwitch>
					<MkTextarea v-model="comment">
						<template #label>{{ i18n.ts._sushiskiEmojiRequest.comment }}</template>
						<template #caption>{{ i18n.ts._sushiskiEmojiRequest.commentDescription }}</template>
					</MkTextarea>

					<MkButton primary rounded style="margin: 0 auto;" :disabled="submitting" @click="submit"><i class="ti ti-send"></i> {{ i18n.ts._sushiskiEmojiRequest.submit }}</MkButton>
				</div>
			</MkFolder>

			<MkFoldableSection :expanded="true">
				<template #header>{{ i18n.ts._sushiskiEmojiRequest.myRequests }}</template>

				<MkLoading v-if="loading"/>
				<MkError v-else-if="loadError" @retry="load()"/>
				<div v-else-if="requests.length === 0" class="_fullinfo">{{ i18n.ts._sushiskiEmojiRequest.noRequests }}</div>
				<div v-else class="_gaps_s">
					<XRequestItem v-for="request in requests" :key="request.id" :request="request">
						<template v-if="request.status === 'pending'" #actions>
							<MkButton small danger @click="cancel(request)"><i class="ti ti-x"></i> {{ i18n.ts._sushiskiEmojiRequest.cancelRequest }}</MkButton>
						</template>
					</XRequestItem>
				</div>
			</MkFoldableSection>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { ref } from 'vue';
import * as Misskey from 'misskey-js';
import XRequestItem from './emoji-requests.item.vue';
import MkButton from '@/components/MkButton.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkFoldableSection from '@/components/MkFoldableSection.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkInput from '@/components/MkInput.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkTextarea from '@/components/MkTextarea.vue';
import { ensureSignin } from '@/i.js';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { selectFile } from '@/utility/drive.js';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';

const $i = ensureSignin();

// 透過した絵文字の見え方を暗い背景と明るい背景で確かめるため、テーマに関係なく固定の色にする (本家の emoji-edit-dialog.vue と同じ)
const previewBackgrounds = ['#000', '#222', '#ddd', '#fff'];

const file = ref<Misskey.entities.DriveFile | null>(null);
const name = ref('');
const category = ref('');
const aliases = ref('');
const license = ref('');
const isSensitive = ref(false);
const localOnly = ref(false);
const comment = ref('');
const submitting = ref(false);

const requests = ref<Misskey.entities.SushiskiEmojiRequest[]>([]);
const loading = ref(true);
const loadError = ref(false);

async function load() {
	loading.value = true;
	loadError.value = false;
	try {
		requests.value = await misskeyApi('emoji-requests/my', { limit: 100 });
	} catch {
		loadError.value = true;
	} finally {
		loading.value = false;
	}
}

load();

async function chooseImage(ev: PointerEvent) {
	file.value = await selectFile({
		anchorElement: ev.currentTarget ?? ev.target,
		multiple: false,
	});
	const candidate = file.value.name.replace(/\.(.+)$/, '');
	if (name.value === '' && /^[a-zA-Z0-9_]+$/.test(candidate)) {
		name.value = candidate;
	}
}

async function submit() {
	if (file.value == null) {
		os.alert({ type: 'warning', text: i18n.ts._sushiskiEmojiRequest.imageRequired });
		return;
	}

	submitting.value = true;
	try {
		const created = await os.apiWithDialog('emoji-requests/create', {
			fileId: file.value.id,
			name: name.value,
			category: category.value === '' ? null : category.value,
			aliases: aliases.value.split(' ').filter(x => x !== ''),
			license: license.value === '' ? null : license.value,
			isSensitive: isSensitive.value,
			localOnly: localOnly.value,
			comment: comment.value === '' ? null : comment.value,
		});
		requests.value.unshift(created);
		file.value = null;
		name.value = '';
		category.value = '';
		aliases.value = '';
		license.value = '';
		isSensitive.value = false;
		localOnly.value = false;
		comment.value = '';
	} finally {
		submitting.value = false;
	}
}

async function cancel(request: Misskey.entities.SushiskiEmojiRequest) {
	const { canceled } = await os.confirm({
		type: 'warning',
		text: i18n.ts._sushiskiEmojiRequest.cancelConfirm,
	});
	if (canceled) return;

	await os.apiWithDialog('emoji-requests/cancel', { requestId: request.id });
	request.status = 'canceled';
}

definePage(() => ({
	title: i18n.ts._sushiskiEmojiRequest.title,
	icon: 'ti ti-icons',
}));
</script>

<style lang="scss" module>
.imgs {
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
	justify-content: center;
}

.imgContainer {
	padding: 8px;
	border-radius: 6px;
}

.img {
	display: block;
	height: 64px;
	width: 64px;
	object-fit: contain;
}
</style>
