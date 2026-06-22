// Per-type notification icon geometry, shared by NotificationPanel.svelte and
// the /notifications full page so both render the SAME glyph for a given type.
//
// Each value is the INNER markup of a 24×24 stroke icon (the wrapping
// `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">` lives in the
// component). These strings are developer-authored CONSTANTS — never user or
// AI content — so rendering them via {@html} is XSS-safe. Colour is driven
// separately by the `data-icon` attribute the components already set.

import type { NotificationType } from "$lib/api/client.ts";

/** Stable icon key per notification type (drives both the glyph + the colour). */
export type NotificationIcon =
	| "comment"
	| "ai-success"
	| "ai-fail"
	| "submit"
	| "approve"
	| "reject"
	| "invite"
	| "quota"
	| "payment-ok"
	| "payment-fail"
	| "team";

export function iconForType(type: NotificationType): NotificationIcon {
	switch (type) {
		case "comment_new":
		case "comment_reply":
			return "comment";
		case "ai_job_complete":
			return "ai-success";
		case "ai_job_failed":
			return "ai-fail";
		case "chapter_submitted":
			return "submit";
		case "chapter_approved":
			return "approve";
		case "chapter_rejected":
			return "reject";
		case "invite_received":
			return "invite";
		case "quota_warning_80pct":
		case "quota_frozen":
			return "quota";
		case "payment_succeeded":
			return "payment-ok";
		case "payment_failed":
			return "payment-fail";
		case "team_member_joined":
			return "team";
		case "task_assigned":
		case "work_assigned":
			return "submit";
		case "ticket_opened":
		case "ticket_replied":
		case "ticket_escalated":
		case "ticket_resolved":
			return "comment";
		default:
			return "comment";
	}
}

// Inner SVG markup (paths only) for each icon key. Constant strings.
const ICON_SVG: Record<NotificationIcon, string> = {
	// Speech bubble — comments + support replies.
	comment:
		'<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
	// Sparkle + check — AI job complete.
	"ai-success":
		'<path d="M20 6 9 17l-5-5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
	// Alert triangle — AI job failed.
	"ai-fail":
		'<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 9v4M12 17h.01" stroke-width="2" stroke-linecap="round"/>',
	// Upload — chapter submitted / task assigned.
	submit:
		'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
	// Check circle — approved.
	approve:
		'<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 4 12 14.01l-3-3" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
	// X circle — rejected.
	reject:
		'<circle cx="12" cy="12" r="9" stroke-width="1.8"/><path d="M15 9l-6 6M9 9l6 6" stroke-width="1.8" stroke-linecap="round"/>',
	// Mail — invite received.
	invite:
		'<rect x="3" y="5" width="18" height="14" rx="2" stroke-width="1.8"/><path d="m3 7 9 6 9-6" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
	// Gauge — quota warning / frozen.
	quota:
		'<path d="M12 21a9 9 0 1 0-9-9" stroke-width="1.8" stroke-linecap="round"/><path d="M12 12 8 8M3 12h2M12 3v2" stroke-width="1.8" stroke-linecap="round"/>',
	// Credit card OK — payment succeeded.
	"payment-ok":
		'<rect x="2" y="5" width="20" height="14" rx="2" stroke-width="1.8"/><path d="M2 10h20" stroke-width="1.8"/><path d="m7 15 2 2 4-4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
	// Credit card with alert — payment failed.
	"payment-fail":
		'<rect x="2" y="5" width="20" height="14" rx="2" stroke-width="1.8"/><path d="M2 10h20M12 14v2M12 18h.01" stroke-width="1.8" stroke-linecap="round"/>',
	// Two people — team member joined.
	team:
		'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="7" r="4" stroke-width="1.8"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
};

/** Inner SVG markup for a notification type (safe constant — render via {@html}). */
export function iconSvgForType(type: NotificationType): string {
	return ICON_SVG[iconForType(type)];
}
