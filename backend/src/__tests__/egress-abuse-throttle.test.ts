import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { v4 as uuid } from "uuid";
import { PROJECTS_DIR, serverConfig } from "../config.js";
import { images } from "../routes/images.js";
import { assertAssetTokenIssuanceAllowed } from "../services/asset-access.js";
import {
	EgressAbuseThrottleError,
	assertProjectEgressNotThrottled,
	evaluateProjectEgressAbuse,
	readEgressAbuseConfig,
	recordAssetEgress,
	releaseProjectEgressReservation,
	reserveProjectEgressForRead,
	resetEgressAccountingForTesting,
	setAssetEgressStoreForTesting,
	summarizeProjectEgress,
} from "../services/egress-accounting.js";
import { objectStorage } from "../services/storage.js";

const ENV_KEYS = [
	"ASSET_EGRESS_WINDOW_MS",
	"ASSET_EGRESS_PROJECT_WINDOW_BYTES",
	"ASSET_EGRESS_LIMIT_ENFORCED",
	"ASSET_EGRESS_ABUSE_WINDOW_BYTES",
	"ASSET_EGRESS_ABUSE_WINDOW_MS",
	"ASSET_EGRESS_ABUSE_MODE",
	"ASSET_EGRESS_STORE",
	"REDIS_URL",
] as const;

const previousEnv: Record<string, string | undefined> = {};
const createdProjectDirs: string[] = [];
// Wave 0 W0.1: legacy anonymous prototype projects.
let previousAllowLegacyAnonymousProjects: boolean;

