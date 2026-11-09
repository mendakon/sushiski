<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- sushi.ski: 絵文字申請 (申請フォームと自分の申請一覧をタブで分ける) -->
<template>
<PageWithHeader v-model:tab="tab" :tabs="headerTabs">
	<div class="_spacer" style="--MI_SPACER-w: 700px;">
		<template v-if="tab === 'request'">
			<MkInfo v-if="!$i.policies.canRequestEmojis">{{ i18n.ts._sushiskiEmojiRequest.notAllowed }}</MkInfo>
			<div v-else class="_gaps_m">
				<MkInfo>{{ i18n.ts._sushiskiEmojiRequest.description }}<br/>{{ i18n.ts._sushiskiEmojiRequest.bundleNote }}</MkInfo>

				<div v-if="file != null" :class="$style.imgs">
					<div v-for="(bg, i) in previewBackgrounds" :key="bg" :class="$style.imgContainer" :style="{ background: bg }">
						<!-- 背景違いの同じ画像なので、読み上げは 1 枚目だけにする -->
						<img :src="file.url" :class="$style.img" :alt="i === 0 ? (name || file.name) : ''" @load="onPreviewLoad"/>
					</div>
				</div>
				<div v-if="file != null && isSquare === false" :class="$style.notSquare" role="status">{{ i18n.ts._sushiskiEmojiRequest.notSquare }}</div>
				<!-- 文中とリアクション欄での見え方。本家のチュートリアルと同じく、MkNote をお試しモードで表示する -->
				<MkFolder v-if="previewNote != null" :defaultOpen="true">
					<template #icon><i class="ti ti-eye"></i></template>
					<template #label>{{ i18n.ts._sushiskiEmojiRequest.previewTitle }}</template>
					<!-- MkNote は作成時のノートを取り込んで固定するので、名前や画像が変わったら作り直す。中のボタンにはフォーカスさせない -->
					<MkNote :key="`${previewEmojiName}:${file?.id}`" :note="previewNote" :mock="true" inert :class="$style.previewNote"/>
				</MkFolder>
				<MkButton rounded style="margin: 0 auto;" @click="chooseImage"><i class="ti ti-photo"></i> {{ i18n.ts._sushiskiEmojiRequest.selectImage }}</MkButton>

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
					<template #caption>
						{{ i18n.ts.theKeywordWhenSearchingForCustomEmoji }}<br/>
						{{ i18n.ts._sushiskiEmojiRequest.tagsCaption }}
					</template>
				</XChipsInput>
				<MkInput v-model="license" :class="$style.lightPlaceholder" :placeholder="i18n.ts._sushiskiEmojiRequest.licensePlaceholder">
					<template #label>{{ i18n.ts.license }}</template>
					<template #caption>{{ i18n.ts._sushiskiEmojiRequest.licenseCaption }}</template>
				</MkInput>
				<MkSwitch v-model="isSensitive">
					<template #label>{{ i18n.ts.sensitive }}</template>
				</MkSwitch>
				<MkSwitch v-model="localOnly">
					<template #label>{{ i18n.ts.localOnly }}</template>
				</MkSwitch>
				<MkTextarea v-model="comment" :class="$style.lightPlaceholder" :placeholder="i18n.ts._sushiskiEmojiRequest.commentPlaceholder" required>
					<template #label>{{ i18n.ts._sushiskiEmojiRequest.comment }}</template>
				</MkTextarea>

				<!-- 本家の新規登録画面のサーバールールへの同意と同じく MkSwitch で同意してもらう -->
				<div class="_gaps_s">
					<MkSwitch v-model="agreeOwnWork">
						<template #label>{{ i18n.ts._sushiskiEmojiRequest.agreeOwnWork }}</template>
					</MkSwitch>
					<MkSwitch v-model="agreeUsage">
						<template #label>{{ i18n.ts._sushiskiEmojiRequest.agreeUsage }}</template>
					</MkSwitch>
					<div v-if="!agreed" :class="$style.agreeNote">{{ i18n.ts.pleaseAgreeAllToContinue }}</div>
				</div>

				<MkButton primary rounded style="margin: 0 auto;" :disabled="submitting || !agreed || name === '' || nameError != null" @click="submit"><i class="ti ti-send"></i> {{ i18n.ts._sushiskiEmojiRequest.submit }}</MkButton>
			</div>
		</template>

		<template v-else>
			<MkLoading v-if="loading"/>
			<MkError v-else-if="loadError" @retry="load()"/>
			<div v-else-if="shownRequests.length === 0" class="_fullinfo">{{ i18n.ts._sushiskiEmojiRequest.noRequests }}</div>
			<div v-else ref="listEl" class="_gaps_s">
				<XRequestItem
					v-for="request in shownRequests"
					:key="request.id"
					:data-request-id="request.id"
					:request="request"
					:class="{ [$style.highlight]: request.id === highlightedId }"
					:aria-current="request.id === highlightedId ? 'true' : undefined"
				>
					<template v-if="request.status === 'pending'" #actions>
						<MkButton small danger @click="cancel(request)"><i class="ti ti-x"></i> {{ i18n.ts._sushiskiEmojiRequest.cancelRequest }}</MkButton>
					</template>
					<template v-else-if="request.status === 'approved'" #actions>
						<MkButton small @click="noteApproved(request)"><i class="ti ti-pencil"></i> {{ i18n.ts._sushiskiEmojiRequest.noteIt }}</MkButton>
					</template>
				</XRequestItem>
			</div>
		</template>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, nextTick, onUnmounted, ref, watchEffect } from 'vue';
