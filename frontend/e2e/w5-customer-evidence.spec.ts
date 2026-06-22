// Wave 5 customer-readiness evidence capture.
// Drives the REAL dev app (live file-mode backend) and writes desktop (1440x1000)
// + iPad (929x1194) screenshots of the key customer surfaces into docs/evidence/.
// Run with: VITE_E2E=1 plus an already-running dev server + backend AND the
// W5_CUSTOMER_SESSION / W5_ADMIN_SESSION auth sessions provided by the harness.
//
// Evidence integrity: this spec MUST NOT silently pass when the required
// screenshots cannot be produced. The protected surfaces require real auth
// sessions; absent them the whole spec is skipped (not regenerated as login
// redirects). Each "required evidence" capture asserts the underlying control
// exists and fails the run if it cannot, so the committed PNGs always match the
// claims in docs/CUSTOMER_READINESS_REPORT.md.
import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const EVIDENCE_DIR = resolve(process.cwd(), "../docs/evidence");

// Real seeded auth session (matches StoredAuthSession shape persisted by the
// auth store). Tokens are injected at test runtime via env from the harness.
const AUTH_STORAGE_KEY = "manga-editor.auth.session.v1";

const CUSTOMER_SESSION = process.env.W5_CUSTOMER_SESSION ?? "";
const ADMIN_SESSION = process.env.W5_ADMIN_SESSION ?? "";

// The Playwright config runs every spec under three projects (desktop/tablet/
// mobile) with fullyParallel:true. This evidence spec owns its filenames and
// must not race three workers writing the same docs/evidence/*.png. Restrict it
// to a single project so the committed evidence is deterministic; this spec
// drives its OWN viewports (desktop 1440x1000 + iPad 929x1194) explicitly.
const EVIDENCE_PROJECT = "chromium-desktop";

type Viewport = { name: "desktop" | "ipad"; width: number; height: number };
const VIEWPORTS: Viewport[] = [
	{ name: "desktop", width: 1440, height: 1000 },
	{ name: "ipad", width: 929, height: 1194 },
];

const consoleErrors: string[] = [];

// Record both console errors AND uncaught runtime exceptions. Uncaught errors
// surface via Playwright's `pageerror` event and are NOT guaranteed to also
// emit a console message, so the report's "no JS exceptions" claim depends on
// listening to both. pageerrors are prefixed so the evidence log distinguishes
// them from 503-style console noise.
function attachErrorCapture(page: Page, vpName: string): void {
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(`${vpName}:${page.url()}:${m.text()}`);
	});
	page.on("pageerror", (err) => {
		consoleErrors.push(`${vpName}:${page.url()}:[pageerror] ${err.message}`);
	});
}

async function seedSession(page: Page, session: string): Promise<void> {
	if (!session) return;
	await page.addInitScript(
		({ key, value }) => {
			try {
				window.localStorage.setItem(key, value);
			} catch {
				/* ignore */
			}
		},
		{ key: AUTH_STORAGE_KEY, value: session },
	);
}

async function settle(page: Page): Promise<void> {
	// The app keeps realtime/SSE connections open, so "networkidle" never fires.
	await page.waitForLoadState("domcontentloaded").catch(() => {});
	await page.waitForTimeout(1400);
	await dismissConsent(page);
	await page.waitForTimeout(300);
}

async function dismissConsent(page: Page): Promise<void> {
	// The cookie-consent banner overlaps the lower viewport; accept it so the
	// real surface is unobstructed in screenshots.
	const accept = page.getByRole("button", { name: /ยอมรับทั้งหมด|ยอมรับ|Accept/ }).first();
	if (await accept.count().catch(() => 0)) {
		await accept.click({ timeout: 2000 }).catch(() => {});
	}
}

async function dismissOnboarding(page: Page): Promise<void> {
	// First-visit onboarding tour modal; Skip/Escape persists dismissal.
	const skip = page.getByRole("button", { name: /Skip|ข้าม/ }).first();
	if (await skip.count().catch(() => 0)) {
		await skip.click({ timeout: 2000 }).catch(() => {});
	}
	await page.keyboard.press("Escape").catch(() => {});
	await page.waitForTimeout(300);
}

async function shoot(page: Page, name: string, vp: Viewport): Promise<void> {
	const file = resolve(EVIDENCE_DIR, `${name}.${vp.name}.png`);
	await page.screenshot({ path: file, fullPage: false });
	// eslint-disable-next-line no-console
	console.log(`[w5] saved ${file}`);
}

test.beforeAll(async () => {
	await mkdir(EVIDENCE_DIR, { recursive: true });
});

// Restrict the whole evidence spec to one Playwright project so the three
// configured projects don't race-write the same docs/evidence/*.png files.
test.beforeEach(() => {
	test.skip(
		test.info().project.name !== EVIDENCE_PROJECT,
		`evidence is captured only under the "${EVIDENCE_PROJECT}" project`,
	);
});

