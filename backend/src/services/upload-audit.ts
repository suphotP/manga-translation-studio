import { getSharedBunSql } from "./sql-pool.js";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { v4 as uuid } from "uuid";
import { DATA_DIR, serverConfig } from "../config.js";
import type { AssetActor } from "../types/index.js";
import { readJsonFile } from "../utils/json-file.js";

export interface UploadAuditEvent {
	auditId: string;
	projectId: string;
	imageId: string;
	originalName: string;
	mimeType: string;
	sizeBytes: number;
	sha256: string;
	storageDriver: string;
	storageKey: string;
	width: number;
	height: number;
	actor: AssetActor;
	ip?: string;
	userAgent?: string;
	createdAt: string;
	metadata?: Record<string, unknown>;
}

interface UploadAuditSnapshot {
	events: UploadAuditEvent[];
}

export interface UploadAuditListOptions {
	limit?: number;
	cursor?: string;
	source?: AssetActor["source"];
	actorUserId?: string;
	imageId?: string;
}

export interface UploadAuditEventPage {
	events: UploadAuditEvent[];
	nextCursor?: string;
}

export interface UploadAuditStore {
	append(input: Omit<UploadAuditEvent, "auditId" | "createdAt">): Promise<UploadAuditEvent>;
	deleteProjectImageEvent(projectId: string, imageId: string): Promise<boolean>;
	listProjectEvents(projectId: string, options?: UploadAuditListOptions): Promise<UploadAuditEvent[]>;
	listProjectEventPage(projectId: string, options?: UploadAuditListOptions): Promise<UploadAuditEventPage>;
}

interface AuditSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	close?(): Promise<void> | void;
}

export class FileUploadAuditStore implements UploadAuditStore {
	private readonly events: UploadAuditEvent[] = [];

	constructor(private readonly persistPath: string) {
		this.load();
	}

	async append(input: Omit<UploadAuditEvent, "auditId" | "createdAt">): Promise<UploadAuditEvent> {
		const previousEvents = [...this.events];
		const event: UploadAuditEvent = {
			...input,
			auditId: uuid(),
			createdAt: new Date().toISOString(),
		};
		this.events.push(event);
		try {
			this.persist();
		} catch (error) {
			this.events.splice(0, this.events.length, ...previousEvents);
			throw error;
		}
		return event;
	}

	async deleteProjectImageEvent(projectId: string, imageId: string): Promise<boolean> {
		const previousEvents = [...this.events];
		const originalLength = this.events.length;
		for (let index = this.events.length - 1; index >= 0; index--) {
			const event = this.events[index];
			if (event && event.projectId === projectId && event.imageId === imageId) {
				this.events.splice(index, 1);
			}
		}
		const deleted = this.events.length !== originalLength;
		if (deleted) {
			try {
				this.persist();
			} catch (error) {
				this.events.splice(0, this.events.length, ...previousEvents);
				throw error;
			}
		}
		return deleted;
	}

	async listProjectEvents(projectId: string, options: UploadAuditListOptions = {}): Promise<UploadAuditEvent[]> {
		return (await this.listProjectEventPage(projectId, options)).events;
	}

	async listProjectEventPage(projectId: string, options: UploadAuditListOptions = {}): Promise<UploadAuditEventPage> {
		const limit = normalizeAuditLimit(options.limit);
		const cursor = decodeUploadAuditCursor(options.cursor);
		const sorted = this.events
			.filter((event) => event.projectId === projectId)
			.filter((event) => !options.source || event.actor?.source === options.source)
			.filter((event) => !options.actorUserId || event.actor?.userId === options.actorUserId)
			.filter((event) => !options.imageId || event.imageId === options.imageId)
			.sort(compareUploadAuditEventOrder);
		const filtered = cursor ? sorted.filter((event) => uploadAuditEventSortsAfterCursor(event, cursor)) : sorted;
		const events = filtered.slice(0, limit);
		const lastEvent = events[events.length - 1];
		return {
			events,
			nextCursor: filtered.length > limit && lastEvent ? encodeUploadAuditCursor(lastEvent) : undefined,
		};
	}

	private load(): void {
		if (!existsSync(this.persistPath)) return;
		try {
			const snapshot = readJsonFile<UploadAuditSnapshot>(this.persistPath);
			if (Array.isArray(snapshot.events)) {
				this.events.splice(0, this.events.length, ...snapshot.events.filter(isUploadAuditEvent));
			}
		} catch (error) {
			console.warn(`[UploadAudit] Failed to load ${this.persistPath}: ${error}`);
		}
	}

