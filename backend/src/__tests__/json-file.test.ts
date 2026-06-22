import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test } from "bun:test";
import { parseJsonText, readJsonFile, stripUtf8Bom } from "../utils/json-file.js";

describe("json file helpers", () => {
	test("strips UTF-8 BOM before parsing JSON text", () => {
		expect(stripUtf8Bom("\uFEFF{\"ok\":true}")).toBe("{\"ok\":true}");
		expect(parseJsonText<{ ok: boolean }>("\uFEFF{\"ok\":true}")).toEqual({ ok: true });
	});

	test("reads JSON files written with a UTF-8 BOM", () => {
		const dir = mkdtempSync(join(tmpdir(), "manga-json-"));
		try {
			const path = join(dir, "state.json");
			writeFileSync(path, "\uFEFF{\"projectId\":\"project-1\",\"pages\":[]}");
			expect(readJsonFile<{ projectId: string; pages: unknown[] }>(path)).toEqual({
				projectId: "project-1",
				pages: [],
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