beforeEach(() => {
	for (const key of ENV_KEYS) {
		previousEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env.ASSET_EGRESS_WINDOW_MS = "60000";
	resetEgressAccountingForTesting();
	previousAllowLegacyAnonymousProjects = serverConfig.allowLegacyAnonymousProjects;
	Object.assign(serverConfig as unknown as Record<string, unknown>, { allowLegacyAnonymousProjects: true });
});

afterEach(() => {
	resetEgressAccountingForTesting();
	Object.assign(serverConfig as unknown as Record<string, unknown>, { allowLegacyAnonymousProjects: previousAllowLegacyAnonymousProjects });
	for (const key of ENV_KEYS) {
		const value = previousEnv[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	const projectsRoot = resolve(PROJECTS_DIR);
	for (const projectDir of createdProjectDirs.splice(0)) {
		const resolved = resolve(projectDir);
		if (!resolved.startsWith(projectsRoot)) {
			throw new Error(`Refusing to remove test directory outside projects root: ${resolved}`);
		}
		rmSync(resolved, { recursive: true, force: true });
	}
});

function createProjectWithImage(bytes = "image-bytes-payload") {
	const projectId = uuid();
	const imageId = `${uuid()}.png`;
	const projectDir = join(PROJECTS_DIR, projectId);
	mkdirSync(join(projectDir, "images"), { recursive: true });
	writeFileSync(join(projectDir, "state.json"), JSON.stringify({
		projectId,
		name: "Egress Abuse Test",
		createdAt: new Date().toISOString(),
		pages: [],
		currentPage: 0,
		targetLang: "th",
	}));
	writeFileSync(join(projectDir, "images", imageId), Buffer.from(bytes));
	// The serve gate now fails closed on an image id with no asset record
	// (codex P0-2), so register a passing/released record alongside the bytes.
	const now = new Date().toISOString();
	writeFileSync(join(projectDir, "assets.json"), JSON.stringify({
		[imageId]: {
			assetId: imageId,
			projectId,
			imageId,
			originalName: imageId,
			mimeType: "image/png",
			sizeBytes: Buffer.from(bytes).byteLength,
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
	return { projectId, imageId, bytes };
}

const NOW = 1_700_000_000_000;

describe("egress abuse auto-throttle (service)", () => {
	test("is disabled and never throttles when no threshold is configured", async () => {
		const config = readEgressAbuseConfig();
		expect(config.enabled).toBe(false);
		expect(config.mode).toBe("observe");

		await recordAssetEgress({ projectId: "project-1", imageId: "a.png", purpose: "editor_preview", bytes: 9_999, statusCode: 200, now: NOW });
		const decision = await evaluateProjectEgressAbuse("project-1", NOW);
		expect(decision.throttled).toBe(false);
		await expect(assertProjectEgressNotThrottled("project-1", "asset_read", NOW)).resolves.toBeDefined();
	});

	test("under threshold passes in enforce mode", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enforce";
		await recordAssetEgress({ projectId: "project-1", imageId: "a.png", purpose: "editor_preview", bytes: 500, statusCode: 200, now: NOW });

		const decision = await assertProjectEgressNotThrottled("project-1", "asset_read", NOW);
		expect(decision.throttled).toBe(false);
		expect(decision.observedBytes).toBe(500);
		expect(decision.thresholdBytes).toBe(1000);
	});

	test("over threshold throttles in enforce mode (fail-closed block)", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enforce";
		await recordAssetEgress({ projectId: "project-1", imageId: "a.png", purpose: "editor_preview", bytes: 800, statusCode: 200, now: NOW });
		await recordAssetEgress({ projectId: "project-1", imageId: "a.png", purpose: "editor_preview", bytes: 300, statusCode: 200, now: NOW });

		const decision = await evaluateProjectEgressAbuse("project-1", NOW);
		expect(decision.observedBytes).toBe(1100);
		expect(decision.throttled).toBe(true);
		expect(decision.enforced).toBe(true);
		expect(decision.retryAfterSeconds).toBeGreaterThan(0);

		let thrown: unknown;
		try {
			await assertProjectEgressNotThrottled("project-1", "asset_read", NOW);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(EgressAbuseThrottleError);
		expect((thrown as EgressAbuseThrottleError).scope).toBe("asset_read");
	});

	test("over threshold only flags in observe mode (fail-open, no block)", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000";
		// mode defaults to observe
		await recordAssetEgress({ projectId: "project-1", imageId: "a.png", purpose: "editor_preview", bytes: 5_000, statusCode: 200, now: NOW });

		const decision = await evaluateProjectEgressAbuse("project-1", NOW);
		expect(decision.observedBytes).toBe(5_000);
		expect(decision.enforced).toBe(false);
		expect(decision.throttled).toBe(false);
		await expect(assertProjectEgressNotThrottled("project-1", "asset_read", NOW)).resolves.toBeDefined();
	});

	test("fails closed in enforce mode when egress accounting is unavailable", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enforce";
		setAssetEgressStoreForTesting({
			record: () => {
				throw new Error("redis unavailable");
			},
			summarize: () => {
				throw new Error("redis unavailable");
			},
		});

		const decision = await evaluateProjectEgressAbuse("project-1", NOW);
		expect(decision.throttled).toBe(true);
		await expect(assertProjectEgressNotThrottled("project-1", "asset_read", NOW)).rejects.toThrow(EgressAbuseThrottleError);
	});

	test("fails open in observe mode when egress accounting is unavailable", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000";
		setAssetEgressStoreForTesting({
			record: () => {
				throw new Error("redis unavailable");
			},
			summarize: () => {
				throw new Error("redis unavailable");
			},
		});

		const decision = await evaluateProjectEgressAbuse("project-1", NOW);
		expect(decision.throttled).toBe(false);
		await expect(assertProjectEgressNotThrottled("project-1", "asset_read", NOW)).resolves.toBeDefined();
	});

	test("token issuance guard mirrors the asset-read throttle in enforce mode", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enforce";
		await recordAssetEgress({ projectId: "project-1", imageId: "a.png", purpose: "editor_preview", bytes: 2_000, statusCode: 200, now: NOW });

		let thrown: unknown;
		try {
			await assertAssetTokenIssuanceAllowed("project-1", NOW);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(EgressAbuseThrottleError);
		expect((thrown as EgressAbuseThrottleError).scope).toBe("token_issuance");
	});
});

describe("egress abuse auto-throttle (image route)", () => {
	test("serves reads under the abuse threshold", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000000";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enforce";
		const { projectId, imageId, bytes } = createProjectWithImage();
		const app = new Hono();
		app.route("/api/images", images);

		const response = await app.request(`/api/images/${projectId}/${imageId}`);
		expect(response.status).toBe(200);
		expect(response.headers.get("X-Asset-Egress-Bytes")).toBe(String(bytes.length));
	});

	test("returns 429 with Retry-After once a project trips the threshold in enforce mode", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "10";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enforce";
		const { projectId, imageId } = createProjectWithImage("over-the-tiny-abuse-threshold");
		const app = new Hono();
		app.route("/api/images", images);

		// First read records bytes well over the 10-byte threshold for the window.
		const firstResponse = await app.request(`/api/images/${projectId}/${imageId}`);
		expect(firstResponse.status).toBe(200);

		// Subsequent read is throttled because the recorded window total is over threshold.
		const throttled = await app.request(`/api/images/${projectId}/${imageId}`);
		expect(throttled.status).toBe(429);
		expect(throttled.headers.get("Retry-After")).toBeTruthy();
		const body = await throttled.json();
		expect(body.code).toBe("asset_egress_abuse_throttled");
		expect(body.scope).toBe("asset_read");
	});

	test("does not block over-threshold reads in observe mode", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "10";
		// observe (default) — should never block
		const { projectId, imageId } = createProjectWithImage("over-the-tiny-abuse-threshold");
		const app = new Hono();
		app.route("/api/images", images);

		const firstResponse = await app.request(`/api/images/${projectId}/${imageId}`);
		expect(firstResponse.status).toBe(200);
		const secondResponse = await app.request(`/api/images/${projectId}/${imageId}`);
		expect(secondResponse.status).toBe(200);
	});

	test("denies signed-asset token issuance once throttled in enforce mode", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "10";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enforce";
		const { projectId, imageId } = createProjectWithImage("over-the-tiny-abuse-threshold");
		const app = new Hono();
		app.route("/api/images", images);

		// Drive the window total over the threshold via a normal read.
		const read = await app.request(`/api/images/${projectId}/${imageId}`);
		expect(read.status).toBe(200);

		const tokenResponse = await app.request(`/api/images/${projectId}/${imageId}/access-token?purpose=original`);
		expect(tokenResponse.status).toBe(429);
		const body = await tokenResponse.json();
		expect(body.code).toBe("asset_egress_abuse_throttled");
		expect(body.scope).toBe("token_issuance");
	});
});