	private persist(): void {
		mkdirSync(dirname(this.persistPath), { recursive: true });
		writeFileSync(this.persistPath, JSON.stringify({ events: this.events }, null, 2));
	}
}

export class PostgresUploadAuditStore implements UploadAuditStore {
	private readonly client: AuditSqlClient;

	constructor(databaseUrl = process.env.DATABASE_URL) {
		if (!databaseUrl?.trim()) {
			throw new Error("UPLOAD_AUDIT_STORE=postgres requires DATABASE_URL");
		}
		this.client = getSharedBunSql(databaseUrl) as unknown as AuditSqlClient;
	}

	async append(input: Omit<UploadAuditEvent, "auditId" | "createdAt">): Promise<UploadAuditEvent> {
		const event: UploadAuditEvent = {
			...input,
			auditId: uuid(),
			createdAt: new Date().toISOString(),
			metadata: {
				...input.metadata,
				actor: input.actor,
			},
		};
		await this.client.unsafe(`
			INSERT INTO upload_audit_events (
				audit_id,
				project_id,
				asset_id,
				image_id,
				actor_user_id,
				actor_source,
				original_name,
				mime_type,
				size_bytes,
				sha256,
				storage_driver,
				storage_key,
				width,
				height,
				ip,
				user_agent,
				metadata,
				created_at
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::text::jsonb, $18)
		`, [
			event.auditId,
			event.projectId,
			event.imageId,
			event.imageId,
			event.actor.userId ?? null,
			event.actor.source,
			event.originalName,
			event.mimeType,
			event.sizeBytes,
			event.sha256,
			event.storageDriver,
			event.storageKey,
			event.width,
			event.height,
			event.ip ?? null,
			event.userAgent ?? null,
			JSON.stringify(event.metadata ?? {}),
			event.createdAt,
		]);
		return event;
	}

	async deleteProjectImageEvent(projectId: string, imageId: string): Promise<boolean> {
		const rows = await this.client.unsafe<{ audit_id: string }>(`
			DELETE FROM upload_audit_events
			WHERE project_id = $1 AND image_id = $2
			RETURNING audit_id
		`, [projectId, imageId]);
		return rows.length > 0;
	}

	async listProjectEvents(projectId: string, options: UploadAuditListOptions = {}): Promise<UploadAuditEvent[]> {
		return (await this.listProjectEventPage(projectId, options)).events;
	}

	async listProjectEventPage(projectId: string, options: UploadAuditListOptions = {}): Promise<UploadAuditEventPage> {
		const limit = normalizeAuditLimit(options.limit);
		const cursor = decodeUploadAuditCursor(options.cursor);
		const conditions = ["project_id = $1"];
		const params: unknown[] = [projectId];
		let nextParam = 2;
		if (options.source) {
			conditions.push(`actor_source = $${nextParam}`);
			params.push(options.source);
			nextParam += 1;
		}
		if (options.actorUserId) {
			conditions.push(`actor_user_id = $${nextParam}`);
			params.push(options.actorUserId);
			nextParam += 1;
		}
		if (options.imageId) {
			conditions.push(`image_id = $${nextParam}`);
			params.push(options.imageId);
			nextParam += 1;
		}
		if (cursor) {
			conditions.push(`(created_at < $${nextParam}::timestamptz OR (created_at = $${nextParam}::timestamptz AND audit_id < $${nextParam + 1}))`);
			params.push(cursor.createdAt, cursor.auditId);
			nextParam += 2;
		}
		params.push(limit + 1);
		const rows = await this.client.unsafe<UploadAuditRow>(`
			SELECT
				audit_id,
				project_id,
				image_id,
				actor_user_id,
				actor_source,
				original_name,
				mime_type,
				size_bytes,
				sha256,
				storage_driver,
				storage_key,
				width,
				height,
				ip,
				user_agent,
				metadata,
				created_at
			FROM upload_audit_events
			WHERE ${conditions.join(" AND ")}
			ORDER BY created_at DESC, audit_id DESC
			LIMIT $${nextParam}
		`, params);
		const events = rows.slice(0, limit).map(mapUploadAuditRow);
		const lastEvent = events[events.length - 1];
		return {
			events,
			nextCursor: rows.length > limit && lastEvent ? encodeUploadAuditCursor(lastEvent) : undefined,
		};
	}
}

