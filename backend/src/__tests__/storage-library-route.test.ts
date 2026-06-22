// HTTP integration test for the workspace storage-management ("Asset Library")
// surface: GET /api/storage/workspaces/:id/assets and
// DELETE /api/storage/projects/:projectId/assets/:imageId.
//
// Proves the owner-facing behaviour: list every asset across the workspace's
// projects with per-asset bytes + project + kind, sorted biggest-first, with
// per-project + workspace totals; drill into one project; and delete an asset
// (freeing space) — reference-safely (refused while still on a live page unless
// forced). Uses the app's default file-backed test runtime + `app.request`
// directly (no env mutation, no global fetch patch) like workspace-home-route.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import sharp from "sharp";
import { createUser, deleteUser, generateTokens, loadUser, markEmailVerified } from "../services/auth.service.js";
import { objectStorage } from "../services/storage.js";
import { getAssetRecordAuthoritative } from "../services/assets.js";
import { resolveWorkspaceEffectiveStorageLimitBytes } from "../services/storage-quota.js";

let app: Hono;
const createdUserIds: string[] = [];
const previousModeration = process.env.OPENAI_MODERATION_ENABLED;

beforeAll(async () => {
	process.env.RATE_LIMIT_AI_SUBMIT_PER_MINUTE ||= "1000";
	process.env.RATE_LIMIT_AI_SUBMIT_COST_UNITS_PER_MINUTE ||= "10000";
	process.env.RATE_LIMIT_AI_SUBMIT_PER_HOUR ||= "10000";
	// Keep uploads off the network: local moderation pass, no OpenAI call.
	process.env.OPENAI_MODERATION_ENABLED = "false";
	app = (await import("../index.js")).app as unknown as Hono;
});

afterAll(async () => {
	for (const id of createdUserIds) await deleteUser(id).catch(() => undefined);
	if (previousModeration === undefined) delete process.env.OPENAI_MODERATION_ENABLED;
	else process.env.OPENAI_MODERATION_ENABLED = previousModeration;
});

async function makeVerifiedUser(prefix: string): Promise<{ id: string; email: string; token: string }> {
	const created = await createUser({ email: `${prefix}-${crypto.randomUUID()}@example.com`, password: "StrongP@ss123", name: prefix });
	createdUserIds.push(created.user.id);
	await markEmailVerified(created.user.id);
	const user = await loadUser(created.user.id);
	const tokens = await generateTokens(user!);
	return { id: user!.id, email: user!.email, token: tokens.accessToken };
}

function authHeaders(token: string, json = false): Record<string, string> {
	const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
	if (json) headers["Content-Type"] = "application/json";
	return headers;
}

async function createWorkspace(token: string, name: string): Promise<string> {
	const res = await app.request("/api/workspaces", { method: "POST", headers: authHeaders(token, true), body: JSON.stringify({ name }) });
	expect(res.status).toBe(201);
	return (await res.json()).workspace.workspaceId as string;
}

async function createWorkspaceProject(token: string, workspaceId: string, name: string): Promise<string> {
	const res = await app.request("/api/project/new", { method: "POST", headers: authHeaders(token, true), body: JSON.stringify({ name, lang: "th", workspaceId }) });
	expect(res.status).toBe(200);
	return (await res.json()).projectId as string;
}

// Distinct dimensions => distinct (and ordered) byte sizes so "biggest first" is testable.
async function makePng(width: number, height: number): Promise<Buffer> {
	return sharp({ create: { width, height, channels: 3, background: { r: (width * 7) % 256, g: (height * 11) % 256, b: 90 } } }).png().toBuffer();
}

// Upload one image and return its imageId.
async function uploadImage(token: string, projectId: string, name: string, width: number, height: number): Promise<{ imageId: string; sizeBytes: number }> {
	const buffer = await makePng(width, height);
	const fd = new FormData();
	fd.append("images", new Blob([buffer], { type: "image/png" }), name);
	const res = await app.request(`/api/images/${projectId}/upload`, { method: "POST", headers: authHeaders(token), body: fd });
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.imageIds?.length).toBe(1);
	return { imageId: body.imageIds[0] as string, sizeBytes: buffer.length };
}

