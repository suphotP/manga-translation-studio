// #1 catalog-mode upload must not require a pre-existing local project directory.
//
// The upload routes previously did `if (!existsSync(projectDir)) return 404` AFTER
// checkProjectOwnership had already authorized the request. Under the Postgres
// catalog a project is fully authoritative with NO local PROJECTS_DIR/<id> tree, so
// that guard 404'd a legitimate catalog-authorized upload even though the object-
// storage/CoW write path creates dirs as needed. The fix replaces the hard 404 with
// ensureUploadProjectDir(), which idempotently creates the local images directory
// so both the raw /upload and /upload-transform routes proceed to the write path.
//
// This pins the directory-provisioning behavior the catalog-mode path now relies on
// (the per-deployment Postgres-vs-file routing of resolveProjectState is covered by
// resolve-project-state.test.ts). It asserts: a missing project dir is created
// (no throw, no 404 dependency) and the call is idempotent for an existing dir.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { ensureUploadProjectDir } from "../routes/images.js";
import { PROJECTS_DIR } from "../config.js";

const created: string[] = [];

afterEach(() => {
	for (const projectId of created.splice(0)) {
		rmSync(join(PROJECTS_DIR, projectId), { recursive: true, force: true });
	}
});

describe("ensureUploadProjectDir — catalog-mode upload directory provisioning", () => {
	test("creates the local images dir when the project dir does not exist", () => {
		const projectId = `proj-${randomUUID()}`;
		created.push(projectId);
		const projectDir = join(PROJECTS_DIR, projectId);
		const imagesDir = join(projectDir, "images");
		// Precondition: catalog-authoritative project with NO local tree — exactly the
		// case the old `existsSync(projectDir)` 404 wrongly rejected.
		expect(existsSync(projectDir)).toBe(false);

		ensureUploadProjectDir(projectId);

		expect(existsSync(imagesDir)).toBe(true);
	});

	test("is idempotent when the images dir already exists", () => {
		const projectId = `proj-${randomUUID()}`;
		created.push(projectId);
		const imagesDir = join(PROJECTS_DIR, projectId, "images");
		mkdirSync(imagesDir, { recursive: true });

		expect(() => ensureUploadProjectDir(projectId)).not.toThrow();
		expect(existsSync(imagesDir)).toBe(true);
	});
});
