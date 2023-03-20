import { Meta, Story } from '@storybook/vue3';
import MkButton from './MkButton.vue';
const meta = {
	title: 'components/MkButton',
	component: MkButton,
};
export default meta;
export const Default = {
	render(args, { argTypes }) {
		return {
			components: {
				MkButton,
			},
			props: Object.keys(argTypes),
			template: '<MkButton v-bind="$props">Text</MkButton>',
		};
	},
	parameters: {
		layout: 'centered',
	},
};