describe("GET /api/storage/workspaces/:id/assets", () => {
	test("lists assets across projects with sizes (biggest-first), per-project + workspace totals, project + kind filters", async () => {
		const owner = await makeVerifiedUser("storage-lib-owner");
		const workspaceId = await createWorkspace(owner.token, "Storage Library WS");
		const projectA = await createWorkspaceProject(owner.token, workspaceId, "Story A — Ch 1");
		const projectB = await createWorkspaceProject(owner.token, workspaceId, "Story B — Ch 2");

		// A: a big page + a small page. B: a medium page.
		const aBig = await uploadImage(owner.token, projectA, "a-big.png", 600, 600);
		const aSmall = await uploadImage(owner.token, projectA, "a-small.png", 60, 60);
		const bMed = await uploadImage(owner.token, projectB, "b-med.png", 300, 300);

		const res = await app.request(`/api/storage/workspaces/${workspaceId}/assets`, { headers: authHeaders(owner.token) });
		expect(res.status).toBe(200);
		const body = await res.json();

		// Every asset present, each carrying bytes + project + kind.
		expect(body.assets).toHaveLength(3);
		for (const asset of body.assets) {
			expect(asset.sizeBytes).toBeGreaterThan(0);
			expect(asset.projectId).toBeTruthy();
			expect(asset.kind).toBe("uploaded");
		}
		// Sorted biggest space first.
		const sizes = body.assets.map((a: any) => a.sizeBytes + a.derivativeBytes);
		expect([...sizes]).toEqual([...sizes].sort((x, y) => y - x));
		expect(body.assets[0].imageId).toBe(aBig.imageId);

		// Per-project totals.
		const totalsByProject = Object.fromEntries(body.projects.map((p: any) => [p.projectId, p]));
		expect(totalsByProject[projectA].assetCount).toBe(2);
		expect(totalsByProject[projectB].assetCount).toBe(1);
		expect(totalsByProject[projectA].originalBytes).toBe(aBig.sizeBytes + aSmall.sizeBytes);
		expect(totalsByProject[projectA].projectName).toBe("Story A — Ch 1");

		// Workspace grand total.
		expect(body.totals.assetCount).toBe(3);
		expect(body.totals.originalBytes).toBe(aBig.sizeBytes + aSmall.sizeBytes + bMed.sizeBytes);
		expect(body.totals.totalBytes).toBe(body.totals.originalBytes + body.totals.derivativeBytes);
		expect(body.totals.projectCount).toBe(2);

		// Drill into ONE project.
		const drillRes = await app.request(`/api/storage/workspaces/${workspaceId}/assets?projectId=${projectA}`, { headers: authHeaders(owner.token) });
		expect(drillRes.status).toBe(200);
		const drill = await drillRes.json();
		expect(drill.assets).toHaveLength(2);
		expect(drill.assets.every((a: any) => a.projectId === projectA)).toBe(true);

		// kind filter (no ai-generated assets => empty).
		const aiRes = await app.request(`/api/storage/workspaces/${workspaceId}/assets?kind=ai-generated`, { headers: authHeaders(owner.token) });
		expect(aiRes.status).toBe(200);
		expect((await aiRes.json()).assets).toHaveLength(0);
	});

	test("denies a non-member (404 workspace_not_found)", async () => {
		const owner = await makeVerifiedUser("storage-lib-owner2");
		const intruder = await makeVerifiedUser("storage-lib-intruder");
		const workspaceId = await createWorkspace(owner.token, "Private Storage WS");

		const res = await app.request(`/api/storage/workspaces/${workspaceId}/assets`, { headers: authHeaders(intruder.token) });
		expect(res.status).toBe(404);
		expect((await res.json()).code).toBe("workspace_not_found");
	});

	// S3 regression: the recorded asset sizeBytes must be the SERVER-DECODED buffer
	// length, not the client-supplied multipart file.size. We upload a real PNG and
	// assert the authoritative record's sizeBytes equals the exact decoded byte
	// length (which is what the CoW ledger / usage gate must also meter).
	test("records server-measured sizeBytes equal to the decoded buffer length (S3)", async () => {
		const owner = await makeVerifiedUser("storage-size-owner");
		const workspaceId = await createWorkspace(owner.token, "Size Source-Of-Truth WS");
		const projectId = await createWorkspaceProject(owner.token, workspaceId, "Size Story");
		const buffer = await makePng(123, 77);
		const fd = new FormData();
		fd.append("images", new Blob([buffer], { type: "image/png" }), "measured.png");
		const res = await app.request(`/api/images/${projectId}/upload`, { method: "POST", headers: authHeaders(owner.token), body: fd });
		expect(res.status).toBe(200);
		const body = await res.json();
		const imageId = body.imageIds[0] as string;
		// The captured storage reservation bytes are the server-measured pending bytes.
		expect(body.storageReservation?.bytes).toBe(buffer.byteLength);

		const record = await getAssetRecordAuthoritative(projectId, imageId);
		expect(record).toBeTruthy();
		expect(record!.sizeBytes).toBe(buffer.byteLength);

		// And the library view reports the same server-measured size.
		const listRes = await app.request(`/api/storage/workspaces/${workspaceId}/assets`, { headers: authHeaders(owner.token) });
		const list = await listRes.json();
		const listed = list.assets.find((a: any) => a.imageId === imageId);
		expect(listed.sizeBytes).toBe(buffer.byteLength);
	});

	// S1 regression: the plan/pack-derived effective limit the CoW gate now uses must
	// agree with storage-quota and exceed the old hardcoded 1 GiB CoW default. Even a
	// free-tier workspace resolves to the storage-quota included default (2 GiB), so a
	// paid customer is no longer wrongly blocked at 1 GiB by the CoW gate.
	test("resolveWorkspaceEffectiveStorageLimitBytes returns the plan limit, not the 1 GiB CoW default (S1)", async () => {
		const owner = await makeVerifiedUser("size-limit-owner");
		const workspaceId = await createWorkspace(owner.token, "Plan Limit WS");
		const ONE_GIB = 1073741824;
		const limit = await resolveWorkspaceEffectiveStorageLimitBytes(workspaceId);
		expect(limit).not.toBeNull();
		// Strictly greater than the old hardcoded 1 GiB CoW row default.
		expect(limit!).toBeGreaterThan(ONE_GIB);
		// And matches the storage-quota free-tier default (2 GiB).
		expect(limit!).toBe(2 * ONE_GIB);
	});

	test("returns honest empty totals for a workspace with no assets", async () => {
		const owner = await makeVerifiedUser("storage-lib-empty");
		const workspaceId = await createWorkspace(owner.token, "Empty Storage WS");

		const res = await app.request(`/api/storage/workspaces/${workspaceId}/assets`, { headers: authHeaders(owner.token) });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.assets).toEqual([]);
		expect(body.totals.assetCount).toBe(0);
		expect(body.totals.totalBytes).toBe(0);
	});
});

