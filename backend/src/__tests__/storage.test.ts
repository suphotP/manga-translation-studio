import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { v4 as uuid } from "uuid";
import { PROJECTS_DIR } from "../config.js";
import { objectStorage } from "../services/storage.js";

const createdProjectDirs: string[] = [];

function createProjectDir(): string {
	const projectId = uuid();
	const projectDir = join(PROJECTS_DIR, projectId);
	mkdirSync(join(projectDir, "images"), { recursive: true });
	writeFileSync(join(projectDir, "state.json"), JSON.stringify({
		projectId,
		name: "Storage Test",
		createdAt: new Date().toISOString(),
		pages: [],
		currentPage: 0,
		targetLang: "th",
	}));
	createdProjectDirs.push(projectDir);
	return projectId;
}

afterEach(() => {
	const projectsRoot = resolve(PROJECTS_DIR);
	for (const projectDir of createdProjectDirs.splice(0)) {
		const resolved = resolve(projectDir);
		if (!resolved.startsWith(projectsRoot)) {
			throw new Error(`Refusing to remove test directory outside projects root: ${resolved}`);
		}
		rmSync(resolved, { recursive: true, force: true });
	}
});

describe("object storage", () => {
	test("stores prototype project images through the local adapter", async () => {
		const projectId = createProjectDir();
		const imageId = `${uuid()}.png`;
		const buffer = Buffer.from("prototype image bytes");

		const stored = await objectStorage.putProjectImage({ projectId, imageId, buffer });
		const loaded = await objectStorage.getProjectImage({ projectId, imageId });

		expect(stored.driver).toBe("local");
		expect(stored.key).toBe(`projects/${projectId}/images/${imageId}`);
		expect(stored.localPath && existsSync(stored.localPath)).toBe(true);
		expect(objectStorage.hasProjectImage({ projectId, imageId })).toBe(true);
		expect(loaded?.equals(buffer)).toBe(true);
	});

	test("deletes stored project export artifacts through the local adapter", async () => {
		const projectId = createProjectDir();
		const exportId = "export-storage-test.zip";
		const buffer = Buffer.from("zip bytes");

		const stored = await objectStorage.putProjectExport({ projectId, exportId, buffer });
		expect(stored.driver).toBe("local");
		expect(stored.key).toBe(`projects/${projectId}/exports/${exportId}`);
		expect(objectStorage.hasProjectExport({ projectId, exportId })).toBe(true);

		const deleted = await objectStorage.deleteProjectExport({ projectId, exportId });
		const deletedAgain = await objectStorage.deleteProjectExport({ projectId, exportId });

		expect(deleted).toBe(true);
		expect(deletedAgain).toBe(false);
		expect(objectStorage.hasProjectExport({ projectId, exportId })).toBe(false);
		expect(await objectStorage.getProjectExport({ projectId, exportId })).toBeUndefined();
	});
});
