import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { isIP } from "net";
import { serverConfig } from "../config.js";

export function getTrustedClientIp(c: Context): string | undefined {
	const socketIp = getSocketClientIp(c);
	if (!serverConfig.trustProxyHeaders) return socketIp;
	return normalizeClientIp(c.req.header("cf-connecting-ip"))
		?? normalizeClientIp(c.req.header("x-real-ip"))
		?? normalizeForwardedFor(c.req.header("x-forwarded-for"))
		?? socketIp;
}

function getSocketClientIp(c: Context): string | undefined {
	try {
		return normalizeClientIp(getConnInfo(c).remote.address);
	} catch {
		return undefined;
	}
}

function normalizeForwardedFor(value: string | undefined): string | undefined {
	const firstHop = value?.split(",")[0]?.trim();
	return normalizeClientIp(firstHop);
}

function normalizeClientIp(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.length > 128) return undefined;
	return isIP(trimmed) ? trimmed : undefined;
}