// Codex finding #1: the abuse burst must be measured over ASSET_EGRESS_ABUSE_WINDOW_MS,
// not the (potentially much larger) normal accounting window.
describe("egress abuse auto-throttle (abuse-window aggregation)", () => {
	test("aggregates over the abuse window, not the normal accounting window", async () => {
		// Normal accounting window is one hour; the abuse burst horizon is one minute.
		process.env.ASSET_EGRESS_WINDOW_MS = "3600000";
		process.env.ASSET_EGRESS_ABUSE_WINDOW_MS = "60000";
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enforce";
		resetEgressAccountingForTesting();

		await recordAssetEgress({ projectId: "project-1", imageId: "a.png", purpose: "editor_preview", bytes: 5_000, statusCode: 200, now: NOW });

		// Within the same abuse minute the burst is observed and throttled.
		const inWindow = await evaluateProjectEgressAbuse("project-1", NOW + 30_000);
		expect(inWindow.observedBytes).toBe(5_000);
		expect(inWindow.windowMs).toBe(60_000);
		expect(inWindow.throttled).toBe(true);

		// Two minutes later we are still inside the one-hour accounting window (the
		// normal aggregate still reports the bytes) but in a fresh abuse minute, so
		// the abuse decision observes zero and does not keep the project throttled.
		const laterAbuse = await evaluateProjectEgressAbuse("project-1", NOW + 120_000);
		expect(laterAbuse.observedBytes).toBe(0);
		expect(laterAbuse.throttled).toBe(false);

		const normalSummary = await summarizeProjectEgress("project-1", NOW + 120_000);
		expect(normalSummary.windowMs).toBe(3_600_000);
		expect(normalSummary.totalBytes).toBe(5_000);
	});

	test("a project throttled inside the abuse window recovers after the abuse window rolls over", async () => {
		process.env.ASSET_EGRESS_WINDOW_MS = "3600000";
		process.env.ASSET_EGRESS_ABUSE_WINDOW_MS = "60000";
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enforce";
		resetEgressAccountingForTesting();

		// A burst inside the abuse minute trips the throttle.
		await recordAssetEgress({ projectId: "project-1", imageId: "a.png", purpose: "editor_preview", bytes: 5_000, statusCode: 200, now: NOW });
		await expect(
			assertProjectEgressNotThrottled("project-1", "asset_read", NOW + 10_000),
		).rejects.toThrow(EgressAbuseThrottleError);

		// Two minutes later the abuse window has rolled over and the project clears,
		// even though the same bytes are still inside the one-hour accounting window.
		await expect(
			assertProjectEgressNotThrottled("project-1", "asset_read", NOW + 120_000),
		).resolves.toMatchObject({ throttled: false, observedBytes: 0 });
		const stillInNormalWindow = await summarizeProjectEgress("project-1", NOW + 120_000);
		expect(stillInNormalWindow.totalBytes).toBe(5_000);
	});
});

