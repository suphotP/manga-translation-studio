import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileUploadAuditStore, isValidUploadAuditCursor, type UploadAuditEvent } from "../services/upload-audit.js";

const tempDirs: string[] = [];

function createStore(events: UploadAuditEvent[]): FileUploadAuditStore {
	const directory = mkdtempSync(join(tmpdir(), "manga-upload-audit-"));
	tempDirs.push(directory);
	const persistPath = join(directory, "upload-audit.json");
	writeFileSync(persistPath, JSON.stringify({ events }, null, 2));
	return new FileUploadAuditStore(persistPath);
}

function createEvent(projectId: string, auditId: string, createdAt: string, overrides: Partial<UploadAuditEvent> = {}): UploadAuditEvent {
	return {
		auditId,
		projectId,
		imageId: `${auditId}.png`,
		originalName: `${auditId}.png`,
		mimeType: "image/png",
		sizeBytes: 70,
		sha256: "a".repeat(64),
		storageDriver: "local",
		storageKey: `projects/${projectId}/images/${auditId}.png`,
		width: 1,
		height: 1,
		actor: { source: "anonymous" },
		createdAt,
		...overrides,
	};
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("upload audit store", () => {
	test("lists upload audit events with bounded cursors and filters", async () => {
		const projectId = "project-a";
		const store = createStore([
			createEvent(projectId, "audit-a", "2026-05-28T01:00:00.000Z", {
				actor: { source: "human", userId: "user-1" },
				imageId: "image-a.png",
			}),
			createEvent(projectId, "audit-b", "2026-05-28T02:00:00.000Z", {
				actor: { source: "anonymous" },
				imageId: "image-b.png",
			}),
			createEvent(projectId, "audit-c", "2026-05-28T03:00:00.000Z", {
				actor: { source: "human", userId: "user-1" },
				imageId: "image-c.png",
			}),
			createEvent("project-b", "audit-other", "2026-05-28T04:00:00.000Z"),
		]);

		const first = await store.listProjectEventPage(projectId, { limit: 2 });
		expect(first.events.map((event) => event.auditId)).toEqual(["audit-c", "audit-b"]);
		expect(first.nextCursor).toEqual(expect.any(String));
		expect(isValidUploadAuditCursor(first.nextCursor)).toBe(true);

		const second = await store.listProjectEventPage(projectId, { limit: 2, cursor: first.nextCursor });
		expect(second.events.map((event) => event.auditId)).toEqual(["audit-a"]);
		expect(second.nextCursor).toBeUndefined();

		const human = await store.listProjectEventPage(projectId, { source: "human", actorUserId: "user-1" });
		expect(human.events.map((event) => event.auditId)).toEqual(["audit-c", "audit-a"]);

		const image = await store.listProjectEventPage(projectId, { imageId: "image-b.png" });
		expect(image.events.map((event) => event.auditId)).toEqual(["audit-b"]);
	});

	test("deletes events for a rolled back project image", async () => {
		const projectId = "project-a";
		const store = createStore([
			createEvent(projectId, "audit-a", "2026-05-28T01:00:00.000Z", { imageId: "image-a.png" }),
			createEvent(projectId, "audit-b", "2026-05-28T02:00:00.000Z", { imageId: "image-b.png" }),
			createEvent("project-b", "audit-b", "2026-05-28T03:00:00.000Z", { imageId: "image-a.png" }),
		]);

		await expect(store.deleteProjectImageEvent(projectId, "image-a.png")).resolves.toBe(true);
		await expect(store.deleteProjectImageEvent(projectId, "missing.png")).resolves.toBe(false);

		expect((await store.listProjectEvents(projectId)).map((event) => event.auditId)).toEqual(["audit-b"]);
		expect((await store.listProjectEvents("project-b")).map((event) => event.auditId)).toEqual(["audit-b"]);
	});

	test("keeps events in memory when delete persistence fails", async () => {
		const projectId = "project-a";
		const directory = mkdtempSync(join(tmpdir(), "manga-upload-audit-delete-fail-"));
		tempDirs.push(directory);
		const persistPath = join(directory, "upload-audit.json");
		writeFileSync(persistPath, JSON.stringify({
			events: [createEvent(projectId, "audit-a", "2026-05-28T01:00:00.000Z", { imageId: "image-a.png" })],
		}, null, 2));
		const store = new FileUploadAuditStore(persistPath);
		rmSync(directory, { recursive: true, force: true });
		writeFileSync(directory, "file");

		await expect(store.deleteProjectImageEvent(projectId, "image-a.png")).rejects.toThrow();
		expect((await store.listProjectEvents(projectId)).map((event) => event.auditId)).toEqual(["audit-a"]);
	});

	test("does not keep appended events in memory when append persistence fails", async () => {
		const directory = mkdtempSync(join(tmpdir(), "manga-upload-audit-append-fail-"));
		tempDirs.push(directory);
		const blockedParent = join(directory, "not-a-dir");
		writeFileSync(blockedParent, "file");
		const store = new FileUploadAuditStore(join(blockedParent, "upload-audit.json"));

		await expect(store.append(createEvent("project-a", "audit-a", "2026-05-28T01:00:00.000Z"))).rejects.toThrow();
		expect(await store.listProjectEvents("project-a")).toEqual([]);
	});

	test("rejects malformed upload audit cursors", () => {
		expect(isValidUploadAuditCursor(undefined)).toBe(true);
		expect(isValidUploadAuditCursor("not-a-cursor")).toBe(false);
		expect(isValidUploadAuditCursor(Buffer.from(JSON.stringify({ createdAt: "nope", auditId: "audit-a" })).toString("base64url"))).toBe(false);
	});
});
