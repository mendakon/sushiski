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
				<template v-else-if="request.status === 'rejected'" #actions>
					<MkButton small @click="unreject(request)"><i class="ti ti-arrow-back-up"></i> {{ i18n.ts._sushiskiEmojiRequest.unreject }}</MkButton>
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
	// 状態が変わってこのタブの対象から外れたものは消し、そうでなければ差し替える
	requests.value = updated.status !== tab.value
		? requests.value.filter(r => r.id !== updated.id)
		: requests.value.map(r => r.id === updated.id ? updated : r);
}

// ダイアログの読み込み中にもう一度押されても、2 つ開かないようにする
let openingApproveDialog = false;

async function approve(request: Misskey.entities.SushiskiEmojiRequest) {
	if (openingApproveDialog) return;
	openingApproveDialog = true;
	// 申請の内容を直してから登録できるようにする
	try {
		const { dispose } = await os.popupAsyncWithDialog(import('./emoji-requests.approve-dialog.vue').then(x => x.default), {
			request,
		}, {
			done: updated => {
				replace(updated);
			},
			closed: () => {
				openingApproveDialog = false;
				dispose();
			},
		});
	} catch {
		// 読み込みの失敗は popupAsyncWithDialog が表示するので、ここではフラグを戻すだけ
		openingApproveDialog = false;
	}
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
	}).catch(() => null);
	if (updated != null) replace(updated);
}

async function unreject(request: Misskey.entities.SushiskiEmojiRequest) {
	const { canceled } = await os.confirm({
		type: 'question',
		text: i18n.ts._sushiskiEmojiRequest.unrejectConfirm,
	});
	if (canceled) return;

	const updated = await os.apiWithDialog('admin/emoji-requests/unreject', { requestId: request.id }).catch(() => null);
	if (updated != null) replace(updated);
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
