// Localized presentation for work-inbox items.
//
// `buildWorkInbox()` (work-inbox.ts) is framework-agnostic and now emits STABLE
// CODES + structured data instead of composed Thai. This module owns the
// Thai-composition that used to live inline in the helper, but driven through
// the svelte-i18n `$_` formatter so every locale renders correctly. Consumers
// pass their `$_` and get back localized title/detail strings — and compare on
// the item's `titleCode`/`workflowTitle.code`, never on rendered text.
//
// `format` is svelte-i18n's `$_`/`$format`: it returns the key itself on a miss
// (or before init), which is acceptable here since every key below ships in all
// six locales (th byte-exact with the old composed output).

import { formatAssigneeHandle, normalizeAssigneeHandle } from "$lib/project/assignees.js";
import { formatWorkflowDueDay } from "$lib/project/task-due.js";
import { resolveQcIssueMessage } from "$lib/project/qc-checks-i18n.js";
import { thbToCredits, formatCreditsCompact } from "$lib/stores/usage.svelte.ts";
import type { WorkInboxDetail, WorkInboxItem, WorkInboxWorkflowTitle } from "./work-inbox.js";

type MsgValues = Record<string, string | number | boolean | Date | null | undefined>;
export type WorkInboxFormat = (key: string, options?: { values?: MsgValues }) => string;

/**
 * Localized AI-tier label for inbox detail (budget-clean -> "คลีนเร็ว", etc.).
 * Unknown tiers fall back to the raw slug, matching the old behavior for ids the
 * catalog doesn't cover.
 */
function workInboxTierLabel(tier: string, format: WorkInboxFormat): string {
	const key = `workInbox.detail.tier.${tier}`;
	const label = format(key);
	return label === key ? tier : label;
}

/**
 * Localized assignee label: the special handles (`local-user` -> "คุณ", `solo` ->
 * the solo-mode label, `qa`/`qc` -> upper-cased) get friendly copy; everyone else
 * renders as `@handle`. Restores the inline normalization the inbox refactor removed.
 */
function workInboxAssignee(value: string | undefined, format: WorkInboxFormat): string {
	const normalized = normalizeAssigneeHandle(value);
	if (!normalized) return formatAssigneeHandle(value);
	const lower = normalized.toLowerCase();
	if (lower === "local-user") return format("workInbox.detail.assigneeYou");
	if (lower === "solo") return format("workInbox.detail.assigneeSolo");
	if (lower === "qa" || lower === "qc") return lower.toUpperCase();
	return formatAssigneeHandle(normalized);
}

/** Localized page label: `หน้า {n}` for a page item, `ทั้งตอน` for a whole-chapter item. */
export function workInboxPageLabel(pageIndex: number | undefined, format: WorkInboxFormat): string {
	return pageIndex === undefined
		? format("workInbox.wholeChapter")
		: format("workInbox.pageN", { values: { n: pageIndex + 1 } });
}

/** Localized workflow-title fragment (the recognized production-title words). */
export function workInboxWorkflowTitle(workflowTitle: WorkInboxWorkflowTitle, format: WorkInboxFormat): string {
	if (workflowTitle.code === "custom") return workflowTitle.customTitle ?? "";
	return format(`workInbox.workflowTitle.${workflowTitle.code}`);
}

/**
 * Localized QC issue label by code, with a generic fallback. `QcIssue.code` is an
 * open-ended set (new image-layer/asset codes get added), so an unmapped code must
 * NOT render its raw key — svelte-i18n returns the key on a miss, so detect that and
 * fall back to the generic QC label.
 */
export function workInboxQcLabel(qcCode: string | undefined, format: WorkInboxFormat): string {
	const key = `workInbox.qc.${qcCode ?? "fallback"}`;
	const label = format(key);
	return label === key ? format("workInbox.qc.fallback") : label;
}

/**
 * The localized inbox TITLE — the old `${pageLabel(idx)} - <intent>` string,
 * recomposed via i18n. For workflow tasks the intent is the workflow-title
 * fragment (custom titles pass their free text through verbatim).
 */
export function workInboxTitle(item: WorkInboxItem, format: WorkInboxFormat): string {
	const page = workInboxPageLabel(item.pageIndex, format);
	if (item.titleCode === "workflow") {
		const fragment = item.workflowTitle ? workInboxWorkflowTitle(item.workflowTitle, format) : "";
		return format("workInbox.title.composed", { values: { page, label: fragment } });
	}
	if (item.titleCode === "qc") {
		const label = workInboxQcLabel(item.qcCode, format);
		return format("workInbox.title.composed", { values: { page, label } });
	}
	const label = format(`workInbox.title.${item.titleCode}`);
	return format("workInbox.title.composed", { values: { page, label } });
}

/** Localized inbox-priority word (ด่วน/สำคัญ/ปกติ) from the structured code. */
function inboxPriorityWord(code: "urgent" | "high" | "normal", format: WorkInboxFormat): string {
	return format(`workInbox.priority.${code}`);
}

export interface WorkInboxDetailOptions {
	/** When false, the assignee fragment is omitted from the composed detail. */
	includeAssignee?: boolean;
}

/**
 * The localized inbox DETAIL — the old composed `detail` string, recomposed via
 * i18n from the structured `WorkInboxDetail`. `comment body` / `QC message` are
 * raw upstream text and pass through unchanged.
 */
export function workInboxDetail(
	detail: WorkInboxDetail,
	format: WorkInboxFormat,
	options: WorkInboxDetailOptions = {},
): string {
	const includeAssignee = options.includeAssignee ?? true;
	const d = includeAssignee ? detail : { ...detail, assignee: undefined };
	switch (d.kind) {
		case "text":
			return d.text;
		case "qc":
			return resolveQcIssueMessage({ messageCode: d.messageCode, messageValues: d.messageValues }, format);
		case "ai_placement_ready": {
			const owner = d.assignee ? ` - ${workInboxAssignee(d.assignee, format)}` : "";
			return `${format("workInbox.detail.aiPlacementReady")}${owner}`;
		}
		case "ai_marker": {
			const owner = d.assignee ? ` - ${workInboxAssignee(d.assignee, format)}` : "";
			const credits = d.hasCost
				? ` - ${format("workInbox.detail.credits", {
					values: { credits: formatCreditsCompact(d.creditUnits ?? thbToCredits(d.estimatedThb)) },
				})}`
				: "";
			return `${workInboxTierLabel(d.tier, format)}${credits}${owner}`;
		}
		case "review_task": {
			const priority = inboxPriorityWord(d.priorityCode, format);
			const title = workInboxWorkflowTitle(d.workflowTitle, format);
			return d.assignee
				? `${priority} - ${title} - ${workInboxAssignee(d.assignee, format)}`
				: `${priority} - ${title}`;
		}
		case "workflow_task": {
			const parts = [format(`workInbox.status.${d.statusCode}`)];
			if (d.assignee) parts.push(workInboxAssignee(d.assignee, format));
			const dueDay = formatWorkflowDueDay(d.dueAt);
			if (dueDay) {
				const word = d.overdue ? format("workInbox.detail.overdue") : format("workInbox.detail.due");
				parts.push(`${word} ${dueDay}`);
			}
			return parts.join(" - ");
		}
	}
}
