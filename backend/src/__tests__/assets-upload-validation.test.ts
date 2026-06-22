// POST /api/assets/upload image-safety parity guard.
//
// The CoW upload surface (assets.ts) used to write a client base64 buffer +
// client-declared mimeType verbatim through storageCowService.writeBlob() with NO
// magic-byte/MIME check, NO pixel-bomb ceiling, and NO mandatory CSAM screen —
// unlike the hardened POST /api/images/:projectId/upload. This suite pins the new
// validateUploadAssetBuffer() gate (and its route wiring) so the bypass cannot
// silently return: a decompression bomb, a spoofed content-type, or a CSAM-blocked
// blob is rejected BEFORE the durable blob is ever written.
//
// All tests are infra-free: the validation runs (and rejects) before the
// DATABASE_URL-backed CoW service is constructed, and the CSAM screen is injected as
// a deterministic fake (the real one needs an OpenAI provider).

import { describe, test, expect, afterEach } from "bun:test";
import { setSharedStorageCowServiceForTesting, StorageCowAuthorizationError, QuotaFrozenError } from "../services/storage-cow.js";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { deflateSync, crc32 } from "node:zlib";
import { createHash } from "node:crypto";
import sharp from "sharp";

import { assets, validateUploadAssetBuffer, type CsamScreen, type TileScreen } from "../routes/assets.js";
import { buildModerationDerivativePlan, storageStatusForModerationResult } from "../services/assets.js";
import type { AssetDerivative } from "../types/index.js";
import {
	setCsamAuditStoreForTests,
	type CsamBlockAuditStore,
	type ModerationAuditRecord,
} from "../services/moderation.js";
import type { AssetModerationResult } from "../types/index.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

async function realPng(width = 16, height = 16): Promise<Buffer> {
	return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
}
async function realWebp(width = 16, height = 16): Promise<Buffer> {
	return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } }).webp().toBuffer();
}
// A TALL webtoon-style page (1024×6000): buildModerationDerivativePlan emits
// moderation TILES for it (scaledHeight > tileHeight*1.5), so the tile fan-out runs.
async function tallPng(width = 1024, height = 6000): Promise<Buffer> {
	return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
}
function passedVerdict(): AssetModerationResult {
	return { status: "passed", provider: "test", checkedAt: new Date().toISOString() };
}

// A crafted PNG whose IHDR DECLARES huge dimensions (a "decompression bomb": a tiny
// on-disk body that allocates hundreds of megapixels when later decoded). The IHDR
// CRC is correct so sharp().metadata() reports the declared dimensions and the pixel
// ceiling — not a parse error — is what rejects it. 100 MP (10000×10000) sits under
// sharp's own internal pixel limit yet over the 60 MP upload ceiling.
function craftPixelBombPng(width: number, height: number): Buffer {
	function chunk(type: string, data: Buffer): Buffer {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length, 0);
		const t = Buffer.from(type, "ascii");
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
		return Buffer.concat([len, t, data, crc]);
	}
	const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.writeUInt8(8, 8); // bit depth
	ihdr.writeUInt8(2, 9); // color type: truecolor
	ihdr.writeUInt8(0, 10);
	ihdr.writeUInt8(0, 11);
	ihdr.writeUInt8(0, 12);
	return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from([0]))), chunk("IEND", Buffer.alloc(0))]);
}

function passingScreen(): AssetModerationResult {
	return { status: "passed", provider: "test", checkedAt: new Date().toISOString() };
}
function blockingScreen(): AssetModerationResult {
	return { status: "blocked", provider: "test", checkedAt: new Date().toISOString(), reason: "csam" };
}

