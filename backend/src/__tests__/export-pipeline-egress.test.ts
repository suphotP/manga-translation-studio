// Streamed-egress + rolling-aggregate-quota coverage for the export pipeline.
//
// mock.module hazard: modules EVALUATED while these mocks are active (here:
// export-pipeline.js and its deps) stay cached for the rest of the `bun test`
// process, so later test files would inherit a pipeline baked against the
// mocks. The afterAll below re-binds the mocked modules to their real,
// pre-mock exports — bun live-rebinds ESM importers, which un-poisons the
// cached pipeline for every file that runs after this one.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ObjectStorage, StoredObject } from "../services/storage.js";
import type { StorageQuotaReservationInput } from "../services/storage-quota.js";
import * as realAssets from "../services/assets.js";
import * as realStorageQuota from "../services/storage-quota.js";
import * as realUsageLedger from "../services/usage-ledger.js";

const savedAssets = { ...realAssets };
const savedStorageQuota = { ...realStorageQuota };
const savedUsageLedger = { ...realUsageLedger };

afterAll(() => {
	mock.module("../services/assets.js", () => savedAssets);
	mock.module("../services/storage-quota.js", () => savedStorageQuota);
	mock.module("../services/usage-ledger.js", () => savedUsageLedger);
});

const quotaMocks = {
	reserveProjectStorageQuota: mock(),
	releaseProjectStorageQuotaReservationBestEffort: mock(),
};

const usageMocks = {
	recordExportUsage: mock(),
};

mock.module("../services/assets.js", () => ({
	getAssetRecordAuthoritative: mock(async () => undefined),
	isNeverGrandfatherImageId: mock(() => false),
}));

mock.module("../services/storage-quota.js", () => ({
	reserveProjectStorageQuota: quotaMocks.reserveProjectStorageQuota,
	releaseProjectStorageQuotaReservationBestEffort: quotaMocks.releaseProjectStorageQuotaReservationBestEffort,
}));

mock.module("../services/usage-ledger.js", () => ({
	recordExportUsage: usageMocks.recordExportUsage,
}));

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ax6kYQAAAAASUVORK5CYII=",
	"base64",
);

class SequencedFakeStorage {
	readonly driver = "r2" as const;
	readonly images = new Map<string, Buffer>();
	readonly exports = new Map<string, Buffer>();
	readonly events: string[] = [];
	readonly deleteExportCalls: string[] = [];

	seedImage(projectId: string, imageId: string, buffer = PNG_1X1): void {
		this.images.set(`${projectId}/${imageId}`, buffer);
	}

	presignProjectObject(input: { projectId: string; objectId: string; kind: string; expiresInSeconds: number }): string {
		return `https://signed.example/${input.kind}/${input.projectId}/${encodeURIComponent(input.objectId)}?ttl=${input.expiresInSeconds}`;
	}

	async getProjectImage(input: { projectId: string; imageId: string }): Promise<Buffer | undefined> {
		this.events.push(`get:${input.imageId}`);
		return this.images.get(`${input.projectId}/${input.imageId}`);
	}

	async putProjectExport(input: { projectId: string; exportId: string; buffer: Buffer }): Promise<StoredObject> {
		this.events.push(`put:${input.exportId}`);
		this.exports.set(`${input.projectId}/${input.exportId}`, input.buffer);
		return { driver: this.driver, key: `projects/${input.projectId}/exports/${input.exportId}` };
	}

	async deleteProjectExport(input: { projectId: string; exportId: string }): Promise<boolean> {
		this.events.push(`delete:${input.exportId}`);
		this.deleteExportCalls.push(input.exportId);
		return this.exports.delete(`${input.projectId}/${input.exportId}`);
	}
}

function nthEventIndex(events: string[], value: string, occurrence: number): number {
	let seen = 0;
	for (let index = 0; index < events.length; index += 1) {
		if (events[index] === value) {
			seen += 1;
			if (seen === occurrence) return index;
		}
	}
	return -1;
}

function firstEventIndexAfter(events: string[], start: number, predicate: (event: string) => boolean): number {
	for (let index = start + 1; index < events.length; index += 1) {
		if (predicate(events[index]!)) return index;
	}
	return -1;
}

