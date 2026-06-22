// Shared admin API client (de-conflict scaffold).
//
// The token + base URL + Bearer-header handling lives here so EVERY per-domain
// admin barrel (revenue/coupons/support/users/content) uses the exact same auth
// header / base URL semantics as the legacy api/admin.ts surface. api/admin.ts
// re-exports `adminFetch`, `AdminApiError`, and `setAdminApiToken` from here, so
// the public import surface is unchanged.

import { config } from "$lib/config.js";

const BASE = config.apiBase;
let token: string | null = null;

export function setAdminApiToken(value: string | null): void {
	token = value?.trim() || null;
}

export function getAdminApiToken(): string | null {
	return token;
}

export function adminApiBase(): string {
	return BASE;
}

export class AdminApiError extends Error {
	constructor(public readonly status: number, message: string, public readonly body: unknown) {
		super(message);
		this.name = "AdminApiError";
	}
}

export interface FetchOpts extends RequestInit {
	timeoutMs?: number;
}

export async function adminFetch<T>(path: string, init: FetchOpts = {}): Promise<T> {
	const headers = new Headers(init.headers);
	if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
	if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
	const res = await fetch(`${BASE}${path}`, { ...init, headers });
	const raw = await res.text();
	if (!res.ok) {
		let detail: unknown = raw;
		try { detail = JSON.parse(raw); } catch { /* keep raw */ }
		throw new AdminApiError(res.status, typeof (detail as { error?: string })?.error === "string" ? (detail as { error: string }).error : `Admin API ${res.status}`, detail);
	}
	if (!raw) return undefined as T;
	return JSON.parse(raw) as T;
}
