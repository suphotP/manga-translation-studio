import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	countTermOccurrences,
	FileGlossaryStore,
	type GlossaryEntry,
	GlossaryError,
	type GlossarySqlClient,
	PostgresGlossaryStore,
} from "../services/glossary.js";
import {
	entryWithinScope,
	filterEntriesByScope,
	scopeAllowsLanguage,
	scopeAllowsProject,
	scopeAllowsWrite,
} from "../routes/glossary.js";
import type { WorkspaceScope } from "../services/workspace-access.js";

// ---------------------------------------------------------------------------
// In-memory fake Postgres client for the glossary store. Executes the minimal
// subset of SQL the store issues against a single in-memory table, enforcing
// the (workspace_id, term, target_lang) unique constraint so upsert and
// conflict paths behave like real Postgres.
// ---------------------------------------------------------------------------
interface Row {
	id: string;
	workspace_id: string;
	term: string;
	translation: string;
	target_lang: string;
	notes: string | null;
	role_scope: string | null;
	project_id: string | null;
	created_by: string | null;
	created_at: string;
	updated_at: string;
}

class FakeGlossarySqlClient implements GlossarySqlClient {
	readonly queries: Array<{ query: string; params: unknown[] }> = [];
	rows: Row[] = [];

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		this.queries.push({ query, params });
		const normalized = query.replace(/\s+/g, " ").trim();

		if (normalized.startsWith("INSERT INTO glossary_entries")) {
			const row = this.toRow(params);
			const conflict = this.rows.find(
				(r) => r.workspace_id === row.workspace_id && r.term === row.term && r.target_lang === row.target_lang,
			);
			if (conflict) {
				conflict.translation = row.translation;
				conflict.notes = row.notes;
				conflict.role_scope = row.role_scope;
				conflict.project_id = row.project_id;
				conflict.updated_at = row.updated_at;
				return [{ ...conflict }] as T[];
			}
			this.rows.push(row);
			return [{ ...row }] as T[];
		}

		if (normalized.startsWith("UPDATE glossary_entries")) {
			const [ws, id, term, translation, targetLang, notes, roleScope, projectId, updatedAt] = params as string[];
			// Simulate the unique index: reject a rename onto another row's key.
			if (this.rows.some((r) => r.id !== id && r.workspace_id === ws && r.term === term && r.target_lang === targetLang)) {
				const error = new Error("duplicate key value violates unique constraint \"glossary_entries_workspace_term_lang_uniq\"");
				(error as { code?: string }).code = "23505";
				throw error;
			}
			const target = this.rows.find((r) => r.id === id && r.workspace_id === ws);
			if (!target) return [] as T[];
			Object.assign(target, {
				term,
				translation,
				target_lang: targetLang,
				notes: notes ?? null,
				role_scope: roleScope ?? null,
				project_id: projectId ?? null,
				updated_at: updatedAt,
			});
			return [{ ...target }] as T[];
		}

		if (normalized.startsWith("DELETE FROM glossary_entries")) {
			const [ws, id] = params as string[];
			const index = this.rows.findIndex((r) => r.id === id && r.workspace_id === ws);
			if (index < 0) return [] as T[];
			const [removed] = this.rows.splice(index, 1);
			return [{ id: removed!.id }] as T[];
		}

