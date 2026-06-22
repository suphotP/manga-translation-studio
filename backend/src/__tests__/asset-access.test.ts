import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { v4 as uuid } from "uuid";
import { PROJECTS_DIR, serverConfig } from "../config.js";
import { images } from "../routes/images.js";
import {
	buildSignedAssetDeliveryUrls,
	buildSignedAssetPath,
	defaultAssetAccessEnforcementEnabled,
	extractAssetAccessToken,
	readAssetAccessConfig,
	signAssetAccessToken,
	verifyAssetAccessToken,
} from "../services/asset-access.js";

const previousEnv: Record<string, string | undefined> = {};
const createdProjectDirs: string[] = [];
// Wave 0 W0.1: these tests build legacy anonymous prototype projects (no
// userId, no workspaceId). The image route now denies that path unless the
// allowLegacyAnonymousProjects hatch is explicitly opted in.
let previousAllowLegacyAnonymousProjects: boolean;

beforeEach(() => {
	for (const key of ["ASSET_SIGNING_SECRET", "ASSET_ACCESS_TOKEN_TTL_SECONDS", "ASSET_ACCESS_TOKEN_MAX_TTL_SECONDS", "ASSET_SIGNED_URLS_ENFORCED", "ASSET_CDN_PROXY_BASE_URL", "R2_PUBLIC_BASE_URL", "NODE_ENV", "STORAGE_DRIVER"]) {
		previousEnv[key] = process.env[key];
	}
	process.env.ASSET_SIGNING_SECRET = "asset-access-test-secret-with-32-chars";
	delete process.env.ASSET_ACCESS_TOKEN_TTL_SECONDS;
	delete process.env.ASSET_ACCESS_TOKEN_MAX_TTL_SECONDS;
	delete process.env.ASSET_SIGNED_URLS_ENFORCED;
	delete process.env.ASSET_CDN_PROXY_BASE_URL;
	delete process.env.R2_PUBLIC_BASE_URL;
	delete process.env.NODE_ENV;
	delete process.env.STORAGE_DRIVER;
	previousAllowLegacyAnonymousProjects = serverConfig.allowLegacyAnonymousProjects;
	Object.assign(serverConfig as unknown as Record<string, unknown>, { allowLegacyAnonymousProjects: true });
});

afterEach(() => {
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	Object.assign(serverConfig as unknown as Record<string, unknown>, { allowLegacyAnonymousProjects: previousAllowLegacyAnonymousProjects });
	const projectsRoot = resolve(PROJECTS_DIR);
	for (const projectDir of createdProjectDirs.splice(0)) {
		const resolved = resolve(projectDir);
		if (!resolved.startsWith(projectsRoot)) {
			throw new Error(`Refusing to remove test directory outside projects root: ${resolved}`);
		}
		rmSync(resolved, { recursive: true, force: true });
	}
});

function createProjectWithImage() {
	const projectId = uuid();
	const imageId = `${uuid()}.png`;
	const projectDir = join(PROJECTS_DIR, projectId);
	mkdirSync(join(projectDir, "images"), { recursive: true });
	writeFileSync(join(projectDir, "state.json"), JSON.stringify({
		projectId,
		name: "Asset Access Test",
		createdAt: new Date().toISOString(),
		pages: [],
		currentPage: 0,
		targetLang: "th",
	}));
	writeFileSync(join(projectDir, "images", imageId), Buffer.from("image-bytes"));
	// The image serve gate now FAILS CLOSED on an image id with no authoritative
	// asset record (codex P0-2: an un-registered object — e.g. the raw pre-moderation
	// AI checkpoint — must not be fetchable by id). These auth-focused tests serve a
	// normal owned image, so register a passing/released record alongside the bytes,
	// matching what every real upload/AI/crop path writes.
	const now = new Date().toISOString();
	writeFileSync(join(projectDir, "assets.json"), JSON.stringify({
		[imageId]: {
			assetId: imageId,
			projectId,
			imageId,
			originalName: imageId,
			mimeType: "image/png",
			sizeBytes: 11,
			sha256: "0".repeat(64),
			storageDriver: "local",
			storageKey: `projects/${projectId}/images/${imageId}`,
			width: 1,
			height: 1,
			storageStatus: "released",
			moderation: { status: "passed", provider: "test", checkedAt: now },
			derivatives: [],
			createdAt: now,
			updatedAt: now,
		},
	}));
	createdProjectDirs.push(projectDir);
	return { projectId, imageId };
}

