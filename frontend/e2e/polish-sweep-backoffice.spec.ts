// QA for the back-office polish sweep (branch claude/polish-sweep-backoffice).
//
// These three admin surfaces are normally gated by real platform RBAC. For an
// isolated visual/behaviour check we inject an admin session into localStorage
// and stub the /api/admin/* + /api/auth/me responses with page.route, so the QA
// is hermetic (no DB / no real admin grant needed). Screenshots land in
// /tmp/qa-polish-sweep/*.png and are referenced in the PR report.
import { expect, test, type Page } from "@playwright/test";

const SHOT_DIR = "/tmp/qa-polish-sweep";

const ADMIN_USER = {
	id: "admin-1",
	email: "owner@example.com",
	name: "QA Owner",
	role: "admin",
};

const ADMIN_PERMS = [
	"admin:access",
	"admin:content.read",
	"admin:content.moderate",
	"admin:coupons.read",
	"admin:coupons.write",
	"admin:revenue.read",
	"admin:revenue.export",
];

async function injectAdminSession(page: Page): Promise<void> {
	await page.addInitScript(
		([user]) => {
			localStorage.setItem(
				"manga-editor.auth.session.v1",
				JSON.stringify({
					user,
					tokens: { accessToken: "qa-access", refreshToken: "qa-refresh" },
				}),
			);
			// Pre-seed cookie consent so the GDPR banner never overlays the surfaces.
			localStorage.setItem(
				"comic-workspace.cookieConsent",
				JSON.stringify({ necessary: true, analytics: false, marketing: false, version: 1, decidedAt: new Date().toISOString() }),
			);
		},
		[ADMIN_USER],
	);
	// Session validation hits GET /api/auth/me — keep it green.
	await page.route("**/api/auth/me", async (route) => {
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ADMIN_USER) });
	});
	// admin shell + per-page permission gate read GET /api/admin/me.
	await page.route("**/api/admin/me", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ role: "admin", permissions: ADMIN_PERMS, sections: [] }),
		});
	});
}

function json(body: unknown, status = 200) {
	return { status, contentType: "application/json", body: JSON.stringify(body) };
}

// ── Content: refetch list after a moderation change (hidden row drops out) ──
test("content: hiding a project (filtered to active) refetches and drops the row", async ({ page }) => {
	await injectAdminSession(page);

	const project = {
		projectId: "proj-1",
		workspaceId: "ws-1",
		workspaceName: "Studio One",
		ownerUserId: "u-1",
		title: "Visible Project",
		status: "active",
		sourceLang: "ja",
		targetLang: "en",
		pageCount: 4,
		assetCount: 6,
		flaggedAssetCount: 0,
		csamBlockCount: 0,
		adminFlagged: false,
		adminFlaggedAt: null,
		adminFlaggedBy: null,
		adminFlagReason: null,
		adminHidden: false,
		adminHiddenAt: null,
		adminHiddenBy: null,
		adminHideReason: null,
		createdAt: "2026-05-01T00:00:00.000Z",
		updatedAt: "2026-05-01T00:00:00.000Z",
	};

	// First LIST call returns the active project; after the hide the SECOND list
	// call (the refetch under test) returns empty — proving we re-query and the
	// row drops out instead of lingering patched-in-place.
	let listCalls = 0;
	await page.route("**/api/admin/content/projects?**", async (route) => {
		listCalls += 1;
		const projects = listCalls === 1 ? [project] : [];
		await route.fulfill(json({ projects, nextCursor: null }));
	});
	await page.route("**/api/admin/content/projects/proj-1", async (route) => {
		await route.fulfill(json({ project: { ...project, pages: [], flaggedAssets: [] } }));
	});
	await page.route("**/api/admin/content/projects/proj-1/hide", async (route) => {
		await route.fulfill(json({ ok: true, project: { ...project, status: "admin_hidden", adminHidden: true } }));
	});
	await page.route("**/api/admin/content/moderation-queue**", async (route) => {
		await route.fulfill(json({ items: [], nextCursor: null }));
	});

	await page.goto("/admin/content");
	await expect(page.getByText("Visible Project")).toBeVisible();
	await page.screenshot({ path: `${SHOT_DIR}/content-before-hide.png`, fullPage: true });

	// Open the drawer, then hide. window.prompt drives the reason.
	page.on("dialog", (d) => d.accept(""));
	await page.getByRole("button", { name: "เปิด" }).first().click();
	await expect(page.getByRole("button", { name: "ซ่อน" })).toBeVisible();
	await page.getByRole("button", { name: "ซ่อน" }).click();

	// The list is refetched (still filtered to "active"): the second call drives a
	// re-render and the now-hidden row drops out of the TABLE (the drawer still
	// references the project it has open — that's expected, so scope to the table).
	const table = page.getByRole("region", { name: "รายการโปรเจกต์" });
	await expect(table.getByText("Visible Project")).toHaveCount(0);
	await expect(table.getByText("ไม่พบโปรเจกต์ที่ตรงเงื่อนไข")).toBeVisible();
	await expect.poll(() => listCalls).toBeGreaterThanOrEqual(2);
	await page.screenshot({ path: `${SHOT_DIR}/content-after-hide.png`, fullPage: true });
});