function configureQuotaMock(options: { failObjectIdIncludes?: string } = {}): void {
	let reservationSeq = 0;
	quotaMocks.reserveProjectStorageQuota.mockImplementation(async (input: StorageQuotaReservationInput) => {
		const objectId = typeof input.metadata?.objectId === "string" ? input.metadata.objectId : "";
		if (options.failObjectIdIncludes && objectId.includes(options.failObjectIdIncludes)) {
			throw new Error(`quota full before ${options.failObjectIdIncludes}`);
		}
		reservationSeq += 1;
		return {
			reservation: {
				reservationId: `reservation-${reservationSeq}`,
				projectId: input.projectId,
				workspaceId: input.workspaceId ?? input.projectId,
				bytes: input.bytes,
				reason: input.reason,
				createdAt: input.now ?? 0,
				expiresAt: (input.now ?? 0) + (input.ttlMs ?? 60_000),
				metadata: input.metadata,
			},
			summary: {},
		};
	});
	quotaMocks.releaseProjectStorageQuotaReservationBestEffort.mockResolvedValue({ released: true });
}

async function loadPipeline(): Promise<typeof import("../services/export-pipeline.js")> {
	process.env.EXPORT_JOB_STORE = "memory";
	return import("../services/export-pipeline.js");
}

describe("export pipeline output egress", () => {
	beforeEach(() => {
		quotaMocks.reserveProjectStorageQuota.mockReset();
		quotaMocks.releaseProjectStorageQuotaReservationBestEffort.mockReset();
		usageMocks.recordExportUsage.mockReset();
		usageMocks.recordExportUsage.mockResolvedValue(undefined);
		configureQuotaMock();
	});

	test("writes each rendered page output before rendering the next page output", async () => {
		const { MemoryExportJobStore, enqueueExportJob, processExportJob } = await loadPipeline();
		const store = new MemoryExportJobStore();
		const storage = new SequencedFakeStorage();
		const projectId = "project-sequential-egress";
		storage.seedImage(projectId, "page-1.png");
		storage.seedImage(projectId, "page-2.png");

		const queued = await enqueueExportJob({
			projectId,
			preset: "master",
			imageIds: ["page-1.png", "page-2.png"],
		}, { store });

		const result = await processExportJob(queued.id, { store, storage: storage as unknown as ObjectStorage });

		expect(result.job.status).toBe("done");
		expect(result.outputs).toHaveLength(2);
		const firstRenderReadPage1 = nthEventIndex(storage.events, "get:page-1.png", 2);
		const firstRenderReadPage2 = nthEventIndex(storage.events, "get:page-2.png", 2);
		const firstPagePut = firstEventIndexAfter(
			storage.events,
			firstRenderReadPage1,
			(event) => event.startsWith("put:") && event.includes("page-1.png"),
		);
		expect(firstRenderReadPage1).toBeGreaterThan(-1);
		expect(firstRenderReadPage2).toBeGreaterThan(-1);
		expect(firstPagePut).toBeGreaterThan(firstRenderReadPage1);
		expect(firstPagePut).toBeLessThan(firstRenderReadPage2);
		expect(storage.events.at(-1)).toBe(`put:${queued.id}/manifest.json`);
	});

	test("re-reserves the running output total with a fresh TTL on each output", async () => {
		const { MemoryExportJobStore, enqueueExportJob, processExportJob } = await loadPipeline();
		const store = new MemoryExportJobStore();
		const storage = new SequencedFakeStorage();
		const projectId = "project-aggregate-reservation";
		storage.seedImage(projectId, "page-1.png");
		storage.seedImage(projectId, "page-2.png");

		const queued = await enqueueExportJob({
			projectId,
			preset: "master",
			imageIds: ["page-1.png", "page-2.png"],
		}, { store });
		await processExportJob(queued.id, { store, storage: storage as unknown as ObjectStorage });

		// page-1 aggregate, page-1+2 aggregate, manifest.
		const reserveCalls = quotaMocks.reserveProjectStorageQuota.mock.calls as Array<[StorageQuotaReservationInput]>;
		expect(reserveCalls).toHaveLength(3);
		const [first, second, manifest] = reserveCalls.map((call) => call[0]);
		expect(first!.metadata?.aggregate).toBe(true);
		expect(second!.metadata?.aggregate).toBe(true);
		// Identical source pages render identical output sizes, so the second
		// aggregate covers exactly twice the first: earlier outputs stay counted.
		expect(second!.bytes).toBe(first!.bytes * 2);
		expect(manifest!.metadata?.objectId).toBe(`${queued.id}/manifest.json`);

		// The superseded page-1 aggregate is released as rolled_up; the final
		// aggregate + manifest reservations release after commit.
		const releaseCalls = quotaMocks.releaseProjectStorageQuotaReservationBestEffort.mock.calls as Array<
			[string, string, Record<string, unknown>]
		>;
		expect(releaseCalls.map((call) => [call[1], call[2]?.phase])).toEqual([
			["reservation-1", "rolled_up"],
			["reservation-2", "after_commit"],
			["reservation-3", "after_commit"],
		]);
	});

	test("keeps a roll-up reservation tracked when its release fails", async () => {
		const { MemoryExportJobStore, enqueueExportJob, processExportJob } = await loadPipeline();
		const store = new MemoryExportJobStore();
		const storage = new SequencedFakeStorage();
		const projectId = "project-rollup-release-failure";
		storage.seedImage(projectId, "page-1.png");
		storage.seedImage(projectId, "page-2.png");
		// Both the roll-up release AND its retry fail; reservation-1 must stay
		// tracked and still be released after commit instead of being dropped.
		quotaMocks.releaseProjectStorageQuotaReservationBestEffort
			.mockResolvedValueOnce({ released: false, error: "redis hiccup" })
			.mockResolvedValueOnce({ released: false, error: "redis hiccup" })
			.mockResolvedValue({ released: true });

		const queued = await enqueueExportJob({
			projectId,
			preset: "master",
			imageIds: ["page-1.png", "page-2.png"],
		}, { store });
		const result = await processExportJob(queued.id, { store, storage: storage as unknown as ObjectStorage });

		expect(result.job.status).toBe("done");
		const releaseCalls = quotaMocks.releaseProjectStorageQuotaReservationBestEffort.mock.calls as Array<
			[string, string, Record<string, unknown>]
		>;
		expect(releaseCalls.map((call) => [call[1], call[2]?.phase])).toEqual([
			["reservation-1", "rolled_up"],
			["reservation-1", "rolled_up_retry"],
			["reservation-1", "after_commit"],
			["reservation-2", "after_commit"],
			["reservation-3", "after_commit"],
		]);
	});

	test("cleans up already-written outputs when a later quota reservation fails", async () => {
		configureQuotaMock({ failObjectIdIncludes: "page-2.png" });
		const { MemoryExportJobStore, enqueueExportJob, processExportJob } = await loadPipeline();
		const store = new MemoryExportJobStore();
		const storage = new SequencedFakeStorage();
		const projectId = "project-quota-rollback";
		storage.seedImage(projectId, "page-1.png");
		storage.seedImage(projectId, "page-2.png");

		const queued = await enqueueExportJob({
			projectId,
			preset: "master",
			imageIds: ["page-1.png", "page-2.png"],
		}, { store });

		await expect(processExportJob(queued.id, { store, storage: storage as unknown as ObjectStorage }))
			.rejects.toThrow(/quota full before page-2\.png/);

		expect((await store.get(queued.id))?.status).toBe("error");
		expect(storage.deleteExportCalls).toHaveLength(1);
		expect(storage.deleteExportCalls[0]).toContain("page-1.png");
		expect(storage.exports.size).toBe(0);
		// The page-1 aggregate was already released (rolled_up) before the failing
		// page-2 re-reserve, so rollback has no reservations left to release.
		const releaseCalls = quotaMocks.releaseProjectStorageQuotaReservationBestEffort.mock.calls as Array<
			[string, string, Record<string, unknown>]
		>;
		expect(releaseCalls.map((call) => [call[1], call[2]?.phase])).toEqual([
			["reservation-1", "rolled_up"],
		]);
		expect(usageMocks.recordExportUsage).not.toHaveBeenCalled();
	});
});
