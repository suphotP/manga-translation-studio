import { getSharedBunSql } from "./sql-pool.js";
import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { v4 as uuid } from "uuid";
import { DATA_DIR, serverConfig } from "../config.js";
import type { AuthIdentityProvider } from "../types/auth.js";
import { readJsonFile } from "../utils/json-file.js";
import type { AuthUserSqlClient } from "./auth-users.js";

export interface OAuthLinkIntentRecord {
	id: string;
	tokenHash: string;
	userId: string;
	provider: Exclude<AuthIdentityProvider, "local">;
	providerUserId: string;
	email?: string;
	name?: string;
	picture?: string;
	expiresAt: number;
	usedAt?: number;
	createdAt: number;
}

interface LinkIntentSnapshot {
	intents: OAuthLinkIntentRecord[];
}

export interface OAuthLinkIntentStore {
	create(input: {
		userId: string;
		provider: Exclude<AuthIdentityProvider, "local">;
		providerUserId: string;
		email?: string;
		name?: string;
		picture?: string;
		ttlMs?: number;
		now?: number;
	}): Promise<{ token: string; intent: OAuthLinkIntentRecord }>;
	find(token: string, now?: number): Promise<OAuthLinkIntentRecord | null>;
	consume(token: string, now?: number): Promise<OAuthLinkIntentRecord | null>;
}

interface OAuthLinkIntentRow {
	id: string;
	user_id: string;
	provider: string;
	provider_user_id: string;
	token_hash: string;
	expires_at: Date | string;
	used_at?: Date | string | null;
	created_at: Date | string;
}

export class FileOAuthLinkIntentStore implements OAuthLinkIntentStore {
	constructor(private readonly persistPath = join(DATA_DIR, "oauth-link-intents.json")) {}

	async create(input: {
		userId: string;
		provider: Exclude<AuthIdentityProvider, "local">;
		providerUserId: string;
		email?: string;
		name?: string;
		picture?: string;
		ttlMs?: number;
		now?: number;
	}): Promise<{ token: string; intent: OAuthLinkIntentRecord }> {
		const now = input.now ?? Date.now();
		const token = `mews_link_${randomBytes(32).toString("base64url")}`;
		const intent: OAuthLinkIntentRecord = {
			id: uuid(),
			tokenHash: hashLinkIntentToken(token),
			userId: input.userId,
			provider: input.provider,
			providerUserId: input.providerUserId,
			email: input.email,
			name: input.name,
			picture: input.picture,
			createdAt: now,
			expiresAt: now + (input.ttlMs ?? 5 * 60 * 1000),
		};
		const snapshot = this.readSnapshot(now);
		snapshot.intents.push(intent);
		this.writeSnapshot(snapshot);
		return { token, intent };
	}

	async find(token: string, now = Date.now()): Promise<OAuthLinkIntentRecord | null> {
		const tokenHash = hashLinkIntentToken(token);
		const snapshot = this.readSnapshot(now);
		const intent = snapshot.intents.find((candidate) => candidate.tokenHash === tokenHash);
		if (!intent || intent.usedAt || intent.expiresAt <= now) return null;
		return intent;
	}

	async consume(token: string, now = Date.now()): Promise<OAuthLinkIntentRecord | null> {
		const tokenHash = hashLinkIntentToken(token);
		const snapshot = this.readSnapshot(now);
		const intent = snapshot.intents.find((candidate) => candidate.tokenHash === tokenHash);
		if (!intent || intent.usedAt || intent.expiresAt <= now) return null;
		intent.usedAt = now;
		this.writeSnapshot(snapshot);
		return intent;
	}

	private readSnapshot(now = Date.now()): LinkIntentSnapshot {
		if (!existsSync(this.persistPath)) return { intents: [] };
		try {
			const snapshot = readJsonFile<LinkIntentSnapshot>(this.persistPath);
			return {
				intents: Array.isArray(snapshot.intents)
					? snapshot.intents.filter((intent) => isIntentRecord(intent) && (!intent.usedAt || intent.expiresAt > now))
					: [],
			};
		} catch {
			return { intents: [] };
		}
	}

	private writeSnapshot(snapshot: LinkIntentSnapshot): void {
		mkdirSync(dirname(this.persistPath), { recursive: true });
		writeFileSync(this.persistPath, JSON.stringify(snapshot, null, 2));
	}
}

export class PostgresOAuthLinkIntentStore implements OAuthLinkIntentStore {
	private readonly client: AuthUserSqlClient;