for (const vp of VIEWPORTS) {
	test.describe(`w5 evidence ${vp.name}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } });

		test(`public + auth surfaces (${vp.name})`, async ({ page }) => {
			attachErrorCapture(page, vp.name);

			await page.goto("/login");
			await settle(page);
			await shoot(page, "login", vp);

			await page.goto("/signup");
			await settle(page);
			await shoot(page, "signup", vp);

			await page.goto("/pricing");
			await settle(page);
			await shoot(page, "pricing", vp);
		});

		test(`workspace surfaces (${vp.name})`, async ({ page }) => {
			// Protected surfaces require a real customer session. Without it the
			// app redirects to /login, so capturing would silently regenerate the
			// dashboard/library/members evidence as unauthenticated states.
			test.skip(!CUSTOMER_SESSION, "W5_CUSTOMER_SESSION is required for workspace evidence");
			attachErrorCapture(page, vp.name);
			await seedSession(page, CUSTOMER_SESSION);

			await page.goto("/dashboard");
			await settle(page);
			await dismissOnboarding(page);
			await shoot(page, "dashboard", vp);

			await page.goto("/library");
			await settle(page);
			await dismissOnboarding(page);
			await shoot(page, "library", vp);

			// Chapter view is REQUIRED evidence. Assert a chapter cover card exists
			// (the customer session must have at least one library project) and only
			// then capture — never leave a stale/missing chapter-view screenshot.
			const coverCard = page.locator("button.cover-card").first();
			await expect(
				coverCard,
				"library must render at least one chapter cover card for chapter-view evidence",
			).toBeVisible({ timeout: 10_000 });
			await coverCard.click({ timeout: 5_000 });
			await settle(page);
			await dismissOnboarding(page);
			await shoot(page, "chapter-view", vp);

			await page.goto("/settings/members");
			await settle(page);
			await shoot(page, "members", vp);

			await page.goto("/settings/usage");
			await settle(page);
			await shoot(page, "billing-usage", vp);

			await page.goto("/settings/billing");
			await settle(page);
			await shoot(page, "billing", vp);
		});

		test(`editor + focus (dev-seeded) (${vp.name})`, async ({ page }) => {
			test.skip(!CUSTOMER_SESSION, "W5_CUSTOMER_SESSION is required for editor/focus evidence");
			attachErrorCapture(page, vp.name);
			await seedSession(page, CUSTOMER_SESSION);

			// The editor surface needs a loaded page. Use the project's own dev-seed
			// debug global (gated to DEV/VITE_E2E) — the same mechanism the existing
			// e2e suite uses. The seeded "flow208-project" is DEMO content; the
			// report labels these editor shots as dev-seeded, not real customer data.
			// Fail fast if the debug global is missing or seeding throws: a redirect/
			// 404/empty canvas must NOT be captured as a "loaded Fabric page".
			await page.goto("/dashboard");
			await page.waitForFunction(() => Boolean((window as any).__mangaWorkflowDebug), null, {
				timeout: 15_000,
			});
			await page.evaluate(async () => {
				const d = (window as any).__mangaWorkflowDebug;
				if (!d?.seedProject) throw new Error("__mangaWorkflowDebug.seedProject unavailable");
				await d.seedProject();
			});

			// Route to the seeded project's editor; the shell re-seeds on this route.
			await page.goto("/projects/flow208-project/pages/1/editor");
			await settle(page);
			// Assert the Fabric canvas actually mounted before claiming an editor shot.
			await expect(
				page.locator("canvas").first(),
				"editor must render a Fabric canvas before capturing editor evidence",
			).toBeVisible({ timeout: 15_000 });
			await page.waitForTimeout(1200);
			await shoot(page, "editor", vp);

			// Crop picker is REQUIRED evidence. Wait for the Crop dock tool, click it,
			// and fail if it cannot be surfaced — never skip the crop-picker capture.
			const cropBtn = page.getByRole("button", { name: /ครอป/ }).first();
			await expect(
				cropBtn,
				"editor crop dock tool must exist for editor-crop-picker evidence",
			).toBeVisible({ timeout: 10_000 });
			await cropBtn.click();
			await page.waitForTimeout(700);
			await shoot(page, "editor-crop-picker", vp);

			// Focus mode: a bare /focus navigation re-initialises the SPA without a
			// project, so the queue shows 0 tasks. Use the PROJECT-SCOPED focus route
			// (`/projects/<id>/focus`) which carries the projectId — the route-aware
			// shell re-seeds the debug project (with its tasks) and auto-selects the
			// first queue item as the active task. The report promises a single-task
			// workflow shot, so assert the active focus card before capturing.
			await page.goto("/projects/flow208-project/focus");
			await settle(page);
			await dismissOnboarding(page);
			await expect(
				page.locator('article[aria-label="งานที่กำลังโฟกัส"]'),
				"focus must show an active task card for focus evidence",
			).toBeVisible({ timeout: 10_000 });
			await shoot(page, "focus", vp);
		});

		test(`admin (${vp.name})`, async ({ page }) => {
			test.skip(!ADMIN_SESSION, "W5_ADMIN_SESSION is required for admin evidence");
			attachErrorCapture(page, vp.name);
			await seedSession(page, ADMIN_SESSION);
			await page.goto("/admin/workspaces");
			await settle(page);
			await shoot(page, "admin", vp);
		});
	});
}

test.afterAll(async () => {
	const log = resolve(EVIDENCE_DIR, "_console-errors.txt");
	await writeFile(log, consoleErrors.length ? consoleErrors.join("\n") : "(no console errors captured)\n");
});
