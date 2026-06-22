// Short-lived signed token used to authenticate browser SSE connections.
//
// EventSource cannot attach an Authorization header, so the SSE handshake uses a
// query-param token instead of the long-lived access JWT. The token is:
//   - subject-scoped (userId)
//   - workspace-scoped (workspaceId, scope='sse')
//   - short-lived (default 60s; configurable via SSE_TOKEN_TTL_SEC)
// The client requests a token via POST /api/realtime/token immediately before
// opening the EventSource so the token barely outlives a single connect attempt.

import { sign, verify } from "jsonwebtoken";
import { serverConfig } from "../config.js";
import { readSseTokenTtlSec } from "./realtime-bus.js";

export interface RealtimeTokenPayload {
	sub: string;
	ws: string;
	scope: "sse";
	iat?: number;
	exp?: number;
}

export interface MintRealtimeTokenInput {
	userId: string;
	workspaceId: string;
	ttlSeconds?: number;
}

export interface MintedRealtimeToken {
	token: string;
	expiresAt: number;
}

export function mintRealtimeToken(input: MintRealtimeTokenInput): MintedRealtimeToken {
	const ttlSeconds = clampTtl(input.ttlSeconds ?? readSseTokenTtlSec());
	const payload: RealtimeTokenPayload = {
		sub: input.userId,
		ws: input.workspaceId,
		scope: "sse",
	};
	const token = sign(payload, serverConfig.jwtSecret, { expiresIn: `${ttlSeconds}s` });
	return {
		token,
		expiresAt: Date.now() + ttlSeconds * 1000,
	};
}

export function verifyRealtimeToken(token: string): RealtimeTokenPayload | null {
	if (!token?.trim()) return null;
	try {
		const decoded = verify(token, serverConfig.jwtSecret) as RealtimeTokenPayload;
		if (decoded.scope !== "sse") return null;
		if (!decoded.sub?.trim() || !decoded.ws?.trim()) return null;
		return decoded;
	} catch {
		return null;
	}
}

function clampTtl(ttl: number): number {
	if (!Number.isFinite(ttl) || ttl <= 0) return 60;
	return Math.min(Math.max(Math.trunc(ttl), 1), 3600);
}
