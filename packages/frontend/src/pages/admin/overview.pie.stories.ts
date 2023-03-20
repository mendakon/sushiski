import { Meta, Story } from '@storybook/vue3';
import overview_pie from './overview.pie.vue';
const meta = {
	title: 'pages/admin/overview.pie',
	component: overview_pie,
};
export const Default = {
	render(args, { argTypes }) {
		return {
			components: {
				overview_pie,
			},
			props: Object.keys(argTypes),
			template: '<overview_pie v-bind="$props" />',
		};
	},
	parameters: {
		layout: 'fullscreen',
	},
};
export default meta;