import * as Misskey from 'misskey-js';
import XRequestItem from './emoji-requests.item.vue';
import XChipsInput from './emoji-requests.chips-input.vue';
import { emojiNameError } from './emoji-requests.name.js';
import MkButton from '@/components/MkButton.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkNote from '@/components/MkNote.vue';
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
import { customEmojiCategories, customEmojis, customEmojisMap } from '@/custom-emojis.js';
import { useRouter } from '@/router.js';

const props = defineProps<{
	// 承認の通知から開いたときの絵文字の名前。その申請までスクロールする
	focusEmojiName?: string;
}>();

const $i = ensureSignin();
const router = useRouter();

type Tab = 'request' | 'pending' | 'done';
const tab = ref<Tab>(props.focusEmojiName != null ? 'done' : 'request');
const headerTabs = computed(() => [{
	key: 'request',
	title: i18n.ts._sushiskiEmojiRequest.tabRequest,
	icon: 'ti ti-send',
}, {
	key: 'pending',
	title: i18n.ts._sushiskiEmojiRequest.tabPending,
	icon: 'ti ti-hourglass',
}, {
	key: 'done',
	title: i18n.ts._sushiskiEmojiRequest.tabDone,
	icon: 'ti ti-checks',
}]);

// 透過した絵文字の見え方を暗い背景と明るい背景で確かめるため、テーマに関係なく固定の色にする (本家の emoji-edit-dialog.vue と同じ)
const previewBackgrounds = ['#000', '#222', '#ddd', '#fff'];

const file = ref<Misskey.entities.DriveFile | null>(null);
const name = ref('');
const category = ref<string[]>([]);
const aliases = ref<string[]>([]);
const license = ref('');
const isSensitive = ref(false);
const localOnly = ref(false);
const agreeOwnWork = ref(false);
const agreeUsage = ref(false);
const agreed = computed(() => agreeOwnWork.value && agreeUsage.value);
const comment = ref('');
const submitting = ref(false);

const nameError = computed(() => emojiNameError(name.value));

// 見え方のお試し用のノート。名前がまだ使えないときや、既にある絵文字と同じ名前のときは、
// 本物の絵文字の画像が出ないよう、重ならない仮の名前で表示する
const previewEmojiName = computed(() => {
	// 使える名前かどうかは、名前欄の確認 (emojiNameError) と同じ判定を使う
	return name.value !== '' && nameError.value == null ? name.value : '__sushiski_preview__';
});

// このサーバーの人の投稿の絵文字は、本家の部品が画面内の絵文字一覧からしか画像を探さない。
// プレビューのあいだだけ申請中の絵文字を一覧に仮に入れ、本文とリアクション欄で実物どおりに表示する。
// 既にある絵文字は上書きせず、入れたものは名前や画像が変わったときと、ページを離れたときに消す
let insertedPreviewEmoji: Misskey.entities.EmojiSimple | null = null;