describe("asset access tokens", () => {
	test("signs and verifies project/image/purpose scoped tokens", () => {
		const now = 1_700_000_000_000;
		const token = signAssetAccessToken({
			projectId: "project-1",
			imageId: "image-1.png",
			purpose: "editor_preview",
			ttlSeconds: 120,
			now,
		});

		const result = verifyAssetAccessToken({
			token,
			projectId: "project-1",
			imageId: "image-1.png",
			purposes: ["editor_preview"],
			now: now + 30_000,
		});

		expect(result.ok).toBe(true);
		expect(result.payload).toEqual(expect.objectContaining({
			projectId: "project-1",
			imageId: "image-1.png",
			purpose: "editor_preview",
			exp: 1_700_000_120,
		}));
	});

	test("rejects expired, tampered, and wrong-purpose tokens", () => {
		const now = 1_700_000_000_000;
		const token = signAssetAccessToken({
			projectId: "project-1",
			imageId: "image-1.png",
			purpose: "thumbnail",
			ttlSeconds: 10,
			now,
		});
		const tampered = `${token.slice(0, -2)}xx`;

		expect(verifyAssetAccessToken({
			token,
			projectId: "project-1",
			imageId: "image-1.png",
			purposes: ["thumbnail"],
			now: now + 11_000,
		}).reason).toBe("expired");
		expect(verifyAssetAccessToken({
			token: tampered,
			projectId: "project-1",
			imageId: "image-1.png",
			purposes: ["thumbnail"],
			now,
		}).reason).toBe("bad_signature");
		expect(verifyAssetAccessToken({
			token,
			projectId: "project-1",
			imageId: "image-1.png",
			purposes: ["editor_preview"],
			now,
		}).reason).toBe("scope_mismatch");
	});

	test("builds signed paths and extracts tokens from supported carriers", () => {
		const token = "abc.def";

		expect(buildSignedAssetPath("/api/images/project/image.png", token)).toBe("/api/images/project/image.png?assetToken=abc.def");
		expect(buildSignedAssetPath("/api/images/project/image.png?width=96", token)).toBe("/api/images/project/image.png?width=96&assetToken=abc.def");
		expect(extractAssetAccessToken(token, undefined, undefined)).toBe(token);
		expect(extractAssetAccessToken(undefined, "Asset from-auth", undefined)).toBe("from-auth");
		expect(extractAssetAccessToken(undefined, undefined, "from-header")).toBe("from-header");
	});

	test("builds signed proxy delivery URLs without direct object storage exposure", () => {
		process.env.ASSET_CDN_PROXY_BASE_URL = "https://cdn.example.com/";
		process.env.R2_PUBLIC_BASE_URL = "https://public-r2.example.com/comic-workspace";

		const urls = buildSignedAssetDeliveryUrls({
			origin: "http://localhost:3001/",
			path: "/api/images/project/image.png",
			token: "abc.def",
		});

		expect(urls).toEqual({
			signedPath: "/api/images/project/image.png?assetToken=abc.def",
			signedUrl: "http://localhost:3001/api/images/project/image.png?assetToken=abc.def",
			signedCdnUrl: "https://cdn.example.com/api/images/project/image.png?assetToken=abc.def",
			deliveryMode: "signed_proxy",
			cdnProxyConfigured: true,
		});
		expect(urls.signedCdnUrl).not.toContain("public-r2.example.com");
	});

	test("reads enforcement and TTL settings from environment", () => {
		process.env.ASSET_SIGNED_URLS_ENFORCED = "true";
		process.env.ASSET_ACCESS_TOKEN_TTL_SECONDS = "600";
		process.env.ASSET_ACCESS_TOKEN_MAX_TTL_SECONDS = "900";

		expect(readAssetAccessConfig()).toEqual({
			enforced: true,
			defaultTtlSeconds: 600,
			maxTtlSeconds: 900,
		});
	});

	test("falls back for malformed signed asset TTL settings", () => {
		process.env.ASSET_ACCESS_TOKEN_TTL_SECONDS = "10abc";
		process.env.ASSET_ACCESS_TOKEN_MAX_TTL_SECONDS = "0";

		expect(readAssetAccessConfig()).toEqual(expect.objectContaining({
			defaultTtlSeconds: 300,
			maxTtlSeconds: 3600,
		}));
	});

	test("signed asset access enforcement is opt-in (default OFF), enabled only by explicit flag", () => {
		const originalNodeEnv = process.env.NODE_ENV;
		const originalStorageDriver = process.env.STORAGE_DRIVER;
		const originalEnforced = process.env.ASSET_SIGNED_URLS_ENFORCED;
		try {
			// Outside production enforcement stays off regardless of config.
			expect(defaultAssetAccessEnforcementEnabled()).toBe(false);
			expect(readAssetAccessConfig().enforced).toBe(false);

			// Codex finding #1: even in production with signed delivery configured
			// (signing secret set in beforeEach + r2 driver) enforcement stays OFF by
			// default — auto-enabling would 401 the frontend's bare image requests.
			process.env.NODE_ENV = "production";
			process.env.STORAGE_DRIVER = "r2";
			delete process.env.ASSET_SIGNED_URLS_ENFORCED;
			expect(defaultAssetAccessEnforcementEnabled()).toBe(false);
			expect(readAssetAccessConfig().enforced).toBe(false);

			// The explicit flag is the only way to turn enforcement on/off.
			process.env.ASSET_SIGNED_URLS_ENFORCED = "true";
			expect(readAssetAccessConfig().enforced).toBe(true);

			process.env.ASSET_SIGNED_URLS_ENFORCED = "false";
			expect(readAssetAccessConfig().enforced).toBe(false);
		} finally {
			if (originalNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = originalNodeEnv;
			}
			if (originalStorageDriver === undefined) {
				delete process.env.STORAGE_DRIVER;
			} else {
				process.env.STORAGE_DRIVER = originalStorageDriver;
			}
			if (originalEnforced === undefined) {
				delete process.env.ASSET_SIGNED_URLS_ENFORCED;
			} else {
				process.env.ASSET_SIGNED_URLS_ENFORCED = originalEnforced;
			}
		}
	});

	test("rejects malformed signed asset enforcement values", () => {
		process.env.NODE_ENV = "production";
		process.env.STORAGE_DRIVER = "r2";
		process.env.ASSET_SIGNED_URLS_ENFORCED = "treu";

		expect(() => readAssetAccessConfig()).toThrow("ASSET_SIGNED_URLS_ENFORCED must be true or false");
	});

	test("image routes require scoped asset tokens only when enforcement is enabled", async () => {
		process.env.ASSET_SIGNED_URLS_ENFORCED = "true";
		const { projectId, imageId } = createProjectWithImage();
		const app = new Hono();
		app.route("/api/images", images);
		const path = `/api/images/${projectId}/${imageId}`;

		const missing = await app.request(path);
		const wrongPurposeToken = signAssetAccessToken({
			projectId,
			imageId,
			purpose: "thumbnail",
			ttlSeconds: 120,
		});
		const wrongPurpose = await app.request(`${path}?assetToken=${encodeURIComponent(wrongPurposeToken)}`);
		const okToken = signAssetAccessToken({
			projectId,
			imageId,
			purpose: "editor_preview",
			ttlSeconds: 120,
		});
		const ok = await app.request(`${path}?assetToken=${encodeURIComponent(okToken)}`);

		expect(missing.status).toBe(401);
		expect(await missing.json()).toEqual(expect.objectContaining({
			code: "asset_access_token_required",
			reason: "missing",
		}));
		expect(wrongPurpose.status).toBe(401);
		expect((await wrongPurpose.json()).reason).toBe("scope_mismatch");
		expect(ok.status).toBe(200);
		expect(await ok.text()).toBe("image-bytes");
	});

	test("signed image responses cap public cache lifetime to the asset token TTL", async () => {
		process.env.ASSET_SIGNED_URLS_ENFORCED = "true";
		const { projectId, imageId } = createProjectWithImage();
		const app = new Hono();
		app.route("/api/images", images);
		const token = signAssetAccessToken({
			projectId,
			imageId,
			purpose: "editor_preview",
			ttlSeconds: 120,
		});

		const response = await app.request(`/api/images/${projectId}/${imageId}?assetToken=${encodeURIComponent(token)}`);
		const cacheControl = response.headers.get("Cache-Control") ?? "";
		const maxAge = Number(cacheControl.match(/max-age=(\d+)/)?.[1] ?? "0");

		expect(response.status).toBe(200);
		expect(maxAge).toBeGreaterThan(0);
		expect(maxAge).toBeLessThanOrEqual(120);
		expect(maxAge).toBeLessThan(3600);
	});

	test("access-token route reports signed CDN proxy URL when configured", async () => {
		process.env.ASSET_CDN_PROXY_BASE_URL = "https://cdn.example.com";
		const { projectId, imageId } = createProjectWithImage();
		const app = new Hono();
		app.route("/api/images", images);

		const response = await app.request(`/api/images/${projectId}/${imageId}/access-token?purpose=thumbnail`);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.signedPath).toContain("/thumbnail?assetToken=");
		expect(String(body.signedCdnUrl).startsWith(`https://cdn.example.com/api/images/${projectId}/${imageId}/thumbnail?assetToken=`)).toBe(true);
		expect(body.delivery).toEqual(expect.objectContaining({
			mode: "signed_proxy",
			cdnProxyConfigured: true,
		}));
	});
});

