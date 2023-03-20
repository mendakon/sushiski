import { Meta, Story } from '@storybook/vue3';
import overview_federation from './overview.federation.vue';
const meta = {
	title: 'pages/admin/overview.federation',
	component: overview_federation,
};
export const Default = {
	render(args, { argTypes }) {
		return {
			components: {
				overview_federation,
			},
			props: Object.keys(argTypes),
			template: '<overview_federation v-bind="$props" />',
		};
	},
	parameters: {
		layout: 'fullscreen',
	},
};
export default meta;