interface UploadAuditRow {
	audit_id: string;
	project_id: string;
	image_id: string;
	actor_user_id?: string | null;
	actor_source: AssetActor["source"];
	original_name: string;
	mime_type: string;
	size_bytes: number | string;
	sha256: string;
	storage_driver: string;
	storage_key: string;
	width?: number | string | null;
	height?: number | string | null;
	ip?: string | null;
	user_agent?: string | null;
	metadata?: unknown;
	created_at: Date | string;
}

function createUploadAuditStore(): UploadAuditStore {
	if (serverConfig.uploadAuditStore === "postgres") {
		return new PostgresUploadAuditStore();
	}
	return new FileUploadAuditStore(join(DATA_DIR, "upload-audit.json"));
}

export const uploadAuditStore = createUploadAuditStore();

function normalizeAuditLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return 100;
	return Math.max(1, Math.min(500, Math.trunc(limit)));
}

interface UploadAuditCursor {
	createdAt: string;
	auditId: string;
}

export function isValidUploadAuditCursor(cursor: string | undefined): boolean {
	if (!cursor?.trim()) return true;
	return decodeUploadAuditCursor(cursor) !== null;
}

function encodeUploadAuditCursor(event: UploadAuditEvent): string {
	return Buffer.from(JSON.stringify({
		createdAt: event.createdAt,
		auditId: event.auditId,
	}), "utf8").toString("base64url");
}

function decodeUploadAuditCursor(cursor: string | undefined): UploadAuditCursor | null {
	if (!cursor?.trim()) return null;
	if (cursor.length > 500) return null;
	try {
		const decoded = JSON.parse(Buffer.from(cursor.trim(), "base64url").toString("utf8")) as Partial<UploadAuditCursor>;
		if (typeof decoded.createdAt !== "string" || typeof decoded.auditId !== "string") return null;
		if (Number.isNaN(new Date(decoded.createdAt).getTime()) || !decoded.auditId.trim()) return null;
		return {
			createdAt: decoded.createdAt,
			auditId: decoded.auditId,
		};
	} catch {
		return null;
	}
}

function uploadAuditEventSortsAfterCursor(event: UploadAuditEvent, cursor: UploadAuditCursor): boolean {
	return event.createdAt < cursor.createdAt
		|| (event.createdAt === cursor.createdAt && event.auditId < cursor.auditId);
}

function compareUploadAuditEventOrder(a: UploadAuditEvent, b: UploadAuditEvent): number {
	return b.createdAt.localeCompare(a.createdAt) || b.auditId.localeCompare(a.auditId);
}

function mapUploadAuditRow(row: UploadAuditRow): UploadAuditEvent {
	const metadata = normalizeMetadata(row.metadata);
	return {
		auditId: row.audit_id,
		projectId: row.project_id,
		imageId: row.image_id,
		originalName: row.original_name,
		mimeType: row.mime_type,
		sizeBytes: Number(row.size_bytes),
		sha256: row.sha256,
		storageDriver: row.storage_driver,
		storageKey: row.storage_key,
		width: Number(row.width ?? 0),
		height: Number(row.height ?? 0),
		actor: normalizeActor(metadata.actor, row.actor_source, row.actor_user_id ?? undefined),
		ip: row.ip ?? undefined,
		userAgent: row.user_agent ?? undefined,
		createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
		metadata,
	};
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
	if (typeof value === "string") {
		try {
			return normalizeMetadata(JSON.parse(value));
		} catch {
			return {};
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function normalizeActor(value: unknown, source: AssetActor["source"], userId?: string): AssetActor {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const actor = value as Partial<AssetActor>;
		return {
			source,
			userId: typeof actor.userId === "string" ? actor.userId : userId,
			email: typeof actor.email === "string" ? actor.email : undefined,
			role: typeof actor.role === "string" ? actor.role : undefined,
			name: typeof actor.name === "string" ? actor.name : undefined,
		};
	}
	return { source, userId };
}

function isUploadAuditEvent(value: unknown): value is UploadAuditEvent {
	const event = value as Partial<UploadAuditEvent>;
	return Boolean(
		event
		&& typeof event.auditId === "string"
		&& typeof event.projectId === "string"
		&& typeof event.imageId === "string"
		&& typeof event.sha256 === "string"
		&& typeof event.storageKey === "string"
		&& typeof event.createdAt === "string",
	);
}