function removePreviewEmoji() {
	// 一覧が作り直されて同じ名前の本物の絵文字が入っていたら、それは消さない
	if (insertedPreviewEmoji != null && customEmojisMap.get(insertedPreviewEmoji.name) === insertedPreviewEmoji) {
		customEmojisMap.delete(insertedPreviewEmoji.name);
	}
	insertedPreviewEmoji = null;
}

watchEffect(() => {
	// 絵文字一覧が更新されると Map は作り直されるので、そのときも入れ直す
	void customEmojis.value;
	removePreviewEmoji();
	// 申請フォームのタブを開いているときだけ入れる
	if (tab.value !== 'request' || file.value == null || customEmojisMap.has(previewEmojiName.value)) return;
	insertedPreviewEmoji = {
		name: previewEmojiName.value,
		category: null,
		aliases: [],
		url: file.value.url,
	};
	customEmojisMap.set(insertedPreviewEmoji.name, insertedPreviewEmoji);
}, { flush: 'pre' });
onUnmounted(() => {
	removePreviewEmoji();
	if (refocusTimer != null) window.clearTimeout(refocusTimer);
});

const previewNote = computed<Misskey.entities.Note | null>(() => {
	if (file.value == null) return null;
	const emojiName = previewEmojiName.value;
	return {
		id: '0000000000',
		createdAt: new Date().toISOString(),
		userId: $i.id,
		user: $i,
		text: i18n.tsx._sushiskiEmojiRequest.previewText({ emoji: `:${emojiName}:` }),
		cw: null,
		visibility: 'public',
		localOnly: false,
		reactionAcceptance: null,
		renoteCount: 0,
		repliesCount: 0,
		reactionCount: 3,
		reactions: { [`:${emojiName}@.:`]: 2, '👍': 1 },
		reactionEmojis: { [emojiName]: file.value.url },
		emojis: { [emojiName]: file.value.url },
		fileIds: [],
		files: [],
		replyId: null,
		renoteId: null,
	};
});

// 既存のカテゴリを候補に出す。新しいカテゴリも書ける
const categoryCandidates = computed(() => customEmojiCategories.value.filter((x): x is string => x != null));

// ファイル情報に縦横が無い画像は、プレビューを読み込んだときの大きさで判断する
const previewSize = ref<{ width: number; height: number } | null>(null);
const isSquare = computed<boolean | null>(() => {
	const width = file.value?.properties.width ?? previewSize.value?.width;
	const height = file.value?.properties.height ?? previewSize.value?.height;
	if (width == null || height == null) return null;
	return width === height;
});

function onPreviewLoad(ev: Event) {
	const img = ev.target as HTMLImageElement;
	previewSize.value = { width: img.naturalWidth, height: img.naturalHeight };
}

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

// 申請中のタブには確認待ち、結果のタブには承認・見送り・取り下げを出す
const shownRequests = computed(() => tab.value === 'pending'
	? requests.value.filter(r => r.status === 'pending')
	: requests.value.filter(r => r.status !== 'pending'));

const loaded = load();

// 承認の通知から開いたとき、その申請までスクロールして目立たせる
const highlightedId = ref<string | null>(null);
const listEl = ref<HTMLElement | null>(null);

