import { describe, expect, it } from "vitest";
import {
	isWorkspaceFeedItemActionable,
	workInboxItemToTarget,
	workspaceFeedItemActionLabel,
	workspaceFeedItemToTarget,
} from "$lib/project/work-targets.js";
import type { WorkspaceFeedItem } from "$lib/types.js";

describe("work target mapping", () => {
	it("maps inbox review and QC items to stable target kinds", () => {
		expect(workInboxItemToTarget({
			id: "review-task-task-1",
			kind: "review_task",
			severity: "info",
			pageIndex: 2,
			titleCode: "review_ready",
			detail: { kind: "review_task", priorityCode: "normal", workflowTitle: { code: "review" } },
			sourceId: "task-1",
		})).toMatchObject({
			origin: "inbox",
			kind: "task",
			sourceId: "task-1",
			pageIndex: 2,
			// `title` carries the stable, locale-neutral title code.
			title: "review_ready",
		});

		expect(workInboxItemToTarget({
			id: "qc-issue-1",
			kind: "qc",
			severity: "error",
			pageIndex: 0,
			titleCode: "qc",
			qcCode: "empty_text_layer",
			detail: { kind: "text", text: "Layer is empty" },
			sourceId: "issue-1",
		})).toMatchObject({
			origin: "inbox",
			kind: "qc_issue",
			sourceId: "issue-1",
			pageIndex: 0,
		});

		expect(workInboxItemToTarget({
			id: "workflow-task-task-2",
			kind: "workflow_task",
			severity: "warning",
			pageIndex: 1,
			titleCode: "workflow",
			workflowTitle: { code: "typeset" },
			detail: { kind: "workflow_task", statusCode: "doing", assignee: "maya" },
			sourceId: "task-2",
			status: "doing",
			assignee: "maya",
		})).toMatchObject({
			origin: "inbox",
			kind: "task",
			sourceId: "task-2",
			pageIndex: 1,
		});
	});

	it("keeps workspace passive feed rows non-actionable", () => {
		const passiveItem: WorkspaceFeedItem = {
			id: "activity-1",
			kind: "activity",
			sourceId: "event-1",
			title: "Saved project",
			detail: "Autosaved",
			createdAt: "",
		};

		expect(workspaceFeedItemToTarget(passiveItem)).toBeNull();
		expect(isWorkspaceFeedItemActionable(passiveItem)).toBe(false);
		expect(workspaceFeedItemActionLabel(passiveItem)).toBe("อ่านบันทึก");
	});

	it("maps workspace version reviews with version IDs for snapshot navigation", () => {
		const item: WorkspaceFeedItem = {
			id: "version-review-1",
			kind: "version_review",
			sourceId: "request-1",
			versionId: "version-1",
			title: "Review version",
			detail: "Please check",
			createdAt: "",
			pageIndex: 1,
		};

		expect(workspaceFeedItemToTarget(item)).toMatchObject({
			origin: "workspace",
			kind: "version_review",
			sourceId: "request-1",
			versionId: "version-1",
			pageIndex: 1,
		});
		expect(isWorkspaceFeedItemActionable(item)).toBe(true);
		expect(workspaceFeedItemActionLabel(item)).toBe("เปิดเวอร์ชัน");
	});

	it("maps workspace export runs to the project pages surface", () => {
		const item: WorkspaceFeedItem = {
			id: "export-run-1",
			kind: "export_run",
			sourceId: "export-1",
			title: "Export failed",
			detail: "2 pages / Page 2 has holds",
			createdAt: "",
			status: "error",
			severity: "error",
		};

		expect(workspaceFeedItemToTarget(item)).toMatchObject({
			origin: "workspace",
			kind: "export_run",
			sourceId: "export-1",
		});
		expect(isWorkspaceFeedItemActionable(item)).toBe(true);
		expect(workspaceFeedItemActionLabel(item)).toBe("เปิด Export");
	});
});
