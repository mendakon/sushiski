import { Meta, Story } from '@storybook/vue3';
import universal_widgets from './universal.widgets.vue';
const meta = {
	title: 'ui/universal.widgets',
	component: universal_widgets,
};
export const Default = {
	render(args, { argTypes }) {
		return {
			components: {
				universal_widgets,
			},
			props: Object.keys(argTypes),
			template: '<universal_widgets v-bind="$props" />',
		};
	},
	parameters: {
		layout: 'centered',
	},
};
export default meta;
