import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const appCss = readFileSync(join(process.cwd(), "src/app.css"), "utf8");

const legacyVisualBridge = {
	"--editor-bg": "var(--color-ws-bg, #0B0B0F)",
	"--editor-surface": "var(--color-ws-surface, #15151D)",
	"--editor-surface-raised": "var(--color-ws-surface2, #1C1C26)",
	"--editor-canvas-bg": "var(--color-ws-bg, #0B0B0F)",
	"--editor-border": "var(--ws-hair-strong, rgba(255, 255, 255, 0.11))",
	"--editor-border-soft": "var(--ws-hair, rgba(255, 255, 255, 0.07))",
	"--editor-text": "var(--color-ws-ink, #ECECF2)",
	"--editor-text-dim": "var(--color-ws-text, #9A9AA8)",
	"--editor-text-muted": "var(--color-ws-faint, #8A8A98)",
	"--editor-accent": "var(--color-ws-accent, #7C5CFF)",
	"--editor-accent-hover": "var(--color-ws-violet, #8B5CF6)",
	"--editor-success": "var(--color-ws-green, #34D399)",
	"--editor-warning": "var(--color-ws-amber, #FBBF24)",
	"--editor-danger": "var(--color-ws-rose, #FB7185)",
	"--workspace-bg": "var(--color-ws-bg, #0B0B0F)",
	"--workspace-bg-2": "var(--color-ws-surface, #15151D)",
	"--workspace-panel": "var(--color-ws-surface, #15151D)",
	"--workspace-panel-raised": "var(--color-ws-surface2, #1C1C26)",
	"--workspace-panel-soft": "var(--ws-hair, rgba(255, 255, 255, 0.07))",
	"--workspace-line": "var(--ws-hair, rgba(255, 255, 255, 0.07))",
	"--workspace-line-strong": "var(--ws-hair-strong, rgba(255, 255, 255, 0.11))",
	"--workspace-ink": "var(--color-ws-ink, #ECECF2)",
	"--workspace-text": "var(--color-ws-text, #9A9AA8)",
	"--workspace-muted": "var(--color-ws-faint, #8A8A98)",
	"--workspace-dim": "var(--color-ws-faint, #8A8A98)",
	"--workspace-violet": "var(--color-ws-violet, #8B5CF6)",
	"--workspace-magenta": "var(--color-ws-accent, #7C5CFF)",
	"--workspace-cyan": "var(--color-ws-cyan, #22D3EE)",
	"--workspace-green": "var(--color-ws-green, #34D399)",
	"--workspace-amber": "var(--color-ws-amber, #FBBF24)",
	"--workspace-red": "var(--color-ws-rose, #FB7185)",
	"--workspace-radius": "var(--radius-ws-card, 12px)",
	"--workspace-shadow": "0 14px 40px -28px color-mix(in srgb, var(--color-ws-bg, #0B0B0F) 90%, transparent)",
} as const;

const structuralLegacyTokens = [
	"--editor-toolbar-h",
	"--editor-statusbar-h",
	"--editor-sidebar-w",
	"--editor-tools-w",
	"--editor-main-toolbar-h",
	"--editor-options-toolbar-h",
] as const;

const canonicalWsTokens = {
	"--color-ws-ink": "#ECECF2",
	"--color-ws-text": "#9A9AA8",
	"--color-ws-faint": "#8A8A98",
	"--color-ws-line": "#a6b7dc",
	"--color-ws-bg": "#0B0B0F",
	"--color-ws-surface": "#15151D",
	"--color-ws-surface2": "#1C1C26",
	"--color-ws-accent": "#7C5CFF",
	"--color-ws-cyan": "#22D3EE",
	"--color-ws-green": "#34D399",
	"--color-ws-amber": "#FBBF24",
	"--color-ws-rose": "#FB7185",
	"--color-ws-violet": "#8B5CF6",
	"--color-ws-blue": "#8fb8ff",
	"--radius-ws": "16px",
	"--radius-ws-card": "12px",
	"--radius-ws-ctrl": "10px",
	"--ws-hair": "rgba(255, 255, 255, 0.07)",
	"--ws-hair-strong": "rgba(255, 255, 255, 0.11)",
} as const;

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function declarationsFor(token: string) {
	const pattern = new RegExp(`^\\s*${escapeRegExp(token)}\\s*:\\s*([^;]+);`, "gm");
	return [...appCss.matchAll(pattern)].map((match) => match[1].trim());
}

function uniqueLegacyTokens() {
	const pattern = /^\s*(--(?:editor|workspace)-[\w-]+)\s*:/gm;
	return [...new Set([...appCss.matchAll(pattern)].map((match) => match[1]))].sort();
}

describe("app.css legacy token bridge", () => {
	it("accounts for every declared legacy editor/workspace token", () => {
		const expectedTokens = [
			...Object.keys(legacyVisualBridge),
			...structuralLegacyTokens,
		].sort();

		expect(uniqueLegacyTokens()).toEqual(expectedTokens);
	});

	it("maps legacy visual tokens to the canonical ws dark tokens", () => {
		for (const [token, expectedValue] of Object.entries(legacyVisualBridge)) {
			expect(declarationsFor(token)[0]).toBe(expectedValue);
		}
	});

	it("leaves structural editor shell tokens as layout values", () => {
		for (const token of structuralLegacyTokens) {
			const values = declarationsFor(token);

			expect(values.length).toBeGreaterThan(0);
			expect(values.every((value) => !value.includes("--color-ws-"))).toBe(true);
			expect(values.every((value) => !value.includes("--ws-hair"))).toBe(true);
		}
	});

	it("does not change canonical ws token values while bridging legacy aliases", () => {
		for (const [token, expectedValue] of Object.entries(canonicalWsTokens)) {
			expect(declarationsFor(token)[0]).toBe(expectedValue);
		}
	});
});
