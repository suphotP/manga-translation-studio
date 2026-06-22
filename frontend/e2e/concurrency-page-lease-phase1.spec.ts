// Concurrent-edit Phase 1 — real-browser proof of the page-lease presence
// steering UI (PageLeaseBanner) + per-tab edit-session identity.
//
// Two contexts:
//   • User A "edits" page 1 → holds the lease (status: held, no banner).
//   • User B opens page 1 → the lease is held by someone else → the banner
//     shows "A is editing this page" with View only / Take over (NOT a 409
//     after doing work).
//   • Same user, 2nd tab on page 1 → held-by-self-tab → the banner shows
//     "You're editing this page in another tab" with Continue here (steered,
//     not a silent clobber).
//
// The lease store exposes a DEV/E2E-only `setEditLeaseStateForTests` hook so the
// steering UI can be exercised without a live Postgres/lock backend. The lease
// LOGIC (acquire/heartbeat/release/expire, same-user-tab conflict, cross-user
// takeover + displaced-holder notify, CAS final net) is covered by the
// unit/integration suites (backend work-locks.test.ts + frontend
// edit-lease/edit-session store tests).

import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const SHOT_DIR = "/tmp/qa/concurrency2";

// A pre-provisioned file-mode dev session injected into localStorage before the
// app boots, so the editor view is reachable without driving the login UI. The
// values come from the QA backend on :9093 (register + GET /api/workspaces) and
// are read from env so the spec stays credential-free in the repo.
const QA_SESSION = process.env.QA_SESSION_JSON ?? "";
const QA_WORKSPACE_ID = process.env.QA_WORKSPACE_ID ?? "";

async function bootEditor(page: Page) {
	if (QA_SESSION) {
		await page.addInitScript(
			([session, ws]) => {
				try {
					localStorage.setItem("manga-editor.auth.session.v1", session);
					if (ws) localStorage.setItem("manga-editor.currentWorkspaceId", ws);
				} catch {
					/* ignore */
				}
			},
			[QA_SESSION, QA_WORKSPACE_ID] as const,
		);
	}
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__mangaEditorDebug && window.__mangaWorkflowDebug));
	await page.evaluate(() => window.__mangaWorkflowDebug!.openView("editor"));
	await page.waitForFunction(() => {
		const root = document.querySelector(".editor-root");
		return Boolean(root && !root.classList.contains("workspace-dashboard-view") && !root.classList.contains("workspace-focus-view"));
	});
	await page.evaluate(() => window.__mangaEditorDebug!.loadTestImage({ width: 1400, height: 2000, label: "PAGE 1" }));
}

test.beforeAll(async () => {
	await mkdir(SHOT_DIR, { recursive: true });
});

test("each tab has a distinct edit-session client id (same-user 2-tab identity)", async ({ browser }) => {
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const tab1 = await ctxA.newPage();
	const tab2 = await ctxB.newPage();
	await bootEditor(tab1);
	await bootEditor(tab2);

	const id1 = await tab1.evaluate(() => window.__mangaEditorDebug!.getEditLeaseClientId());
	const id2 = await tab2.evaluate(() => window.__mangaEditorDebug!.getEditLeaseClientId());

	expect(id1).toMatch(/^tab-/);
	expect(id2).toMatch(/^tab-/);
	// Two tabs/sessions of (potentially) the same user MUST get different client
	// ids so the backend can tell them apart and steer the 2nd, not clobber.
	expect(id1).not.toBe(id2);

	await ctxA.close();
	await ctxB.close();
});

test("User A holds the lease → no steering banner (free to edit)", async ({ page }) => {
	await bootEditor(page);
	await page.evaluate(() => window.__mangaEditorDebug!.setEditLeaseStateForTests("held"));
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.screenshot({ path: `${SHOT_DIR}/A-holds-lease-no-banner.png`, fullPage: false });
});

test("User B opens A's page → 'A is editing this page' + View / Take over", async ({ page }) => {
	await bootEditor(page);
	await page.evaluate(() =>
		window.__mangaEditorDebug!.setEditLeaseStateForTests("held-by-other", {
			heldByUserId: "Translator A",
			expiresAt: new Date(Date.now() + 180_000).toISOString(),
			lockId: "lock-a-page-1",
		}),
	);

	const banner = page.getByRole("alert");
	await expect(banner).toBeVisible();
	await expect(banner).toContainText("Translator A is editing this page");
	// Steering choices — NOT a blocking error. The "Take over" button is the
	// cross-user takeover affordance the owner asked for.
	await expect(banner.getByRole("button", { name: "View only" })).toBeVisible();
	await expect(banner.getByRole("button", { name: "Take over" })).toBeVisible();

	await page.screenshot({ path: `${SHOT_DIR}/B-sees-A-editing-steer.png`, fullPage: false });

	// "View only" dismisses to a non-blocking read state (no clobber, no error).
	await banner.getByRole("button", { name: "View only" }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.screenshot({ path: `${SHOT_DIR}/B-view-only-dismissed.png`, fullPage: false });
});

test("Same user 2nd tab on the page → 'editing in another tab' + Continue here", async ({ page }) => {
	await bootEditor(page);
	await page.evaluate(() =>
		window.__mangaEditorDebug!.setEditLeaseStateForTests("held-by-self-tab", {
			heldByUserId: "me",
			heldByClientId: "tab-other",
			expiresAt: new Date(Date.now() + 180_000).toISOString(),
			lockId: "lock-self-page-1",
		}),
	);

	const banner = page.getByRole("alert");
	await expect(banner).toBeVisible();
	await expect(banner).toContainText("another tab");
	// Same-user case: "Continue here" takeover, and NO "View only" (it's your own work).
	await expect(banner.getByRole("button", { name: "Continue here" })).toBeVisible();
	await expect(banner.getByRole("button", { name: "View only" })).toHaveCount(0);

	await page.screenshot({ path: `${SHOT_DIR}/self-2nd-tab-continue-here.png`, fullPage: false });
});

test("lock-service unavailable → no banner (edit anyway; CAS is the final net)", async ({ page }) => {
	await bootEditor(page);
	await page.evaluate(() => window.__mangaEditorDebug!.setEditLeaseStateForTests("unavailable"));
	// A lock hiccup must NEVER block the editor — no steering banner, user edits,
	// CAS on save remains the durable guard.
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.screenshot({ path: `${SHOT_DIR}/lock-unavailable-edit-anyway.png`, fullPage: false });
});
