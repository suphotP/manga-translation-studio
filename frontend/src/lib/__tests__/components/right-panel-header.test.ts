import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
// Register the locale dictionaries so the component's $_(...) tab/context keys
// resolve. Default test locale is `th`, so the byte-exact Thai assertions below
// match the rendered output.
import "$lib/i18n";
import RightPanelHeader from "$lib/components/RightPanelHeader.svelte";
import type { RightPanelContext, RightPanelTab } from "$lib/panels/right-panel-model.js";
import type { RightPanelMode } from "$lib/stores/editor-ui.svelte.ts";

// Tabs now carry i18n keys (RightPanelHeader localizes label/description); these
// are the real RIGHT_PANEL_TABS keys so the rendered th text matches.
const tabs: readonly RightPanelTab[] = [
	{ id: "work", labelKey: "rightPanel.tabs.workLabel", descriptionKey: "rightPanel.tabs.workDescription" },
	{ id: "layers", labelKey: "rightPanel.tabs.layersLabel", descriptionKey: "rightPanel.tabs.layersDescription" },
	{ id: "ai", labelKey: "rightPanel.tabs.aiLabel", descriptionKey: "rightPanel.tabs.aiDescription" },
	{ id: "project", labelKey: "rightPanel.tabs.projectLabel", descriptionKey: "rightPanel.tabs.projectDescription" },
];

function context(overrides: Partial<RightPanelContext> = {}): RightPanelContext {
	return {
		eyebrow: { key: "rightPanel.context.layersEyebrow" },
		title: { value: "1 กล่องข้อความ" },
		detail: { value: "เลือกหรือวางข้อความบนรูป" },
		badge: { key: "rightPanel.context.layersBadgeEditable" },
		tone: "ready",
		...overrides,
	};
}

describe("RightPanelHeader", () => {
	it("renders page context, tab metadata, and the mode summary", () => {
		render(RightPanelHeader, {
			props: {
				pageLabel: "1/2",
				tabs,
				activeMode: "layers",
				context: context(),
				getTabMeta: (id: RightPanelMode) => (({ layers: "ฐาน 1 / แก้ 1", ai: "SFX", project: "1/2" }) as Partial<Record<RightPanelMode, string>>)[id] ?? "",
				onModeChange: vi.fn(),
			},
		});

		expect(screen.getByText("แผง เลเยอร์")).toBeTruthy();
		expect(screen.getByTitle("1/2 / เลเยอร์ที่เลือก: 1 กล่องข้อความ. เลือกหรือวางข้อความบนรูป")).toBeTruthy();
		expect(screen.getByText("1 กล่องข้อความ / แก้ได้")).toBeTruthy();
		// The confusing "next panel" cycler has been removed in favor of a single
		// explicit segmented control (tablist) — so there is no สลับ/cycle button.
		expect(screen.queryByRole("button", { name: /สลับไปแผง/ })).toBeNull();
		expect(screen.queryByText("ถัดไป")).toBeNull();
		// Every section is reachable as an explicit tab, and the active one is marked.
		expect(screen.getByRole("tab", { name: "เปิดแผง งาน: งานด่วน, QC, โน้ต, และงานหน้า" })).toBeTruthy();
		expect(screen.getByRole("tab", { name: "เปิดแผง AI: คลีน, SFX, แปรงคลีน, และรีวิวผล AI. SFX" })).toBeTruthy();
		expect(screen.getByRole("tab", { name: "เปิดแผง เลเยอร์: กล่องข้อความ, รูปเสริม, และค่าของวัตถุ. ฐาน 1 / แก้ 1" }).getAttribute("aria-selected")).toBe("true");
		expect(screen.queryByText("เลือกหรือวางข้อความบนรูป")).toBeNull();
	});

	it("lets active context rename the visible panel title", () => {
		render(RightPanelHeader, {
			props: {
				pageLabel: "1/2",
				tabs,
				activeMode: "ai",
				context: context({
					panelLabel: { key: "rightPanel.context.aiBrushPanelLabel" },
					title: { key: "rightPanel.context.aiBrushPickTitle" },
					badge: { value: "ยังไม่เลือกเลเยอร์" },
				}),
				getTabMeta: (id: RightPanelMode) => (({ ai: "แปรง", project: "1/2" }) as Partial<Record<RightPanelMode, string>>)[id] ?? "",
				onModeChange: vi.fn(),
			},
		});

		expect(screen.getByText("แผง แปรงคลีน")).toBeTruthy();
		expect(screen.getByText("เลือกเลเยอร์ก่อนใช้แปรง")).toBeTruthy();
	});

	it("delegates mode changes without importing editor stores", async () => {
		const onModeChange = vi.fn();

		render(RightPanelHeader, {
			props: {
				pageLabel: "ยังไม่มี Project",
				tabs,
				activeMode: "work",
				context: context({
					eyebrow: { key: "rightPanel.context.noProjectEyebrow" },
					title: { key: "rightPanel.context.noProjectTitle" },
					badge: { key: "rightPanel.context.layersBadgeEmpty" },
					tone: "neutral",
				}),
				getTabMeta: () => "",
				onModeChange,
			},
		});

		await fireEvent.click(screen.getByRole("tab", { name: "เปิดแผง เลเยอร์: กล่องข้อความ, รูปเสริม, และค่าของวัตถุ" }));

		expect(onModeChange).toHaveBeenCalledWith("layers");

		await fireEvent.click(screen.getByRole("tab", { name: "เปิดแผง โปรเจกต์: หน้าในตอน, การใช้งาน, เวอร์ชัน, และประวัติตอน" }));

		expect(onModeChange).toHaveBeenCalledWith("project");
	});
});
