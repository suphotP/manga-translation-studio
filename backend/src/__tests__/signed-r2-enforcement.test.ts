import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { v4 as uuid } from "uuid";
import { restoreAssetRecord } from "../services/assets.js";
import type { AssetRecord } from "../types/index.js";
import {
	defaultR2PresignedDeliveryEnabled,
	isR2FullyConfigured,
	PROJECTS_DIR,
	r2PresignCapable,
	r2PresignedDeliveryEnabled,
	readR2PresignConfig,
	serverConfig,
} from "../config.js";
import {
	defaultAssetAccessEnforcementEnabled,
	readAssetAccessConfig,
	resetUnenforcedProductionDeliveryObservation,
	resolvePresignedR2Delivery,
	signedAssetDeliveryConfigured,
} from "../services/asset-access.js";
import { images } from "../routes/images.js";
import { createR2ObjectStorage, objectStorage, type ObjectStorage } from "../services/storage.js";

// Env keys this suite mutates. Snapshotted/restored around every test so it
// never leaks production-like config into sibling suites.
const ENV_KEYS = [
	"NODE_ENV",
	"STORAGE_DRIVER",
	"ASSET_SIGNING_SECRET",
	"ASSET_SIGNED_URLS_ENFORCED",
	"ASSET_R2_PRESIGNED_DELIVERY_ENABLED",
	"ASSET_R2_PRESIGN_TTL_SECONDS",
	"ASSET_R2_PRESIGN_MAX_TTL_SECONDS",
	"R2_ACCOUNT_ID",
	"R2_BUCKET",
	"R2_ENDPOINT",
	"R2_ACCESS_KEY_ID",
	"R2_SECRET_ACCESS_KEY",
	"R2_PUBLIC_BASE_URL",
] as const;

const previousEnv: Record<string, string | undefined> = {};
const createdProjectDirs: string[] = [];
// Wave 0 W0.1: legacy anonymous prototype projects (no userId/workspaceId).
let previousAllowLegacyAnonymousProjects: boolean;

function createProjectWithImage() {
	const projectId = uuid();
	const imageId = `${uuid()}.png`;
	const projectDir = join(PROJECTS_DIR, projectId);
	mkdirSync(join(projectDir, "images"), { recursive: true });
	writeFileSync(join(projectDir, "state.json"), JSON.stringify({
		projectId,
		name: "Signed R2 Enforcement Test",
		createdAt: new Date().toISOString(),
		pages: [],
		currentPage: 0,
		targetLang: "th",
	}));
	writeFileSync(join(projectDir, "images", imageId), Buffer.from("image-bytes"));
	// Register a passing/released asset record so the serve gate (which now fails
	// closed on a missing record — codex P0-2) treats this image as servable.
	const now = new Date().toISOString();
	writeFileSync(join(projectDir, "assets.json"), JSON.stringify({
		[imageId]: {
			assetId: imageId, projectId, imageId, originalName: imageId, mimeType: "image/png",
			sizeBytes: 11, sha256: "0".repeat(64), storageDriver: "local",
			storageKey: `projects/${projectId}/images/${imageId}`, width: 1, height: 1,
			storageStatus: "released", moderation: { status: "passed", provider: "test", checkedAt: now },
			derivatives: [], createdAt: now, updatedAt: now,
		},
	}));
	createdProjectDirs.push(projectDir);
	return { projectId, imageId };
}

const MOCK_R2_CREDS = {
	accountId: "",
	bucket: "comic-workspace",
	endpoint: "https://example.r2.cloudflarestorage.com",
	accessKeyId: "mock-access-key-id",
	secretAccessKey: "mock-secret-access-key",
};

function configureFullR2Env(): void {
	process.env.STORAGE_DRIVER = "r2";
	process.env.R2_BUCKET = MOCK_R2_CREDS.bucket;
	process.env.R2_ENDPOINT = MOCK_R2_CREDS.endpoint;
	process.env.R2_ACCESS_KEY_ID = MOCK_R2_CREDS.accessKeyId;
	process.env.R2_SECRET_ACCESS_KEY = MOCK_R2_CREDS.secretAccessKey;
}