		if (normalized.startsWith("SELECT") && normalized.includes("FROM glossary_entries")) {
			const ws = params[0];
			let matched = this.rows.filter((r) => r.workspace_id === ws);
			// get(): "AND id = $2 LIMIT 1"
			if (normalized.includes("AND id = $2")) {
				return matched.filter((r) => r.id === params[1]).map((r) => ({ ...r })) as T[];
			}
			// lookup(): "AND target_lang = $2 AND position(lower(term) IN lower($3)) > 0
			//   AND (role_scope IS NULL OR role_scope = $4)
			//   AND (project_id IS NULL OR project_id = $5)
			//   ORDER BY length(term) DESC, lower(term)" — NO truncating LIMIT.
			if (normalized.includes("AND target_lang = $2")) {
				let lookupRows = matched.filter((r) => r.target_lang === params[1]);
				const lowerSql = normalized.toLowerCase();
				// Mirror the SQL substring prefilter so the bounded-candidate behavior is
				// exercised: only terms whose lowercased value is a substring of the
				// lowercased haystack ($3) come back.
				if (lowerSql.includes("position(lower(term) in lower($3))")) {
					const haystack = String(params[2] ?? "").toLowerCase();
					lookupRows = lookupRows.filter((r) => haystack.includes(r.term.toLowerCase()));
				}
				// Mirror the SQL scope predicates pushed down in the round-3 P1a fix.
				// `role_scope = NULL` is never true in SQL, so a NULL bind keeps only
				// role-less rows — exactly like filterByScope when no role is requested.
				if (lowerSql.includes("(role_scope is null or role_scope = $4)")) {
					const role = params[3] ?? null;
					lookupRows = lookupRows.filter((r) => r.role_scope === null || r.role_scope === role);
				}
				if (lowerSql.includes("(project_id is null or project_id = $5)")) {
					const projectId = params[4] ?? null;
					lookupRows = lookupRows.filter((r) => r.project_id === null || r.project_id === projectId);
				}
				// Longer terms first (matches ORDER BY length(term) DESC, lower(term)).
				lookupRows = lookupRows
					.slice()
					.sort((a, b) => b.term.length - a.term.length || a.term.toLowerCase().localeCompare(b.term.toLowerCase()));
				return lookupRows.map((r) => ({ ...r })) as T[];
			}
			// list(): optional target_lang/role_scope/project_id filters by position.
			let paramIndex = 1;
			if (normalized.includes("target_lang = $")) {
				const value = params[paramIndex++];
				matched = matched.filter((r) => r.target_lang === value);
			}
			if (normalized.includes("role_scope = $")) {
				const value = params[paramIndex++];
				matched = matched.filter((r) => r.role_scope === value);
			}
			if (normalized.includes("project_id = $")) {
				const value = params[paramIndex++];
				matched = matched.filter((r) => r.project_id === value);
			}
			return matched
				.slice()
				.sort((a, b) => a.term.toLowerCase().localeCompare(b.term.toLowerCase()))
				.map((r) => ({ ...r })) as T[];
		}

		throw new Error(`Unexpected SQL in fake glossary client: ${normalized}`);
	}

	private toRow(params: unknown[]): Row {
		const [id, workspaceId, term, translation, targetLang, notes, roleScope, projectId, createdBy, createdAt, updatedAt] =
			params as Array<string | null>;
		return {
			id: id!,
			workspace_id: workspaceId!,
			term: term!,
			translation: translation!,
			target_lang: targetLang!,
			notes: notes ?? null,
			role_scope: roleScope ?? null,
			project_id: projectId ?? null,
			created_by: createdBy ?? null,
			created_at: createdAt!,
			updated_at: updatedAt!,
		};
	}
}

