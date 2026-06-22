// Notification preferences — per-user, per-(type × channel) opt-out store.
//
// Pairs with migration 0054. The model is SPARSE / opt-out: a stored row only
// exists when a user has explicitly overridden a default. For any (type,
// channel) without a row, the effective value comes from
// DEFAULT_CHANNEL_PREFS below. This keeps the table tiny (one row per explicit
// change, not user × type × channel) and means a freshly-registered user gets
// sensible defaults with zero rows written.
//
// Layered shape mirrors notifications.ts / billing-store.ts:
//   - `NotificationPreferenceStore` is the storage interface.
//   - `FileNotificationPreferenceStore` is the JSON-snapshot store for tests +
//     the file/prototype runtime.
//   - `PostgresNotificationPreferenceStore` is the production path against the
//     0054 `notification_preferences` table.
//   - `createNotificationPreferenceStore()` picks one, reusing the same
//     file|postgres gating signal as the notification store.
//
// The taxonomy (NOTIFICATION_TYPES) is single-sourced from notifications.ts so
// adding a notification type there automatically flows here.

import { getSharedBunSql } from "./sql-pool.js";
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from "fs";
import { randomUUID } from "crypto";
import { dirname, join } from "path";
import { DATA_DIR, serverConfig } from "../config.js";
import { readJsonFile } from "../utils/json-file.js";
import { NOTIFICATION_TYPES, isNotificationType, type NotificationType } from "./notifications.js";