// Wave: browser <img src> can't send a Bearer header. A valid signed assetToken
// must authorize the asset-serving routes on its own — even for an OWNED project
// (userId set, legacy-anonymous hatch CLOSED) where the JWT-only ownership check
// would otherwise 401. The token is minted only after ownership is verified and
// is HMAC-scoped to (projectId, imageId, purpose), so it is safe authorization.
describe("signed asset token authorizes browser <img> without a Bearer header", () => {
	function createOwnedProjectWithImage(userId: string) {
		const projectId = uuid();
		const imageId = `${uuid()}.png`;
		const projectDir = join(PROJECTS_DIR, projectId);
		mkdirSync(join(projectDir, "images"), { recursive: true });
		writeFileSync(join(projectDir, "state.json"), JSON.stringify({
			projectId,
			userId,
			name: "Owned Asset Test",
			createdAt: new Date().toISOString(),
			pages: [],
			currentPage: 0,
			targetLang: "th",
		}));
		writeFileSync(join(projectDir, "images", imageId), Buffer.from("image-bytes"));
		// Register a passing/released asset record so the serve gate (which now fails
		// closed on a missing record — codex P0-2) treats this owned image as servable.
		const now = new Date().toISOString();
		writeFileSync(join(projectDir, "assets.json"), JSON.stringify({
			[imageId]: {
				assetId: imageId,
				projectId,
				imageId,
				originalName: imageId,
				mimeType: "image/png",
				sizeBytes: 11,
				sha256: "0".repeat(64),
				storageDriver: "local",
				storageKey: `projects/${projectId}/images/${imageId}`,
				width: 1,
				height: 1,
				storageStatus: "released",
				moderation: { status: "passed", provider: "test", checkedAt: now },
				derivatives: [],
				createdAt: now,
				updatedAt: now,
			},
		}));
		createdProjectDirs.push(projectDir);
		return { projectId, imageId };
	}

	// Close the legacy-anonymous hatch so an unauthenticated request to an
	// owned project is denied unless a signed token authorizes it.
	beforeEach(() => {
		Object.assign(serverConfig as unknown as Record<string, unknown>, { allowLegacyAnonymousProjects: false });
	});

	test("owned-project image 401s without a Bearer header or token (the original bug)", async () => {
		const { projectId, imageId } = createOwnedProjectWithImage("owner-1");
		const app = new Hono();
		app.route("/api/images", images);

		const res = await app.request(`/api/images/${projectId}/${imageId}`);
		expect(res.status).toBe(401);
	});

	test("a valid signed token serves the owned-project image with NO Bearer header (the fix)", async () => {
		const { projectId, imageId } = createOwnedProjectWithImage("owner-1");
		const app = new Hono();
		app.route("/api/images", images);

		const token = signAssetAccessToken({ projectId, imageId, purpose: "editor_preview", ttlSeconds: 120 });
		const res = await app.request(`/api/images/${projectId}/${imageId}?assetToken=${encodeURIComponent(token)}`);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("image-bytes");
	});

	test("a token scoped to a DIFFERENT project does not authorize this project (cross-project denial)", async () => {
		const a = createOwnedProjectWithImage("owner-a");
		const b = createOwnedProjectWithImage("owner-b");
		const app = new Hono();
		app.route("/api/images", images);

		// Token minted for project A's image, replayed on project B's URL.
		const tokenForA = signAssetAccessToken({ projectId: a.projectId, imageId: a.imageId, purpose: "editor_preview", ttlSeconds: 120 });
		const res = await app.request(`/api/images/${b.projectId}/${b.imageId}?assetToken=${encodeURIComponent(tokenForA)}`);

		// Scope mismatch → token not accepted → JWT ownership fallback → 401 (no Bearer).
		expect(res.status).toBe(401);
	});

	test("a wrong-purpose token does not authorize the route (purpose scoping)", async () => {
		const { projectId, imageId } = createOwnedProjectWithImage("owner-1");
		const app = new Hono();
		app.route("/api/images", images);

		// `thumbnail` purpose is not accepted by the full-image route.
		const token = signAssetAccessToken({ projectId, imageId, purpose: "thumbnail", ttlSeconds: 120 });
		const res = await app.request(`/api/images/${projectId}/${imageId}?assetToken=${encodeURIComponent(token)}`);

		expect(res.status).toBe(401);
	});

	test("an expired token does not authorize the route", async () => {
		const { projectId, imageId } = createOwnedProjectWithImage("owner-1");
		const app = new Hono();
		app.route("/api/images", images);

		const now = Date.now();
		const token = signAssetAccessToken({ projectId, imageId, purpose: "editor_preview", ttlSeconds: 1, now: now - 10_000 });
		const res = await app.request(`/api/images/${projectId}/${imageId}?assetToken=${encodeURIComponent(token)}`);

		expect(res.status).toBe(401);
	});
});

