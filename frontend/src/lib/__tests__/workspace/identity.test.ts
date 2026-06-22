import { describe, expect, it } from "vitest";
import {
	WORKSPACE_IDENTITY_PALETTE,
	workspaceIdentityColor,
	workspaceIdentityFor,
	workspaceInitials,
} from "$lib/workspace/identity";

describe("workspace identity", () => {
	it("keeps the house-color palette to ten ws-theme token colors", () => {
		expect(WORKSPACE_IDENTITY_PALETTE).toHaveLength(10);
		expect(new Set(WORKSPACE_IDENTITY_PALETTE.map((color) => color.name)).size).toBe(10);
		expect(WORKSPACE_IDENTITY_PALETTE.every((color) => color.value.includes("--color-ws-"))).toBe(true);
	});

	it("maps workspace ids to deterministic palette colors", () => {
		const first = workspaceIdentityColor("workspace-alpha");
		const second = workspaceIdentityColor("workspace-alpha");
		const alternate = workspaceIdentityColor("workspace-beta");

		expect(second).toEqual(first);
		expect(WORKSPACE_IDENTITY_PALETTE).toContain(first);
		expect(WORKSPACE_IDENTITY_PALETTE).toContain(alternate);
	});

	it("uses the same fallback color for missing or blank workspace ids", () => {
		expect(workspaceIdentityColor(undefined)).toEqual(workspaceIdentityColor("workspace"));
		expect(workspaceIdentityColor("   ")).toEqual(workspaceIdentityColor("workspace"));
	});

	it("builds two-character initials from human workspace names", () => {
		expect(workspaceInitials("Suphot Studio")).toBe("SS");
		expect(workspaceInitials("manga-localization")).toBe("ML");
		expect(workspaceInitials("บ้านของ สุพจน์")).toBe("บส");
		expect(workspaceInitials("東京制作")).toBe("東京");
	});

	it("ignores punctuation and falls back when a name has no letters or numbers", () => {
		expect(workspaceInitials("  @@@ Comic!! Workspace  ")).toBe("CW");
		expect(workspaceInitials("✨ / --")).toBe("WS");
		expect(workspaceInitials(null)).toBe("WS");
	});

	it("combines initials and color for a sidebar identity mark", () => {
		const identity = workspaceIdentityFor({ workspaceId: "ws-suphot", name: "Suphot Workspace" });

		expect(identity.initials).toBe("SW");
		expect(WORKSPACE_IDENTITY_PALETTE).toContain(identity.color);
	});
});
