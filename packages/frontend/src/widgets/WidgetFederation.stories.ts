import { Meta, Story } from '@storybook/vue3';
import WidgetFederation from './WidgetFederation.vue';
const meta = {
	title: 'widgets/WidgetFederation',
	component: WidgetFederation,
};
export const Default = {
	render(args, { argTypes }) {
		return {
			components: {
				WidgetFederation,
			},
			props: Object.keys(argTypes),
			template: '<WidgetFederation v-bind="$props" />',
		};
	},
	parameters: {
		layout: 'centered',
	},
};
export default meta;