function clearR2Env(): void {
	delete process.env.STORAGE_DRIVER;
	delete process.env.R2_ACCOUNT_ID;
	delete process.env.R2_BUCKET;
	delete process.env.R2_ENDPOINT;
	delete process.env.R2_ACCESS_KEY_ID;
	delete process.env.R2_SECRET_ACCESS_KEY;
	delete process.env.R2_PUBLIC_BASE_URL;
}

beforeEach(() => {
	for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
	for (const key of ENV_KEYS) delete process.env[key];
	resetUnenforcedProductionDeliveryObservation();
	previousAllowLegacyAnonymousProjects = serverConfig.allowLegacyAnonymousProjects;
	Object.assign(serverConfig as unknown as Record<string, unknown>, { allowLegacyAnonymousProjects: true });
});

afterEach(() => {
	mock.restore();
	for (const key of ENV_KEYS) {
		const value = previousEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	Object.assign(serverConfig as unknown as Record<string, unknown>, { allowLegacyAnonymousProjects: previousAllowLegacyAnonymousProjects });
	resetUnenforcedProductionDeliveryObservation();
	const projectsRoot = resolve(PROJECTS_DIR);
	for (const projectDir of createdProjectDirs.splice(0)) {
		const resolved = resolve(projectDir);
		if (!resolved.startsWith(projectsRoot)) {
			throw new Error(`Refusing to remove test directory outside projects root: ${resolved}`);
		}
		rmSync(resolved, { recursive: true, force: true });
	}
});

describe("signed-asset enforcement default (opt-in)", () => {
	test("stays off outside production regardless of configuration", () => {
		configureFullR2Env();
		process.env.ASSET_SIGNING_SECRET = "asset-signing-secret-with-32-characters";

		expect(defaultAssetAccessEnforcementEnabled("development")).toBe(false);
		expect(defaultAssetAccessEnforcementEnabled(undefined)).toBe(false);
		// NODE_ENV unset → readAssetAccessConfig should not enforce.
		expect(readAssetAccessConfig().enforced).toBe(false);
	});

	test("stays OFF by default in production even when signed delivery is configured (opt-in only)", () => {
		// Codex finding #1: enabling enforcement auto-magically in production would
		// 401 every bare /api/images request the frontend still makes (it does not
		// yet attach signed tokens), wiping the workspace. So the default is OFF and
		// signed delivery being configured does NOT flip it on.
		process.env.NODE_ENV = "production";
		configureFullR2Env();

		expect(signedAssetDeliveryConfigured()).toBe(true);
		expect(defaultAssetAccessEnforcementEnabled()).toBe(false);
		expect(readAssetAccessConfig().enforced).toBe(false);
	});

	test("stays OFF by default in production with only a signing secret (opt-in only)", () => {
		process.env.NODE_ENV = "production";
		process.env.ASSET_SIGNING_SECRET = "asset-signing-secret-with-32-characters";

		expect(signedAssetDeliveryConfigured()).toBe(true);
		expect(defaultAssetAccessEnforcementEnabled()).toBe(false);
		expect(readAssetAccessConfig().enforced).toBe(false);
	});

	test("stays OFF in production when signed delivery is NOT configured", () => {
		process.env.NODE_ENV = "production";
		// No R2 credentials and no signing secret → delivery is not configured.
		expect(signedAssetDeliveryConfigured()).toBe(false);
		expect(defaultAssetAccessEnforcementEnabled()).toBe(false);
		expect(readAssetAccessConfig().enforced).toBe(false);
	});

	test("explicit ASSET_SIGNED_URLS_ENFORCED is the ONLY way to turn enforcement on", () => {
		process.env.NODE_ENV = "production";
		configureFullR2Env();

		// Configured but no explicit flag → still off.
		expect(readAssetAccessConfig().enforced).toBe(false);

		process.env.ASSET_SIGNED_URLS_ENFORCED = "false";
		expect(readAssetAccessConfig().enforced).toBe(false);

		process.env.ASSET_SIGNED_URLS_ENFORCED = "true";
		expect(readAssetAccessConfig().enforced).toBe(true);

		// Explicit opt-in is honored even outside production / when unconfigured —
		// it is the operator's deliberate choice (paired with the frontend slice).
		clearR2Env();
		delete process.env.ASSET_SIGNING_SECRET;
		delete process.env.NODE_ENV;
		process.env.ASSET_SIGNED_URLS_ENFORCED = "true";
		expect(readAssetAccessConfig().enforced).toBe(true);
	});
});

describe("signed delivery configuration guard", () => {
	test("full R2 credentials count as configured even without a signing secret", () => {
		expect(isR2FullyConfigured({
			accountId: "",
			bucket: "b",
			endpoint: "https://x.r2.cloudflarestorage.com",
			accessKeyId: "k",
			secretAccessKey: "s",
		})).toBe(true);
		expect(signedAssetDeliveryConfigured("r2", {
			accountId: "",
			bucket: "b",
			endpoint: "https://x.r2.cloudflarestorage.com",
			accessKeyId: "k",
			secretAccessKey: "s",
			publicBaseUrl: "",
		}, undefined)).toBe(true);
	});

	test("partial R2 credentials do NOT count as configured", () => {
		expect(isR2FullyConfigured({
			accountId: "",
			bucket: "b",
			endpoint: "",
			accessKeyId: "k",
			secretAccessKey: "",
		})).toBe(false);
	});
});

describe("R2 presigned delivery config gates (opt-in)", () => {
	test("presigned delivery defaults OFF even when driver=r2 and R2 fully configured", () => {
		// Codex finding #2/#4: direct R2 redirects need bucket CORS for the canvas
		// and under-count egress, so direct delivery is opt-in, not auto-on.
		clearR2Env();
		expect(defaultR2PresignedDeliveryEnabled()).toBe(false);
		expect(r2PresignCapable()).toBe(false);

		configureFullR2Env();
		// Capable (R2 fully configured) but still OFF without an explicit opt-in.
		expect(r2PresignCapable()).toBe(true);
		expect(defaultR2PresignedDeliveryEnabled()).toBe(false);
		expect(r2PresignedDeliveryEnabled()).toBe(false);
	});

	test("explicit ASSET_R2_PRESIGNED_DELIVERY_ENABLED=true enables presign when R2 is configured", () => {
		configureFullR2Env();
		process.env.ASSET_R2_PRESIGNED_DELIVERY_ENABLED = "true";
		expect(r2PresignedDeliveryEnabled()).toBe(true);
	});

	test("explicit ASSET_R2_PRESIGNED_DELIVERY_ENABLED=false disables presign even when configured", () => {
		configureFullR2Env();
		process.env.ASSET_R2_PRESIGNED_DELIVERY_ENABLED = "false";
		expect(r2PresignedDeliveryEnabled()).toBe(false);
	});

	test("explicit enable cannot force presign when R2 is not configured", () => {
		clearR2Env();
		process.env.ASSET_R2_PRESIGNED_DELIVERY_ENABLED = "true";
		expect(r2PresignedDeliveryEnabled()).toBe(false);
	});

	test("presign TTL config clamps default to the configured maximum", () => {
		process.env.ASSET_R2_PRESIGN_TTL_SECONDS = "9000";
		process.env.ASSET_R2_PRESIGN_MAX_TTL_SECONDS = "1200";
		expect(readR2PresignConfig()).toEqual({ defaultTtlSeconds: 1200, maxTtlSeconds: 1200 });
	});
});

describe("resolvePresignedR2Delivery", () => {
	test("produces a presigned descriptor with clamped TTL when enabled", () => {
		configureFullR2Env();
		process.env.ASSET_R2_PRESIGNED_DELIVERY_ENABLED = "true"; // opt-in to direct delivery
		process.env.ASSET_R2_PRESIGN_MAX_TTL_SECONDS = "600";
		const now = 1_700_000_000_000;

		const delivery = resolvePresignedR2Delivery({
			ttlSeconds: 5_000, // requested beyond max → clamped to 600
			now,
			presign: (expiresInSeconds) => `https://r2.example/object?X-Amz-Expires=${expiresInSeconds}`,
		});

		expect(delivery).toEqual({
			mode: "presigned_r2",
			url: "https://r2.example/object?X-Amz-Expires=600",
			ttlSeconds: 600,
			expiresAt: Math.floor(now / 1000) + 600,
		});
	});

	test("returns undefined (through-backend fallback) when presigned delivery is disabled", () => {
		clearR2Env(); // not configured → presign disabled
		let presignCalls = 0;
		const delivery = resolvePresignedR2Delivery({
			presign: () => {
				presignCalls += 1;
				return "https://should-not-be-used";
			},
		});
		expect(delivery).toBeUndefined();
		expect(presignCalls).toBe(0);
	});

	test("returns undefined when the presigner yields no URL (fallback to through-backend)", () => {
		configureFullR2Env();
		process.env.ASSET_R2_PRESIGNED_DELIVERY_ENABLED = "true"; // opt-in, so the no-URL path is exercised
		const delivery = resolvePresignedR2Delivery({ presign: () => undefined });
		expect(delivery).toBeUndefined();
	});
});

describe("object storage presign capability", () => {
	test("R2 storage presigns project objects with a TTL via SigV4 (no live R2 needed)", () => {
		const storage: ObjectStorage = createR2ObjectStorage(MOCK_R2_CREDS);

		const url = storage.presignProjectObject({
			projectId: "project-1",
			objectId: "image-1.png",
			kind: "image",
			expiresInSeconds: 300,
		});

		expect(typeof url).toBe("string");
		const parsed = new URL(url as string);
		// Object key is embedded in the path.
		expect(parsed.pathname).toContain("projects/project-1/images/image-1.png");
		// Short-TTL SigV4 presign markers are present.
		expect(parsed.searchParams.get("X-Amz-Expires")).toBe("300");
		expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
		expect(parsed.searchParams.get("X-Amz-Signature")).toBeTruthy();
	});

	test("R2 storage presigns derivative and export objects under their key prefixes", () => {
		const storage = createR2ObjectStorage(MOCK_R2_CREDS);

		const derivativeUrl = storage.presignProjectObject({
			projectId: "project-1",
			objectId: "thumb-1",
			kind: "derivative",
			expiresInSeconds: 120,
		});
		const exportUrl = storage.presignProjectObject({
			projectId: "project-1",
			objectId: "export-1.zip",
			kind: "export",
			expiresInSeconds: 120,
		});

		expect(new URL(derivativeUrl as string).pathname).toContain("projects/project-1/derivatives/thumb-1");
		expect(new URL(exportUrl as string).pathname).toContain("projects/project-1/exports/export-1.zip");
	});

	test("local storage cannot presign (returns undefined → through-backend fallback)", () => {
		// The default test-runtime singleton is local storage.
		expect(objectStorage.driver).toBe("local");
		expect(objectStorage.presignProjectObject({
			projectId: "p",
			objectId: "i.png",
			kind: "image",
			expiresInSeconds: 300,
		})).toBeUndefined();
	});
});

describe("image route delivery (through-backend fallback preserved)", () => {
	test("serves bytes through the backend (200, not a 302 redirect) when presign is unavailable", async () => {
		// Local-storage singleton → presign disabled → through-backend path.
		const { projectId, imageId } = createProjectWithImage();
		const app = new Hono();
		app.route("/api/images", images);

		const response = await app.request(`/api/images/${projectId}/${imageId}`, { redirect: "manual" });

		expect(response.status).toBe(200);
		expect(response.headers.get("X-Asset-Delivery-Mode")).toBeNull();
		expect(response.headers.get("Content-Type")).toBe("image/png");
		expect(await response.text()).toBe("image-bytes");
	});

	test("access-token route reports presignedR2Enabled=false under local storage", async () => {
		const { projectId, imageId } = createProjectWithImage();
		const app = new Hono();
		app.route("/api/images", images);

		const response = await app.request(`/api/images/${projectId}/${imageId}/access-token?purpose=editor_preview`);
		const body = await response.json() as { delivery?: { presignedR2Enabled?: boolean } };

		expect(response.status).toBe(200);
		expect(body.delivery?.presignedR2Enabled).toBe(false);
	});

	test("editor_preview (canvas) is NOT redirected to R2 even when presigned delivery is opted in", async () => {
		// Codex finding #2: the editor loads canvas images with crossOrigin="anonymous";
		// a 302 to a private R2 origin without bucket CORS makes the browser reject the
		// image. So editor_preview always stays through-backend, even with presign on.
		configureFullR2Env();
		process.env.ASSET_R2_PRESIGNED_DELIVERY_ENABLED = "true";

		const { projectId, imageId } = createProjectWithImage();
		// Seed an asset record so the image route reaches the presign attempt (it is
		// keyed off getAssetRecord); the editor_preview guard must then short-circuit.
		restoreAssetRecord(projectId, {
			assetId: imageId,
			projectId,
			imageId,
			originalName: imageId,
			mimeType: "image/png",
			sizeBytes: 11,
			sha256: "a".repeat(64),
			storageDriver: "local",
			storageKey: `projects/${projectId}/images/${imageId}`,
			width: 4,
			height: 4,
			storageStatus: "released",
			moderation: { status: "passed", provider: "test", checkedAt: new Date().toISOString() },
			derivatives: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		// Make the route believe presign is possible without touching real R2.
		const presignSpy = spyOn(objectStorage, "presignProjectObject").mockReturnValue(
			"https://r2.example/should-not-be-used",
		);

		const app = new Hono();
		app.route("/api/images", images);
		// No purpose query / token → image route resolves the editor_preview fallback.
		const response = await app.request(`/api/images/${projectId}/${imageId}`, { redirect: "manual" });

		expect(response.status).toBe(200);
		expect(response.headers.get("X-Asset-Delivery-Mode")).toBeNull();
		expect(await response.text()).toBe("image-bytes");
		// The canvas guard must short-circuit BEFORE presigning.
		expect(presignSpy).not.toHaveBeenCalled();
	});

	test("a cached thumbnail is presigned from its record WITHOUT downloading the buffer", async () => {
		// Codex finding #3: on a thumbnail cache HIT, presign directly from the stored
		// derivative (id + size) instead of having ensureThumbnailDerivative download
		// the full cached buffer just to 302 past it.
		configureFullR2Env();
		process.env.ASSET_R2_PRESIGNED_DELIVERY_ENABLED = "true";

		const { projectId, imageId } = createProjectWithImage();
		// Default thumbnail dims are 192x288; the derivative id embeds them.
		const derivativeId = `${imageId}.thumbnail.192x288.v1.webp`;
		const record: AssetRecord = {
			assetId: imageId,
			projectId,
			imageId,
			originalName: imageId,
			mimeType: "image/png",
			sizeBytes: 11,
			sha256: "a".repeat(64),
			storageDriver: "local",
			storageKey: `projects/${projectId}/images/${imageId}`,
			width: 4,
			height: 4,
			storageStatus: "released",
			moderation: { status: "passed", provider: "test", checkedAt: new Date().toISOString() },
			derivatives: [{
				id: derivativeId,
				purpose: "thumbnail",
				status: "ready",
				width: 192,
				height: 288,
				sourceRect: { x: 0, y: 0, w: 4, h: 4 },
				scale: 1,
				storageKey: `projects/${projectId}/derivatives/${derivativeId}`,
				sizeBytes: 4096,
				createdAt: new Date().toISOString(),
			}],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		restoreAssetRecord(projectId, record);

		// Cached derivative exists in storage; presign succeeds. getProjectDerivative
		// is the buffer-download we must NOT call on a cache hit. (hasProjectDerivative
		// returns boolean | Promise<boolean>; return a plain boolean — the caller awaits.)
		spyOn(objectStorage, "hasProjectDerivative").mockImplementation(() => true);
		const presignSpy = spyOn(objectStorage, "presignProjectObject").mockImplementation(
			({ kind, objectId, expiresInSeconds }) =>
				`https://r2.example/${kind}/${objectId}?X-Amz-Expires=${expiresInSeconds}`,
		);
		const bufferReadSpy = spyOn(objectStorage, "getProjectDerivative");

		const app = new Hono();
		app.route("/api/images", images);
		const response = await app.request(`/api/images/${projectId}/${imageId}/thumbnail`, { redirect: "manual" });

		expect(response.status).toBe(302);
		expect(response.headers.get("X-Asset-Delivery-Mode")).toBe("presigned_r2");
		expect(response.headers.get("Location")).toContain(`derivative/${derivativeId}`);
		// Egress is recorded from the derivative's known size, not a downloaded buffer.
		expect(response.headers.get("X-Asset-Egress-Bytes")).toBe("4096");
		// The cached buffer was never read.
		expect(bufferReadSpy).not.toHaveBeenCalled();
		// Presigned the derivative object directly.
		expect(presignSpy).toHaveBeenCalledTimes(1);
		expect(presignSpy.mock.calls[0]![0]).toMatchObject({ kind: "derivative", objectId: derivativeId });
	});
});
