<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- sushi.ski: 絵文字申請の 1 件分の表示 (申請ページと確認ページで共用) -->
<template>
<div v-panel :class="$style.root">
	<div :class="$style.imgContainer">
		<!-- 確認する人がアニメーションを確かめられるよう、確認ページでは元の画像を出す -->
		<img v-if="request.file != null" :src="showUser ? request.file.url : (request.file.thumbnailUrl ?? request.file.url)" :class="$style.img" :alt="request.name"/>
		<i v-else class="ti ti-photo-off" :class="$style.noImg"></i>
	</div>
	<div :class="$style.body">
		<div :class="$style.header">
			<span :class="$style.name">:{{ request.name }}:</span>
			<span :class="[$style.status, $style['status_' + request.status]]">{{ i18n.ts._sushiskiEmojiRequest._status[request.status] }}</span>
		</div>
		<div v-if="showUser" :class="$style.meta">
			{{ i18n.ts._sushiskiEmojiRequest.requestedBy }}:
			<MkA :to="userPage(request.user)"><MkAcct :user="request.user"/></MkA>
		</div>
		<div v-if="request.category != null" :class="[$style.meta, $style.chips]">
			{{ i18n.ts.category }}:
			<MkTagItem :content="request.category"/>
		</div>
		<div v-if="request.aliases.length > 0" :class="[$style.meta, $style.chips]">
			{{ i18n.ts.tags }}:
			<MkTagItem v-for="(tag, i) in request.aliases" :key="`${i}:${tag}`" :content="tag"/>
		</div>
		<div v-if="request.license != null" :class="$style.meta">{{ i18n.ts.license }}: {{ request.license }}</div>
		<div v-if="request.comment != null" :class="$style.comment">{{ request.comment }}</div>
		<div v-if="request.status === 'rejected' && request.rejectReason != null" :class="$style.meta">
			{{ i18n.ts._sushiskiEmojiRequest.rejectedReason }}: {{ request.rejectReason }}
		</div>
		<div :class="$style.meta"><MkTime :time="request.createdAt"/></div>
		<div v-if="$slots.actions" :class="$style.actions">
			<slot name="actions"></slot>
		</div>
	</div>
</div>
</template>

<script lang="ts" setup>
import * as Misskey from 'misskey-js';
import MkTagItem from '@/components/MkTagItem.vue';
import { i18n } from '@/i18n.js';
import { userPage } from '@/filters/user.js';

withDefaults(defineProps<{
	request: Misskey.entities.SushiskiEmojiRequest;
	showUser?: boolean;
}>(), {
	showUser: false,
});
</script>

<style lang="scss" module>
.root {
	display: flex;
	gap: 14px;
	padding: 14px;
	border-radius: 8px;
}

.imgContainer {
	flex-shrink: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	width: 64px;
	height: 64px;
}

.img {
	max-width: 64px;
	max-height: 64px;
	object-fit: contain;
}

.noImg {
	font-size: 28px;
	opacity: 0.5;
}

.body {
	flex: 1;
	min-width: 0;
}

.header {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-wrap: wrap;
}

.name {
	font-weight: bold;
	word-break: break-all;
}

.status {
	font-size: 0.8em;
	padding: 2px 8px;
	border-radius: 999px;
	background: var(--MI_THEME-buttonBg);
}

.status_pending {
	color: var(--MI_THEME-warn);
}

.status_approved {
	color: var(--MI_THEME-success);
}

.status_rejected {
	color: var(--MI_THEME-error);
}

.meta {
	font-size: 0.9em;
	opacity: 0.8;
	margin-top: 4px;
	word-break: break-all;
}

.chips {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px;
}

.comment {
	margin-top: 6px;
	white-space: pre-wrap;
	word-break: break-all;
}

.actions {
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
	margin-top: 10px;
}
</style>
