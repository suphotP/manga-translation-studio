// i18n locale parity guard.
//
// en.json is the source of truth for which keys must exist. Every other
// shipped locale (th/id/ms) MUST contain every key that en.json has,
// otherwise svelte-i18n silently falls back to another language and users
// see the wrong-language string (the bug this guard prevents).
//
// This test fails the build/CI the moment a locale drops below 100% key
// parity with en.json, so a partially-translated locale cannot ship.
//
// It ALSO scans the source for $t('...')/$_('...')/t('...') usages and fails if
// a referenced key is missing from en.json (the restore-page bug, where the
// page called `restore.*` keys that only existed as `privacy.restore.*`).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import en from "../locales/en.json";
import th from "../locales/th.json";
import id from "../locales/id.json";
import ms from "../locales/ms.json";

type Dict = Record<string, unknown>;

// Locales that must be fully translated. en is the reference; it is not tested
// against itself.
const locales: Record<string, Dict> = { th, id, ms };

/** Flatten a nested message dictionary into dotted leaf keys -> string value. */
function flatten(obj: Dict, prefix = "", out: Record<string, string> = {}) {
	for (const [key, value] of Object.entries(obj)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (value && typeof value === "object" && !Array.isArray(value)) {
			flatten(value as Dict, path, out);
		} else {
			out[path] = String(value);
		}
	}
	return out;
}

/** Extract interpolation tokens like {count}, {name} from a string. */
function tokens(value: string): string[] {
	return (value.match(/\{[^}]+\}/g) ?? []).sort();
}

const enFlat = flatten(en as Dict);
const enKeys = Object.keys(enFlat);
const enKeySet = new Set(enKeys);
// Top-level namespaces present in en.json — used to recognize "real" i18n keys
// referenced in source and avoid false positives from unrelated t()/_() calls.
const enNamespaces = new Set(Object.keys(en as Dict));

describe("i18n locale parity", () => {
	it("en.json has a non-trivial number of keys (sanity)", () => {
		expect(enKeys.length).toBeGreaterThan(100);
	});

	for (const [code, dict] of Object.entries(locales)) {
		describe(`${code}.json`, () => {
			const flat = flatten(dict);

			it(`has every key present in en.json`, () => {
				const missing = enKeys.filter((k) => !(k in flat));
				expect(
					missing,
					`${code}.json is missing ${missing.length} key(s) that en.json has; ` +
						`add translations for: ${missing.join(", ")}`,
				).toEqual([]);
			});

			it(`has no empty string values for en's keys`, () => {
				const empty = enKeys.filter(
					(k) => k in flat && flat[k].trim() === "",
				);
				expect(empty, `${code}.json has empty values for: ${empty.join(", ")}`).toEqual(
					[],
				);
			});

			it(`preserves interpolation tokens from en.json`, () => {
				const mismatches: string[] = [];
				for (const k of enKeys) {
					if (!(k in flat)) continue;
					const expected = tokens(enFlat[k]);
					const actual = tokens(flat[k]);
					if (expected.join("|") !== actual.join("|")) {
						mismatches.push(
							`${k}: expected [${expected.join(", ")}], got [${actual.join(", ")}]`,
						);
					}
				}
				expect(
					mismatches,
					`${code}.json has interpolation token mismatches:\n${mismatches.join("\n")}`,
				).toEqual([]);
			});
		});
	}
});

// ── used-but-missing key scan ────────────────────────────────────────────────
//
// Walk frontend/src for i18n key references and assert each resolves in
// en.json. Catches keys like `restore.*` that a page used while only
// `privacy.restore.*` existed (the original P1 regression).

const HERE = dirname(fileURLToPath(import.meta.url));
// .../frontend/src/lib/i18n/__tests__  ->  .../frontend/src
const SRC_ROOT = join(HERE, "..", "..", "..");

function walk(dir: string, files: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "__tests__") continue;
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) walk(full, files);
		else if (/\.(svelte|ts)$/.test(entry)) files.push(full);
	}
	return files;
}

// Match $_('a.b'), $t("a.b"), _('a.b'), t('a.b', ...), msg('a.b', ...),
// safeT('a.b', ...), safeFormat('a.b', ...). Group 2 = the dotted key.
const KEY_CALL = /(?:\$?_|\$?t|msg|safeT|safeFormat)\(\s*(['"])([a-zA-Z][\w.]*\.[\w.]+)\1/g;

function collectUsedKeys(): Map<string, Set<string>> {
	const used = new Map<string, Set<string>>();
	for (const file of walk(SRC_ROOT)) {
		const text = readFileSync(file, "utf8");
		let m: RegExpExecArray | null;
		KEY_CALL.lastIndex = 0;
		while ((m = KEY_CALL.exec(text)) !== null) {
			const key = m[2];
			// Only treat it as an i18n key if its namespace exists in en.json —
			// this filters out unrelated dotted args to non-i18n t()/_()/msg().
			const ns = key.split(".")[0];
			if (!enNamespaces.has(ns)) continue;
			if (!used.has(key)) used.set(key, new Set());
			used.get(key)!.add(file.replace(SRC_ROOT, "src"));
		}
	}
	return used;
}

describe("i18n used-key coverage", () => {
	it("every referenced i18n key exists in en.json", () => {
		const used = collectUsedKeys();
		const missing: string[] = [];
		for (const [key, files] of used) {
			// A reference resolves if it is an exact leaf, or a parent prefix of
			// real leaves (some callers reference a subtree root).
			const isLeaf = enKeySet.has(key);
			const isParent = enKeys.some((k) => k.startsWith(`${key}.`));
			if (!isLeaf && !isParent) {
				missing.push(`${key}  (used in ${[...files].join(", ")})`);
			}
		}
		expect(
			missing,
			`These i18n keys are referenced in source but missing from en.json:\n${missing.join("\n")}`,
		).toEqual([]);
	});
});