// Codex finding #2: parallel reads during a burst must not all serve before the
// counter updates — the atomic reservation bounds overshoot to a single read.
describe("egress abuse auto-throttle (concurrent burst)", () => {
	test("a concurrent read burst does not exceed the threshold by the batch size", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "10";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enforce";
		resetEgressAccountingForTesting();
		// 29-byte payload, well over the 10-byte threshold, so a single served read
		// already crosses it; any additional concurrent reads must be throttled.
		const { projectId, imageId, bytes } = createProjectWithImage("over-the-tiny-abuse-threshold");
		const app = new Hono();
		app.route("/api/images", images);

		const responses = await Promise.all(
			Array.from({ length: 8 }, () => app.request(`/api/images/${projectId}/${imageId}`)),
		);
		const served = responses.filter((response) => response.status === 200);
		const throttled = responses.filter((response) => response.status === 429);

		// Exactly one read may serve; the rest are throttled. Without the atomic
		// reservation every concurrent read would pass the stale pre-read check.
		expect(served.length).toBe(1);
		expect(throttled.length).toBe(7);
		// Total egress is bounded to a single read instead of the whole batch.
		const totalServedBytes = served.length * bytes.length;
		expect(totalServedBytes).toBeLessThanOrEqual(bytes.length);
	});

	test("reservation projects this read's bytes before deciding", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enforce";
		resetEgressAccountingForTesting();

		// First reservation observes an empty window (prior total 0) and is allowed.
		const first = await reserveProjectEgressForRead("project-1", 900, "asset_read", NOW);
		expect(first.throttled).toBe(false);
		expect(first.observedBytes).toBe(0);

		// Second reservation now sees the prior 900 reserved bytes. It is under the
		// 1000 threshold, so it is still allowed but the prior total is reflected.
		const second = await reserveProjectEgressForRead("project-1", 900, "asset_read", NOW);
		expect(second.observedBytes).toBe(900);
		expect(second.throttled).toBe(false);

		// Third reservation sees 1800 reserved bytes (over threshold) and throttles.
		await expect(
			reserveProjectEgressForRead("project-1", 900, "asset_read", NOW),
		).rejects.toThrow(EgressAbuseThrottleError);
	});
});