function sha256Hex(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

// In-memory CSAM denylist + audit store: lets us (a) seed a known-blocked sha so the
// gate hard-blocks BEFORE any provider/screen call, and (b) assert a confirmed block
// SEEDS the denylist via `append`. Mirrors moderation.ts's Memory store.
class FakeCsamAuditStore implements CsamBlockAuditStore {
	records: ModerationAuditRecord[] = [];
	blocked = new Set<string>();
	lookupCalls: string[] = [];

	async append(record: ModerationAuditRecord): Promise<void> {
		this.records.push(record);
		if (record.sha256) this.blocked.add(record.sha256.trim());
	}

	async hasBlockedSha256(sha256: string): Promise<boolean> {
		const target = sha256.trim();
		this.lookupCalls.push(target);
		return this.blocked.has(target);
	}
}

// ── unit: validateUploadAssetBuffer ──────────────────────────────────────────

describe("validateUploadAssetBuffer (image-upload parity gate)", () => {
	test("rejects a declared MIME that mismatches the actual magic bytes (mime_type_mismatch 400)", async () => {
		const pngBytes = await realPng();
		const spy: CsamScreen = async () => passingScreen();
		const result = await validateUploadAssetBuffer({
			buffer: pngBytes,
			mimeType: "image/webp", // lie: the bytes are PNG
			assetId: "asset-mismatch",
			workspaceId: "ws-1",
			screen: spy,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.status).toBe(400);
		expect(result.body.code).toBe("mime_type_mismatch");
		expect(result.body.actualFormat).toBe("png");
	});

	test("rejects an oversized-pixel decompression bomb (image_dimensions_too_large 413)", async () => {
		const bomb = craftPixelBombPng(10000, 10000); // ~66 bytes on disk, 100 MP declared
		expect(bomb.byteLength).toBeLessThan(1024); // ≤1MB body, hundreds of MP on decode
		const result = await validateUploadAssetBuffer({
			buffer: bomb,
			mimeType: "image/png",
			assetId: "asset-bomb",
			workspaceId: "ws-1",
			screen: async () => passingScreen(),
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.status).toBe(413);
		expect(result.body.code).toBe("image_dimensions_too_large");
		expect(result.body.width).toBe(10000);
	});

	test("rejects a declared type with no validation story (unsupported_asset_type 400)", async () => {
		const result = await validateUploadAssetBuffer({
			buffer: Buffer.from("not really a font but declared as one"),
			mimeType: "font/woff2",
			assetId: "asset-font",
			workspaceId: "ws-1",
			screen: async () => passingScreen(),
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.status).toBe(400);
		expect(result.body.code).toBe("unsupported_asset_type");
	});

	test("rejects an image asset extension that disagrees with the declared MIME before decode/screen", async () => {
		const pngBytes = await realPng();
		let screenCalled = false;
		const result = await validateUploadAssetBuffer({
			buffer: pngBytes,
			mimeType: "image/png",
			assetId: "asset-extension-lie.webp",
			workspaceId: "ws-1",
			screen: async () => {
				screenCalled = true;
				return passingScreen();
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.status).toBe(400);
		expect(result.body.code).toBe("asset_extension_mismatch");
		expect(result.body.expectedMimeType).toBe("image/webp");
		// The suffix is cheap client metadata; reject it before sharp decode/screens
		// can spend CPU or provider quota on bytes that cannot be accepted as named.
		expect(screenCalled).toBe(false);
	});

	test("rejects an unsupported image-looking asset extension before decode/screen", async () => {
		let screenCalled = false;
		const result = await validateUploadAssetBuffer({
			buffer: Buffer.from("gif-ish"),
			mimeType: "image/png",
			assetId: "asset-unsupported.gif",
			workspaceId: "ws-1",
			screen: async () => {
				screenCalled = true;
				return passingScreen();
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.status).toBe(400);
		expect(result.body.code).toBe("unsupported_asset_extension");
		expect(screenCalled).toBe(false);
	});

	test("rejects a non-decodable buffer declared as an image (image_not_decodable 400)", async () => {
		const result = await validateUploadAssetBuffer({
			buffer: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
			mimeType: "image/png",
			assetId: "asset-garbage",
			workspaceId: "ws-1",
			screen: async () => passingScreen(),
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.status).toBe(400);
		expect(result.body.code).toBe("image_not_decodable");
	});

	test("invokes the mandatory CSAM screen with the buffer/mime and rejects a hard block (403)", async () => {
		const pngBytes = await realPng();
		const calls: Array<{ mimeType: string; workspaceId: string | undefined; bytes: number }> = [];
		const screen: CsamScreen = async (buffer, mimeType, workspaceId) => {
			calls.push({ mimeType, workspaceId, bytes: buffer.byteLength });
			return blockingScreen();
		};
		const result = await validateUploadAssetBuffer({
			buffer: pngBytes,
			mimeType: "image/png",
			assetId: "asset-csam",
			workspaceId: "ws-screen",
			screen,
		});
		// The screen MUST have been called on the real image bytes.
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({ mimeType: "image/png", workspaceId: "ws-screen", bytes: pngBytes.byteLength });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.status).toBe(403);
		expect(result.body.code).toBe("moderation_blocked");
	});

	test("fail-closed needs_review is PERSISTED-WITH-QUARANTINE (images precedent), never a hard 403", async () => {
		// A provider outage fails closed to needs_review inside the real screen. PARITY
		// with the /api/images upload path (images.ts ~L1649): a non-`blocked` verdict is
		// NOT rejected — it proceeds (ok:true) with the verdict threaded so the route
		// PERSISTS the asset but QUARANTINES it. We pin: the screen RAN, the upload is not
		// hard-blocked, the threaded verdict carries failClosed, and the derived storage
		// status is `quarantined` (withheld from serving AND export) — not released. A
		// blanket reject on a provider outage would break uploads platform-wide.
		const pngBytes = await realPng();
		let called = false;
		const screen: CsamScreen = async () => {
			called = true;
			return { status: "needs_review", provider: "test", checkedAt: new Date().toISOString(), failClosed: true };
		};
		const result = await validateUploadAssetBuffer({
			buffer: pngBytes,
			mimeType: "image/png",
			assetId: "asset-needs-review",
			workspaceId: "ws-1",
			screen,
		});
		expect(called).toBe(true);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.moderation.status).toBe("needs_review");
		expect(result.moderation.failClosed).toBe(true);
		// The verdict that gets threaded into writeBlob quarantines the record.
		expect(storageStatusForModerationResult(result.moderation)).toBe("quarantined");
	});

	test("passes a legitimate image (png + webp) so honest uploads still proceed", async () => {
		for (const [mime, bytes] of [["image/png", await realPng()], ["image/webp", await realWebp()]] as const) {
			const result = await validateUploadAssetBuffer({
				buffer: bytes,
				mimeType: mime,
				assetId: `asset-ok-${mime.replace("/", "-")}`,
				workspaceId: "ws-1",
				screen: async () => passingScreen(),
			});
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("unreachable");
			expect(result.moderation.status).toBe("passed");
			// A passed verdict releases the asset (servable) — the quarantine path does
			// not regress honest uploads.
			expect(storageStatusForModerationResult(result.moderation)).toBe("released");
		}
	});
});

// ── FINDING 2: tile moderation parity (tall pages screened by tiles, not just overview) ──

describe("validateUploadAssetBuffer tile moderation (FINDING 2 — webtoon tall-page dilution)", () => {
	test("a TALL page runs the tile plan (plan carries tiles) after the overview screen", async () => {
		const bytes = await tallPng();
		const calls: AssetDerivative[][] = [];
		// Inject the tile executor as a spy so we can prove it ran WITH a real tile plan
		// (the same buildModerationDerivativePlan images.ts uses), without a provider.
		const tileScreen: TileScreen = async (_buf, _mime, plan, overview) => {
			calls.push(plan);
			return overview;
		};
		const result = await validateUploadAssetBuffer({
			buffer: bytes,
			mimeType: "image/png",
			assetId: "asset-tall",
			workspaceId: "ws-tall",
			screen: async () => passedVerdict(),
			tileScreen,
		});
		expect(result.ok).toBe(true);
		// The tile executor ran exactly once, and the plan it received actually contains
		// moderation tiles (a tall page is NOT screened by the diluted overview alone).
		expect(calls).toHaveLength(1);
		expect(calls[0].some((d) => d.purpose === "moderation_tile")).toBe(true);
		// Sanity: the same plan builder confirms this geometry produces tiles.
		expect(buildModerationDerivativePlan({ width: 1024, height: 6000 }).some((d) => d.purpose === "moderation_tile")).toBe(true);
	});

	test("a SHORT page produces NO tiles (plan is overview-only — no extra provider cost)", async () => {
		const bytes = await realPng(64, 64);
		const calls: AssetDerivative[][] = [];
		const tileScreen: TileScreen = async (_buf, _mime, plan, overview) => {
			calls.push(plan);
			return overview;
		};
		const result = await validateUploadAssetBuffer({
			buffer: bytes,
			mimeType: "image/png",
			assetId: "asset-short",
			workspaceId: "ws-short",
			screen: async () => passedVerdict(),
			tileScreen,
		});
		expect(result.ok).toBe(true);
		// executeModerationTilePlan is still invoked (mirrors images.ts), but with a
		// tile-free plan, so it returns the overview verdict unchanged at no fan-out cost.
		expect(calls).toHaveLength(1);
		expect(calls[0].some((d) => d.purpose === "moderation_tile")).toBe(false);
		expect(buildModerationDerivativePlan({ width: 64, height: 64 }).some((d) => d.purpose === "moderation_tile")).toBe(false);
	});

	test("a BLOCKED tile aggregate REJECTS the tall upload (403) even when the overview passed", async () => {
		// The whole point of FINDING 2: a tall page whose OVERVIEW passes (a small unsafe
		// region diluted below threshold) must still be blocked when a TILE blocks.
		const bytes = await tallPng();
		const overviewScreen: CsamScreen = async () => passedVerdict();
		const tileScreen: TileScreen = async () => ({ status: "blocked", provider: "test", checkedAt: new Date().toISOString(), reason: "tile csam" });
		const result = await validateUploadAssetBuffer({
			buffer: bytes,
			mimeType: "image/png",
			assetId: "asset-tall-blocked",
			workspaceId: "ws-tall",
			screen: overviewScreen,
			tileScreen,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.status).toBe(403);
		expect(result.body.code).toBe("moderation_blocked");
	});

	test("a fail-closed (needs_review) tile aggregate threads through to quarantine, not a hard 403", async () => {
		const bytes = await tallPng();
		const tileScreen: TileScreen = async () => ({ status: "needs_review", provider: "test", checkedAt: new Date().toISOString(), failClosed: true });
		const result = await validateUploadAssetBuffer({
			buffer: bytes,
			mimeType: "image/png",
			assetId: "asset-tall-review",
			workspaceId: "ws-tall",
			screen: async () => passedVerdict(),
			tileScreen,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.moderation.status).toBe("needs_review");
		expect(storageStatusForModerationResult(result.moderation)).toBe("quarantined");
	});

	test("the REAL tile executor screens a tall page end-to-end and a benign page passes", async () => {
		// No injected tileScreen: drive the real executeModerationTilePlan. With no
		// OPENAI_API_KEY in the non-production test env the mandatory screen local-passes,
		// so a benign tall page aggregates to `passed` — proving the wiring runs without
		// throwing and short-circuits cleanly (overview already passed via injected screen).
		const bytes = await tallPng();
		const result = await validateUploadAssetBuffer({
			buffer: bytes,
			mimeType: "image/png",
			assetId: "asset-tall-real",
			workspaceId: "ws-tall-real",
			screen: async () => passedVerdict(),
			// no tileScreen → real executeModerationTilePlan
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.moderation.status).toBe("passed");
	});
});

// ── known-CSAM-sha denylist (FINDING 2): hard-block + seed BEFORE any provider call ──

describe("validateUploadAssetBuffer known-CSAM-sha denylist", () => {
	afterEach(() => {
		// Restore the default (real) audit store between tests.
		setCsamAuditStoreForTests(new FakeCsamAuditStore())();
	});

	test("a known-blocked sha is HARD-BLOCKED (403) with NO provider/screen call", async () => {
		const pngBytes = await realPng(8, 8);
		const audit = new FakeCsamAuditStore();
		// Seed the denylist with THIS buffer's sha (the same hex encoding the CoW layer
		// + csam_blocks use), so the lookup hits BEFORE the screen runs.
		audit.blocked.add(sha256Hex(pngBytes));
		const restore = setCsamAuditStoreForTests(audit);
		let screenCalled = false;
		const screen: CsamScreen = async () => {
			screenCalled = true;
			return passingScreen();
		};
		try {
			const result = await validateUploadAssetBuffer({
				buffer: pngBytes,
				mimeType: "image/png",
				assetId: "asset-known-bad",
				workspaceId: "ws-1",
				screen,
			});
			// Hard-block regardless of provider availability...
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("unreachable");
			expect(result.status).toBe(403);
			expect(result.body.code).toBe("moderation_blocked");
			// ...and the provider/screen was NEVER consulted (denylist short-circuits it).
			expect(screenCalled).toBe(false);
			// The denylist WAS consulted with the computed sha.
			expect(audit.lookupCalls).toContain(sha256Hex(pngBytes));
		} finally {
			restore();
		}
	});

	test("a denylist LOOKUP failure fails closed to persisted-with-quarantine (no provider call)", async () => {
		const pngBytes = await realPng(8, 8);
		// Audit store whose lookup THROWS (DB down): an exact known-bad re-upload must
		// not depend on provider rediscovery, so the gate holds for review without a
		// provider call (mirrors images.ts buildDenylistLookupFailClosedResult()).
		const failingAudit: CsamBlockAuditStore = {
			async append() {},
			async hasBlockedSha256() {
				throw new Error("denylist DB down");
			},
		};
		const restore = setCsamAuditStoreForTests(failingAudit);
		let screenCalled = false;
		const screen: CsamScreen = async () => {
			screenCalled = true;
			return passingScreen();
		};
		try {
			const result = await validateUploadAssetBuffer({
				buffer: pngBytes,
				mimeType: "image/png",
				assetId: "asset-lookup-err",
				workspaceId: "ws-1",
				screen,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("unreachable");
			expect(result.moderation.status).toBe("needs_review");
			expect(result.moderation.failClosed).toBe(true);
			expect(storageStatusForModerationResult(result.moderation)).toBe("quarantined");
			// Held WITHOUT spending a provider call.
			expect(screenCalled).toBe(false);
		} finally {
			restore();
		}
	});

	test("the mandatory screen is passed the computed sha256 (so a confirmed block SEEDS the denylist)", async () => {
		const pngBytes = await realPng(8, 8);
		const audit = new FakeCsamAuditStore();
		const restore = setCsamAuditStoreForTests(audit);
		let seenSha: string | undefined;
		const screen: CsamScreen = async (_buffer, _mime, _ws, options) => {
			seenSha = options?.sha256;
			return passingScreen();
		};
		try {
			const result = await validateUploadAssetBuffer({
				buffer: pngBytes,
				mimeType: "image/png",
				assetId: "asset-seed",
				workspaceId: "ws-1",
				screen,
			});
			expect(result.ok).toBe(true);
			// The sha threaded into the screen is the buffer's content hash — the same
			// value csam_blocks records, so a confirmed block on the real path seeds the
			// denylist for future hard-blocks.
			expect(seenSha).toBe(sha256Hex(pngBytes));
		} finally {
			restore();
		}
	});

	test("a confirmed mandatory block via the REAL screen seeds the denylist (append called with the sha)", async () => {
		// Drive the REAL mandatoryCsamScreenBuffer (no injected screen) with a stubbed
		// OpenAI response that scores sexual/minors above the CSAM cutoff. The real
		// screen routes through moderateMultimodal → evaluateOpenAiResult, which appends
		// a csam_blocks audit row carrying the threaded sha — proving the wiring seeds
		// the denylist end-to-end.
		const originalFetch = globalThis.fetch;
		const originalKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "sk-test";
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (!url.startsWith("https://api.openai.com/v1/moderations")) return originalFetch(input, init);
			return new Response(JSON.stringify({
				id: "modr-test",
				model: "omni-moderation-latest",
				results: [{ flagged: true, categories: { "sexual/minors": true }, category_scores: { "sexual/minors": 0.92 }, category_applied_input_types: {} }],
			}), { status: 200, headers: { "Content-Type": "application/json" } });
		}) as typeof fetch;
		const pngBytes = await realPng(8, 8);
		const audit = new FakeCsamAuditStore();
		const restore = setCsamAuditStoreForTests(audit);
		try {
			const result = await validateUploadAssetBuffer({
				buffer: pngBytes,
				mimeType: "image/png",
				assetId: "asset-confirmed",
				workspaceId: "ws-confirmed",
				// no `screen` → real mandatoryCsamScreenBuffer runs
			});
			// A confirmed CSAM verdict hard-blocks the upload (403)...
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("unreachable");
			expect(result.status).toBe(403);
			// ...and seeds the denylist: an audit row was appended carrying the sha.
			expect(audit.records.length).toBeGreaterThanOrEqual(1);
			expect(audit.records.some((r) => r.sha256 === sha256Hex(pngBytes))).toBe(true);
			expect(audit.blocked.has(sha256Hex(pngBytes))).toBe(true);
		} finally {
			restore();
			globalThis.fetch = originalFetch;
			if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = originalKey;
		}
	});
});

// ── route wiring: POST /api/assets/upload rejects before the DB-backed service ──

describe("POST /api/assets/upload route wiring (rejects before writeBlob)", () => {
	// The authoritative write check now runs BEFORE validation (codex P1), so the
	// wiring tests inject a fake CoW service: assertCanWriteAsset resolves (the
	// caller is authorized) and writeBlob throws if ever reached — proving every
	// rejection below happens before the durable write.
	const passingService = {
		assertCanWriteAsset: async () => ({}),
		assertAccountNotFrozen: async () => undefined,
		writeBlob: async () => {
			throw new Error("writeBlob must not be reached by a rejected upload");
		},
	} as unknown as import("../services/storage-cow.js").StorageCowService;

	function uploadApp(): Hono {
		const app = new Hono();
		app.use("*", async (c: Context, next: Next) => {
			c.set("user", { userId: "u-1", email: "u@x.com", role: "editor", iat: 0, exp: 0 });
			await next();
		});
		app.route("/api/assets", assets);
		return app;
	}

	async function upload(
		body: Record<string, unknown>,
		service: import("../services/storage-cow.js").StorageCowService = passingService,
	): Promise<{ status: number; json: any }> {
		setSharedStorageCowServiceForTesting(service);
		try {
			const res = await uploadApp().request("/api/assets/upload", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			return { status: res.status, json: await res.json().catch(() => ({})) };
		} finally {
			setSharedStorageCowServiceForTesting(null);
		}
	}

	test("mismatched magic bytes → 400 mime_type_mismatch", async () => {
		const png = await realPng();
		const { status, json } = await upload({
			accountKind: "workspace",
			accountId: "ws-1",
			assetId: "route-mismatch",
			mimeType: "image/webp", // bytes are PNG
			bufferBase64: png.toString("base64"),
		});
		expect(status).toBe(400);
		expect(json.code).toBe("mime_type_mismatch");
	});

	test("extension/MIME disagreement → 400 asset_extension_mismatch before writeBlob", async () => {
		const png = await realPng();
		const { status, json } = await upload({
			accountKind: "workspace",
			accountId: "ws-1",
			assetId: "route-extension-lie.webp",
			mimeType: "image/png",
			bufferBase64: png.toString("base64"),
		});
		expect(status).toBe(400);
		expect(json.code).toBe("asset_extension_mismatch");
		expect(json.expectedMimeType).toBe("image/webp");
	});

	test("oversized-pixel bomb → 413 image_dimensions_too_large", async () => {
		const bomb = craftPixelBombPng(10000, 10000);
		const { status, json } = await upload({
			accountKind: "workspace",
			accountId: "ws-1",
			assetId: "route-bomb",
			mimeType: "image/png",
			bufferBase64: bomb.toString("base64"),
		});
		expect(status).toBe(413);
		expect(json.code).toBe("image_dimensions_too_large");
	});

	test("AUTHORIZATION RUNS FIRST: an unauthorized upload is rejected before any decode/moderation work", async () => {
		// A pixel bomb that validation would 413 — but the caller is NOT authorized.
		// The cheap authoritative write check must reject BEFORE the expensive
		// decode + paid moderation gate runs (codex P1): asserting the 403 (not the
		// 413) proves the ordering without needing a screen spy.
		const denyingService = {
			assertCanWriteAsset: async () => {
				throw new StorageCowAuthorizationError("not a member of this workspace", 403, "forbidden");
			},
			assertAccountNotFrozen: async () => undefined,
			writeBlob: async () => {
				throw new Error("writeBlob must not be reached");
			},
		} as unknown as import("../services/storage-cow.js").StorageCowService;
		const bomb = craftPixelBombPng(10000, 10000);
		const { status, json } = await upload({
			accountKind: "workspace",
			accountId: "ws-unauthorized",
			assetId: "route-authz-first",
			mimeType: "image/png",
			bufferBase64: bomb.toString("base64"),
		}, denyingService);
		expect(status).toBe(403);
		expect(json.code).toBe("forbidden");
	});

	test("non-image declared type → 400 unsupported_asset_type", async () => {
		const { status, json } = await upload({
			accountKind: "workspace",
			accountId: "ws-1",
			assetId: "route-font",
			mimeType: "application/octet-stream",
			bufferBase64: Buffer.from("arbitrary bytes").toString("base64"),
		});
		expect(status).toBe(400);
		expect(json.code).toBe("unsupported_asset_type");
	});

	test("non-decodable image bytes → 400 image_not_decodable", async () => {
		const { status, json } = await upload({
			accountKind: "workspace",
			accountId: "ws-1",
			assetId: "route-garbage",
			mimeType: "image/png",
			bufferBase64: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]).toString("base64"),
		});
		expect(status).toBe(400);
		expect(json.code).toBe("image_not_decodable");
	});

	test("a known-blocked sha → 403 moderation_blocked BEFORE writeBlob (FINDING 2)", async () => {
		const png = await realPng(8, 8);
		const audit = new FakeCsamAuditStore();
		audit.blocked.add(sha256Hex(png));
		const restore = setCsamAuditStoreForTests(audit);
		try {
			// passingService.writeBlob throws if reached, so a 403 proves the denylist
			// hard-block fires before the durable write.
			const { status, json } = await upload({
				accountKind: "workspace",
				accountId: "ws-1",
				assetId: "route-known-bad",
				mimeType: "image/png",
				bufferBase64: png.toString("base64"),
			});
			expect(status).toBe(403);
			expect(json.code).toBe("moderation_blocked");
		} finally {
			restore();
		}
	});

	test("FINDING 1: a FROZEN account is rejected (402) BEFORE any screen/denylist/tile call (no paid moderation burned)", async () => {
		// The pre-moderation freeze gate runs BETWEEN assertCanWriteAsset and
		// validateUploadAssetBuffer, so an authorized-but-frozen account must be
		// 402'd before a single moderation call (screen/denylist lookup/tile) runs.
		const png = await realPng(8, 8);
		// A spy audit store: any moderation work inside validateUploadAssetBuffer
		// would consult the denylist (hasBlockedSha256) and/or append. The freeze
		// gate must short-circuit so BOTH stay at zero.
		const audit = new FakeCsamAuditStore();
		const restore = setCsamAuditStoreForTests(audit);
		const frozenService = {
			assertCanWriteAsset: async () => ({ workspaceId: "ws-1" }),
			assertAccountNotFrozen: async () => {
				throw new QuotaFrozenError({
					accountKind: "workspace",
					accountId: "ws-1",
					usedBytes: 1024,
					limitBytes: 1024,
					top5LargestAssets: [],
				});
			},
			writeBlob: async () => {
				throw new Error("writeBlob must not be reached by a frozen upload");
			},
		} as unknown as import("../services/storage-cow.js").StorageCowService;
		try {
			const { status, json } = await upload({
				accountKind: "workspace",
				accountId: "ws-1",
				assetId: "route-frozen",
				mimeType: "image/png",
				bufferBase64: png.toString("base64"),
			}, frozenService);
			// The route maps QuotaFrozenError → 402 quota_frozen.
			expect(status).toBe(402);
			expect(json.code).toBe("quota_frozen");
			// NO moderation work ran: the denylist was never consulted and nothing was
			// appended — the PAID screen/tile path was skipped entirely (zero spies).
			expect(audit.lookupCalls).toHaveLength(0);
			expect(audit.records).toHaveLength(0);
		} finally {
			restore();
		}
	});

	test("FINDING 2: the RESOLVED workspace id reaches the screen for a USER-branch upload of a WORKSPACE asset", async () => {
		// assertCanWriteAsset resolves the asset's owning workspace; the route must
		// thread that into the moderation call even though accountKind is 'user'
		// (working copy). We drive the REAL mandatory screen with a stubbed OpenAI
		// CSAM block so it appends an audit row, then assert the row's workspaceId is
		// the RESOLVED workspace ("ws-resolved") — not "" (which a user-branch upload
		// would otherwise pass), proving BYO/audit attribution is preserved.
		const png = await realPng(8, 8);
		const audit = new FakeCsamAuditStore();
		const restore = setCsamAuditStoreForTests(audit);
		const originalFetch = globalThis.fetch;
		const originalKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "sk-test";
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (!url.startsWith("https://api.openai.com/v1/moderations")) return originalFetch(input, init);
			return new Response(JSON.stringify({
				id: "modr-test",
				model: "omni-moderation-latest",
				results: [{ flagged: true, categories: { "sexual/minors": true }, category_scores: { "sexual/minors": 0.92 }, category_applied_input_types: {} }],
			}), { status: 200, headers: { "Content-Type": "application/json" } });
		}) as typeof fetch;
		// The service resolves the asset's owning workspace and returns it; writeBlob
		// is never reached (the CSAM block 403s first).
		const resolvingService = {
			assertCanWriteAsset: async () => ({ workspaceId: "ws-resolved" }),
			assertAccountNotFrozen: async () => undefined,
			writeBlob: async () => {
				throw new Error("writeBlob must not be reached by a blocked upload");
			},
		} as unknown as import("../services/storage-cow.js").StorageCowService;
		try {
			const { status, json } = await upload({
				accountKind: "user",
				accountId: "u-1", // the test user (working-copy upload of a workspace asset)
				assetId: "route-user-ws-asset",
				mimeType: "image/png",
				bufferBase64: png.toString("base64"),
				asWorkingCopy: true,
			}, resolvingService);
			// The confirmed CSAM block 403s the upload...
			expect(status).toBe(403);
			expect(json.code).toBe("moderation_blocked");
			// ...and the audit row attributes the RESOLVED workspace, not "".
			expect(audit.records.length).toBeGreaterThanOrEqual(1);
			const blockRow = audit.records.find((r) => r.sha256 === sha256Hex(png));
			expect(blockRow?.workspaceId).toBe("ws-resolved");
		} finally {
			restore();
			globalThis.fetch = originalFetch;
			if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = originalKey;
		}
	});

	test("FINDING 3: a bad parentVersionId → 400 BEFORE any screen/tile/denylist call (no paid moderation burned)", async () => {
		// The parent-version tenancy/UUID preflight runs BETWEEN assertAccountNotFrozen
		// and validateUploadAssetBuffer, so a parentVersionId that fails the cheap
		// read-only check must 400 before a single moderation call (screen / denylist
		// lookup / tile) runs — mirroring the FROZEN-account precheck above. We spy the
		// denylist audit store: a leaked moderation call would consult/append to it.
		const png = await realPng(8, 8);
		const audit = new FakeCsamAuditStore();
		const restore = setCsamAuditStoreForTests(audit);
		// The fake service's preflight rejects (e.g. parent belongs to another asset);
		// writeBlob throws if ever reached, proving the rejection precedes the durable write.
		let preflightCalledWith: { parentVersionId: string; assetId: string } | undefined;
		const parentRejectingService = {
			assertCanWriteAsset: async () => ({ workspaceId: "ws-1" }),
			assertAccountNotFrozen: async () => undefined,
			assertParentVersionWritable: async (parentVersionId: string, assetId: string) => {
				preflightCalledWith = { parentVersionId, assetId };
				throw new StorageCowAuthorizationError(
					"Parent version belongs to a different asset",
					400,
					"parent_version_asset_mismatch",
				);
			},
			writeBlob: async () => {
				throw new Error("writeBlob must not be reached by a bad-parent upload");
			},
		} as unknown as import("../services/storage-cow.js").StorageCowService;
		try {
			const { status, json } = await upload({
				accountKind: "workspace",
				accountId: "ws-1",
				assetId: "route-bad-parent",
				mimeType: "image/png",
				bufferBase64: png.toString("base64"),
				parentVersionId: "11111111-1111-4111-8111-111111111111", // valid uuid, wrong asset
			}, parentRejectingService);
			// The preflight maps StorageCowAuthorizationError(400) → 400 with the code.
			expect(status).toBe(400);
			expect(json.code).toBe("parent_version_asset_mismatch");
			// The preflight ran with the route's parsed parentVersionId + assetId...
			expect(preflightCalledWith).toEqual({
				parentVersionId: "11111111-1111-4111-8111-111111111111",
				assetId: "route-bad-parent",
			});
			// ...and NO moderation work ran: the denylist was never consulted and nothing
			// was appended — the PAID screen/tile path was skipped entirely (zero spies).
			expect(audit.lookupCalls).toHaveLength(0);
			expect(audit.records).toHaveLength(0);
		} finally {
			restore();
		}
	});

	test("FINDING 3: a GOOD parentVersionId passes the preflight and proceeds to the durable write", async () => {
		// Complement: a parentVersionId that passes the preflight does NOT short-circuit —
		// the upload proceeds THROUGH moderation to the durable-write boundary. We stub
		// writeBlob to throw a QuotaFrozenError (mapped to a deterministic 402) so reaching
		// it proves we got past BOTH the preflight and the moderation gate.
		const png = await realPng(8, 8);
		let preflightCalled = false;
		const passingParentService = {
			assertCanWriteAsset: async () => ({ workspaceId: "ws-1" }),
			assertAccountNotFrozen: async () => undefined,
			assertParentVersionWritable: async () => {
				preflightCalled = true;
			},
			writeBlob: async () => {
				// Authoritative write boundary reached → prove it with a deterministic 402.
				throw new QuotaFrozenError({
					accountKind: "workspace",
					accountId: "ws-1",
					usedBytes: 1024,
					limitBytes: 1024,
					top5LargestAssets: [],
				});
			},
		} as unknown as import("../services/storage-cow.js").StorageCowService;
		const { status, json } = await upload({
			accountKind: "workspace",
			accountId: "ws-1",
			assetId: "route-good-parent",
			mimeType: "image/png",
			bufferBase64: png.toString("base64"),
			parentVersionId: "22222222-2222-4222-8222-222222222222",
		}, passingParentService);
		// The preflight ran and did NOT reject; the request advanced past it + moderation
		// into writeBlob (the 402 it throws), proving the good parent is not short-circuited.
		expect(preflightCalled).toBe(true);
		expect(status).toBe(402);
		expect(json.code).toBe("quota_frozen");
	});
});
