import { Meta, Story } from '@storybook/vue3';
import navbar from './navbar.vue';
const meta = {
	title: 'ui/_common_/navbar',
	component: navbar,
};
export const Default = {
	render(args, { argTypes }) {
		return {
			components: {
				navbar,
			},
			props: Object.keys(argTypes),
			template: '<navbar v-bind="$props" />',
		};
	},
	parameters: {
		layout: 'centered',
	},
};
export default meta;
