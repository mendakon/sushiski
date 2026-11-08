<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- sushi.ski: 絵文字申請の確認 (モデレーター以上と canApproveEmojiRequests を持つ人向け) -->
<template>
<PageWithHeader v-model:tab="tab" :tabs="headerTabs">
	<div class="_spacer" style="--MI_SPACER-w: 700px;">
		<MkLoading v-if="loading"/>
		<MkError v-else-if="loadError" @retry="load()"/>
		<div v-else-if="requests.length === 0" class="_fullinfo">{{ i18n.ts._sushiskiEmojiRequest.noRequests }}</div>
		<div v-else class="_gaps_s">
			<XRequestItem v-for="request in requests" :key="request.id" :request="request" :showUser="true">
				<template v-if="request.status === 'pending'" #actions>
					<MkButton small primary @click="approve(request)"><i class="ti ti-check"></i> {{ i18n.ts._sushiskiEmojiRequest.approve }}</MkButton>
					<MkButton small danger @click="reject(request)"><i class="ti ti-x"></i> {{ i18n.ts._sushiskiEmojiRequest.reject }}</MkButton>
				</template>
			</XRequestItem>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, ref, watch } from 'vue';
import * as Misskey from 'misskey-js';
import XRequestItem from './emoji-requests.item.vue';
import MkButton from '@/components/MkButton.vue';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';

type Status = Misskey.entities.SushiskiEmojiRequest['status'];

const tab = ref<Status>('pending');
const requests = ref<Misskey.entities.SushiskiEmojiRequest[]>([]);
const loading = ref(true);
const loadError = ref(false);

async function load() {
	// タブを素早く切り替えたとき、前のタブの遅れた結果で上書きしないようにする
	const requestedTab = tab.value;
	loading.value = true;
	loadError.value = false;
	try {
		const res = await misskeyApi('admin/emoji-requests/list', { status: requestedTab, limit: 100 });
		if (tab.value !== requestedTab) return;
		requests.value = res;
	} catch {
		if (tab.value !== requestedTab) return;
		loadError.value = true;
	} finally {
		if (tab.value === requestedTab) loading.value = false;
	}
}

watch(tab, load, { immediate: true });

function replace(updated: Misskey.entities.SushiskiEmojiRequest) {
	// 確認待ちのタブからは消し、ほかのタブでは差し替える
	requests.value = tab.value === 'pending'
		? requests.value.filter(r => r.id !== updated.id)
		: requests.value.map(r => r.id === updated.id ? updated : r);
}

async function approve(request: Misskey.entities.SushiskiEmojiRequest) {
	// 申請の内容を直してから登録できるようにする
	const { canceled, result } = await os.form(i18n.ts._sushiskiEmojiRequest.approveConfirm, {
		name: {
			type: 'string',
			label: i18n.ts.name,
			default: request.name,
		},
		category: {
			type: 'string',
			required: false,
			label: i18n.ts.category,
			default: request.category ?? '',
		},
		aliases: {
			type: 'string',
			required: false,
			label: i18n.ts.tags,
			description: i18n.ts.setMultipleBySeparatingWithSpace,
			default: request.aliases.join(' '),
		},
		license: {
			type: 'string',
			required: false,
			label: i18n.ts.license,
			default: request.license ?? '',
		},
		isSensitive: {
			type: 'boolean',
			label: i18n.ts.sensitive,
			default: request.isSensitive,
		},
		localOnly: {
			type: 'boolean',
			label: i18n.ts.localOnly,
			default: request.localOnly,
		},
	});
	if (canceled) return;

	const updated = await os.apiWithDialog('admin/emoji-requests/approve', {
		requestId: request.id,
		name: result.name,
		category: result.category == null || result.category === '' ? null : result.category,
		aliases: (result.aliases ?? '').split(' ').filter(x => x !== ''),
		license: result.license == null || result.license === '' ? null : result.license,
		isSensitive: result.isSensitive,
		localOnly: result.localOnly,
	});
	replace(updated);
}

async function reject(request: Misskey.entities.SushiskiEmojiRequest) {
	const { canceled, result } = await os.inputText({
		title: i18n.ts._sushiskiEmojiRequest.rejectReason,
		text: i18n.ts._sushiskiEmojiRequest.rejectReasonDescription,
		default: '',
		maxLength: 2048,
	});
	if (canceled) return;

	const updated = await os.apiWithDialog('admin/emoji-requests/reject', {
		requestId: request.id,
		reason: result == null || result === '' ? null : result,
	});
	replace(updated);
}

const headerTabs = computed(() => (['pending', 'approved', 'rejected', 'canceled'] as const).map(status => ({
	key: status,
	title: i18n.ts._sushiskiEmojiRequest._status[status],
})));

definePage(() => ({
	title: i18n.ts._sushiskiEmojiRequest.reviewTitle,
	icon: 'ti ti-icons',
}));
</script>
