// Hardcoded-Thai regression guard (i18n acquisition tier).
//
// WHY THIS EXISTS
// This app was built Thai-first: large parts of the UI hardcode Thai strings
// directly in `.svelte` markup with no i18n call, so en/ja/ko/zh/ar users see
// raw Thai. We are localizing the app surface-by-surface (starting with the
// ACQUISITION tier: auth modal, account menu, pricing, landing). This test
// measures how much raw, NON-i18n Thai still ships and freezes it behind a
// BASELINE allowlist so:
//   1. it PASSES today (the known Thai-first gap is grandfathered in), and
//   2. it FAILS the moment NEW hardcoded Thai is added, OR an already-localized
//      acquisition surface regresses back to hardcoded Thai.
//
// IMPORTANT: the BASELINE is a CEILING that must only ever RATCHET DOWN. As more
// surfaces are localized (editor panels, library, workboard — the deferred
// ~100-file core-app i18n), lower `THAI_CHAR_BASELINE` / `THAI_FILE_BASELINE`
// to the new (smaller) measured numbers so the gap can never grow back.
//
// WHAT COUNTS AS "RAW" THAI
// Thai that lives inside an i18n helper call — `$_("k")`, `_("k")`, `$t("k")`,
// `t("k", "fallback")`, `msg("k", "ไทย")`, `safeT(...)`, `safeFormat(...)` — is
// considered LOCALIZED (the string is bound to a key, the Thai is only a
// default/fallback) and is NOT counted. Likewise, Thai inside comments
// (`// …`, `<!-- … -->`, `/* … */`) is NOT counted — this repo is heavily
// Thai-commented and those are not user-facing. Everything else (Thai in
// template text or in plain attribute string literals) IS counted.
//
// SCOPE: `.svelte` files under src/lib/components and src/routes, EXCLUDING the
// /admin back-office (internal, intentionally Thai-only for now).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
// .../frontend/src/lib/__tests__  ->  .../frontend/src
const SRC_ROOT = join(HERE, "..", "..");
const SCAN_ROOTS = [join(SRC_ROOT, "lib", "components"), join(SRC_ROOT, "routes")];

// Thai Unicode block (incl. digits + symbols): U+0E00–U+0E7B.
const THAI_RE = /[฀-๻]/g;

function relpath(file: string): string {
	return file.slice(SRC_ROOT.length + 1).split(sep).join("/");
}

function isExcluded(fullPath: string): boolean {
	const rel = relpath(fullPath);
	// Exclude the /admin back-office anywhere in the path.
	return rel.split("/").includes("admin");
}

function walk(dir: string, files: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (isExcluded(full)) continue;
		const st = statSync(full);
		if (st.isDirectory()) walk(full, files);
		else if (entry.endsWith(".svelte")) files.push(full);
	}
	return files;
}

// i18n helper identifiers whose string-literal arguments are i18n-bound.
const HELPER_RE = /(?:\$_|_|\$t|t|msg|safeT|safeFormat)$/;

function isIdentChar(c: string): boolean {
	return /[A-Za-z0-9_$.]/.test(c);
}

/**
 * Return `src` with comments removed and every string literal that is an
 * argument to an i18n helper call blanked to an empty string. The argument
 * walker balances parentheses and skips over string contents, so Thai strings
 * that themselves contain `(`, `)`, or quotes (e.g. FAQ answers) are handled
 * correctly. Whatever Thai remains afterwards is "raw" (non-i18n) Thai.
 */