// Run the same suite against both store implementations.
function buildStores(): Array<{ name: string; make: () => { store: any; cleanup?: () => void } }> {
	return [
		{
			name: "FileGlossaryStore",
			make: () => {
				const dir = mkdtempSync(join(tmpdir(), "glossary-test-"));
				return { store: new FileGlossaryStore(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
			},
		},
		{
			name: "PostgresGlossaryStore",
			make: () => ({ store: new PostgresGlossaryStore(new FakeGlossarySqlClient()) }),
		},
	];
}

for (const variant of buildStores()) {
	describe(`glossary store (${variant.name})`, () => {
		let store: any;
		let cleanup: (() => void) | undefined;

		beforeEach(() => {
			const built = variant.make();
			store = built.store;
			cleanup = built.cleanup;
		});

		afterEach(() => cleanup?.());

		test("CRUD lifecycle", async () => {
			const created = await store.create({
				workspaceId: "ws-1",
				term: "Senpai",
				translation: "Senior",
				targetLang: "en",
				notes: "honorific",
				createdBy: "user-1",
			});
			expect(created.id).toBeTruthy();
			expect(created.term).toBe("Senpai");
			expect(created.translation).toBe("Senior");
			expect(created.createdBy).toBe("user-1");

			const fetched = await store.get("ws-1", created.id);
			expect(fetched?.translation).toBe("Senior");

			const updated = await store.update("ws-1", created.id, { translation: "Upperclassman", notes: null });
			expect(updated?.translation).toBe("Upperclassman");
			expect(updated?.notes).toBeUndefined();

			const listed = await store.list("ws-1");
			expect(listed).toHaveLength(1);

			const removed = await store.delete("ws-1", created.id);
			expect(removed).toBe(true);
			expect(await store.get("ws-1", created.id)).toBeNull();
			expect(await store.delete("ws-1", created.id)).toBe(false);
		});

		test("update/get/delete return null/false across workspace boundaries", async () => {
			const created = await store.create({ workspaceId: "ws-1", term: "Nakama", translation: "Comrade", targetLang: "en" });
			// Another workspace must never see or mutate this entry.
			expect(await store.get("ws-2", created.id)).toBeNull();
			expect(await store.update("ws-2", created.id, { translation: "Friend" })).toBeNull();
			expect(await store.delete("ws-2", created.id)).toBe(false);
			// Original is untouched.
			expect((await store.get("ws-1", created.id))?.translation).toBe("Comrade");
		});

		test("upsert on (workspace, term, targetLang) conflict", async () => {
			const first = await store.create({ workspaceId: "ws-1", term: "Baka", translation: "Idiot", targetLang: "en" });
			const second = await store.create({ workspaceId: "ws-1", term: "Baka", translation: "Fool", targetLang: "en" });
			// Same term+lang collapses to one row with the new translation.
			expect(second.id).toBe(first.id);
			expect(second.translation).toBe("Fool");
			expect(await store.list("ws-1")).toHaveLength(1);
			// Same term, different language is a distinct entry.
			const fr = await store.create({ workspaceId: "ws-1", term: "Baka", translation: "Idiot", targetLang: "fr" });
			expect(fr.id).not.toBe(first.id);
			expect(await store.list("ws-1")).toHaveLength(2);
		});

		test("update onto an existing term+lang raises a conflict", async () => {
			await store.create({ workspaceId: "ws-1", term: "Kaijuu", translation: "Monster", targetLang: "en" });
			const other = await store.create({ workspaceId: "ws-1", term: "Yokai", translation: "Spirit", targetLang: "en" });
			await expect(store.update("ws-1", other.id, { term: "Kaijuu" })).rejects.toBeInstanceOf(GlossaryError);
		});

		test("workspace isolation in list and lookup", async () => {
			await store.create({ workspaceId: "ws-1", term: "Sensei", translation: "Teacher", targetLang: "en" });
			await store.create({ workspaceId: "ws-2", term: "Sensei", translation: "Master", targetLang: "en" });

			const list1 = await store.list("ws-1");
			expect(list1).toHaveLength(1);
			expect(list1[0].translation).toBe("Teacher");

			const matches2 = await store.lookup("ws-2", "the sensei arrived", "en");
			expect(matches2).toHaveLength(1);
			expect(matches2[0].entry.translation).toBe("Master");
			expect(matches2[0].entry.workspaceId).toBe("ws-2");
		});

		test("lookup returns terms found in the supplied text with counts", async () => {
			await store.create({ workspaceId: "ws-1", term: "ninja", translation: "shinobi", targetLang: "en" });
			await store.create({ workspaceId: "ws-1", term: "katana", translation: "sword", targetLang: "en" });
			await store.create({ workspaceId: "ws-1", term: "absent", translation: "missing", targetLang: "en" });

			const matches = await store.lookup("ws-1", "The ninja drew a katana, a second ninja followed.", "en");
			const byTerm = Object.fromEntries(matches.map((m: any) => [m.entry.term, m.count]));
			expect(byTerm.ninja).toBe(2);
			expect(byTerm.katana).toBe(1);
			expect(byTerm.absent).toBeUndefined();
		});

		test("lookup uses word boundaries for wordy terms and substring for CJK", async () => {
			await store.create({ workspaceId: "ws-1", term: "cat", translation: "neko", targetLang: "en" });
			await store.create({ workspaceId: "ws-1", term: "猫", translation: "cat", targetLang: "en" });

			// "cat" must not match inside "concatenate".
			const wordy = await store.lookup("ws-1", "please concatenate the list", "en");
			expect(wordy).toHaveLength(0);

			const word = await store.lookup("ws-1", "the cat sat", "en");
			expect(word.map((m: any) => m.entry.term)).toEqual(["cat"]);

			// CJK term matches as a substring regardless of surrounding characters.
			const cjk = await store.lookup("ws-1", "黒い猫だ", "en");
			expect(cjk.map((m: any) => m.entry.term)).toEqual(["猫"]);
		});

		test("lookup is scoped by target language", async () => {
			await store.create({ workspaceId: "ws-1", term: "dragon", translation: "ryu", targetLang: "en" });
			await store.create({ workspaceId: "ws-1", term: "dragon", translation: "dragón", targetLang: "es" });
			const en = await store.lookup("ws-1", "a dragon flies", "en");
			expect(en).toHaveLength(1);
			expect(en[0].entry.translation).toBe("ryu");
		});

		test("role_scope filter on list and lookup", async () => {
			await store.create({ workspaceId: "ws-1", term: "SFX", translation: "sound", targetLang: "en", roleScope: "typesetter" });
			await store.create({ workspaceId: "ws-1", term: "tone", translation: "mood", targetLang: "en", roleScope: "qc" });
			await store.create({ workspaceId: "ws-1", term: "name", translation: "namae", targetLang: "en" });

			const typesetterList = await store.list("ws-1", { roleScope: "typesetter" });
			expect(typesetterList.map((e: any) => e.term)).toEqual(["SFX"]);

			// A typesetter lookup sees role-less entries plus typesetter-scoped ones,
			// never the qc-only entry.
			const matches = await store.lookup("ws-1", "the SFX tone and name", "en", { roleScope: "typesetter" });
			const terms = matches.map((m: any) => m.entry.term).sort();
			expect(terms).toEqual(["SFX", "name"]);

			// A lookup with no role only sees role-less entries.
			const noRole = await store.lookup("ws-1", "the SFX tone and name", "en");
			expect(noRole.map((m: any) => m.entry.term)).toEqual(["name"]);
		});

		test("project_id narrows lookup", async () => {
			await store.create({ workspaceId: "ws-1", term: "Arc", translation: "saga", targetLang: "en", projectId: "p-1" });
			await store.create({ workspaceId: "ws-1", term: "global", translation: "common", targetLang: "en" });

			const scoped = await store.lookup("ws-1", "the Arc is global", "en", { projectId: "p-1" });
			expect(scoped.map((m: any) => m.entry.term).sort()).toEqual(["Arc", "global"]);

			const wrongProject = await store.lookup("ws-1", "the Arc is global", "en", { projectId: "p-2" });
			expect(wrongProject.map((m: any) => m.entry.term)).toEqual(["global"]);

			const noProject = await store.lookup("ws-1", "the Arc is global", "en");
			expect(noProject.map((m: any) => m.entry.term)).toEqual(["global"]);
		});

		test("rejects invalid input", async () => {
			await expect(store.create({ workspaceId: "ws-1", term: "  ", translation: "x", targetLang: "en" })).rejects.toBeInstanceOf(GlossaryError);
			await expect(store.create({ workspaceId: "", term: "x", translation: "y", targetLang: "en" })).rejects.toBeInstanceOf(GlossaryError);
			await expect(
				store.create({ workspaceId: "ws-1", term: "x", translation: "y", targetLang: "en", roleScope: "wizard" as any }),
			).rejects.toBeInstanceOf(GlossaryError);
		});

		test("empty/blank lookup text returns no matches", async () => {
			await store.create({ workspaceId: "ws-1", term: "x", translation: "y", targetLang: "en" });
			expect(await store.lookup("ws-1", "", "en")).toHaveLength(0);
			expect(await store.lookup("ws-1", "   ", "en")).toHaveLength(0);
		});
	});
}

describe("PostgresGlossaryStore.lookup is bounded by a substring prefilter (rank 15)", () => {
	test("pushes a substring prefilter + scope into SQL instead of loading the whole glossary, with NO truncating LIMIT", async () => {
		const client = new FakeGlossarySqlClient();
		const store = new PostgresGlossaryStore(client);
		await store.create({ workspaceId: "ws-1", term: "ninja", translation: "忍者", targetLang: "ja" });
		await store.create({ workspaceId: "ws-1", term: "katana", translation: "刀", targetLang: "ja" });
		// A term that does NOT appear in the lookup text must never be materialized.
		await store.create({ workspaceId: "ws-1", term: "dragon", translation: "竜", targetLang: "ja" });
		client.queries.length = 0;

		const matches = await store.lookup("ws-1", "the ninja drew a katana", "ja");
		expect(matches.map((m) => m.entry.term).sort()).toEqual(["katana", "ninja"]);

		// Exactly ONE SELECT, and it carries the bounding substring predicate + the
		// scope predicates — and crucially NO truncating LIMIT (the round-3 P1a fix).
		const selects = client.queries.filter((q) => /SELECT/i.test(q.query) && /FROM glossary_entries/i.test(q.query));
		expect(selects).toHaveLength(1);
		const sql = selects[0]!.query.replace(/\s+/g, " ");
		expect(sql).toMatch(/position\(lower\(term\) IN lower\(\$3\)\)/i);
		expect(sql).toMatch(/role_scope IS NULL OR role_scope = \$4/i);
		expect(sql).toMatch(/project_id IS NULL OR project_id = \$5/i);
		expect(sql).not.toMatch(/LIMIT/i);
		// $3 is the haystack; $4/$5 are the (here null) role/project scope binds.
		expect(selects[0]!.params[2]).toBe("the ninja drew a katana");
		expect(selects[0]!.params[3]).toBeNull();
		expect(selects[0]!.params[4]).toBeNull();
		// No JS array is ever bound — every param is a scalar.
		for (const param of selects[0]!.params) expect(Array.isArray(param)).toBe(false);
	});

	test("the SQL prefilter never returns a term that is not a substring of the text", async () => {
		const client = new FakeGlossarySqlClient();
		const store = new PostgresGlossaryStore(client);
		await store.create({ workspaceId: "ws-1", term: "boss", translation: "ボス", targetLang: "ja" });
		await store.create({ workspaceId: "ws-1", term: "sidekick", translation: "相棒", targetLang: "ja" });
		client.queries.length = 0;

		// Only "boss" appears; the fake honors the position() prefilter so the store
		// receives a bounded candidate set, not the full glossary.
		const matches = await store.lookup("ws-1", "the boss arrived", "ja");
		expect(matches.map((m) => m.entry.term)).toEqual(["boss"]);
	});

	// Round-3 P1a regression guard: the OLD code applied `LIMIT 2000` BEFORE
	// filterByScope ran in JS, ordered only by length(term) DESC. With >2000
	// substring-matching candidates, or with thousands of longer out-of-scope terms
	// sorting ahead of a short in-scope match, the row cap silently DROPPED valid
	// matches the load-all behavior returned. The lookup contract is "return ALL
	// glossary matches"; these cases prove no match is truncated.
	test("returns ALL matches even when far more than the old 2000-row cap substring-match the text", async () => {
		const client = new FakeGlossarySqlClient();
		const store = new PostgresGlossaryStore(client);
		// Build a single text whose every token is a distinct glossary term, with the
		// number of distinct terms well past the old 2000 ceiling. Terms are kept
		// compact (base-36) so all of them fit inside lookupHaystack's truncation
		// window — the point is the ROW count exceeding 2000, not text length.
		const COUNT = 2500;
		const terms = Array.from({ length: COUNT }, (_, i) => `w${i.toString(36)}z`);
		expect(new Set(terms).size).toBe(COUNT); // distinct
		for (const term of terms) {
			await store.create({ workspaceId: "ws-1", term, translation: `t-${term}`, targetLang: "en" });
		}
		const text = terms.join(" ");
		expect(text.length).toBeLessThan(20000); // within lookupHaystack truncation
		client.queries.length = 0;

		const matches = await store.lookup("ws-1", text, "en");
		// Every one of the 2500 terms is a real word-boundary match — none dropped by a
		// row cap the way the old LIMIT 2000 would have.
		expect(matches).toHaveLength(COUNT);
		expect(new Set(matches.map((m) => m.entry.term)).size).toBe(COUNT);
		// And it took exactly one SELECT with no LIMIT clause.
		const selects = client.queries.filter((q) => /SELECT/i.test(q.query) && /FROM glossary_entries/i.test(q.query));
		expect(selects).toHaveLength(1);
		expect(selects[0]!.query.replace(/\s+/g, " ")).not.toMatch(/LIMIT/i);
	});

	test("an out-of-scope-heavy glossary never lets out-of-scope terms crowd out an in-scope match (no truncation)", async () => {
		const client = new FakeGlossarySqlClient();
		const store = new PostgresGlossaryStore(client);
		// Thousands of terms scoped to a DIFFERENT project, all crafted to substring-
		// match the haystack so the prefilter cannot exclude them. Under the old code
		// these counted against the 2000-row cap (ordered length DESC) and could consume
		// the entire budget BEFORE filterByScope ran in JS — dropping the real in-scope
		// match. The in-scope term is placed at the START of the text so haystack
		// truncation can never be the reason it survives; only the SQL scope filter +
		// the removed LIMIT explain it.
		const OUT = 2400;
		const outTerms = Array.from({ length: OUT }, (_, i) => `o${i.toString(36)}x`);
		for (const term of outTerms) {
			await store.create({ workspaceId: "ws-1", term, translation: `x-${term}`, targetLang: "en", projectId: "other-project" });
		}
		await store.create({ workspaceId: "ws-1", term: "hero", translation: "主人公", targetLang: "en", projectId: "p-1" });
		const text = `the hero arrives ${outTerms.join(" ")}`;
		client.queries.length = 0;

		// Requesting project p-1: only the in-scope term + any unscoped terms apply.
		const matches = await store.lookup("ws-1", text, "en", { projectId: "p-1" });
		expect(matches.map((m) => m.entry.term)).toEqual(["hero"]);
		// The SQL scope filter dropped the out-of-scope rows before the JS matcher, and
		// there is no LIMIT to truncate the in-scope match.
		const selects = client.queries.filter((q) => /SELECT/i.test(q.query) && /FROM glossary_entries/i.test(q.query));
		expect(selects).toHaveLength(1);
		expect(selects[0]!.query.replace(/\s+/g, " ")).not.toMatch(/LIMIT/i);
	});
});

describe("countTermOccurrences", () => {
	test("is case-insensitive and respects word boundaries", () => {
		expect(countTermOccurrences("Ninja ninja NINJA", "ninja")).toBe(3);
		expect(countTermOccurrences("concatenate cat scatter", "cat")).toBe(1);
		expect(countTermOccurrences("", "cat")).toBe(0);
		expect(countTermOccurrences("anything", "  ")).toBe(0);
	});

	test("matches multi-word phrases and treats punctuation terms as substrings", () => {
		expect(countTermOccurrences("the big boss fight, big boss again", "big boss")).toBe(2);
		expect(countTermOccurrences("a.b a.b", "a.b")).toBe(2);
	});

	test("accented Latin terms use word boundaries, not substring matching", () => {
		// "café" must not match inside "decaféinated" — accented Latin is still wordy.
		expect(countTermOccurrences("decaféinated coffee", "café")).toBe(0);
		expect(countTermOccurrences("a café here, another café", "café")).toBe(2);
		// Accented uppercase forms and multi-word accented phrases.
		expect(countTermOccurrences("São Paulo and saopaulo", "São")).toBe(1);
		expect(countTermOccurrences("Señor Señorita", "Señor")).toBe(1);
	});
});

describe("FileGlossaryStore corrupt-file handling", () => {
	let dir: string;
	let store: FileGlossaryStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "glossary-corrupt-"));
		store = new FileGlossaryStore(dir);
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("a malformed JSON file surfaces an error instead of overwriting data", async () => {
		await store.create({ workspaceId: "ws-1", term: "Senpai", translation: "Senior", targetLang: "en" });
		// Simulate a truncated/corrupt file from a prior crash.
		const filePath = join(dir, `${encodeURIComponent("ws-1")}.json`);
		writeFileSync(filePath, '[{"id":"x","workspaceId":"ws-1"');

		// Reads must throw, not silently report an empty workspace.
		await expect(store.list("ws-1")).rejects.toBeInstanceOf(GlossaryError);
		// A subsequent write must NOT clobber the file with only the new entry.
		await expect(store.create({ workspaceId: "ws-1", term: "Kohai", translation: "Junior", targetLang: "en" }))
			.rejects.toBeInstanceOf(GlossaryError);

		// The corrupt file is preserved (still recoverable), not replaced.
		const raw = await Bun.file(filePath).text();
		expect(raw).toBe('[{"id":"x","workspaceId":"ws-1"');
	});

	test("a non-array JSON file is treated as corrupt", async () => {
		const filePath = join(dir, `${encodeURIComponent("ws-2")}.json`);
		writeFileSync(filePath, '{"not":"an array"}');
		await expect(store.list("ws-2")).rejects.toBeInstanceOf(GlossaryError);
	});
});