// Codex finding #3: a throttle-config error while a threshold is set must NOT
// become a successful read — it has to fail closed, never fail open.
describe("egress abuse auto-throttle (config-error fail-closed)", () => {
	test("evaluate fails closed when the abuse mode is misconfigured and a threshold is set", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enfroce"; // typo
		resetEgressAccountingForTesting();

		const decision = await evaluateProjectEgressAbuse("project-1", NOW);
		expect(decision.throttled).toBe(true);
		await expect(
			assertProjectEgressNotThrottled("project-1", "asset_read", NOW),
		).rejects.toThrow(EgressAbuseThrottleError);
	});

	test("reservation fails closed when the abuse mode is misconfigured and a threshold is set", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000";
		process.env.ASSET_EGRESS_ABUSE_MODE = "observ"; // typo
		resetEgressAccountingForTesting();

		await expect(
			reserveProjectEgressForRead("project-1", 1, "asset_read", NOW),
		).rejects.toThrow(EgressAbuseThrottleError);
	});

	test("stays disabled (no throttle) on a config typo when no threshold is configured", async () => {
		process.env.ASSET_EGRESS_ABUSE_MODE = "enfroce"; // typo, but feature is off
		resetEgressAccountingForTesting();

		const decision = await evaluateProjectEgressAbuse("project-1", NOW);
		expect(decision.throttled).toBe(false);
		await expect(assertProjectEgressNotThrottled("project-1", "asset_read", NOW)).resolves.toBeDefined();
	});

	test("the image route fails closed (does not serve) on a misconfigured abuse mode", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000000";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enfroce"; // typo while threshold set
		resetEgressAccountingForTesting();
		const { projectId, imageId } = createProjectWithImage();
		const app = new Hono();
		app.route("/api/images", images);

		const response = await app.request(`/api/images/${projectId}/${imageId}`);
		// Must not be a 200: the misconfigured shutoff fails closed rather than
		// silently serving bytes. The route surfaces a throttle (429).
		expect(response.status).not.toBe(200);
		expect([429, 503]).toContain(response.status);
	});

	test("token issuance fails closed on a misconfigured abuse mode", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000000";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enfroce"; // typo while threshold set
		resetEgressAccountingForTesting();
		const { projectId, imageId } = createProjectWithImage();
		const app = new Hono();
		app.route("/api/images", images);

		const tokenResponse = await app.request(`/api/images/${projectId}/${imageId}/access-token?purpose=original`);
		expect(tokenResponse.status).not.toBe(200);
		expect([429, 503]).toContain(tokenResponse.status);
	});
});

// Codex round-2 #1: an already-over-threshold project must be rejected by a
// read-only pre-check BEFORE the object is fetched, so it can no longer force a
// full backend/R2 download + buffer allocation just to receive a 429.
describe("egress abuse auto-throttle (pre-check before download)", () => {
	test("rejects an already-throttled project without downloading the object", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "10";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enforce";
		resetEgressAccountingForTesting();
		const { projectId, imageId } = createProjectWithImage("over-the-tiny-abuse-threshold");

		// Drive the abuse window over the threshold WITHOUT serving (record-only),
		// so the next request starts already throttled.
		await recordAssetEgress({ projectId, imageId, purpose: "editor_preview", bytes: 5_000, statusCode: 200 });

		const originalGetProjectImage = objectStorage.getProjectImage.bind(objectStorage);
		let downloadCount = 0;
		(objectStorage as { getProjectImage: typeof objectStorage.getProjectImage }).getProjectImage = async (input) => {
			downloadCount += 1;
			return originalGetProjectImage(input);
		};
		try {
			const app = new Hono();
			app.route("/api/images", images);
			const response = await app.request(`/api/images/${projectId}/${imageId}`);
			expect(response.status).toBe(429);
			const body = await response.json();
			expect(body.code).toBe("asset_egress_abuse_throttled");
			// The object must never have been downloaded for the rejected read.
			expect(downloadCount).toBe(0);
		} finally {
			(objectStorage as { getProjectImage: typeof objectStorage.getProjectImage }).getProjectImage = originalGetProjectImage;
		}
	});

	test("an under-threshold project still downloads and serves", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000000";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enforce";
		resetEgressAccountingForTesting();
		const { projectId, imageId, bytes } = createProjectWithImage();

		const originalGetProjectImage = objectStorage.getProjectImage.bind(objectStorage);
		let downloadCount = 0;
		(objectStorage as { getProjectImage: typeof objectStorage.getProjectImage }).getProjectImage = async (input) => {
			downloadCount += 1;
			return originalGetProjectImage(input);
		};
		try {
			const app = new Hono();
			app.route("/api/images", images);
			const response = await app.request(`/api/images/${projectId}/${imageId}`);
			expect(response.status).toBe(200);
			expect(response.headers.get("X-Asset-Egress-Bytes")).toBe(String(bytes.length));
			expect(downloadCount).toBe(1);
		} finally {
			(objectStorage as { getProjectImage: typeof objectStorage.getProjectImage }).getProjectImage = originalGetProjectImage;
		}
	});
});

