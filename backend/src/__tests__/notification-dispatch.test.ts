import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	DEFAULT_CHANNEL_PREFS,
	FileNotificationPreferenceStore,
	NotificationPreferenceStoreError,
	defaultPreference,
	type NotificationPreferenceStore,
} from "../services/notification-preferences.js";
import { FileNotificationStore, NOTIFICATION_TYPES } from "../services/notifications.js";
import { notify } from "../services/notification-dispatch.js";
import type { SendResult } from "../services/mailer.js";

const tempDirs: string[] = [];

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "manga-notif-dispatch-"));
	tempDirs.push(dir);
	return dir;
}

function freshStores(): {
	notifications: FileNotificationStore;
	preferences: FileNotificationPreferenceStore;
} {
	const dir = tmp();
	return {
		notifications: new FileNotificationStore(join(dir, "notifications.json")),
		preferences: new FileNotificationPreferenceStore(join(dir, "notification-preferences.json")),
	};
}

const sentEmails: Array<{ template: string; data: any; locale: string }> = [];
function recordingSendEmail(): typeof import("../services/mailer.js").sendTransactionalEmail {
	return (async (template: string, data: unknown, locale = "en") => {
		sentEmails.push({ template, data, locale });
		return {
			success: true,
			provider: "null",
			status: "sent",
			messageId: "test",
			retryable: false,
		} as SendResult;
	}) as never;
}