async function focusRequest() {
	if (props.focusEmojiName == null) return;
	await loaded;
	// 承認済みの絵文字の名前は重ならないので、名前で探せる
	const request = requests.value.find(r => r.name === props.focusEmojiName && r.status === 'approved');
	// 同じ通知をもう一度押したときは、見つかったときだけ切り替える (見つからないときに、いま見ているタブから動かさない)。
	// 最初に開いたときは、タブの初期値がすでに 'done' になっている
	if (request == null) return;
	tab.value = 'done';
	highlightedId.value = request.id;
	await nextTick();
	// デッキなどで同じページが 2 つ開いていても取り違えないよう、このページの一覧の中から探す
	listEl.value?.querySelector(`[data-request-id="${request.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

focusRequest();

// 同じ通知をもう一度押したときは、ページは作り直されず、ヘッダーが先頭へスクロールする。
// そのスクロールが終わってから、改めて申請までスクロールする
let refocusTimer: number | null = null;
router.useListener('same', () => {
	if (refocusTimer != null) window.clearTimeout(refocusTimer);
	refocusTimer = window.setTimeout(focusRequest, 500);
});

async function chooseImage(ev: PointerEvent) {
	const selected = await selectFile({
		anchorElement: ev.currentTarget ?? ev.target,
		multiple: false,
	});
	// 同じ画像を選び直したときはプレビューの load が来ないので、大きさを消さない
	if (selected.id !== file.value?.id) previewSize.value = null;
	file.value = selected;
	const candidate = file.value.name.replace(/\.[^.]+$/, '');
	if (name.value === '' && /^[a-zA-Z0-9_]+$/.test(candidate)) {
		name.value = candidate;
	}
}

async function submit() {
	if (file.value == null) {
		os.alert({ type: 'warning', text: i18n.ts._sushiskiEmojiRequest.imageRequired });
		return;
	}
	if (!agreed.value || name.value === '' || nameError.value != null) return;
	if (comment.value.trim() === '') {
		os.alert({ type: 'warning', text: i18n.ts._sushiskiEmojiRequest.commentRequired });
		return;
	}

	submitting.value = true;
	try {
		const submittedFile = file.value;
		const created = await os.apiWithDialog('emoji-requests/create', {
			fileId: submittedFile.id,
			name: name.value,
			category: category.value[0] ?? null,
			aliases: aliases.value,
			license: license.value === '' ? null : license.value,
			isSensitive: isSensitive.value,
			localOnly: localOnly.value,
			comment: comment.value,
		}).catch(() => null);
		if (created == null) return;

		requests.value.unshift(created);
		file.value = null;
		previewSize.value = null;
		name.value = '';
		category.value = [];
		aliases.value = [];
		license.value = '';
		isSensitive.value = false;
		localOnly.value = false;
		agreeOwnWork.value = false;
		agreeUsage.value = false;
		comment.value = '';

		tab.value = 'pending';
		const { canceled } = await os.confirm({
			type: 'success',
			title: i18n.ts._sushiskiEmojiRequest.submitted,
			text: i18n.tsx._sushiskiEmojiRequest.submittedDescription({ name: created.name }),
			okText: i18n.ts._sushiskiEmojiRequest.noteIt,
			cancelText: i18n.ts.close,
		});
		if (canceled) return;
		os.post({
			initialText: i18n.tsx._sushiskiEmojiRequest.noteSubmittedText({ name: created.name }),
			initialFiles: [submittedFile],
			// 書きかけの下書きで上書きされないようにする
			instant: true,
		});
	} finally {
		submitting.value = false;
	}
}

function noteApproved(request: Misskey.entities.SushiskiEmojiRequest) {
	os.post({
		initialText: i18n.tsx._sushiskiEmojiRequest.noteApprovedText({ name: request.name }),
		// 書きかけの下書きで上書きされないようにする
		instant: true,
	});
}

async function cancel(request: Misskey.entities.SushiskiEmojiRequest) {
	const { canceled } = await os.confirm({
		type: 'warning',
		text: i18n.ts._sushiskiEmojiRequest.cancelConfirm,
	});
	if (canceled) return;

	const ok = await os.apiWithDialog('emoji-requests/cancel', { requestId: request.id }).then(() => true, () => false);
	if (ok) request.status = 'canceled';
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

.error {
	color: var(--MI_THEME-error);
}

// 開閉のアニメーション中は MkFolder の中がスクロール領域になるので、
// ノートのアバターやフッターが「ヘッダーの下に張り付く」位置までずれて見える。プレビューでは張り付く位置を 0 にする
.previewNote {
	pointer-events: none;
	--MI-stickyTop: 0px;
	--MI-stickyBottom: 0px;
}

.highlight {
	outline: solid 2px var(--MI_THEME-accent);
	outline-offset: -2px;
}

// 本家の入力欄はブラウザ標準のプレースホルダー色で濃く見えるので、ここだけ薄くする
.lightPlaceholder :global(textarea)::placeholder,
.lightPlaceholder :global(input)::placeholder {
	color: color(from var(--MI_THEME-fg) srgb r g b / 0.4);
}

.agreeNote {
	font-size: 0.9em;
	text-align: center;
}

.notSquare {
	text-align: center;
	font-size: 0.9em;
}

.img {
	display: block;
	height: 64px;
	width: 64px;
	object-fit: contain;
}
</style>