// Codex round-2 #2: when ASSET_EGRESS_ABUSE_WINDOW_MS and ASSET_EGRESS_WINDOW_MS
// are both omitted, the abuse window must default to the accounting window
// (1 hour) — the documented behavior — not a separate 5-minute default.
describe("egress abuse auto-throttle (abuse window defaults to accounting window)", () => {
	const ACCOUNTING_DEFAULT_WINDOW_MS = 60 * 60 * 1000;

	test("defaults the abuse window to the accounting default when both window vars are unset", async () => {
		delete process.env.ASSET_EGRESS_WINDOW_MS;
		delete process.env.ASSET_EGRESS_ABUSE_WINDOW_MS;
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000";
		resetEgressAccountingForTesting();

		const abuse = readEgressAbuseConfig();
		expect(abuse.windowMs).toBe(ACCOUNTING_DEFAULT_WINDOW_MS);
		// And it tracks the accounting window the summary reports (the strong invariant).
		const summary = await summarizeProjectEgress("project-1", NOW);
		expect(abuse.windowMs).toBe(summary.windowMs);

		// The decision the gate produces is bucketed over that same hour window.
		const decision = await evaluateProjectEgressAbuse("project-1", NOW);
		expect(decision.windowMs).toBe(ACCOUNTING_DEFAULT_WINDOW_MS);
	});

	test("still tracks an explicitly-set accounting window when only ASSET_EGRESS_WINDOW_MS is set", async () => {
		process.env.ASSET_EGRESS_WINDOW_MS = "120000";
		delete process.env.ASSET_EGRESS_ABUSE_WINDOW_MS;
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000";
		resetEgressAccountingForTesting();

		expect(readEgressAbuseConfig().windowMs).toBe(120_000);
	});

	test("an explicit ASSET_EGRESS_ABUSE_WINDOW_MS still overrides the accounting window", async () => {
		process.env.ASSET_EGRESS_WINDOW_MS = "3600000";
		process.env.ASSET_EGRESS_ABUSE_WINDOW_MS = "60000";
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000";
		resetEgressAccountingForTesting();

		expect(readEgressAbuseConfig().windowMs).toBe(60_000);
	});
});