// SECURITY (codex P0-1/P0-2/P0-3): the image serve gate is the server-authoritative
// moderation enforcement point for direct-by-id reads (in-editor preview AND
// single-page export download). It must:
//   - DENY an id with NO asset record (un-registered / pre-moderation object such
//     as the raw AI provider checkpoint) — P0-2/P0-3.
//   - serve a genuine `needs_review` for in-editor preview, but NOT for `export`.
//   - DENY a quarantined (provider-failure fail-closed) or blocked asset on EVERY
//     purpose.
describe("serve gate enforces moderation by purpose (codex P0)", () => {
	function createProjectWithModeratedImage(opts: {
		moderationStatus: "passed" | "needs_review" | "blocked";
		storageStatus: "released" | "quarantined" | "blocked";
		register?: boolean;
		imageId?: string;
	}): { projectId: string; imageId: string } {
		const projectId = uuid();
		const imageId = opts.imageId ?? `${uuid()}.png`;
		const projectDir = join(PROJECTS_DIR, projectId);
		mkdirSync(join(projectDir, "images"), { recursive: true });
		writeFileSync(join(projectDir, "state.json"), JSON.stringify({
			projectId, name: "Serve Gate Test", createdAt: new Date().toISOString(),
			pages: [], currentPage: 0, targetLang: "th",
		}));
		writeFileSync(join(projectDir, "images", imageId), Buffer.from("image-bytes"));
		if (opts.register !== false) {
			const now = new Date().toISOString();
			writeFileSync(join(projectDir, "assets.json"), JSON.stringify({
				[imageId]: {
					assetId: imageId, projectId, imageId, originalName: imageId, mimeType: "image/png",
					sizeBytes: 11, sha256: "0".repeat(64), storageDriver: "local",
					storageKey: `projects/${projectId}/images/${imageId}`, width: 1, height: 1,
					storageStatus: opts.storageStatus,
					moderation: { status: opts.moderationStatus, provider: "test", checkedAt: now },
					derivatives: [], createdAt: now, updatedAt: now,
				},
			}));
		}
		createdProjectDirs.push(projectDir);
		return { projectId, imageId };
	}

	function buildApp() {
		const app = new Hono();
		app.route("/api/images", images);
		return app;
	}

	function serveUrl(projectId: string, imageId: string, purpose: string): string {
		const token = signAssetAccessToken({ projectId, imageId, purpose: purpose as any, ttlSeconds: 120 });
		return `/api/images/${projectId}/${imageId}?assetToken=${encodeURIComponent(token)}`;
	}

	test("an id with NO asset record is denied (403 asset_not_registered) — AI checkpoint not servable pre-moderation", async () => {
		// Mimic the raw AI provider checkpoint: a project image written to disk under a
		// predictable id with NO asset record. It must NOT be fetchable by id.
		const { projectId, imageId } = createProjectWithModeratedImage({
			moderationStatus: "passed", storageStatus: "released", register: false,
			imageId: "aijob_provider_test-job-123.png",
		});
		const res = await buildApp().request(serveUrl(projectId, imageId, "editor_preview"));
		expect(res.status).toBe(403);
		expect((await res.json()).code).toBe("asset_not_registered");
	});

	test("a PASSED asset serves on both editor_preview and export", async () => {
		const { projectId, imageId } = createProjectWithModeratedImage({ moderationStatus: "passed", storageStatus: "released" });
		expect((await buildApp().request(serveUrl(projectId, imageId, "editor_preview"))).status).toBe(200);
		expect((await buildApp().request(serveUrl(projectId, imageId, "export"))).status).toBe(200);
	});

	test("a genuine needs_review serves for editor_preview but is DENIED for export", async () => {
		const { projectId, imageId } = createProjectWithModeratedImage({ moderationStatus: "needs_review", storageStatus: "released" });
		expect((await buildApp().request(serveUrl(projectId, imageId, "editor_preview"))).status).toBe(200);
		const exportRes = await buildApp().request(serveUrl(projectId, imageId, "export"));
		expect(exportRes.status).toBe(403);
		expect((await exportRes.json()).code).toBe("asset_not_exportable");
	});

	test("a QUARANTINED (provider-failure fail-closed) asset is denied on EVERY purpose", async () => {
		const { projectId, imageId } = createProjectWithModeratedImage({ moderationStatus: "needs_review", storageStatus: "quarantined" });
		expect((await buildApp().request(serveUrl(projectId, imageId, "editor_preview"))).status).toBe(403);
		expect((await buildApp().request(serveUrl(projectId, imageId, "export"))).status).toBe(403);
	});

	test("a BLOCKED asset is denied on EVERY purpose", async () => {
		const { projectId, imageId } = createProjectWithModeratedImage({ moderationStatus: "blocked", storageStatus: "blocked" });
		expect((await buildApp().request(serveUrl(projectId, imageId, "editor_preview"))).status).toBe(403);
		expect((await buildApp().request(serveUrl(projectId, imageId, "export"))).status).toBe(403);
	});

	// codex P1-2: raw ORIGINAL download/serve must be held to the export bar
	// (moderation `passed`) — a needs_review asset previously used the laxer preview
	// bar, so it could be downloaded as the raw original before review. In-editor
	// PREVIEW (editor_preview) deliberately STILL serves needs_review (its review
	// banner UX is intended).
	test("a genuine needs_review is DENIED for original (passed-only) but STILL serves for editor_preview", async () => {
		const { projectId, imageId } = createProjectWithModeratedImage({ moderationStatus: "needs_review", storageStatus: "released" });
		const originalRes = await buildApp().request(serveUrl(projectId, imageId, "original"));
		expect(originalRes.status).toBe(403);
		expect((await originalRes.json()).code).toBe("asset_not_downloadable");
		// PREVIEW UX preserved: needs_review still serves for in-editor preview.
		expect((await buildApp().request(serveUrl(projectId, imageId, "editor_preview"))).status).toBe(200);
	});

	test("a PASSED asset still serves for original", async () => {
		const { projectId, imageId } = createProjectWithModeratedImage({ moderationStatus: "passed", storageStatus: "released" });
		expect((await buildApp().request(serveUrl(projectId, imageId, "original"))).status).toBe(200);
	});

	// codex P1-2 (mint side, documented): the access-token MINT route runs the SAME
	// assertAssetServable(purpose) (images.ts ~2154) BEFORE signing a token, so a
	// needs_review asset can no longer mint an `original` token (the download/presign
	// precursor) — closing the mint side as well as the serve side proven above. We do
	// NOT add a separate HTTP /access-token mint test here: the unauthed mint route is
	// subject to PRE-EXISTING suite-wide auth-mock pollution (the existing
	// "access-token route reports signed CDN proxy URL" test fails identically under
	// the full `bun test`). The token-authorized serve-path tests above already
	// exercise the exact gate end-to-end, robustly, in the full suite.
});

