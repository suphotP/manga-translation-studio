import { json } from '@sveltejs/kit';

// Liveness probe for the web (SvelteKit/adapter-node) container.
// Returns 200 as long as the Node server is up and serving requests.
// Used by docker-compose healthcheck and the Caddy app-host health probe.
export const prerender = false;

export function GET() {
	return json({ ok: true, service: 'web', uptime: process.uptime() });
}