afterEach(() => {
	sentEmails.length = 0;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("DEFAULT_CHANNEL_PREFS", () => {
	test("covers every notification type", () => {
		for (const type of NOTIFICATION_TYPES) {
			expect(DEFAULT_CHANNEL_PREFS[type]).toBeDefined();
			expect(typeof DEFAULT_CHANNEL_PREFS[type].email).toBe("boolean");
			expect(typeof DEFAULT_CHANNEL_PREFS[type].in_app).toBe("boolean");
		}
	});

	test("in_app defaults on for all types (opt-out model)", () => {
		for (const type of NOTIFICATION_TYPES) {
			expect(defaultPreference(type, "in_app")).toBe(true);
		}
	});
});

describe("notify() honors preferences", () => {
	test("default-on for an absent pref writes in_app and emails (when email default-on)", async () => {
		const { notifications, preferences } = freshStores();
		const result = await notify(
			{ userId: "u1", email: "u1@example.com", type: "ticket_replied", title: "Reply", body: "We replied" },
			{ notificationStore: notifications, preferenceStore: preferences, sendEmail: recordingSendEmail() },
		);
		expect(result.inAppDelivered).toBe(true);
		expect(result.emailAttempted).toBe(true);
		expect(sentEmails).toHaveLength(1);
		const page = await notifications.listForUser("u1");
		expect(page.items).toHaveLength(1);
		expect(page.items[0]?.type).toBe("ticket_replied");
	});

	test("disabled in_app pref => no in-app row, email still fires", async () => {
		const { notifications, preferences } = freshStores();
		await preferences.setMany("u1", [{ type: "ticket_replied", channel: "in_app", enabled: false }]);
		const result = await notify(
			{ userId: "u1", email: "u1@example.com", type: "ticket_replied", title: "Reply" },
			{ notificationStore: notifications, preferenceStore: preferences, sendEmail: recordingSendEmail() },
		);
		expect(result.inAppDelivered).toBe(false);
		expect(result.skipped).toContainEqual({ channel: "in_app", reason: "disabled_by_pref" });
		expect(result.emailAttempted).toBe(true);
		const page = await notifications.listForUser("u1");
		expect(page.items).toHaveLength(0);
	});

	test("disabled email pref => no email, in_app still written", async () => {
		const { notifications, preferences } = freshStores();
		await preferences.setMany("u1", [{ type: "ticket_replied", channel: "email", enabled: false }]);
		const result = await notify(
			{ userId: "u1", email: "u1@example.com", type: "ticket_replied", title: "Reply" },
			{ notificationStore: notifications, preferenceStore: preferences, sendEmail: recordingSendEmail() },
		);
		expect(result.emailAttempted).toBe(false);
		expect(result.skipped).toContainEqual({ channel: "email", reason: "disabled_by_pref" });
		expect(result.inAppDelivered).toBe(true);
		expect(sentEmails).toHaveLength(0);
	});

	test("a type whose email defaults OFF (comment_new) does not email", async () => {
		const { notifications, preferences } = freshStores();
		const result = await notify(
			{ userId: "u1", email: "u1@example.com", type: "comment_new", title: "New comment" },
			{ notificationStore: notifications, preferenceStore: preferences, sendEmail: recordingSendEmail() },
		);
		expect(result.inAppDelivered).toBe(true);
		expect(result.emailAttempted).toBe(false);
		expect(sentEmails).toHaveLength(0);
	});

	test("no recipient email => email channel skipped with no_recipient", async () => {
		const { notifications, preferences } = freshStores();
		const result = await notify(
			{ userId: "u1", type: "ticket_replied", title: "Reply" },
			{
				notificationStore: notifications,
				preferenceStore: preferences,
				sendEmail: recordingSendEmail(),
				// An unknown user => the dispatcher can't resolve an email; gracefully skip.
				userStore: { async load() { return null; } },
			},
		);
		expect(result.emailAttempted).toBe(false);
		expect(result.skipped).toContainEqual({ channel: "email", reason: "no_recipient" });
		expect(result.inAppDelivered).toBe(true);
	});

	test("channels filter restricts which channels fire (still pref-gated)", async () => {
		const { notifications, preferences } = freshStores();
		const result = await notify(
			{ userId: "u1", email: "u1@example.com", type: "ticket_replied", title: "Reply", channels: ["in_app"] },
			{ notificationStore: notifications, preferenceStore: preferences, sendEmail: recordingSendEmail() },
		);
		expect(result.inAppDelivered).toBe(true);
		expect(result.emailAttempted).toBe(false);
		expect(result.skipped).toContainEqual({ channel: "email", reason: "not_requested" });
	});

	test("missing userId is a no-op", async () => {
		const { notifications, preferences } = freshStores();
		const result = await notify(
			{ userId: "  ", email: "u1@example.com", type: "ticket_replied", title: "Reply" },
			{ notificationStore: notifications, preferenceStore: preferences, sendEmail: recordingSendEmail() },
		);
		expect(result.inAppDelivered).toBe(false);
		expect(result.emailAttempted).toBe(false);
	});

	// P1-3: an EMAIL-ONLY invite (no userId, e.g. a pending chapter-team invite to an
	// address with no account yet) must STILL send the invite email — it was being
	// dropped by the early missing_user return.
	test("email-only INVITE (no userId) still sends the invite email", async () => {
		const { notifications, preferences } = freshStores();
		const result = await notify(
			{ userId: "", email: "pending-invitee@example.com", type: "invite_received", title: "You were invited", body: "Join the chapter", linkUrl: "/library" },
			{ notificationStore: notifications, preferenceStore: preferences, sendEmail: recordingSendEmail() },
		);
		// No in-app row (no user), but the email channel fired.
		expect(result.inAppDelivered).toBe(false);
		expect(result.emailAttempted).toBe(true);
		expect(sentEmails).toHaveLength(1);
		expect(sentEmails[0]?.data?.user?.email).toBe("pending-invitee@example.com");
	});

	test("email-only NON-invite type (no userId) is still dropped (no generic email sink)", async () => {
		const { notifications, preferences } = freshStores();
		const result = await notify(
			{ userId: "", email: "someone@example.com", type: "ticket_replied", title: "Reply" },
			{ notificationStore: notifications, preferenceStore: preferences, sendEmail: recordingSendEmail() },
		);
		expect(result.emailAttempted).toBe(false);
		expect(result.skipped).toContainEqual({ channel: "email", reason: "missing_user" });
		expect(sentEmails).toHaveLength(0);
	});

	test("email-only invite with an invalid email is dropped", async () => {
		const { notifications, preferences } = freshStores();
		const result = await notify(
			{ userId: "", email: "not-an-email", type: "invite_received", title: "You were invited" },
			{ notificationStore: notifications, preferenceStore: preferences, sendEmail: recordingSendEmail() },
		);
		expect(result.emailAttempted).toBe(false);
		expect(sentEmails).toHaveLength(0);
	});
});

// The original work_assigned bug: callers (e.g. work-states.ts) invoke
// notify({ userId, type, ... }) with NO email/name. The dispatcher must
// self-resolve the recipient from the user store so the default-ON email pref
// actually delivers — and must do so ONLY when email is going to fire, never
// redundantly when the caller already passed input.email.
describe("notify() resolves the recipient from the user store for userId-only calls", () => {
	/** Records every userStore.load() call so we can assert when a lookup happened. */
	function spyUserStore(record: Array<{ email?: string | null; name?: string | null } | null>) {
		const calls: string[] = [];
		const store = {
			calls,
			async load(userId: string) {
				calls.push(userId);
				return record.shift() ?? null;
			},
		};
		return store;
	}

	test("work_assigned with only {userId,type} => dispatcher resolves email and the email channel fires (pref on)", async () => {
		const { notifications, preferences } = freshStores();
		const userStore = spyUserStore([{ email: "assignee@example.com", name: "Assignee" }]);
		const result = await notify(
			{ userId: "assignee-1", type: "work_assigned", title: "You were assigned chapter work", linkUrl: "/projects/p1/work" },
			{ notificationStore: notifications, preferenceStore: preferences, sendEmail: recordingSendEmail(), userStore },
		);
		// in_app + email both default-ON for work_assigned
		expect(result.inAppDelivered).toBe(true);
		expect(result.emailAttempted).toBe(true);
		expect(userStore.calls).toEqual(["assignee-1"]);
		expect(sentEmails).toHaveLength(1);
		// resolved email + name flowed into the mailer payload
		expect(sentEmails[0]?.data.user).toEqual({ name: "Assignee", email: "assignee@example.com" });
	});

	test("email pref OFF => dispatcher skips email WITHOUT a recipient lookup (no throw)", async () => {
		const { notifications, preferences } = freshStores();
		await preferences.setMany("u1", [{ type: "work_assigned", channel: "email", enabled: false }]);
		const userStore = spyUserStore([{ email: "u1@example.com", name: "U1" }]);
		const result = await notify(
			{ userId: "u1", type: "work_assigned", title: "Assigned" },
			{ notificationStore: notifications, preferenceStore: preferences, sendEmail: recordingSendEmail(), userStore },
		);
		expect(result.emailAttempted).toBe(false);
		expect(result.skipped).toContainEqual({ channel: "email", reason: "disabled_by_pref" });
		// pref gate runs BEFORE the lookup, so the store was never consulted
		expect(userStore.calls).toEqual([]);
		expect(sentEmails).toHaveLength(0);
		// in_app still delivered
		expect(result.inAppDelivered).toBe(true);
	});

	test("recipient unresolvable (no email) => email skipped gracefully, no throw, in_app intact", async () => {
		const { notifications, preferences } = freshStores();
		// User exists but has no email on record.
		const userStore = spyUserStore([{ email: null, name: "Ghost" }]);
		const result = await notify(
			{ userId: "u1", type: "work_assigned", title: "Assigned" },
			{ notificationStore: notifications, preferenceStore: preferences, sendEmail: recordingSendEmail(), userStore },
		);
		expect(userStore.calls).toEqual(["u1"]);
		expect(result.emailAttempted).toBe(false);
		expect(result.skipped).toContainEqual({ channel: "email", reason: "no_recipient" });
		expect(result.inAppDelivered).toBe(true);
		expect(sentEmails).toHaveLength(0);
	});

	test("user store throw => email skipped gracefully (best-effort), in_app intact", async () => {
		const { notifications, preferences } = freshStores();
		const userStore = {
			async load(): Promise<{ email?: string | null } | null> {
				throw new Error("db down");
			},
		};
		const result = await notify(
			{ userId: "u1", type: "work_assigned", title: "Assigned" },
			{ notificationStore: notifications, preferenceStore: preferences, sendEmail: recordingSendEmail(), userStore },
		);
		expect(result.emailAttempted).toBe(false);
		expect(result.skipped).toContainEqual({ channel: "email", reason: "no_recipient" });
		expect(result.inAppDelivered).toBe(true);
	});

	test("explicit input.email wins => NO redundant store lookup", async () => {
		const { notifications, preferences } = freshStores();
		const userStore = spyUserStore([{ email: "should-not-be-used@example.com", name: "Nope" }]);
		const result = await notify(
			{ userId: "u1", email: "explicit@example.com", name: "Explicit", type: "work_assigned", title: "Assigned" },
			{ notificationStore: notifications, preferenceStore: preferences, sendEmail: recordingSendEmail(), userStore },
		);
		expect(result.emailAttempted).toBe(true);
		expect(userStore.calls).toEqual([]); // explicit recipient => no lookup
		expect(sentEmails[0]?.data.user).toEqual({ name: "Explicit", email: "explicit@example.com" });
	});

	test("email channel NOT requested => no recipient lookup at all", async () => {
		const { notifications, preferences } = freshStores();
		const userStore = spyUserStore([{ email: "u1@example.com", name: "U1" }]);
		const result = await notify(
			{ userId: "u1", type: "work_assigned", title: "Assigned", channels: ["in_app"] },
			{ notificationStore: notifications, preferenceStore: preferences, sendEmail: recordingSendEmail(), userStore },
		);
		expect(result.emailAttempted).toBe(false);
		expect(result.skipped).toContainEqual({ channel: "email", reason: "not_requested" });
		expect(userStore.calls).toEqual([]);
	});
});

describe("notify() email safety without a configured mailer", () => {
	test("uses the real mailer pipeline (null provider) without crashing and no RESEND key", async () => {
		// No RESEND_API_KEY / MAILER_PROVIDER=null in the test runtime => the real
		// sendTransactionalEmail resolves through NullMailer (logs, never throws).
		const prevKey = process.env.RESEND_API_KEY;
		const prevProvider = process.env.MAILER_PROVIDER;
		delete process.env.RESEND_API_KEY;
		process.env.MAILER_PROVIDER = "null";
		try {
			const { notifications, preferences } = freshStores();
			const result = await notify(
				{ userId: "u1", email: "u1@example.com", type: "ticket_replied", title: "Reply", linkUrl: "/tickets/1" },
				{ notificationStore: notifications, preferenceStore: preferences },
			);
			expect(result.emailAttempted).toBe(true);
			expect(result.emailResult?.success).toBe(true);
			expect(result.emailResult?.provider).toBe("null");
		} finally {
			if (prevKey === undefined) delete process.env.RESEND_API_KEY;
			else process.env.RESEND_API_KEY = prevKey;
			if (prevProvider === undefined) delete process.env.MAILER_PROVIDER;
			else process.env.MAILER_PROVIDER = prevProvider;
		}
	});
});

describe("NotificationPreferenceStore validation", () => {
	test("rejects unknown type / channel / non-boolean enabled", async () => {
		const { preferences } = freshStores();
		await expect(preferences.setMany("u1", [{ type: "nope" as never, channel: "email", enabled: true }])).rejects.toBeInstanceOf(
			NotificationPreferenceStoreError,
		);
		await expect(preferences.setMany("u1", [{ type: "ticket_replied", channel: "sms" as never, enabled: true }])).rejects.toBeInstanceOf(
			NotificationPreferenceStoreError,
		);
		await expect(
			preferences.setMany("u1", [{ type: "ticket_replied", channel: "email", enabled: "yes" as never }]),
		).rejects.toBeInstanceOf(NotificationPreferenceStoreError);
	});

	test("getForUser returns a full effective matrix merging overrides", async () => {
		const { preferences } = freshStores();
		await preferences.setMany("u1", [
			{ type: "comment_new", channel: "email", enabled: true },
			{ type: "ticket_replied", channel: "email", enabled: false },
		]);
		const matrix = await preferences.getForUser("u1");
		expect(matrix.types).toEqual(NOTIFICATION_TYPES);
		expect(matrix.channels).toEqual(["email", "in_app"]);
		// override flips comment_new email ON (default was OFF)
		expect(matrix.values.comment_new.email).toBe(true);
		expect(matrix.defaults.comment_new.email).toBe(false);
		// override flips ticket_replied email OFF (default was ON)
		expect(matrix.values.ticket_replied.email).toBe(false);
		expect(matrix.defaults.ticket_replied.email).toBe(true);
		// untouched type keeps its default
		expect(matrix.values.payment_failed.email).toBe(DEFAULT_CHANNEL_PREFS.payment_failed.email);
	});

	test("file store persists overrides across instances", async () => {
		const dir = tmp();
		const path = join(dir, "notification-preferences.json");
		const a = new FileNotificationPreferenceStore(path);
		await a.setMany("u1", [{ type: "ticket_replied", channel: "email", enabled: false }]);
		const b = new FileNotificationPreferenceStore(path);
		expect(await b.isEnabled("u1", "ticket_replied", "email")).toBe(false);
		// last-write-wins on the same key
		await b.setMany("u1", [{ type: "ticket_replied", channel: "email", enabled: true }]);
		expect(await b.isEnabled("u1", "ticket_replied", "email")).toBe(true);
	});
});

// Parity: drive the SAME contract against a fake SQL client backing the
// Postgres store so File vs Postgres behave identically without a live server.
describe("File vs Postgres preference store parity (fake client)", () => {
	function makeFakeClient() {
		const rows: Array<{ user_id: string; notification_type: string; channel: string; enabled: boolean }> = [];
		const client = {
			rows,
			async unsafe(query: string, params: unknown[] = []) {
				const q = query.replace(/\s+/g, " ").trim();
				if (q.startsWith("INSERT INTO notification_preferences")) {
					const [userId, type, channel, enabled] = params as [string, string, string, boolean];
					const existing = rows.find(
						(r) => r.user_id === userId && r.notification_type === type && r.channel === channel,
					);
					if (existing) existing.enabled = enabled;
					else rows.push({ user_id: userId, notification_type: type, channel, enabled });
					return [];
				}
				if (q.startsWith("SELECT notification_type, channel, enabled")) {
					const [userId] = params as [string];
					return rows
						.filter((r) => r.user_id === userId)
						.map((r) => ({ notification_type: r.notification_type, channel: r.channel, enabled: r.enabled }));
				}
				if (q.startsWith("SELECT enabled FROM notification_preferences")) {
					const [userId, type, channel] = params as [string, string, string];
					const row = rows.find(
						(r) => r.user_id === userId && r.notification_type === type && r.channel === channel,
					);
					return row ? [{ enabled: row.enabled }] : [];
				}
				return [];
			},
		};
		return client;
	}

	async function runContract(store: NotificationPreferenceStore): Promise<unknown> {
		await store.setMany("u1", [
			{ type: "comment_new", channel: "email", enabled: true },
			{ type: "ticket_replied", channel: "in_app", enabled: false },
		]);
		const matrix = await store.getForUser("u1");
		return {
			commentEmail: matrix.values.comment_new.email,
			ticketInApp: matrix.values.ticket_replied.in_app,
			defaultPaymentEmail: matrix.values.payment_failed.email,
			isEnabledCommentEmail: await store.isEnabled("u1", "comment_new", "email"),
			isEnabledTicketInApp: await store.isEnabled("u1", "ticket_replied", "in_app"),
			isEnabledUntouched: await store.isEnabled("u1", "payment_failed", "email"),
			isEnabledOtherUser: await store.isEnabled("u2", "comment_new", "email"),
		};
	}

	test("File and Postgres produce identical effective state", async () => {
		const { preferences: fileStore } = freshStores();
		const { PostgresNotificationPreferenceStore } = await import("../services/notification-preferences.js");
		const pgStore = new PostgresNotificationPreferenceStore(makeFakeClient() as never);

		const fileResult = await runContract(fileStore);
		const pgResult = await runContract(pgStore);
		expect(pgResult).toEqual(fileResult);
	});

	test("PostgresNotificationPreferenceStore.setMany rollback on failure", async () => {
		const { PostgresNotificationPreferenceStore } = await import("../services/notification-preferences.js");

		let dbRows: Array<{ user_id: string; notification_type: string; channel: string; enabled: boolean }> = [];
		let tempRows: typeof dbRows = [];
		let inTransaction = false;
		let queryLog: string[] = [];

		const client = {
			async unsafe(query: string, params: unknown[] = []) {
				const q = query.replace(/\s+/g, " ").trim();
				queryLog.push(q);
				if (q === "BEGIN") {
					inTransaction = true;
					tempRows = [...dbRows];
					return [];
				}
				if (q === "COMMIT") {
					inTransaction = false;
					dbRows = tempRows;
					return [];
				}
				if (q === "ROLLBACK") {
					inTransaction = false;
					tempRows = [];
					return [];
				}
				if (q.startsWith("INSERT INTO notification_preferences")) {
					const [userId, type, channel, enabled] = params as [string, string, string, boolean];
					
					if (type === "ai_job_failed") {
						throw new Error("Simulated DB Insert Failure");
					}

					const target = inTransaction ? tempRows : dbRows;
					const existing = target.find(
						(r) => r.user_id === userId && r.notification_type === type && r.channel === channel,
					);
					if (existing) {
						existing.enabled = enabled;
					} else {
						target.push({ user_id: userId, notification_type: type, channel, enabled });
					}
					return [];
				}
				return [];
			},
		};

		const pgStore = new PostgresNotificationPreferenceStore(client as never);

		await pgStore.setMany("u1", [{ type: "comment_new", channel: "email", enabled: true }]);
		expect(dbRows).toHaveLength(1);

		queryLog.length = 0; // Clear log before the failing transaction
		let errorThrown = false;
		try {
			await pgStore.setMany("u1", [
				{ type: "comment_reply", channel: "email", enabled: true },
				{ type: "ai_job_failed", channel: "email", enabled: true },
			]);
		} catch (error: any) {
			if (error.message === "Simulated DB Insert Failure") {
				errorThrown = true;
			}
		}

		expect(errorThrown).toBe(true);
		expect(queryLog).toContain("ROLLBACK");
		expect(dbRows).toHaveLength(1);
		expect(dbRows[0]?.notification_type).toBe("comment_new");
	});

	test("PostgresNotificationPreferenceStore.setMany rollback on failure with client.begin", async () => {
		const { PostgresNotificationPreferenceStore } = await import("../services/notification-preferences.js");

		let dbRows: Array<{ user_id: string; notification_type: string; channel: string; enabled: boolean }> = [];
		let tempRows: typeof dbRows = [];
		let queryLog: string[] = [];

		const createTxClient = (inTx: boolean) => {
			return {
				async unsafe(query: string, params: unknown[] = []) {
					const q = query.replace(/\s+/g, " ").trim();
					queryLog.push((inTx ? "[TX] " : "") + q);
					if (q.startsWith("INSERT INTO notification_preferences")) {
						const [userId, type, channel, enabled] = params as [string, string, string, boolean];
						
						if (type === "ai_job_failed") {
							throw new Error("Simulated DB Insert Failure");
						}

						const target = inTx ? tempRows : dbRows;
						const existing = target.find(
							(r) => r.user_id === userId && r.notification_type === type && r.channel === channel,
						);
						if (existing) {
							existing.enabled = enabled;
						} else {
							target.push({ user_id: userId, notification_type: type, channel, enabled });
						}
						return [];
					}
					return [];
				}
			};
		};

		const rootClient = {
			...createTxClient(false),
			async begin(fn: (tx: any) => Promise<any>) {
				queryLog.push("BEGIN_FN");
				tempRows = [...dbRows];
				const txClient = createTxClient(true);
				try {
					const result = await fn(txClient);
					dbRows = tempRows;
					queryLog.push("COMMIT_FN");
					return result;
				} catch (error) {
					queryLog.push("ROLLBACK_FN");
					tempRows = [];
					throw error;
				}
			}
		};

		const pgStore = new PostgresNotificationPreferenceStore(rootClient as never);

		await pgStore.setMany("u1", [{ type: "comment_new", channel: "email", enabled: true }]);
		expect(dbRows).toHaveLength(1);

		queryLog.length = 0; // Clear log before the failing transaction
		let errorThrown = false;
		try {
			await pgStore.setMany("u1", [
				{ type: "comment_reply", channel: "email", enabled: true },
				{ type: "ai_job_failed", channel: "email", enabled: true },
			]);
		} catch (error: any) {
			if (error.message === "Simulated DB Insert Failure") {
				errorThrown = true;
			}
		}

		expect(errorThrown).toBe(true);
		expect(queryLog).toContain("BEGIN_FN");
		expect(queryLog).toContain("ROLLBACK_FN");
		expect(queryLog).not.toContain("COMMIT_FN");
		expect(dbRows).toHaveLength(1);
		expect(dbRows[0]?.notification_type).toBe("comment_new");
	});

	test("FileNotificationPreferenceStore rollback on persist failure", async () => {
		const dir = tmp();
		const path = join(dir, "notification-preferences-rollback.json");
		const store = new FileNotificationPreferenceStore(path);

		await store.setMany("u1", [{ type: "comment_new", channel: "email", enabled: true }]);
		expect(await store.isEnabled("u1", "comment_new", "email")).toBe(true);

		// Force write failure with a path whose PARENT is a regular file, not a directory.
		// Writing under a non-directory always fails (ENOTDIR) regardless of privilege —
		// unlike a missing root-level dir, which mkdir can create when tests run as root.
		const blocker = join(dir, "blocker-file");
		writeFileSync(blocker, "x");
		(store as any).persistPath = join(blocker, "notification-preferences-rollback.json");

		let errorThrown = false;
		try {
			await store.setMany("u1", [{ type: "ticket_replied", channel: "email", enabled: false }]);
		} catch (error: any) {
			errorThrown = true;
		}

		expect(errorThrown).toBe(true);
		expect(await store.isEnabled("u1", "ticket_replied", "email")).toBe(true);
		expect(await store.isEnabled("u1", "comment_new", "email")).toBe(true);
	});
});

describe("notify() realtime SSE fan-out (a16 #1)", () => {
	type PublishCall = { workspaceId: string; userId: string; kind: string; data: Record<string, unknown> };
	function spyPublish(): { fn: NonNullable<Parameters<typeof notify>[1]>["publishRealtime"]; calls: PublishCall[] } {
		const calls: PublishCall[] = [];
		const fn = async (workspaceId: string, userId: string, kind: "notification_new", data: Record<string, unknown>) => {
			calls.push({ workspaceId, userId, kind, data });
			return null;
		};
		return { fn, calls };
	}

	test("publishes notification_new on the recipient's PER-USER channel when the in-app write succeeds", async () => {
		const { notifications, preferences } = freshStores();
		const publish = spyPublish();
		await notify(
			{ userId: "user-1", workspaceId: "ws-A", type: "comment_new", title: "Hi", channels: ["in_app"] },
			{ notificationStore: notifications, preferenceStore: preferences, publishRealtime: publish.fn },
		);
		expect(publish.calls).toHaveLength(1);
		const call = publish.calls[0]!;
		expect(call.workspaceId).toBe("ws-A");
		// Routed to the recipient's per-user channel — the private payload never rides
		// the shared workspace stream (a16 re-review P1 #1).
		expect(call.userId).toBe("user-1");
		expect(call.kind).toBe("notification_new");
		expect(call.data.userId).toBe("user-1");
		const notification = call.data.notification as { id: string; userId: string; category: string };
		expect(notification.userId).toBe("user-1");
		expect(typeof notification.id).toBe("string");
		expect(notification.category).toBe("tasks");
	});

	test("does NOT publish for a personal (workspace-less) notification — polling stays its path", async () => {
		const { notifications, preferences } = freshStores();
		const publish = spyPublish();
		await notify(
			{ userId: "user-1", type: "payment_succeeded", title: "Receipt", channels: ["in_app"] },
			{ notificationStore: notifications, preferenceStore: preferences, publishRealtime: publish.fn },
		);
		expect(publish.calls).toHaveLength(0);
	});

	test("a realtime publish failure never fails the in-app write (best-effort)", async () => {
		const { notifications, preferences } = freshStores();
		const result = await notify(
			{ userId: "user-1", workspaceId: "ws-A", type: "comment_new", title: "Hi", channels: ["in_app"] },
			{
				notificationStore: notifications,
				preferenceStore: preferences,
				publishRealtime: async () => {
					throw new Error("redis down");
				},
			},
		);
		expect(result.inAppDelivered).toBe(true);
		// The notification was still persisted despite the realtime failure.
		const page = await notifications.listForUser("user-1");
		expect(page.items).toHaveLength(1);
	});
});

describe("notify() in-app durable dedupe (inAppDedupeKey)", () => {
	test("two notifies with the SAME inAppDedupeKey write exactly ONE in-app row", async () => {
		const { notifications, preferences } = freshStores();
		const publishCalls: unknown[] = [];
		const deps = {
			notificationStore: notifications,
			preferenceStore: preferences,
			publishRealtime: (async (...args: unknown[]) => { publishCalls.push(args); }) as never,
		};
		const first = await notify(
			{ userId: "u1", workspaceId: "ws", type: "payment_succeeded", title: "Receipt", channels: ["in_app"], inAppDedupeKey: "dodo-receipt:pay_1:inapp" },
			deps,
		);
		const second = await notify(
			{ userId: "u1", workspaceId: "ws", type: "payment_succeeded", title: "Receipt", channels: ["in_app"], inAppDedupeKey: "dodo-receipt:pay_1:inapp" },
			deps,
		);
		expect(first.inAppDelivered).toBe(true);
		expect(second.inAppDelivered).toBe(false);
		expect(second.skipped).toContainEqual({ channel: "in_app", reason: "duplicate" });
		const page = await notifications.listForUser("u1");
		expect(page.items).toHaveLength(1);
		// Realtime fan-out fired only for the first (the duplicate is suppressed).
		expect(publishCalls).toHaveLength(1);
	});

	test("two notifies with DISTINCT inAppDedupeKeys write TWO in-app rows", async () => {
		const { notifications, preferences } = freshStores();
		const deps = { notificationStore: notifications, preferenceStore: preferences };
		await notify(
			{ userId: "u1", workspaceId: "ws", type: "payment_succeeded", title: "Receipt", channels: ["in_app"], inAppDedupeKey: "dodo-receipt:pay_1:inapp" },
			deps,
		);
		await notify(
			{ userId: "u1", workspaceId: "ws", type: "payment_succeeded", title: "Receipt", channels: ["in_app"], inAppDedupeKey: "dodo-receipt:pay_2:inapp" },
			deps,
		);
		const page = await notifications.listForUser("u1");
		expect(page.items).toHaveLength(2);
	});

	// F1 (round-3): one charge can present DIFFERENT identifiers across deliveries —
	// payment.succeeded carries payment_id while a sibling invoice.paid carries only
	// invoice_id — so the two derive DIVERGENT primary keys. The candidate-key existence
	// check (inAppDedupeKeyCandidates) collapses them: the row is written under the primary,
	// but a sibling whose candidate set overlaps finds it and is suppressed.
	test("candidate-key backstop: an existing row under a key in the NEW delivery's candidate set suppresses the write", async () => {
		const { notifications, preferences } = freshStores();
		const deps = { notificationStore: notifications, preferenceStore: preferences };
		// Delivery 1 wrote a row under payment_id (e.g. a payment.succeeded seen first under a
		// payment-first primary in a legacy/edge wiring).
		const first = await notify(
			{
				userId: "u1", workspaceId: "ws", type: "payment_succeeded", title: "Receipt", channels: ["in_app"],
				inAppDedupeKey: "dodo-receipt:pay_X:inapp",
				inAppDedupeKeyCandidates: ["dodo-receipt:pay_X:inapp"],
			},
			deps,
		);
		// Delivery 2 derives a DIFFERENT primary (inv_X) but forwards EVERY candidate of the
		// charge — including pay_X. The pre-check finds the existing row via that candidate and
		// suppresses the second write, so the divergent-key sibling collapses to ONE row.
		const second = await notify(
			{
				userId: "u1", workspaceId: "ws", type: "payment_succeeded", title: "Receipt", channels: ["in_app"],
				inAppDedupeKey: "dodo-receipt:inv_X:inapp",
				inAppDedupeKeyCandidates: ["dodo-receipt:inv_X:inapp", "dodo-receipt:pay_X:inapp"],
			},
			deps,
		);
		expect(first.inAppDelivered).toBe(true);
		expect(second.inAppDelivered).toBe(false);
		expect(second.skipped).toContainEqual({ channel: "in_app", reason: "duplicate" });
		const page = await notifications.listForUser("u1");
		expect(page.items).toHaveLength(1);
	});

	test("invoice-first convergence: succeeded(pay+inv) then invoice(inv-only) → ONE row", async () => {
		const { notifications, preferences } = freshStores();
		const deps = { notificationStore: notifications, preferenceStore: preferences };
		// Mirrors the dodo wiring: the in-app PRIMARY is invoice-first, so a charge's
		// payment.succeeded and its invoice.paid both write under dodo-receipt:inv_X:inapp.
		await notify(
			{
				userId: "u1", workspaceId: "ws", type: "payment_succeeded", title: "Receipt", channels: ["in_app"],
				inAppDedupeKey: "dodo-receipt:inv_X:inapp",
				inAppDedupeKeyCandidates: ["dodo-receipt:inv_X:inapp", "dodo-receipt:pay_X:inapp"],
			},
			deps,
		);
		const second = await notify(
			{
				userId: "u1", workspaceId: "ws", type: "payment_succeeded", title: "Receipt", channels: ["in_app"],
				inAppDedupeKey: "dodo-receipt:inv_X:inapp",
				inAppDedupeKeyCandidates: ["dodo-receipt:inv_X:inapp"],
			},
			deps,
		);
		expect(second.inAppDelivered).toBe(false);
		const page = await notifications.listForUser("u1");
		expect(page.items).toHaveLength(1);
	});

	test("two genuinely DISTINCT charges (no shared candidate) still write TWO rows", async () => {
		const { notifications, preferences } = freshStores();
		const deps = { notificationStore: notifications, preferenceStore: preferences };
		await notify(
			{
				userId: "u1", workspaceId: "ws", type: "payment_succeeded", title: "Receipt", channels: ["in_app"],
				inAppDedupeKey: "dodo-receipt:inv_A:inapp",
				inAppDedupeKeyCandidates: ["dodo-receipt:inv_A:inapp", "dodo-receipt:pay_A:inapp"],
			},
			deps,
		);
		await notify(
			{
				userId: "u1", workspaceId: "ws", type: "payment_succeeded", title: "Receipt", channels: ["in_app"],
				inAppDedupeKey: "dodo-receipt:inv_B:inapp",
				inAppDedupeKeyCandidates: ["dodo-receipt:inv_B:inapp", "dodo-receipt:pay_B:inapp"],
			},
			deps,
		);
		const page = await notifications.listForUser("u1");
		expect(page.items).toHaveLength(2);
	});

	test("no inAppDedupeKey => no dedupe (each notify writes its own row)", async () => {
		const { notifications, preferences } = freshStores();
		const deps = { notificationStore: notifications, preferenceStore: preferences };
		await notify({ userId: "u1", workspaceId: "ws", type: "payment_succeeded", title: "Receipt", channels: ["in_app"] }, deps);
		await notify({ userId: "u1", workspaceId: "ws", type: "payment_succeeded", title: "Receipt", channels: ["in_app"] }, deps);
		const page = await notifications.listForUser("u1");
		expect(page.items).toHaveLength(2);
	});

	test("the dedupe key is scoped per-user (same key, different users => two rows)", async () => {
		const { notifications, preferences } = freshStores();
		const deps = { notificationStore: notifications, preferenceStore: preferences };
		await notify({ userId: "u1", workspaceId: "ws", type: "payment_succeeded", title: "R", channels: ["in_app"], inAppDedupeKey: "k1" }, deps);
		await notify({ userId: "u2", workspaceId: "ws", type: "payment_succeeded", title: "R", channels: ["in_app"], inAppDedupeKey: "k1" }, deps);
		expect((await notifications.listForUser("u1")).items).toHaveLength(1);
		expect((await notifications.listForUser("u2")).items).toHaveLength(1);
	});
});
