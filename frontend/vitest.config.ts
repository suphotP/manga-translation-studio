/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { svelteTesting } from '@testing-library/svelte/vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), svelteTesting()],
	test: {
		globals: true,
		environment: 'jsdom',
		setupFiles: ['./src/test-setup.ts'],
		// Include .svelte.ts files in transform
		include: ['**/*.{test,spec}.{js,ts}'],
		exclude: ['e2e/**', 'node_modules/**', '.svelte-kit/**'],
		// Use Vite's config to process .svelte.ts files
		// This ensures Svelte's rune transformation is applied
	},
});