	constructor(databaseUrlOrClient: string | AuthUserSqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new Error("PostgresOAuthLinkIntentStore requires DATABASE_URL");
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as AuthUserSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	async create(input: {
		userId: string;
		provider: Exclude<AuthIdentityProvider, "local">;
		providerUserId: string;
		email?: string;
		name?: string;
		picture?: string;
		ttlMs?: number;
		now?: number;
	}): Promise<{ token: string; intent: OAuthLinkIntentRecord }> {
		const now = input.now ?? Date.now();
		const token = `mews_link_${randomBytes(32).toString("base64url")}`;
		const intent: OAuthLinkIntentRecord = {
			id: uuid(),
			tokenHash: hashLinkIntentToken(token),
			userId: input.userId,
			provider: input.provider,
			providerUserId: input.providerUserId,
			email: input.email,
			name: input.name,
			picture: input.picture,
			createdAt: now,
			expiresAt: now + (input.ttlMs ?? 5 * 60 * 1000),
		};
		const rows = await this.client.unsafe<OAuthLinkIntentRow>(`
			INSERT INTO oauth_link_intent_tokens (
				id, user_id, provider, provider_user_id, token_hash, expires_at, created_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING id, user_id, provider, provider_user_id, token_hash, expires_at, used_at, created_at
		`, [
			intent.id,
			intent.userId,
			intent.provider,
			intent.providerUserId,
			intent.tokenHash,
			new Date(intent.expiresAt).toISOString(),
			new Date(intent.createdAt).toISOString(),
		]);
		const row = rows[0];
		if (!row) throw new Error("oauth_link_intent_tokens INSERT did not return a row");
		return { token, intent: mapIntentRow(row, intent) };
	}

	async find(token: string, now = Date.now()): Promise<OAuthLinkIntentRecord | null> {
		const rows = await this.client.unsafe<OAuthLinkIntentRow>(`
			SELECT id, user_id, provider, provider_user_id, token_hash, expires_at, used_at, created_at
			FROM oauth_link_intent_tokens
			WHERE token_hash = $1
				AND used_at IS NULL
				AND expires_at > $2
			LIMIT 1
		`, [hashLinkIntentToken(token), new Date(now).toISOString()]);
		return rows[0] ? mapIntentRow(rows[0]) : null;
	}

	async consume(token: string, now = Date.now()): Promise<OAuthLinkIntentRecord | null> {
		const rows = await this.client.unsafe<OAuthLinkIntentRow>(`
			UPDATE oauth_link_intent_tokens
			SET used_at = $2
			WHERE token_hash = $1
				AND used_at IS NULL
				AND expires_at > $2
			RETURNING id, user_id, provider, provider_user_id, token_hash, expires_at, used_at, created_at
		`, [hashLinkIntentToken(token), new Date(now).toISOString()]);
		return rows[0] ? mapIntentRow(rows[0]) : null;
	}
}

export function createOAuthLinkIntentStore(): OAuthLinkIntentStore {
	if (serverConfig.authUserStore === "postgres") {
		return new PostgresOAuthLinkIntentStore();
	}
	return new FileOAuthLinkIntentStore();
}

export const oauthLinkIntentStore = createOAuthLinkIntentStore();

export function hashLinkIntentToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function isIntentRecord(value: unknown): value is OAuthLinkIntentRecord {
	const record = value as Partial<OAuthLinkIntentRecord>;
	return Boolean(
		record
		&& typeof record.id === "string"
		&& typeof record.tokenHash === "string"
		&& typeof record.userId === "string"
		&& typeof record.provider === "string"
		&& typeof record.providerUserId === "string"
		&& typeof record.expiresAt === "number"
		&& typeof record.createdAt === "number",
	);
}

function mapIntentRow(row: OAuthLinkIntentRow, fallback?: Partial<OAuthLinkIntentRecord>): OAuthLinkIntentRecord {
	return {
		id: row.id,
		tokenHash: row.token_hash,
		userId: row.user_id,
		provider: row.provider as Exclude<AuthIdentityProvider, "local">,
		providerUserId: row.provider_user_id,
		email: fallback?.email,
		name: fallback?.name,
		picture: fallback?.picture,
		expiresAt: toTime(row.expires_at),
		usedAt: row.used_at ? toTime(row.used_at) : undefined,
		createdAt: toTime(row.created_at),
	};
}

function toTime(value: Date | string): number {
	return value instanceof Date ? value.getTime() : Date.parse(value);
}