describe("glossary per-member scope enforcement", () => {
	const unscoped: WorkspaceScope = {};
	const projectScoped: WorkspaceScope = { projectIds: ["p-1"] };
	const langScoped: WorkspaceScope = { languages: ["en"] };

	const entry = (over: Partial<GlossaryEntry>): GlossaryEntry => ({
		id: "e-1",
		workspaceId: "ws-1",
		term: "Senpai",
		translation: "Senior",
		targetLang: "en",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...over,
	});

	test("unscoped member can read/write any project and language", () => {
		expect(scopeAllowsProject(unscoped, undefined)).toBe(true);
		expect(scopeAllowsProject(unscoped, "p-9")).toBe(true);
		expect(scopeAllowsLanguage(unscoped, "fr")).toBe(true);
		expect(scopeAllowsWrite(unscoped, { projectId: undefined, targetLang: "fr" })).toBe(true);
	});

	test("project-scoped member cannot read or write outside assigned project", () => {
		// In-scope project entry: visible and writable.
		expect(entryWithinScope(projectScoped, entry({ projectId: "p-1" }))).toBe(true);
		expect(scopeAllowsWrite(projectScoped, { projectId: "p-1", targetLang: "en" })).toBe(true);
		// Out-of-scope project: hidden and not writable.
		expect(entryWithinScope(projectScoped, entry({ projectId: "p-2" }))).toBe(false);
		expect(scopeAllowsWrite(projectScoped, { projectId: "p-2", targetLang: "en" })).toBe(false);
		// Workspace-wide entry (no projectId): readable, but NOT overwritable by a
		// project-scoped member — this is the P1 upsert-hijack the review flagged.
		expect(entryWithinScope(projectScoped, entry({ projectId: undefined }))).toBe(true);
		expect(scopeAllowsWrite(projectScoped, { projectId: undefined, targetLang: "en" })).toBe(false);
	});

	test("language-scoped member is limited to allowed languages", () => {
		expect(scopeAllowsLanguage(langScoped, "en")).toBe(true);
		expect(scopeAllowsLanguage(langScoped, "fr")).toBe(false);
		// Omitting the language (undefined) cannot bypass a language restriction.
		expect(scopeAllowsLanguage(langScoped, undefined)).toBe(false);
		expect(entryWithinScope(langScoped, entry({ targetLang: "fr" }))).toBe(false);
	});

	test("filterEntriesByScope drops out-of-scope entries even when filters are omitted", () => {
		const entries = [
			entry({ id: "a", projectId: "p-1", targetLang: "en" }),
			entry({ id: "b", projectId: "p-2", targetLang: "en" }),
			entry({ id: "c", projectId: undefined, targetLang: "en" }),
			entry({ id: "d", projectId: "p-1", targetLang: "fr" }),
		];
		// Project-scoped reader: only p-1 + workspace-wide entries.
		expect(filterEntriesByScope(projectScoped, entries).map((e) => e.id).sort()).toEqual(["a", "c", "d"]);
		// Language-scoped reader: only English entries.
		expect(filterEntriesByScope(langScoped, entries).map((e) => e.id).sort()).toEqual(["a", "b", "c"]);
		// Unscoped reader sees everything.
		expect(filterEntriesByScope(unscoped, entries)).toHaveLength(4);
	});
});
