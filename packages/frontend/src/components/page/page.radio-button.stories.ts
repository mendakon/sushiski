import { Meta, Story } from '@storybook/vue3';
import page_radio_button from './page.radio-button.vue';
const meta = {
	title: 'components/page/page.radio-button',
	component: page_radio_button,
};
export const Default = {
	render(args, { argTypes }) {
		return {
			components: {
				page_radio_button,
			},
			props: Object.keys(argTypes),
			template: '<page_radio_button v-bind="$props" />',
		};
	},
	parameters: {
		layout: 'centered',
	},
};
export default meta;