// ── Content: moderate buttons DISABLED (not hidden) without permission ──
test("content: moderate buttons render disabled when lacking content.moderate", async ({ page }) => {
	await injectAdminSession(page);
	// Drop the moderate permission for this run (keep admin:access so the shell renders).
	await page.unroute("**/api/admin/me");
	await page.route("**/api/admin/me", async (route) => {
		await route.fulfill(
			json({ role: "admin", permissions: ["admin:access", "admin:content.read"], sections: [] }),
		);
	});

	const project = {
		projectId: "proj-1",
		workspaceId: "ws-1",
		workspaceName: "Studio One",
		ownerUserId: "u-1",
		title: "Read Only Project",
		status: "active",
		sourceLang: null,
		targetLang: null,
		pageCount: 1,
		assetCount: 1,
		flaggedAssetCount: 0,
		csamBlockCount: 0,
		adminFlagged: false,
		adminFlaggedAt: null,
		adminFlaggedBy: null,
		adminFlagReason: null,
		adminHidden: false,
		adminHiddenAt: null,
		adminHiddenBy: null,
		adminHideReason: null,
		createdAt: "2026-05-01T00:00:00.000Z",
		updatedAt: "2026-05-01T00:00:00.000Z",
	};
	await page.route("**/api/admin/content/projects?**", async (route) => route.fulfill(json({ projects: [project], nextCursor: null })));
	await page.route("**/api/admin/content/projects/proj-1", async (route) => route.fulfill(json({ project: { ...project, pages: [], flaggedAssets: [] } })));
	await page.route("**/api/admin/content/moderation-queue**", async (route) => route.fulfill(json({ items: [], nextCursor: null })));

	await page.goto("/admin/content");
	await page.getByRole("button", { name: "เปิด" }).first().click();

	// Buttons are present (rendered) but disabled — matching the users-page pattern.
	const flagBtn = page.getByRole("button", { name: "Flag" });
	const hideBtn = page.getByRole("button", { name: "ซ่อน" });
	await expect(flagBtn).toBeVisible();
	await expect(flagBtn).toBeDisabled();
	await expect(hideBtn).toBeVisible();
	await expect(hideBtn).toBeDisabled();
	await page.screenshot({ path: `${SHOT_DIR}/content-buttons-disabled.png`, fullPage: true });
});

