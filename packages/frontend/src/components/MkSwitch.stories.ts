import { Meta, Story } from '@storybook/vue3';
import MkSwitch from './MkSwitch.vue';
const meta = {
	title: 'components/MkSwitch',
	component: MkSwitch,
};
export const Default = {
	render(args, { argTypes }) {
		return {
			components: {
				MkSwitch,
			},
			props: Object.keys(argTypes),
			template: '<MkSwitch v-bind="$props" />',
		};
	},
	parameters: {
		layout: 'centered',
	},
};
export default meta;