function sanitize(src: string): string {
	let s = src;
	s = s.replace(/<!--[\s\S]*?-->/g, ""); // HTML comments
	s = s.replace(/\/\*[\s\S]*?\*\//g, ""); // block comments
	s = s.replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://` URLs)

	const out = s.split("");
	const n = s.length;
	let i = 0;
	while (i < n) {
		if (s[i] === "(") {
			// Identify the identifier immediately before the "(".
			let j = i - 1;
			while (j >= 0 && /\s/.test(s[j]!)) j--;
			const end = j;
			while (j >= 0 && isIdentChar(s[j]!)) j--;
			const ident = s.slice(j + 1, end + 1);
			if (ident.length > 0 && HELPER_RE.test(ident)) {
				// Walk to the matching ")", blanking string-literal contents.
				let depth = 0;
				let k = i;
				for (; k < n; k++) {
					const c = s[k]!;
					if (c === "'" || c === '"' || c === "`") {
						const q = c;
						let m = k + 1;
						for (; m < n; m++) {
							if (s[m] === "\\") {
								m++;
								continue;
							}
							if (s[m] === q) break;
						}
						for (let p = k + 1; p < m && p < n; p++) out[p] = "";
						k = m;
						continue;
					}
					if (c === "(") depth++;
					else if (c === ")") {
						depth--;
						if (depth === 0) break;
					}
				}
				i = k + 1;
				continue;
			}
		}
		i++;
	}
	return out.join("");
}

function countRawThai(file: string): number {
	const clean = sanitize(readFileSync(file, "utf8"));
	return (clean.match(THAI_RE) ?? []).length;
}

// ── BASELINE (ratchet DOWN only) ─────────────────────────────────────────────
// Measured AFTER the acquisition-tier extraction (auth/pricing/landing = 0).
// If you localize more surfaces, RE-MEASURE and lower these numbers. Never
// raise them: a higher number means new hardcoded Thai slipped in.
const THAI_CHAR_BASELINE = 44;
const THAI_FILE_BASELINE = 6;

// Acquisition-tier surfaces that MUST stay fully extracted (zero raw Thai).
const ZERO_THAI_FILES = [
	"lib/components/auth/AuthModal.svelte",
	"lib/components/AuthAccountMenu.svelte",
	"routes/pricing/+page.svelte",
	"routes/+page.svelte",
	// Standalone (auth) route-group pages — localized in the public-conversion
	// i18n pass (login/signup/verify-email/forgot/reset).
	"routes/(auth)/login/+page.svelte",
	"routes/(auth)/signup/+page.svelte",
	"routes/(auth)/verify-email/+page.svelte",
	"routes/(auth)/forgot-password/+page.svelte",
	"routes/(auth)/reset-password/+page.svelte",
];

describe("no-hardcoded-thai guard", () => {
	const files = SCAN_ROOTS.flatMap((root) => walk(root));
	const perFile = files
		.map((f) => [relpath(f), countRawThai(f)] as const)
		.filter(([, c]) => c > 0)
		.sort((a, b) => b[1] - a[1]);
	const totalChars = perFile.reduce((sum, [, c]) => sum + c, 0);

	it("scans a meaningful number of files (sanity)", () => {
		expect(files.length).toBeGreaterThan(50);
	});

	it("total raw (non-i18n) Thai does not exceed the baseline ceiling", () => {
		// If this fails because the count went UP, you added hardcoded Thai —
		// wrap it in $_()/msg() with a key. If it went DOWN, lower the baseline.
		expect(
			totalChars,
			`Raw Thai char count is ${totalChars} (baseline ${THAI_CHAR_BASELINE}). ` +
				`If higher: new hardcoded Thai was added — localize it via $_()/msg(). ` +
				`If lower: ratchet THAI_CHAR_BASELINE down to ${totalChars}.\n` +
				`Top offenders:\n${perFile.slice(0, 15).map(([f, c]) => `  ${c}\t${f}`).join("\n")}`,
		).toBeLessThanOrEqual(THAI_CHAR_BASELINE);
	});

	it("number of files containing raw Thai does not exceed the baseline", () => {
		expect(
			perFile.length,
			`${perFile.length} files contain raw Thai (baseline ${THAI_FILE_BASELINE}). ` +
				`If lower, ratchet THAI_FILE_BASELINE down to ${perFile.length}.`,
		).toBeLessThanOrEqual(THAI_FILE_BASELINE);
	});

	it("already-localized acquisition surfaces stay at zero raw Thai", () => {
		const regressed: string[] = [];
		for (const rel of ZERO_THAI_FILES) {
			const full = join(SRC_ROOT, rel);
			const count = countRawThai(full);
			if (count > 0) regressed.push(`${rel}: ${count} raw Thai char(s)`);
		}
		expect(
			regressed,
			`These acquisition-tier files regressed to hardcoded Thai — re-extract to i18n keys:\n${regressed.join("\n")}`,
		).toEqual([]);
	});

	it("does not false-positive on Thai that lives only in comments", () => {
		// A file that is pure Thai comments must sanitize to zero raw Thai.
		const sample = `<!-- ไทยในคอมเมนต์ -->\n<script>\n// คอมเมนต์ไทย\n/* บล็อกไทย */\nconst x = 1;\n</script>\n<div>{x}</div>`;
		expect((sanitize(sample).match(THAI_RE) ?? []).length).toBe(0);
	});

	it("does not false-positive on Thai inside i18n helper fallbacks", () => {
		const sample = `<span>{msg("auth.email", "อีเมล")}</span>\n<p>{$_("pricing.lede")}</p>`;
		expect((sanitize(sample).match(THAI_RE) ?? []).length).toBe(0);
	});

	it("DOES catch raw Thai in template text and attributes", () => {
		const sample = `<h2>คำถามที่พบบ่อย</h2>\n<div aria-label="รอบบิล"></div>`;
		expect((sanitize(sample).match(THAI_RE) ?? []).length).toBeGreaterThan(0);
	});
});