// SECURITY (codex P0 round-3 — CSAM-laundering fix): the serve gate now FAILS CLOSED
// on a missing asset record (NO on-demand "grandfather on first serve"). The old
// on-serve grandfather trusted CLIENT-writable project-state references — an attacker
// could park an unmoderated object, save a crafted state referencing its id, and have
// the serve path register it `passed` (a NEW laundering bypass). Legacy pre-registry
// user images are instead given a `passed` record by the SERVER-SIDE, deploy-time
// backfillStateReferencedAssets(). These tests assert: (1) a fresh/missing-record
// reference is ALWAYS denied at serve time (even when state-referenced — the
// laundering vector), and (2) the backfill registers genuinely-existing legacy
// references and serves them afterwards.
describe("missing-record serve gate fails closed; legacy is grandfathered by deploy-time backfill (codex P0)", () => {
	async function tinyPng(): Promise<Buffer> {
		const sharp = (await import("sharp")).default;
		return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
	}

	// 2026-01-01: well before ASSET_REGISTRY_GRANDFATHER_CUTOFF_MS (2026-06-01).
	const PRE_CUTOFF_SECONDS = Date.UTC(2026, 0, 1, 0, 0, 0) / 1000;
	function backdateToBeforeCutoff(path: string): void {
		utimesSync(path, PRE_CUTOFF_SECONDS, PRE_CUTOFF_SECONDS);
	}

	function buildApp() {
		const app = new Hono();
		app.route("/api/images", images);
		return app;
	}

	function serveUrl(projectId: string, imageId: string, purpose: string): string {
		const token = signAssetAccessToken({ projectId, imageId, purpose: purpose as any, ttlSeconds: 120 });
		return `/api/images/${projectId}/${imageId}?assetToken=${encodeURIComponent(token)}`;
	}

	// Create a project whose state references `referencedImageId` (as a real page
	// background) but does NOT reference `orphanImageId`. NEITHER has an asset record
	// (assets.json is intentionally absent) — exactly the pre-registry legacy shape.
	async function createLegacyProject(): Promise<{ projectId: string; referencedImageId: string; orphanImageId: string }> {
		const projectId = uuid();
		const referencedImageId = `${uuid()}.png`;
		const orphanImageId = `aijob_provider_${uuid()}.png`;
		const projectDir = join(PROJECTS_DIR, projectId);
		mkdirSync(join(projectDir, "images"), { recursive: true });
		writeFileSync(join(projectDir, "state.json"), JSON.stringify({
			projectId,
			name: "Legacy Pre-Registry Project",
			createdAt: new Date().toISOString(),
			currentPage: 0,
			targetLang: "th",
			// Real page references the legacy user image; the orphan/checkpoint is NOT here.
			pages: [{ imageId: referencedImageId, imageName: referencedImageId, textLayers: [], pendingAiJobs: [], coverRect: null }],
		}));
		const png = await tinyPng();
		writeFileSync(join(projectDir, "images", referencedImageId), png);
		writeFileSync(join(projectDir, "images", orphanImageId), png);
		// Backdate BOTH object mtimes to BEFORE the registry cutoff so they look like
		// genuine pre-registry legacy uploads (the only thing the backfill may
		// grandfather). The aijob_provider_* orphan is still excluded by prefix even
		// though it is pre-cutoff — proving the prefix-exclude defense.
		backdateToBeforeCutoff(join(projectDir, "images", referencedImageId));
		backdateToBeforeCutoff(join(projectDir, "images", orphanImageId));
		// NO assets.json — both ids have no asset record.
		createdProjectDirs.push(projectDir);
		return { projectId, referencedImageId, orphanImageId };
	}

	test("LAUNDERING BLOCKED: a brand-new unregistered object referenced by a fresh client save is NOT served/registered (403 stays)", async () => {
		// Mimic the exploit: an unmoderated object (e.g. a raw aijob_provider_* checkpoint,
		// or any newly-parked blob) exists, and a CLIENT save references its id from live
		// project state. Pre-fix, the on-serve grandfather would see the state reference and
		// register it `passed`, laundering it into export. The serve gate must now deny it.
		const projectId = uuid();
		const launderedImageId = `aijob_provider_${uuid()}.png`;
		const projectDir = join(PROJECTS_DIR, projectId);
		mkdirSync(join(projectDir, "images"), { recursive: true });
		// Crafted client state references the unmoderated object as a page background.
		writeFileSync(join(projectDir, "state.json"), JSON.stringify({
			projectId,
			name: "Laundering Attempt",
			createdAt: new Date().toISOString(),
			currentPage: 0,
			targetLang: "th",
			pages: [{ imageId: launderedImageId, imageName: launderedImageId, textLayers: [], pendingAiJobs: [], coverRect: null }],
		}));
		writeFileSync(join(projectDir, "images", launderedImageId), await tinyPng());
		// NO assets.json — the object is genuinely unregistered/unmoderated.
		createdProjectDirs.push(projectDir);

		// editor_preview AND export both fail closed (the laundering vector is the same).
		const previewRes = await buildApp().request(serveUrl(projectId, launderedImageId, "editor_preview"));
		expect(previewRes.status).toBe(403);
		expect(((await previewRes.json()) as { code?: string }).code).toBe("asset_not_registered");
		const exportRes = await buildApp().request(serveUrl(projectId, launderedImageId, "export"));
		expect(exportRes.status).toBe(403);

		// And serving it did NOT lazily register it as a side effect (stays unmoderated).
		const { getAssetRecordAuthoritative } = await import("../services/assets.js");
		expect(await getAssetRecordAuthoritative(projectId, launderedImageId)).toBeUndefined();
	});

	test("a legacy state-referenced object with NO record is DENIED at serve time UNTIL the backfill runs", async () => {
		const { projectId, referencedImageId } = await createLegacyProject();
		// Before backfill: the serve gate fails closed (no on-demand grandfather).
		const before = await buildApp().request(serveUrl(projectId, referencedImageId, "editor_preview"));
		expect(before.status).toBe(403);
		expect(((await before.json()) as { code?: string }).code).toBe("asset_not_registered");

		// Run the deploy-time, SERVER-SIDE backfill over this project's existing corpus.
		const { backfillStateReferencedAssets, getAssetRecordAuthoritative } = await import("../services/assets.js");
		const result = await backfillStateReferencedAssets({ projectIds: [projectId] });
		expect(result.registered).toBeGreaterThanOrEqual(1);

		// After backfill: the legacy reference has a `passed`/released record and serves.
		const record = await getAssetRecordAuthoritative(projectId, referencedImageId);
		expect(record?.storageStatus).toBe("released");
		expect(record?.moderation.status).toBe("passed");
		const after = await buildApp().request(serveUrl(projectId, referencedImageId, "editor_preview"));
		expect(after.status).toBe(200);
		const exportRes = await buildApp().request(serveUrl(projectId, referencedImageId, "export"));
		expect(exportRes.status).toBe(200);
	});

	test("BACKFILL does NOT register an UNREFERENCED object (raw AI checkpoint / orphan); it stays denied", async () => {
		const { projectId, orphanImageId } = await createLegacyProject();
		const { backfillStateReferencedAssets, getAssetRecordAuthoritative } = await import("../services/assets.js");
		await backfillStateReferencedAssets({ projectIds: [projectId] });

		// The orphan (NOT state-referenced) was never registered by the backfill...
		expect(await getAssetRecordAuthoritative(projectId, orphanImageId)).toBeUndefined();
		// ...and still 403s at serve time.
		const res = await buildApp().request(serveUrl(projectId, orphanImageId, "editor_preview"));
		expect(res.status).toBe(403);
		expect(((await res.json()) as { code?: string }).code).toBe("asset_not_registered");
	});

	test("BACKFILL is idempotent: re-running it does not re-register (already-registered count)", async () => {
		const { projectId } = await createLegacyProject();
		const { backfillStateReferencedAssets } = await import("../services/assets.js");
		const first = await backfillStateReferencedAssets({ projectIds: [projectId] });
		expect(first.registered).toBeGreaterThanOrEqual(1);
		const second = await backfillStateReferencedAssets({ projectIds: [projectId] });
		expect(second.registered).toBe(0);
		expect(second.alreadyRegistered).toBeGreaterThanOrEqual(1);
	});

	test("collectStateReferencedImageIds excludes the raw AI provider checkpoint id", async () => {
		const { collectStateReferencedImageIds } = await import("../services/assets.js");
		const ids = collectStateReferencedImageIds({
			projectId: "p", userId: "u", name: "n", createdAt: "t", currentPage: 0, targetLang: "th",
			coverImageId: "cover.png",
			aiReviewMarkers: [{ id: "m", jobId: "j", pageIndex: 0, imageId: "page.png", region: { x: 0, y: 0, w: 1, h: 1 }, status: "pending" as any, tier: "clean-pro" as any, resultImageId: "result_final.png", createdAt: "t", updatedAt: "t" }],
			pages: [{
				imageId: "page.png", imageName: "page.png", textLayers: [], pendingAiJobs: [], coverRect: null,
				edits: { imageId: "baked.png" },
				imageLayers: [{ id: "L", imageId: "overlay.png", imageName: "overlay.png", x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1, index: 0 }] as any,
				imageEditLayers: [{ id: "E", kind: "fill-mask", target: "page-background", visible: true, opacity: 1, sourceImageId: "page.png", bbox: { x: 0, y: 0, w: 1, h: 1 }, index: 0, tool: { id: "bubble-clean" }, createdAt: "t", payload: { type: "fill-mask", maskAssetId: "mask.png", maskEncoding: "png-alpha", fill: { r: 0, g: 0, b: 0, a: 255 } } }] as any,
			}],
		} as any);
		// Real referenced ids are present...
		expect(ids.has("cover.png")).toBe(true);
		expect(ids.has("page.png")).toBe(true);
		expect(ids.has("baked.png")).toBe(true);
		expect(ids.has("overlay.png")).toBe(true);
		expect(ids.has("mask.png")).toBe(true);
		expect(ids.has("result_final.png")).toBe(true);
		// ...but a raw provider checkpoint (never in ProjectState) is NOT.
		expect(ids.has("aijob_provider_xyz.png")).toBe(false);
	});

	// Build a project whose state references exactly `imageId` (a page background) and
	// write the object to disk. Caller controls the object mtime via `backdate`.
	async function createProjectReferencing(imageId: string, opts: { backdate: boolean }): Promise<string> {
		const projectId = uuid();
		const projectDir = join(PROJECTS_DIR, projectId);
		mkdirSync(join(projectDir, "images"), { recursive: true });
		writeFileSync(join(projectDir, "state.json"), JSON.stringify({
			projectId,
			name: "ref",
			createdAt: new Date().toISOString(),
			currentPage: 0,
			targetLang: "th",
			pages: [{ imageId, imageName: imageId, textLayers: [], pendingAiJobs: [], coverRect: null }],
		}));
		writeFileSync(join(projectDir, "images", imageId), await tinyPng());
		if (opts.backdate) backdateToBeforeCutoff(join(projectDir, "images", imageId));
		createdProjectDirs.push(projectDir);
		return projectId;
	}

	// (a) Backfill laundering via NEW (post-cutoff) object: a client saves a reference
	// to an unregistered object that was just written (mtime = now, AFTER the cutoff).
	// The immutable time-cutoff defense means the backfill must NOT grandfather it.
	test("BACKFILL does NOT grandfather a NEW (post-cutoff) state-referenced object — stays denied (codex P0 round-4)", async () => {
		const freshImageId = `${uuid()}.png`;
		// NOT backdated → object mtime is `now`, which is >= the 2026-06-01 cutoff.
		const projectId = await createProjectReferencing(freshImageId, { backdate: false });

		const { backfillStateReferencedAssets, getAssetRecordAuthoritative } = await import("../services/assets.js");
		const result = await backfillStateReferencedAssets({ projectIds: [projectId] });
		expect(result.registered).toBe(0);
		expect(result.skipped).toBeGreaterThanOrEqual(1);
		// No record minted → still unregistered → serve gate fails closed.
		expect(await getAssetRecordAuthoritative(projectId, freshImageId)).toBeUndefined();
		const res = await buildApp().request(serveUrl(projectId, freshImageId, "editor_preview"));
		expect(res.status).toBe(403);
		expect(((await res.json()) as { code?: string }).code).toBe("asset_not_registered");
	});

	// (b) Prefix-exclude: a raw aijob_provider_* checkpoint is NEVER grandfathered, even
	// when it IS state-referenced AND pre-cutoff (the strongest attacker position).
	test("BACKFILL never grandfathers an aijob_provider_* object even if state-referenced + pre-cutoff (codex P0 round-4)", async () => {
		const checkpointId = `aijob_provider_${uuid()}.png`;
		const projectId = await createProjectReferencing(checkpointId, { backdate: true });

		const { backfillStateReferencedAssets, getAssetRecordAuthoritative } = await import("../services/assets.js");
		const result = await backfillStateReferencedAssets({ projectIds: [projectId] });
		expect(result.registered).toBe(0);
		expect(await getAssetRecordAuthoritative(projectId, checkpointId)).toBeUndefined();
		const res = await buildApp().request(serveUrl(projectId, checkpointId, "editor_preview"));
		expect(res.status).toBe(403);
	});

	// (c) Genuine pre-cutoff legacy object IS grandfathered (no false 403). Mirrors the
	// "...DENIED UNTIL backfill runs" test above; asserted explicitly for the round-4 trio.
	test("BACKFILL DOES grandfather a genuine pre-cutoff legacy state-referenced object (codex P0 round-4)", async () => {
		const legacyId = `${uuid()}.png`;
		const projectId = await createProjectReferencing(legacyId, { backdate: true });

		const { backfillStateReferencedAssets, getAssetRecordAuthoritative } = await import("../services/assets.js");
		const result = await backfillStateReferencedAssets({ projectIds: [projectId] });
		expect(result.registered).toBeGreaterThanOrEqual(1);
		const record = await getAssetRecordAuthoritative(projectId, legacyId);
		expect(record?.storageStatus).toBe("released");
		expect(record?.moderation.status).toBe("passed");
		expect((await buildApp().request(serveUrl(projectId, legacyId, "editor_preview"))).status).toBe(200);
	});
});
