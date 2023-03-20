import { Meta, Story } from '@storybook/vue3';
import page_text from './page.text.vue';
const meta = {
	title: 'components/page/page.text',
	component: page_text,
};
export const Default = {
	render(args, { argTypes }) {
		return {
			components: {
				page_text,
			},
			props: Object.keys(argTypes),
			template: '<page_text v-bind="$props" />',
		};
	},
	parameters: {
		layout: 'centered',
	},
};
export default meta;