// ── Coupons: Dodo load error shows error state, NOT the empty row ──
test("coupons: dodo load error shows error state and no empty-discounts row", async ({ page }) => {
	await injectAdminSession(page);
	await page.route("**/api/admin/coupons/dodo**", async (route) => {
		if (route.request().method() === "GET") {
			await route.fulfill(json({ error: "Dodo unavailable" }, 502));
			return;
		}
		await route.fallback();
	});
	await page.route("**/api/admin/coupons/credit**", async (route) => route.fulfill(json({ coupons: [] })));

	await page.goto("/admin/coupons");
	// Error alert visible; the "no discounts" empty message must NOT be rendered.
	await expect(page.getByRole("alert")).toBeVisible();
	await expect(page.getByText("ยังไม่มีส่วนลด Dodo")).toHaveCount(0);
	await page.screenshot({ path: `${SHOT_DIR}/coupons-error-state.png`, fullPage: true });
});

// ── Coupons: invalid credit-coupon code rejected client-side ──
test("coupons: invalid credit code is rejected before submit", async ({ page }) => {
	await injectAdminSession(page);
	let createCalled = false;
	await page.route("**/api/admin/coupons/dodo**", async (route) => {
		if (route.request().method() === "GET") {
			await route.fulfill(json({ discounts: [] }));
			return;
		}
		await route.fallback();
	});
	await page.route("**/api/admin/coupons/credit", async (route) => {
		if (route.request().method() === "POST") {
			createCalled = true;
			await route.fulfill(json({ coupon: {} }));
			return;
		}
		await route.fulfill(json({ coupons: [] }));
	});
	await page.route("**/api/admin/coupons/credit?**", async (route) => route.fulfill(json({ coupons: [] })));

	await page.goto("/admin/coupons");
	await page.getByRole("tab", { name: /Credit coupons/ }).click();
	await page.getByRole("button", { name: "+ Generate credit coupon" }).click();

	await page.getByPlaceholder("เช่น 500").fill("500");
	// Invalid: contains a space + lowercase punctuation not in [A-Z0-9-].
	await page.getByPlaceholder("เช่น WELCOME500").fill("bad code!");
	// The button should be disabled when the code is invalid.
	await expect(page.getByRole("button", { name: "Generate coupon" })).toBeDisabled();

	// Client validation should block the POST and show a field error.
	await expect(page.getByText(/ใช้ได้เฉพาะ A-Z, 0-9/)).toBeVisible();
	await page.screenshot({ path: `${SHOT_DIR}/coupons-invalid-code.png`, fullPage: true });
	expect(createCalled).toBe(false);
});

// ── Revenue: long per-plan MRR money label does not clip ──
test("revenue: long per-plan MRR label is fully visible (no clip)", async ({ page }) => {
	await injectAdminSession(page);
	const summary = {
		currencies: [{ currency: "USD", mrrCents: "199900", arrCents: "2398800", activeSubscriptions: 12 }],
		plans: [
			{ planId: "studio", planName: "Studio", activeSubscriptions: 8, mrrCents: "199900", arrCents: "2398800", currency: "USD" },
			{ planId: "team", planName: "Team", activeSubscriptions: 4, mrrCents: "49900", arrCents: "598800", currency: "USD" },
		],
		activeSubscriptionsTotal: 12,
	};
	await page.route("**/api/admin/revenue/summary", async (route) => route.fulfill(json(summary)));
	await page.route("**/api/admin/revenue/timeseries**", async (route) => route.fulfill(json({ interval: "month", series: [] })));
	await page.route("**/api/admin/revenue/refunds-disputes**", async (route) => route.fulfill(json({ currencies: [] })));
	await page.route("**/api/admin/revenue/transactions**", async (route) => route.fulfill(json({ transactions: [], total: 0, nextCursor: null })));

	await page.goto("/admin/revenue");
	const label = page.locator(".plan-bar-value", { hasText: "1,999.00" }).first();
	await expect(label).toBeVisible();

	// Assert the rendered text is not clipped: scrollWidth must fit clientWidth.
	const notClipped = await label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
	expect(notClipped).toBe(true);
	await page.screenshot({ path: `${SHOT_DIR}/revenue-long-label.png`, fullPage: true });
});
