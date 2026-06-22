import { Hono } from "hono";
import {
	DodoBillingError,
	dodoService as defaultDodoService,
	type DodoService,
} from "../services/dodo.service.js";

export interface DodoWebhookRouterDeps {
	service?: DodoService;
}

export function createDodoWebhookRouter(deps: DodoWebhookRouterDeps = {}): Hono {
	const webhooks = new Hono();
	const service = deps.service ?? defaultDodoService;

	webhooks.post("/dodo/webhook", async (c) => {
		const rawBody = await c.req.text();
		try {
			const result = await service.processWebhook(rawBody, c.req.raw.headers);
			return c.json({
				ok: true,
				processed: result.processed,
				event_id: result.eventId,
				type: result.type,
			});
		} catch (error) {
			if (error instanceof DodoBillingError) {
				return c.json({ error: error.message, code: error.code }, error.status as 400 | 401 | 404 | 500 | 502 | 503);
			}
			throw error;
		}
	});

	return webhooks;
}

export const dodoWebhooks = createDodoWebhookRouter();
