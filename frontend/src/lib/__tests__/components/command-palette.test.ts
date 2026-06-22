import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import CommandPalette from "$lib/components/CommandPalette.svelte";
import { fuzzyScore, searchCommands, type Command } from "$lib/commands/command-registry.ts";
import { commandPaletteStore } from "$lib/stores/command-palette.svelte.ts";

// The palette's visibility lives in a shared singleton store, so each test must
// start from a closed palette to stay independent.
afterEach(() => {
	commandPaletteStore.closePalette();
});

function makeCommands(runners: Record<string, () => void> = {}): Command[] {
	return [
		{
			id: "nav-dashboard",
			title: "แดชบอร์ด",
			section: "navigate",
			keywords: ["dashboard", "home"],
			run: runners["nav-dashboard"] ?? (() => {}),
		},
		{
			id: "nav-library",
			title: "คลังการ์ตูน",
			section: "navigate",
			keywords: ["library"],
			run: runners["nav-library"] ?? (() => {}),
		},
		{
			id: "tool-brush",
			title: "เครื่องมือแปรงคลีน (Brush)",
			section: "tools",
			keywords: ["brush", "clean"],
			run: runners["tool-brush"] ?? (() => {}),
		},
	];
}

async function pressCmdK(): Promise<void> {
	await fireEvent.keyDown(window, { key: "k", metaKey: true });
}

describe("command-registry fuzzy matching", () => {
	it("scores subsequence matches and rejects non-matches", () => {
		expect(fuzzyScore("dash", "Dashboard")).not.toBeNull();
		expect(fuzzyScore("brsh", "brush clean")).not.toBeNull();
		expect(fuzzyScore("zzz", "Dashboard")).toBeNull();
	});

	it("returns the full list (stable order) for an empty query", () => {
		const commands = makeCommands();
		const matches = searchCommands(commands, "  ");
		expect(matches).toHaveLength(3);
		expect(matches.map((m) => m.command.id)).toEqual([
			"nav-dashboard",
			"nav-library",
			"tool-brush",
		]);
	});

	it("filters and ranks by score for a query", () => {
		const commands = makeCommands();
		const matches = searchCommands(commands, "brush");
		expect(matches).toHaveLength(1);
		expect(matches[0].command.id).toBe("tool-brush");
	});
});

describe("CommandPalette", () => {
	it("opens on Cmd+K, filters, runs a command on Enter, and closes", async () => {
		const run = vi.fn();
		render(CommandPalette, { props: { buildCommands: () => makeCommands({ "tool-brush": run }) } });

		// Not mounted until opened.
		expect(screen.queryByRole("dialog")).toBeNull();

		await pressCmdK();

		const dialog = await screen.findByRole("dialog", { name: /command palette/i });
		expect(dialog).toBeTruthy();

		// All three commands present initially.
		expect(screen.getAllByRole("option")).toHaveLength(3);

		// Filter down to the brush tool.
		const input = screen.getByRole("combobox");
		await fireEvent.input(input, { target: { value: "brush" } });

		await waitFor(() => {
			expect(screen.getAllByRole("option")).toHaveLength(1);
		});
		expect(screen.getByRole("option").textContent).toContain("Brush");

		// Enter runs the (only) match and closes the palette.
		await fireEvent.keyDown(dialog, { key: "Enter" });

		expect(run).toHaveBeenCalledTimes(1);
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});
	});

	it("moves selection with arrow keys and shows aria-activedescendant", async () => {
		render(CommandPalette, { props: { buildCommands: () => makeCommands() } });
		await pressCmdK();
		const dialog = await screen.findByRole("dialog");
		const input = screen.getByRole("combobox");

		// First option is active by default.
		expect(input.getAttribute("aria-activedescendant")).toBe("command-palette-option-0");
		expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");

		await fireEvent.keyDown(dialog, { key: "ArrowDown" });
		await waitFor(() => {
			expect(input.getAttribute("aria-activedescendant")).toBe("command-palette-option-1");
		});
		expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
	});

	it("closes on Escape without running a command", async () => {
		const run = vi.fn();
		render(CommandPalette, { props: { buildCommands: () => makeCommands({ "nav-dashboard": run }) } });
		await pressCmdK();
		const dialog = await screen.findByRole("dialog");

		await fireEvent.keyDown(dialog, { key: "Escape" });

		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});
		expect(run).not.toHaveBeenCalled();
	});

	it("shows an empty state when nothing matches", async () => {
		render(CommandPalette, { props: { buildCommands: () => makeCommands() } });
		await pressCmdK();
		const input = screen.getByRole("combobox");
		await fireEvent.input(input, { target: { value: "zzzzz" } });

		await waitFor(() => {
			expect(screen.queryAllByRole("option")).toHaveLength(0);
		});
		expect(screen.getByText(/ไม่พบคำสั่ง/)).toBeTruthy();
	});

	it("opens when the shared store is opened (e.g. the sidebar ⌘K button)", async () => {
		render(CommandPalette, { props: { buildCommands: () => makeCommands() } });
		expect(screen.queryByRole("dialog")).toBeNull();

		// Simulate the top-bar affordance / any external launcher.
		commandPaletteStore.openPalette();

		const dialog = await screen.findByRole("dialog");
		expect(dialog).toBeTruthy();
		expect(screen.getAllByRole("option")).toHaveLength(3);
	});

	it("renders each option without a nested focusable button (valid ARIA option)", async () => {
		render(CommandPalette, { props: { buildCommands: () => makeCommands() } });
		await pressCmdK();
		await screen.findByRole("dialog");

		const options = screen.getAllByRole("option");
		expect(options).toHaveLength(3);
		for (const option of options) {
			// A role="option" must not contain a separately-interactive descendant.
			expect(option.querySelector("button")).toBeNull();
			expect(option.querySelector("[tabindex]")).toBeNull();
			expect(option.querySelector("a[href]")).toBeNull();
		}
	});

	it("still activates an option via mouse click", async () => {
		const run = vi.fn();
		render(CommandPalette, { props: { buildCommands: () => makeCommands({ "tool-brush": run }) } });
		await pressCmdK();
		await screen.findByRole("dialog");

		const brush = screen
			.getAllByRole("option")
			.find((option) => option.textContent?.includes("Brush"));
		expect(brush).toBeTruthy();
		await fireEvent.click(brush as HTMLElement);

		expect(run).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
});
