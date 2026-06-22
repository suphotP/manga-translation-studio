import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		host: "0.0.0.0",
		proxy: {
			"/api": process.env.VITE_DEV_PROXY_TARGET || "http://127.0.0.1:3001",
			"/healthz": process.env.VITE_DEV_PROXY_TARGET || "http://127.0.0.1:3001",
			"/readyz": process.env.VITE_DEV_PROXY_TARGET || "http://127.0.0.1:3001",
			"/metrics": process.env.VITE_DEV_PROXY_TARGET || "http://127.0.0.1:3001",
		},
	},
});
