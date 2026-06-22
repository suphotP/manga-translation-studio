// P1 (missing asset appeal/review transition): admins can approve / block an
// individual asset's moderation status. A `needs_review` asset can display but
// never export/AI (those require `passed`); before this surface there was no way
// to resolve it either way. These tests drive the audited HTTP endpoints end to
// end against the real (file-mode) asset store.

import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { createAdminContentRouter } from "../routes/admin/content.js";
import { getAssetRecordAuthoritative, restoreAssetRecord, removeAssetRecord } from "../services/assets.js";
import { PROJECTS_DIR } from "../config.js";
import type { UserRole } from "../types/auth.js";
import type { AssetModerationStatus, AssetRecord, AssetStorageStatus } from "../types/index.js";

const seeded: Array<{ projectId: string; imageId: string }> = [];

afterEach(() => {
	for (const { projectId, imageId } of seeded.splice(0)) {
		removeAssetRecord(projectId, imageId);
	}
});

type AuditEntry = { adminUserId: string; action: string; targetKind?: string | null; targetId?: string | null; detail?: Record<string, unknown> };

function stubGdpr(sink: AuditEntry[]) {
	return {
		async recordAdminAudit(input: AuditEntry) {
			sink.push(input);
			return { auditId: randomUUID(), createdAt: new Date().toISOString(), ...input } as never;
		},
	} as never;
}

function appAs(role: UserRole, gdpr: ReturnType<typeof stubGdpr>): Hono {
	const app = new Hono();
	const stubAuth = async (c: Context, next: Next) => {
		c.set("user", { userId: `stub-${role}`, email: `${role}@example.com`, role, iat: 0, exp: 0 });
		await next();
	};
	app.use("*", stubAuth);
	app.route("/", createAdminContentRouter({ gdpr }));
	return app;
}

function seedAsset(storageStatus: AssetStorageStatus, moderationStatus: AssetModerationStatus): { projectId: string; imageId: string } {
	const projectId = `proj-${randomUUID()}`;
	const imageId = `${randomUUID()}.png`;
	mkdirSync(join(PROJECTS_DIR, projectId, "images"), { recursive: true });
	const createdAt = "2026-06-05T00:00:00.000Z";
	const record: AssetRecord = {
		assetId: imageId,
		projectId,
		imageId,
		originalName: imageId,
		mimeType: "image/png",
		sizeBytes: 4,
		sha256: randomUUID().replace(/-/g, ""),
		storageDriver: "local",
		storageKey: `projects/${projectId}/images/${imageId}`,
		width: 1,
		height: 1,
		storageStatus,
		moderation: { status: moderationStatus, provider: "test", checkedAt: createdAt },
		derivatives: [],
		createdAt,
		updatedAt: createdAt,
	};
	restoreAssetRecord(projectId, record);
	seeded.push({ projectId, imageId });
	return { projectId, imageId };
}

describe("admin asset moderation transitions", () => {
	test("approve: needs_review → passed + released, audited", async () => {
		const audit: AuditEntry[] = [];
		const { projectId, imageId } = seedAsset("released", "needs_review");
		const res = await appAs("admin", stubGdpr(audit)).request(`/assets/${projectId}/${imageId}/approve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason: "manual review ok" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json() as { ok: boolean; asset: { moderationStatus: string; storageStatus: string } };
		expect(body.ok).toBe(true);
		expect(body.asset.moderationStatus).toBe("passed");
		expect(body.asset.storageStatus).toBe("released");

		const after = await getAssetRecordAuthoritative(projectId, imageId);
		expect(after?.moderation.status).toBe("passed");
		expect(after?.storageStatus).toBe("released");
		expect(audit.some((a) => a.action === "admin.content.asset.approve" && a.targetId === `${projectId}/${imageId}`)).toBe(true);
	});

	test("block: needs_review → blocked + quarantined, audited", async () => {
		const audit: AuditEntry[] = [];
		const { projectId, imageId } = seedAsset("released", "needs_review");
		const res = await appAs("owner", stubGdpr(audit)).request(`/assets/${projectId}/${imageId}/block`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason: "confirmed violation" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json() as { asset: { moderationStatus: string; storageStatus: string } };
		expect(body.asset.moderationStatus).toBe("blocked");
		expect(body.asset.storageStatus).toBe("blocked");

		const after = await getAssetRecordAuthoritative(projectId, imageId);
		expect(after?.moderation.status).toBe("blocked");
		expect(after?.storageStatus).toBe("blocked");
		expect(audit.some((a) => a.action === "admin.content.asset.block")).toBe(true);
	});

	// FIX #4 (codex re-review): approve is ONLY a release path for `needs_review`.
	// A `blocked` (mandatory/CSAM/denylist) asset MUST NOT be releasable through the
	// normal approve flow — that would be a direct, audited release of mandatory-
	// blocked content. It must be rejected with 409 and left unchanged.
	test("approve: blocked asset is rejected with 409 and stays blocked", async () => {
		const audit: AuditEntry[] = [];
		const { projectId, imageId } = seedAsset("blocked", "blocked");
		const res = await appAs("owner", stubGdpr(audit)).request(`/assets/${projectId}/${imageId}/approve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason: "should not be releasable" }),
		});
		expect(res.status).toBe(409);
		const body = await res.json() as { code: string };
		expect(body.code).toBe("asset_blocked_not_approvable");

		// Unchanged: still blocked + quarantined, and NOT audited as an approval.
		const after = await getAssetRecordAuthoritative(projectId, imageId);
		expect(after?.moderation.status).toBe("blocked");
		expect(after?.storageStatus).toBe("blocked");
		expect(audit.some((a) => a.action === "admin.content.asset.approve")).toBe(false);
	});

	// FIX #4: the block transition still works on an already-blocked asset (idempotent
	// re-affirmation), and approve continues to work for needs_review (above) — only
	// the blocked→passed release is forbidden.
	test("block: blocked asset stays blocked (200, idempotent)", async () => {
		const audit: AuditEntry[] = [];
		const { projectId, imageId } = seedAsset("blocked", "blocked");
		const res = await appAs("owner", stubGdpr(audit)).request(`/assets/${projectId}/${imageId}/block`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason: "re-affirm" }),
		});
		expect(res.status).toBe(200);
		const after = await getAssetRecordAuthoritative(projectId, imageId);
		expect(after?.moderation.status).toBe("blocked");
	});

	test("unknown asset → 404", async () => {
		const res = await appAs("admin", stubGdpr([])).request(`/assets/proj-${randomUUID()}/${randomUUID()}.png/approve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(404);
	});

	test("support (read-only content) cannot transition — CONTENT_MODERATE required (403)", async () => {
		const { projectId, imageId } = seedAsset("released", "needs_review");
		const res = await appAs("support", stubGdpr([])).request(`/assets/${projectId}/${imageId}/block`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(403);
		// Unchanged.
		const after = await getAssetRecordAuthoritative(projectId, imageId);
		expect(after?.moderation.status).toBe("needs_review");
	});
});
