import { describe, expect, test } from "bun:test";
import { buildAnyArrayPredicate, pushArrayLiteral } from "../services/pg-array.js";

describe("pg-array helpers", () => {
	describe("pushArrayLiteral", () => {
		test("appends each value as its own scalar bind and numbers placeholders from current length", () => {
			const params: unknown[] = [];
			const fragment = pushArrayLiteral(params, ["a", "b", "c"]);
			expect(fragment).toBe("ARRAY[$1,$2,$3]::text[]");
			expect(params).toEqual(["a", "b", "c"]);
		});

		test("numbers placeholders relative to pre-existing params", () => {
			const params: unknown[] = ["subjectKind"];
			const fragment = pushArrayLiteral(params, ["x", "y"]);
			expect(fragment).toBe("ARRAY[$2,$3]::text[]");
			expect(params).toEqual(["subjectKind", "x", "y"]);
		});

		test("respects a custom cast type", () => {
			const params: unknown[] = [];
			const fragment = pushArrayLiteral(params, ["00000000-0000-4000-8000-000000000000"], "uuid");
			expect(fragment).toBe("ARRAY[$1]::uuid[]");
		});

		test("empty values produce a valid empty array literal and add no binds", () => {
			const params: unknown[] = ["existing"];
			const fragment = pushArrayLiteral(params, []);
			expect(fragment).toBe("ARRAY[]::text[]");
			expect(params).toEqual(["existing"]);
		});

		test("does NOT bind a JS array as a single param (the bug this guards against)", () => {
			// The whole point: each element is a scalar, never a nested array.
			const params: unknown[] = [];
			pushArrayLiteral(params, ["a", "b"]);
			expect(params.some((p) => Array.isArray(p))).toBe(false);
		});
	});

	describe("buildAnyArrayPredicate", () => {
		test("builds a column = ANY(ARRAY[...]) predicate with scalar binds", () => {
			const params: unknown[] = [];
			const predicate = buildAnyArrayPredicate("project_id", ["p1", "p2"], params);
			expect(predicate).toBe("project_id = ANY(ARRAY[$1,$2]::text[])");
			expect(params).toEqual(["p1", "p2"]);
		});

		test("composes after existing binds (correct placeholder numbering)", () => {
			const params: unknown[] = ["page"];
			const predicate = buildAnyArrayPredicate("subject_id", ["s1", "s2"], params);
			expect(predicate).toBe("subject_id = ANY(ARRAY[$2,$3]::text[])");
			expect(params).toEqual(["page", "s1", "s2"]);
		});

		test("empty values return a never-match FALSE without touching params", () => {
			const params: unknown[] = ["keep"];
			const predicate = buildAnyArrayPredicate("project_id", [], params);
			expect(predicate).toBe("FALSE");
			expect(params).toEqual(["keep"]);
		});
	});
});
