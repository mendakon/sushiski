import { Meta, Story } from '@storybook/vue3';
import index_photos from './index.photos.vue';
const meta = {
	title: 'pages/user/index.photos',
	component: index_photos,
};
export const Default = {
	render(args, { argTypes }) {
		return {
			components: {
				index_photos,
			},
			props: Object.keys(argTypes),
			template: '<index_photos v-bind="$props" />',
		};
	},
	parameters: {
		layout: 'fullscreen',
	},
};
export default meta;
