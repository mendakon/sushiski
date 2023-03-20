import { Meta, Story } from '@storybook/vue3';
import MkAbuseReport from './MkAbuseReport.vue';
const meta = {
	title: 'components/MkAbuseReport',
	component: MkAbuseReport,
};
export const Default = {
	render(args, { argTypes }) {
		return {
			components: {
				MkAbuseReport,
			},
			props: Object.keys(argTypes),
			template: '<MkAbuseReport v-bind="$props" />',
		};
	},
	parameters: {
		layout: 'centered',
	},
};
export default meta;
