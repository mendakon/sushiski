import { Meta, Story } from '@storybook/vue3';
import user_tag from './user-tag.vue';
const meta = {
	title: 'pages/user-tag',
	component: user_tag,
};
export const Default = {
	render(args, { argTypes }) {
		return {
			components: {
				user_tag,
			},
			props: Object.keys(argTypes),
			template: '<user_tag v-bind="$props" />',
		};
	},
	parameters: {
		layout: 'fullscreen',
	},
};
export default meta;