/** The two delivery channels every notification type can flow through. */
export const NOTIFICATION_CHANNELS = ["email", "in_app"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export function isNotificationChannel(value: unknown): value is NotificationChannel {
	return typeof value === "string" && (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

export interface ChannelPrefs {
	email: boolean;
	in_app: boolean;
}

/**
 * Coded defaults for every (type × channel). in_app is on for everything (the
 * bell/panel is cheap and expected). email defaults are deliberately
 * conservative: ON for the high-signal transactional types (billing, quota,
 * payment, invites, support tickets, work/task assignment) and OFF for the
 * noisy in-product chatter (comments, AI job churn, per-chapter workflow pings)
 * that would otherwise spam inboxes. A user can always flip any cell via the
 * preferences API / settings UI.
 */
export const DEFAULT_CHANNEL_PREFS: Record<NotificationType, ChannelPrefs> = {
	// In-product chatter — in-app only by default.
	comment_new: { email: false, in_app: true },
	comment_reply: { email: false, in_app: true },
	ai_job_complete: { email: false, in_app: true },
	ai_job_failed: { email: false, in_app: true },
	chapter_submitted: { email: false, in_app: true },
	chapter_approved: { email: false, in_app: true },
	chapter_rejected: { email: false, in_app: true },
	// Work assignment — high signal, email by default.
	task_assigned: { email: true, in_app: true },
	work_assigned: { email: true, in_app: true },
	// Review cancelled — the assignee may already be working; always email + in-app.
	review_cancelled: { email: true, in_app: true },
	// Revision sent back — the worker must fix it; high signal, always email + in-app.
	revision_requested: { email: true, in_app: true },
	// Editing taken over — data-safety notice (your page is now edited by someone
	// else; your unsaved work is a recovery draft). In-app is mandatory at the call
	// site; keep email off — it's an in-the-moment workspace event, not an inbox one.
	editing_taken_over: { email: false, in_app: true },
	// System / membership.
	invite_received: { email: true, in_app: true },
	team_member_joined: { email: false, in_app: true },
	// Billing / quota — always worth an email.
	quota_warning_80pct: { email: true, in_app: true },
	quota_frozen: { email: true, in_app: true },
	payment_succeeded: { email: true, in_app: true },
	payment_failed: { email: true, in_app: true },
	// Support tickets — the user is waiting on a reply, email by default.
	ticket_opened: { email: true, in_app: true },
	ticket_replied: { email: true, in_app: true },
	ticket_escalated: { email: true, in_app: true },
	ticket_resolved: { email: true, in_app: true },
	// Data export ready — the user explicitly requested it and is waiting for a
	// (time-limited) download link; deliver email + in-app by default.
	account_export_ready: { email: true, in_app: true },
};

/** Coded default for one (type, channel). Falls back to in_app-on / email-off. */
export function defaultPreference(type: NotificationType, channel: NotificationChannel): boolean {
	const prefs = DEFAULT_CHANNEL_PREFS[type];
	if (!prefs) return channel === "in_app";
	return prefs[channel];
}

/** A single explicit override row. */
export interface NotificationPreferenceUpdate {
	type: NotificationType;
	channel: NotificationChannel;
	enabled: boolean;
}

/**
 * The effective matrix returned to the API/UI: the merged view of coded
 * defaults + stored overrides. `values[type][channel]` is the effective
 * boolean; `defaults[type][channel]` is the coded default (so the UI can show
 * "back to default" affordances).
 */
export interface EffectivePreferences {
	types: readonly NotificationType[];
	channels: readonly NotificationChannel[];
	values: Record<NotificationType, ChannelPrefs>;
	defaults: Record<NotificationType, ChannelPrefs>;
}

export class NotificationPreferenceStoreError extends Error {
	constructor(message: string, readonly code = "notification_preference_store_error") {
		super(message);
		this.name = "NotificationPreferenceStoreError";
	}
}

export interface NotificationPreferenceStore {
	/** Effective (defaults merged with overrides) matrix for one user. */
	getForUser(userId: string): Promise<EffectivePreferences>;
	/** Is delivery on this channel enabled for this user+type? (Hot path for notify().) */
	isEnabled(userId: string, type: NotificationType, channel: NotificationChannel): Promise<boolean>;
	/** Upsert a batch of explicit overrides. Returns the number of rows written. */
	setMany(userId: string, updates: NotificationPreferenceUpdate[]): Promise<number>;
}

/** Validate + normalise an update batch, throwing a typed error on bad input. */
function normalizeUpdates(updates: NotificationPreferenceUpdate[]): NotificationPreferenceUpdate[] {
	if (!Array.isArray(updates)) {
		throw new NotificationPreferenceStoreError("updates must be an array", "notification_preference_invalid_updates");
	}
	return updates.map((update) => {
		if (!isNotificationType(update?.type)) {
			throw new NotificationPreferenceStoreError(
				`Unknown notification type '${String(update?.type)}'`,
				"notification_preference_unknown_type",
			);
		}
		if (!isNotificationChannel(update?.channel)) {
			throw new NotificationPreferenceStoreError(
				`Unknown channel '${String(update?.channel)}'`,
				"notification_preference_unknown_channel",
			);
		}
		if (typeof update.enabled !== "boolean") {
			throw new NotificationPreferenceStoreError("enabled must be a boolean", "notification_preference_invalid_enabled");
		}
		return { type: update.type, channel: update.channel, enabled: update.enabled };
	});
}

function emptyMatrix(): Record<NotificationType, ChannelPrefs> {
	const out = {} as Record<NotificationType, ChannelPrefs>;
	for (const type of NOTIFICATION_TYPES) {
		out[type] = { email: defaultPreference(type, "email"), in_app: defaultPreference(type, "in_app") };
	}
	return out;
}

function clonedDefaults(): Record<NotificationType, ChannelPrefs> {
	const out = {} as Record<NotificationType, ChannelPrefs>;
	for (const type of NOTIFICATION_TYPES) {
		out[type] = { email: DEFAULT_CHANNEL_PREFS[type].email, in_app: DEFAULT_CHANNEL_PREFS[type].in_app };
	}
	return out;
}

/** Build the effective matrix from a map of override rows keyed `type::channel`. */
function buildEffective(overrides: Map<string, boolean>): EffectivePreferences {
	const values = emptyMatrix();
	for (const [key, enabled] of overrides) {
		const [type, channel] = key.split("::");
		if (isNotificationType(type) && isNotificationChannel(channel)) {
			values[type][channel] = enabled;
		}
	}
	return {
		types: NOTIFICATION_TYPES,
		channels: NOTIFICATION_CHANNELS,
		values,
		defaults: clonedDefaults(),
	};
}

function overrideKey(type: NotificationType, channel: NotificationChannel): string {
	return `${type}::${channel}`;
}

interface PreferenceSnapshotRow {
	userId: string;
	type: string;
	channel: string;
	enabled: boolean;
}

/**
 * In-memory preference store with optional JSON snapshot persistence. Stores
 * only explicit overrides (sparse), exactly like the Postgres table.
 */
export class FileNotificationPreferenceStore implements NotificationPreferenceStore {
	/** userId -> (type::channel -> enabled). Only explicit overrides are stored. */
	private readonly overrides = new Map<string, Map<string, boolean>>();

	constructor(private readonly persistPath?: string) {
		this.load();
	}

	async getForUser(userId: string): Promise<EffectivePreferences> {
		const normalized = userId.trim();
		const userOverrides = this.overrides.get(normalized) ?? new Map<string, boolean>();
		return buildEffective(userOverrides);
	}

	async isEnabled(userId: string, type: NotificationType, channel: NotificationChannel): Promise<boolean> {
		const normalized = userId.trim();
		const userOverrides = this.overrides.get(normalized);
		const stored = userOverrides?.get(overrideKey(type, channel));
		if (stored === undefined) return defaultPreference(type, channel);
		return stored;
	}

	async setMany(userId: string, updates: NotificationPreferenceUpdate[]): Promise<number> {
		const normalized = userId.trim();
		if (!normalized) {
			throw new NotificationPreferenceStoreError("userId is required", "notification_preference_invalid_user");
		}
		const normalizedUpdates = normalizeUpdates(updates);
		if (normalizedUpdates.length === 0) return 0;

		// Snapshot for rollback if persistence fails.
		const previous = this.overrides.get(normalized);
		const snapshot = previous ? new Map(previous) : null;

		const target = previous ?? new Map<string, boolean>();
		for (const update of normalizedUpdates) {
			target.set(overrideKey(update.type, update.channel), update.enabled);
		}
		this.overrides.set(normalized, target);

		try {
			this.persist();
		} catch (error) {
			if (snapshot) {
				this.overrides.set(normalized, snapshot);
			} else {
				this.overrides.delete(normalized);
			}
			throw error;
		}
		return normalizedUpdates.length;
	}

	private load(): void {
		if (!this.persistPath || !existsSync(this.persistPath)) return;
		try {
			const snapshot = readJsonFile<{ preferences?: PreferenceSnapshotRow[] }>(this.persistPath);
			if (Array.isArray(snapshot.preferences)) {
				for (const row of snapshot.preferences) {
					if (
						row
						&& typeof row.userId === "string"
						&& isNotificationType(row.type)
						&& isNotificationChannel(row.channel)
						&& typeof row.enabled === "boolean"
					) {
						const userOverrides = this.overrides.get(row.userId) ?? new Map<string, boolean>();
						userOverrides.set(overrideKey(row.type, row.channel), row.enabled);
						this.overrides.set(row.userId, userOverrides);
					}
				}
			}
		} catch (error) {
			console.warn(`[NotificationPreferenceStore] Failed to load ${this.persistPath}: ${error}`);
		}
	}

	private persist(): void {
		if (!this.persistPath) return;
		const rows: PreferenceSnapshotRow[] = [];
		for (const [userId, userOverrides] of this.overrides) {
			for (const [key, enabled] of userOverrides) {
				const [type, channel] = key.split("::");
				if (isNotificationType(type) && isNotificationChannel(channel)) {
					rows.push({ userId, type, channel, enabled });
				}
			}
		}
		mkdirSync(dirname(this.persistPath), { recursive: true });
		const tmpPath = `${this.persistPath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(tmpPath, JSON.stringify({ preferences: rows }, null, 2));
			renameSync(tmpPath, this.persistPath);
		} catch (error) {
			try {
				rmSync(tmpPath, { force: true });
			} catch {
				// best effort cleanup
			}
			throw error;
		}
	}
}

interface PreferenceSqlClient {
	unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	begin?<T>(fn: (transaction: PreferenceSqlClient) => Promise<T>): Promise<T>;
	close?(): Promise<void> | void;
}

interface PreferenceRow {
	notification_type: string;
	channel: string;
	enabled: boolean | string;
}

function rowEnabled(value: boolean | string): boolean {
	return value === true || value === "t" || value === "true" || value === 1;
}

/** Postgres-backed preference store against the 0054 `notification_preferences` table. */
export class PostgresNotificationPreferenceStore implements NotificationPreferenceStore {
	private readonly client: PreferenceSqlClient;

	constructor(databaseUrlOrClient: string | PreferenceSqlClient = process.env.DATABASE_URL ?? "") {
		if (typeof databaseUrlOrClient === "string") {
			if (!databaseUrlOrClient.trim()) {
				throw new NotificationPreferenceStoreError(
					"NOTIFICATIONS_STORE=postgres requires DATABASE_URL",
					"notification_preference_store_unconfigured",
				);
			}
			this.client = getSharedBunSql(databaseUrlOrClient) as unknown as PreferenceSqlClient;
		} else {
			this.client = databaseUrlOrClient;
		}
	}

	async getForUser(userId: string): Promise<EffectivePreferences> {
		const normalized = userId.trim();
		const overrides = new Map<string, boolean>();
		if (!normalized) return buildEffective(overrides);
		const rows = await this.client.unsafe<PreferenceRow>(
			`SELECT notification_type, channel, enabled FROM notification_preferences WHERE user_id = $1`,
			[normalized],
		);
		for (const row of rows) {
			if (isNotificationType(row.notification_type) && isNotificationChannel(row.channel)) {
				overrides.set(overrideKey(row.notification_type, row.channel), rowEnabled(row.enabled));
			}
		}
		return buildEffective(overrides);
	}

	async isEnabled(userId: string, type: NotificationType, channel: NotificationChannel): Promise<boolean> {
		const normalized = userId.trim();
		if (!normalized) return defaultPreference(type, channel);
		const rows = await this.client.unsafe<PreferenceRow>(
			`SELECT enabled FROM notification_preferences WHERE user_id = $1 AND notification_type = $2 AND channel = $3`,
			[normalized, type, channel],
		);
		const row = rows[0];
		if (!row) return defaultPreference(type, channel);
		return rowEnabled(row.enabled);
	}

	async setMany(userId: string, updates: NotificationPreferenceUpdate[]): Promise<number> {
		const normalized = userId.trim();
		if (!normalized) {
			throw new NotificationPreferenceStoreError("userId is required", "notification_preference_invalid_user");
		}
		const normalizedUpdates = normalizeUpdates(updates);
		if (normalizedUpdates.length === 0) return 0;

		const execute = async (tx: PreferenceSqlClient) => {
			for (const update of normalizedUpdates) {
				await tx.unsafe(
					`INSERT INTO notification_preferences (user_id, notification_type, channel, enabled, updated_at)
					 VALUES ($1, $2, $3, $4, now())
					 ON CONFLICT (user_id, notification_type, channel)
					 DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
					[normalized, update.type, update.channel, update.enabled],
				);
			}
			return normalizedUpdates.length;
		};

		if (this.client.begin) {
			return this.client.begin(execute);
		}

		await this.client.unsafe("BEGIN");
		try {
			const result = await execute(this.client);
			await this.client.unsafe("COMMIT");
			return result;
		} catch (error) {
			await this.client.unsafe("ROLLBACK");
			throw error;
		}
	}
}

/**
 * Resolve which backing store to use — mirror the notification store's gating
 * so prefs and notifications always land in the same place (file vs postgres).
 */
function resolveStoreMode(): "file" | "postgres" {
	const override = process.env.NOTIFICATIONS_STORE?.trim().toLowerCase();
	if (override === "postgres") return "postgres";
	if (override === "file") return "file";
	return serverConfig.billingStore === "postgres" ? "postgres" : "file";
}

export function createNotificationPreferenceStore(): NotificationPreferenceStore {
	if (resolveStoreMode() === "postgres") {
		return new PostgresNotificationPreferenceStore();
	}
	return new FileNotificationPreferenceStore(join(DATA_DIR, "notification-preferences.json"));
}

export const notificationPreferenceStore: NotificationPreferenceStore = createNotificationPreferenceStore();
