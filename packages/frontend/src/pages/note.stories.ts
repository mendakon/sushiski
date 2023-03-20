import { Meta, Story } from '@storybook/vue3';
import note from './note.vue';
const meta = {
	title: 'pages/note',
	component: note,
};
export const Default = {
	render(args, { argTypes }) {
		return {
			components: {
				note,
			},
			props: Object.keys(argTypes),
			template: '<note v-bind="$props" />',
		};
	},
	parameters: {
		layout: 'fullscreen',
	},
};
export default meta;