describe("DELETE /api/storage/projects/:projectId/assets/:imageId", () => {
	test("deletes an unreferenced asset, frees space, and drops it from totals", async () => {
		const owner = await makeVerifiedUser("storage-del-owner");
		const workspaceId = await createWorkspace(owner.token, "Delete WS");
		const projectId = await createWorkspaceProject(owner.token, workspaceId, "Delete Story");
		const big = await uploadImage(owner.token, projectId, "del-big.png", 500, 500);
		const small = await uploadImage(owner.token, projectId, "del-small.png", 80, 80);

		const beforeRes = await app.request(`/api/storage/workspaces/${workspaceId}/assets`, { headers: authHeaders(owner.token) });
		const before = await beforeRes.json();
		expect(before.totals.assetCount).toBe(2);

		// Delete the big one (not referenced by any page — pages array is empty).
		const delRes = await app.request(`/api/storage/projects/${projectId}/assets/${big.imageId}`, { method: "DELETE", headers: authHeaders(owner.token) });
		expect(delRes.status).toBe(200);
		const del = await delRes.json();
		expect(del.ok).toBe(true);
		expect(del.objectDeleted).toBe(true);
		expect(del.wasReferenced).toBe(false);
		expect(del.freedBytes).toBeGreaterThanOrEqual(big.sizeBytes);
		// The delete echoes the refreshed project storage quota so the in-editor asset
		// library can update its space-used total from this single round-trip.
		expect(del.storageQuota).toBeDefined();
		expect(del.storageQuota.projectId).toBe(projectId);
		expect(typeof del.storageQuota.usedBytes).toBe("number");

		const afterRes = await app.request(`/api/storage/workspaces/${workspaceId}/assets`, { headers: authHeaders(owner.token) });
		const after = await afterRes.json();
		expect(after.totals.assetCount).toBe(1);
		expect(after.assets.map((a: any) => a.imageId)).toEqual([small.imageId]);
		expect(after.totals.originalBytes).toBeLessThan(before.totals.originalBytes);

		// A second delete of the same id is now a 404.
		const dupRes = await app.request(`/api/storage/projects/${projectId}/assets/${big.imageId}`, { method: "DELETE", headers: authHeaders(owner.token) });
		expect(dupRes.status).toBe(404);
	});

	test("deleting an asset also frees its derivative objects in storage (no derivative leak)", async () => {
		const owner = await makeVerifiedUser("storage-del-deriv");
		const workspaceId = await createWorkspace(owner.token, "Deriv WS");
		const projectId = await createWorkspaceProject(owner.token, workspaceId, "Deriv Story");
		const asset = await uploadImage(owner.token, projectId, "deriv-src.png", 400, 400);

		// Materialize a thumbnail derivative for the asset (generates + persists the
		// derivative object + records it on the asset_records row).
		const thumbRes = await app.request(
			`/api/images/${projectId}/${asset.imageId}/thumbnail?width=128&height=128`,
			{ headers: authHeaders(owner.token) },
		);
		expect(thumbRes.status).toBe(200);

		// Find the ready derivative the route persisted and confirm its object exists.
		const record = await getAssetRecordAuthoritative(projectId, asset.imageId);
		const readyDerivative = (record?.derivatives ?? []).find((d) => d.status === "ready" && d.storageKey);
		expect(readyDerivative).toBeDefined();
		expect(await objectStorage.hasProjectDerivative({ projectId, derivativeId: readyDerivative!.id })).toBe(true);

		// Delete the asset.
		const delRes = await app.request(`/api/storage/projects/${projectId}/assets/${asset.imageId}`, { method: "DELETE", headers: authHeaders(owner.token) });
		expect(delRes.status).toBe(200);

		// The derivative object is gone (previously it leaked — deleteProjectImage
		// only removed the original, never the derivatives).
		expect(await objectStorage.hasProjectDerivative({ projectId, derivativeId: readyDerivative!.id })).toBe(false);
	});

	test("refuses to delete an asset referenced by a live page unless forced", async () => {
		const owner = await makeVerifiedUser("storage-del-ref");
		const workspaceId = await createWorkspace(owner.token, "Ref WS");
		const projectId = await createWorkspaceProject(owner.token, workspaceId, "Ref Story");
		const used = await uploadImage(owner.token, projectId, "used.png", 200, 200);

		// Reference the uploaded image from a live page.
		const stateRes = await app.request(`/api/project/${projectId}`, { headers: authHeaders(owner.token) });
		const state = await stateRes.json();
		state.pages = [{ imageId: used.imageId, imageName: "used.png", textLayers: [], imageLayers: [], pendingAiJobs: [], coverRect: null }];
		state.currentPage = 0;
		const saveRes = await app.request(`/api/project/${projectId}/save`, { method: "POST", headers: authHeaders(owner.token, true), body: JSON.stringify(state) });
		expect(saveRes.status).toBe(200);

		// Unforced delete is refused with the referencing page numbers.
		const refusedRes = await app.request(`/api/storage/projects/${projectId}/assets/${used.imageId}`, { method: "DELETE", headers: authHeaders(owner.token) });
		expect(refusedRes.status).toBe(409);
		const refused = await refusedRes.json();
		expect(refused.code).toBe("asset_referenced");
		expect(refused.referencedByPages).toEqual([1]);
		expect(refused.requiresForce).toBe(true);

		// Forced delete succeeds and reports it WAS referenced.
		const forcedRes = await app.request(`/api/storage/projects/${projectId}/assets/${used.imageId}?force=true`, { method: "DELETE", headers: authHeaders(owner.token) });
		expect(forcedRes.status).toBe(200);
		const forced = await forcedRes.json();
		expect(forced.ok).toBe(true);
		expect(forced.wasReferenced).toBe(true);
		expect(forced.referencedByPages).toEqual([1]);
	});

	test("refuses to delete an asset referenced ONLY by a per-language render output unless forced", async () => {
		// Data-loss guard: a translated/typeset render lives under
		// page.languageOutputs[lang].typesetImageId — NOT page.imageId — so the
		// reference scan must look inside languageOutputs too (matching the export
		// pipeline's languageRenderImageId resolution), or force=false would orphan it.
		const owner = await makeVerifiedUser("storage-del-langref");
		const workspaceId = await createWorkspace(owner.token, "LangRef WS");
		const projectId = await createWorkspaceProject(owner.token, workspaceId, "LangRef Story");
		const source = await uploadImage(owner.token, projectId, "lang-source.png", 220, 220);
		const render = await uploadImage(owner.token, projectId, "lang-render.png", 221, 221);

		// Page renders FROM `source`, but the English typeset output points at `render`.
		const stateRes = await app.request(`/api/project/${projectId}`, { headers: authHeaders(owner.token) });
		const state = await stateRes.json();
		state.pages = [{
			imageId: source.imageId,
			imageName: "lang-source.png",
			textLayers: [],
			imageLayers: [],
			pendingAiJobs: [],
			coverRect: null,
			languageOutputs: { en: { textLayers: [], typesetImageId: render.imageId } },
		}];
		state.currentPage = 0;
		const saveRes = await app.request(`/api/project/${projectId}/save`, { method: "POST", headers: authHeaders(owner.token, true), body: JSON.stringify(state) });
		expect(saveRes.status).toBe(200);

		// Deleting the render image (force=false) is refused with the referencing page.
		const refusedRes = await app.request(`/api/storage/projects/${projectId}/assets/${render.imageId}`, { method: "DELETE", headers: authHeaders(owner.token) });
		expect(refusedRes.status).toBe(409);
		const refused = await refusedRes.json();
		expect(refused.code).toBe("asset_referenced");
		expect(refused.referencedByPages).toEqual([1]);
		expect(refused.requiresForce).toBe(true);

		// Forced delete succeeds and reports it WAS referenced.
		const forcedRes = await app.request(`/api/storage/projects/${projectId}/assets/${render.imageId}?force=true`, { method: "DELETE", headers: authHeaders(owner.token) });
		expect(forcedRes.status).toBe(200);
		const forced = await forcedRes.json();
		expect(forced.ok).toBe(true);
		expect(forced.wasReferenced).toBe(true);
		expect(forced.referencedByPages).toEqual([1]);
	});

	test("refuses to delete an asset referenced ONLY by a per-language image LAYER unless forced (#3)", async () => {
		// Track-asset GC guard: a per-language track can carry its OWN imageLayers[]
		// (the export pipeline's languageOutputs[lang].imageLayers OVERRIDE over the
		// flat page.imageLayers). An asset referenced only there is still LIVE for that
		// language's export, so the reference scan must look inside languageOutputs
		// imageLayers too (matching resolveExportImageLayers), or force=false would
		// orphan it and corrupt the track.
		const owner = await makeVerifiedUser("storage-del-langlayer");
		const workspaceId = await createWorkspace(owner.token, "LangLayer WS");
		const projectId = await createWorkspaceProject(owner.token, workspaceId, "LangLayer Story");
		const source = await uploadImage(owner.token, projectId, "ll-source.png", 230, 230);
		const overlay = await uploadImage(owner.token, projectId, "ll-overlay.png", 231, 231);

		// The flat page references `source`; only the English track's imageLayers names
		// `overlay`. The flat page.imageLayers is EMPTY, so the only reference to
		// `overlay` is inside languageOutputs.en.imageLayers.
		const stateRes = await app.request(`/api/project/${projectId}`, { headers: authHeaders(owner.token) });
		const state = await stateRes.json();
		state.pages = [{
			imageId: source.imageId,
			imageName: "ll-source.png",
			textLayers: [],
			imageLayers: [],
			pendingAiJobs: [],
			coverRect: null,
			languageOutputs: {
				en: {
					textLayers: [],
					imageLayers: [
						{ id: "L1", imageId: overlay.imageId, imageName: "ll-overlay.png", x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1, index: 0 },
					],
				},
			},
		}];
		state.currentPage = 0;
		const saveRes = await app.request(`/api/project/${projectId}/save`, { method: "POST", headers: authHeaders(owner.token, true), body: JSON.stringify(state) });
		expect(saveRes.status).toBe(200);

		// Deleting the overlay (force=false) is refused with the referencing page.
		const refusedRes = await app.request(`/api/storage/projects/${projectId}/assets/${overlay.imageId}`, { method: "DELETE", headers: authHeaders(owner.token) });
		expect(refusedRes.status).toBe(409);
		const refused = await refusedRes.json();
		expect(refused.code).toBe("asset_referenced");
		expect(refused.referencedByPages).toEqual([1]);

		// Forced delete succeeds and reports it WAS referenced.
		const forcedRes = await app.request(`/api/storage/projects/${projectId}/assets/${overlay.imageId}?force=true`, { method: "DELETE", headers: authHeaders(owner.token) });
		expect(forcedRes.status).toBe(200);
		const forced = await forcedRes.json();
		expect(forced.ok).toBe(true);
		expect(forced.wasReferenced).toBe(true);
		expect(forced.referencedByPages).toEqual([1]);
	});

	test("P1-b — refuses to delete an edit-layer MASK asset (imageEditLayers[].payload.maskAssetId) unless forced", async () => {
		// Non-destructive bubble-clean stores its result as a tiny image-edit-mask asset
		// referenced by page.imageEditLayers[].payload.maskAssetId — NOT page.imageId. If
		// the reference scan ignored it, a GC/delete pass would remove a mask still
		// composited at reload/export and the clean would silently disappear. The scan
		// must count edit-layer mask ids as live references.
		const owner = await makeVerifiedUser("storage-del-editmask");
		const workspaceId = await createWorkspace(owner.token, "EditMask WS");
		const projectId = await createWorkspaceProject(owner.token, workspaceId, "EditMask Story");
		const source = await uploadImage(owner.token, projectId, "em-source.png", 240, 240);
		const mask = await uploadImage(owner.token, projectId, "em-mask.png", 32, 32);

		// The page background is `source`; the ONLY reference to `mask` is the
		// non-destructive edit layer's payload.maskAssetId.
		const stateRes = await app.request(`/api/project/${projectId}`, { headers: authHeaders(owner.token) });
		const state = await stateRes.json();
		state.pages = [{
			imageId: source.imageId,
			imageName: "em-source.png",
			textLayers: [],
			imageLayers: [],
			pendingAiJobs: [],
			coverRect: null,
			imageEditLayers: [
				{
					id: "edit-1",
					kind: "bubble-clean",
					target: "page-background",
					visible: true,
					opacity: 1,
					sourceImageId: source.imageId,
					bbox: { x: 4, y: 4, w: 10, h: 10 },
					payload: { type: "fill-mask", maskAssetId: mask.imageId, maskEncoding: "png-alpha", fill: { r: 255, g: 255, b: 255, a: 255 } },
					index: 0,
					tool: { id: "bubble-clean" },
					createdAt: "2026-05-12T00:00:00.000Z",
				},
			],
		}];
		state.currentPage = 0;
		const saveRes = await app.request(`/api/project/${projectId}/save`, { method: "POST", headers: authHeaders(owner.token, true), body: JSON.stringify(state) });
		expect(saveRes.status).toBe(200);

		// Deleting the mask (force=false) is refused with the referencing page.
		const refusedRes = await app.request(`/api/storage/projects/${projectId}/assets/${mask.imageId}`, { method: "DELETE", headers: authHeaders(owner.token) });
		expect(refusedRes.status).toBe(409);
		const refused = await refusedRes.json();
		expect(refused.code).toBe("asset_referenced");
		expect(refused.referencedByPages).toEqual([1]);

		// Forced delete succeeds and reports it WAS referenced.
		const forcedRes = await app.request(`/api/storage/projects/${projectId}/assets/${mask.imageId}?force=true`, { method: "DELETE", headers: authHeaders(owner.token) });
		expect(forcedRes.status).toBe(200);
		const forced = await forcedRes.json();
		expect(forced.ok).toBe(true);
		expect(forced.wasReferenced).toBe(true);
		expect(forced.referencedByPages).toEqual([1]);
	});

	test("P1-2 — refuses to delete an edit-layer asset still referenced by a VERSION SNAPSHOT even after it is reverted out of LIVE state", async () => {
		// Data-loss guard: a non-destructive edit reverted/deleted out of live state can
		// still be referenced by a durable version snapshot's imageEditLayers. If the scan
		// only saw live state the mask asset would look unreferenced and GC/delete could
		// remove it — then restoring that snapshot would point imageEditLayers at a deleted
		// asset (broken render/export). The scan must protect snapshot-referenced edit assets.
		const owner = await makeVerifiedUser("storage-del-snapmask");
		const workspaceId = await createWorkspace(owner.token, "SnapMask WS");
		const projectId = await createWorkspaceProject(owner.token, workspaceId, "SnapMask Story");
		const source = await uploadImage(owner.token, projectId, "sm-source.png", 250, 250);
		const mask = await uploadImage(owner.token, projectId, "sm-mask.png", 32, 32);

		const editLayer = {
			id: "edit-snap-1",
			kind: "bubble-clean",
			target: "page-background",
			visible: true,
			opacity: 1,
			sourceImageId: source.imageId,
			bbox: { x: 4, y: 4, w: 10, h: 10 },
			payload: { type: "fill-mask", maskAssetId: mask.imageId, maskEncoding: "png-alpha", fill: { r: 255, g: 255, b: 255, a: 255 } },
			index: 0,
			tool: { id: "bubble-clean" },
			createdAt: "2026-05-12T00:00:00.000Z",
		};
		const basePage = {
			imageId: source.imageId,
			imageName: "sm-source.png",
			textLayers: [],
			imageLayers: [],
			pendingAiJobs: [],
			coverRect: null,
		};

		// 1) Save state WITH the edit layer (references the mask asset).
		const stateRes = await app.request(`/api/project/${projectId}`, { headers: authHeaders(owner.token) });
		const state = await stateRes.json();
		state.pages = [{ ...basePage, imageEditLayers: [editLayer] }];
		state.currentPage = 0;
		const saveWithEdit = await app.request(`/api/project/${projectId}/save`, { method: "POST", headers: authHeaders(owner.token, true), body: JSON.stringify(state) });
		expect(saveWithEdit.status).toBe(200);

		// 2) Snapshot the state that references the mask (durable version).
		const versionRes = await app.request(`/api/project/${projectId}/versions`, { method: "POST", headers: authHeaders(owner.token, true), body: JSON.stringify({ label: "before-revert" }) });
		expect(versionRes.status).toBe(200);
		const versionId = (await versionRes.json()).version.versionId as string;

		// 3) Revert the edit OUT of live state (no live reference to the mask anymore).
		const revertedState = { ...state, pages: [{ ...basePage, imageEditLayers: [] }], currentPage: 0 };
		const saveReverted = await app.request(`/api/project/${projectId}/save`, { method: "POST", headers: authHeaders(owner.token, true), body: JSON.stringify(revertedState) });
		expect(saveReverted.status).toBe(200);

		// 4) The mask is unreferenced in LIVE state but still referenced by the snapshot →
		//    delete is HARD-BLOCKED (data-loss guard). A snapshot is a restore point, so its
		//    assets are NOT force-deletable: even ?force=true returns 409 (P1-2). The error
		//    carries NO requiresForce flag — force does not override a snapshot reference.
		const refusedRes = await app.request(`/api/storage/projects/${projectId}/assets/${mask.imageId}`, { method: "DELETE", headers: authHeaders(owner.token) });
		expect(refusedRes.status).toBe(409);
		const refused = await refusedRes.json();
		expect(refused.code).toBe("asset_referenced_by_version_snapshot");
		expect(refused.referencedByVersionSnapshot).toBe(true);
		expect(refused.referencedByPages).toEqual([]); // not live
		expect(refused.requiresForce).toBeUndefined();

		// 4b) ?force=true is ALSO rejected (the whole point of P1-2): the mask is a durable
		//     snapshot asset, so a forced delete must not be able to orphan a restore point.
		const forcedRes = await app.request(`/api/storage/projects/${projectId}/assets/${mask.imageId}?force=true`, { method: "DELETE", headers: authHeaders(owner.token) });
		expect(forcedRes.status).toBe(409);
		const forced = await forcedRes.json();
		expect(forced.code).toBe("asset_referenced_by_version_snapshot");
		expect(forced.referencedByVersionSnapshot).toBe(true);
		// The asset must STILL exist after the rejected force-delete.
		expect(await getAssetRecordAuthoritative(projectId, mask.imageId)).not.toBeNull();

		// 5) Restoring the snapshot brings the edit layer back AND the mask asset still
		//    exists (the guard kept it alive — even against force), so it resolves correctly.
		const restoreRes = await app.request(`/api/project/${projectId}/versions/${versionId}/restore`, { method: "POST", headers: authHeaders(owner.token, true), body: "{}" });
		expect(restoreRes.status).toBe(200);
		const afterRestore = await (await app.request(`/api/project/${projectId}`, { headers: authHeaders(owner.token) })).json();
		expect(afterRestore.pages[0].imageEditLayers).toHaveLength(1);
		expect(afterRestore.pages[0].imageEditLayers[0].payload.maskAssetId).toBe(mask.imageId);
		expect(await getAssetRecordAuthoritative(projectId, mask.imageId)).not.toBeNull();
	});

	test("refuses to delete the project COVER asset unless forced, and clears the cover first (#2)", async () => {
		// Cover GC guard: the project cover lives at state.coverImageId (NOT on a page),
		// so the page reference scan misses it. Deleting it must be refused unless
		// forced, and a force-delete must clear the cover metadata BEFORE removing the
		// asset so the Library never renders a cover pointing at a deleted image.
		const owner = await makeVerifiedUser("storage-del-cover");
		const workspaceId = await createWorkspace(owner.token, "Cover WS");
		const projectId = await createWorkspaceProject(owner.token, workspaceId, "Cover Story");
		const pageImg = await uploadImage(owner.token, projectId, "cover-page.png", 240, 240);
		const coverImg = await uploadImage(owner.token, projectId, "cover-art.png", 241, 241);

		// One page (so the cover can fall back to it) + an EXPLICIT cover that is NOT
		// any page image, so the only reference to `coverImg` is state.coverImageId.
		const stateRes = await app.request(`/api/project/${projectId}`, { headers: authHeaders(owner.token) });
		const state = await stateRes.json();
		state.pages = [{ imageId: pageImg.imageId, imageName: "cover-page.png", textLayers: [], imageLayers: [], pendingAiJobs: [], coverRect: null }];
		state.currentPage = 0;
		state.coverImageId = coverImg.imageId;
		state.coverOriginalName = "cover-art.png";
		const saveRes = await app.request(`/api/project/${projectId}/save`, { method: "POST", headers: authHeaders(owner.token, true), body: JSON.stringify(state) });
		expect(saveRes.status).toBe(200);

		// Unforced delete of the cover is refused.
		const refusedRes = await app.request(`/api/storage/projects/${projectId}/assets/${coverImg.imageId}`, { method: "DELETE", headers: authHeaders(owner.token) });
		expect(refusedRes.status).toBe(409);
		const refused = await refusedRes.json();
		expect(refused.code).toBe("asset_referenced");
		expect(refused.isProjectCover).toBe(true);
		expect(refused.requiresForce).toBe(true);

		// Forced delete succeeds, reports it was the cover, and the asset is gone.
		const forcedRes = await app.request(`/api/storage/projects/${projectId}/assets/${coverImg.imageId}?force=true`, { method: "DELETE", headers: authHeaders(owner.token) });
		expect(forcedRes.status).toBe(200);
		const forced = await forcedRes.json();
		expect(forced.ok).toBe(true);
		expect(forced.wasProjectCover).toBe(true);

		// The cover metadata was cleared BEFORE the delete → state.coverImageId no
		// longer points at the deleted asset (falls back to the first-page image).
		const afterStateRes = await app.request(`/api/project/${projectId}`, { headers: authHeaders(owner.token) });
		const afterState = await afterStateRes.json();
		expect(afterState.coverImageId).not.toBe(coverImg.imageId);

		// The asset is no longer listed.
		const listRes = await app.request(`/api/storage/workspaces/${workspaceId}/assets`, { headers: authHeaders(owner.token) });
		expect((await listRes.json()).assets.map((a: any) => a.imageId)).not.toContain(coverImg.imageId);
	});

	test("denies delete for a non-member", async () => {
		const owner = await makeVerifiedUser("storage-del-owner3");
		const intruder = await makeVerifiedUser("storage-del-intruder");
		const workspaceId = await createWorkspace(owner.token, "Guarded WS");
		const projectId = await createWorkspaceProject(owner.token, workspaceId, "Guarded Story");
		const asset = await uploadImage(owner.token, projectId, "guarded.png", 120, 120);

		const res = await app.request(`/api/storage/projects/${projectId}/assets/${asset.imageId}`, { method: "DELETE", headers: authHeaders(intruder.token) });
		expect([403, 404]).toContain(res.status);

		// The asset is still listed for the owner.
		const listRes = await app.request(`/api/storage/workspaces/${workspaceId}/assets`, { headers: authHeaders(owner.token) });
		expect((await listRes.json()).assets.map((a: any) => a.imageId)).toContain(asset.imageId);
	});
});