// Codex round-2 #3: when the normal egress cap rejects a read, the abuse-window
// reservation made earlier must not be retained — undelivered bytes must not
// trip/extend the abuse throttle.
describe("egress abuse auto-throttle (no reservation retained on rejected read)", () => {
	test("releasing a reservation removes it from the abuse window total", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enforce";
		resetEgressAccountingForTesting();

		// Reserve 900 (observes prior 0), then release it. A second reservation must
		// again observe 0 — proving the released bytes did not linger.
		const reserved = await reserveProjectEgressForRead("project-1", 900, "asset_read", NOW);
		expect(reserved.observedBytes).toBe(0);
		await releaseProjectEgressReservation("project-1", 900, NOW);

		const afterRelease = await reserveProjectEgressForRead("project-1", 900, "asset_read", NOW);
		expect(afterRelease.observedBytes).toBe(0);
	});

	test("rolling back more than the window total clamps at zero (never negative)", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enforce";
		resetEgressAccountingForTesting();

		await reserveProjectEgressForRead("project-1", 100, "asset_read", NOW);
		// Release far more than was ever reserved; the total must clamp at 0.
		await releaseProjectEgressReservation("project-1", 10_000, NOW);

		const reservation = await reserveProjectEgressForRead("project-1", 1, "asset_read", NOW);
		expect(reservation.observedBytes).toBe(0);
	});

	test("a read rejected by the normal egress cap leaves no abuse reservation behind", async () => {
		// Normal per-window cap is tiny and enforced so the read is rejected after
		// the abuse reservation is made; abuse enforcement is also on with a higher
		// threshold so the abuse gate itself would not have blocked this read.
		process.env.ASSET_EGRESS_PROJECT_WINDOW_BYTES = "5";
		process.env.ASSET_EGRESS_LIMIT_ENFORCED = "true";
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000000";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enforce";
		resetEgressAccountingForTesting();
		const { projectId, imageId } = createProjectWithImage("payload-larger-than-five-bytes");
		const app = new Hono();
		app.route("/api/images", images);

		// The read is rejected by the normal cap (payload exceeds the 5-byte cap).
		const rejected = await app.request(`/api/images/${projectId}/${imageId}`);
		expect(rejected.status).toBe(429);
		const body = await rejected.json();
		expect(body.code).toBe("asset_egress_limit_exceeded");

		// The rejected read's bytes must NOT remain in the abuse window: the next
		// reservation observes zero prior bytes, so undelivered traffic cannot
		// trip/extend the abuse throttle. (Uses real time — same abuse bucket the
		// route just exercised — rather than the fixed NOW used elsewhere.)
		const decision = await evaluateProjectEgressAbuse(projectId);
		expect(decision.observedBytes).toBe(0);
		const reservation = await reserveProjectEgressForRead(projectId, 1, "asset_read");
		expect(reservation.observedBytes).toBe(0);
	});
});

// Codex round-2 #4 (origin-side mitigation): while abuse enforcement is engaged,
// throttle-eligible asset responses must not advertise `immutable` or a long
// public TTL, so a CDN cannot keep serving a now-throttled asset from cache and
// bypass the origin gate. (The residual edge-cache staleness is a documented
// limitation — see buildAssetCacheControl.)
describe("egress abuse auto-throttle (cache-control does not let CDN bypass throttle)", () => {
	test("served reads omit immutable and cap public TTL when abuse enforcement is engaged", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000000";
		process.env.ASSET_EGRESS_ABUSE_MODE = "enforce";
		resetEgressAccountingForTesting();
		const { projectId, imageId } = createProjectWithImage();
		const app = new Hono();
		app.route("/api/images", images);

		const response = await app.request(`/api/images/${projectId}/${imageId}`);
		expect(response.status).toBe(200);
		const cacheControl = response.headers.get("Cache-Control") ?? "";
		expect(cacheControl).not.toContain("immutable");
		const maxAge = Number(cacheControl.match(/max-age=(\d+)/)?.[1] ?? "0");
		expect(maxAge).toBeGreaterThan(0);
		expect(maxAge).toBeLessThanOrEqual(60);
	});

	test("observe mode (enforcement not engaged) keeps the normal long public TTL", async () => {
		process.env.ASSET_EGRESS_ABUSE_WINDOW_BYTES = "1000000";
		// mode defaults to observe — enforcement is NOT engaged
		resetEgressAccountingForTesting();
		const { projectId, imageId } = createProjectWithImage();
		const app = new Hono();
		app.route("/api/images", images);

		const response = await app.request(`/api/images/${projectId}/${imageId}`);
		expect(response.status).toBe(200);
		const cacheControl = response.headers.get("Cache-Control") ?? "";
		const maxAge = Number(cacheControl.match(/max-age=(\d+)/)?.[1] ?? "0");
		expect(maxAge).toBe(3600);
	});
});
