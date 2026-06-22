import { describe, expect, test } from "bun:test";
import { resolveAiProjectAccess } from "../routes/ai.js";
import type { JWTPayload } from "../types/auth.js";

const editorUser: JWTPayload = {
	userId: "user-editor",
	email: "editor@example.com",
	role: "editor",
};

const viewerUser: JWTPayload = {
	userId: "user-viewer",
	email: "viewer@example.com",
	role: "viewer",
};

describe("AI route project access", () => {
	test("allows workspace catalog members before applying the file-owner role gate", async () => {
		const decision = await resolveAiProjectAccess({
			stateUserId: "owner-user",
			user: viewerUser,
			permission: "generate:ai",
			catalogCanAccess: async () => true,
		});

		expect(decision).toBe("allowed");
	});

	test("uses workspace membership before personal owner role gates on workspace projects", async () => {
		const decision = await resolveAiProjectAccess({
			stateUserId: viewerUser.userId,
			stateWorkspaceId: "workspace-1",
			user: viewerUser,
			permission: "generate:ai",
			catalogCanAccess: async () => true,
		});

		expect(decision).toBe("allowed");
	});

	test("passes requested job language into catalog access checks", async () => {
		let checkedLanguage: string | undefined;
		const decision = await resolveAiProjectAccess({
			stateUserId: "owner-user",
			user: editorUser,
			permission: "generate:ai",
			language: "en",
			catalogCanAccess: async ({ language }) => {
				checkedLanguage = language;
				return language === "th";
			},
		});

		expect(checkedLanguage).toBe("en");
		expect(decision).toBe("not_found");
	});

	test("passes scoped page and task context into catalog access checks", async () => {
		let checkedPageIndex: number | undefined;
		let checkedTaskType: string | undefined;
		const decision = await resolveAiProjectAccess({
			stateUserId: "owner-user",
			user: editorUser,
			permission: "generate:ai",
			language: "th",
			pageIndex: 0,
			taskType: "review",
			catalogCanAccess: async ({ pageIndex, taskType }) => {
				checkedPageIndex = pageIndex;
				checkedTaskType = taskType;
				return pageIndex === 0 && taskType === "review";
			},
		});

		expect(checkedPageIndex).toBe(0);
		expect(checkedTaskType).toBe("review");
		expect(decision).toBe("allowed");
	});

	test("hides owned projects from authenticated users without owner or catalog access", async () => {
		const decision = await resolveAiProjectAccess({
			stateUserId: "owner-user",
			user: editorUser,
			permission: "generate:ai",
			catalogCanAccess: async () => false,
		});

		expect(decision).toBe("not_found");
	});

	test("keeps owner access bound to normal API role permissions", async () => {
		const decision = await resolveAiProjectAccess({
			stateUserId: viewerUser.userId,
			user: viewerUser,
			permission: "generate:ai",
		});

		expect(decision).toBe("forbidden");
	});
});
