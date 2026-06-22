import { Hono } from "hono";
import { z } from "zod/v4";
import { v4 as uuid } from "uuid";
import { authMiddleware, getAuthUser, requireEmailVerified } from "../middleware/auth.middleware.js";
import type { JWTPayload } from "../types/auth.js";
import { readMailerEnvConfig } from "../config.js";
import {
	WorkspaceAccessError,
	isValidWorkspacePageCursor,
	roleHasPermission,
	workspaceScopeCovers,
	workspaceAccessStore,
	STORY_ASSIGNMENT_ROLES,
	type CreatedWorkspaceInvite,
	type StoryAssignmentRole,
	type StoryRoleAssignmentRecord,
	type WorkspaceMemberPage,
	type WorkspaceRole,
	type WorkspaceStudioRole,
	type WorkspaceScope,
} from "../services/workspace-access.js";
import { readJsonBody } from "../utils/request-body.js";
import { AdminSelfProtectionError, assertWorkspaceAdminSelfMutationAllowed } from "../services/admin-protection.js";
import { ByoApiError, byoApiService, type ByoProvider } from "../services/byo-api.js";
import { turnstileVerify } from "../middleware/turnstile-verify.js";
import { projectCatalogStore, type ProjectSummary } from "../services/project-catalog.js";
import { buildWorkspaceHomeAggregate, type WorkspaceHomeProjectInput } from "../services/workspace-home.js";
import { indexStoryRolesByStoryId, resolveViewerDutyTaskTypes } from "../services/story-duties.js";
import { authUserStore } from "../services/auth-users.js";
import { notify } from "../services/notification-dispatch.js";
import { sendTransactionalEmail } from "../services/mailer.js";
import { workLockStore, type WorkLockStore } from "../services/work-locks.js";
import { SignatureTtlSingleFlightCache } from "../services/single-flight.js";
import type { WorkflowTaskType } from "../types/index.js";

const workspaces = new Hono();

type WorkspaceInviteEmailSender = typeof sendTransactionalEmail;
type WorkspaceInviteNotifier = typeof notify;

let workspaceInviteEmailSender: WorkspaceInviteEmailSender = sendTransactionalEmail;
let workspaceInviteNotifier: WorkspaceInviteNotifier = notify;
let workspaceWorkLockStore: WorkLockStore | null = workLockStore;

export function setWorkspaceInviteEmailSenderForTesting(sender: WorkspaceInviteEmailSender = sendTransactionalEmail): void {
	workspaceInviteEmailSender = sender;
}

export function setWorkspaceInviteNotifierForTesting(notifier: WorkspaceInviteNotifier = notify): void {
	workspaceInviteNotifier = notifier;
}

export function setWorkspaceWorkLockStoreForTesting(store: WorkLockStore | null = workLockStore): void {
	workspaceWorkLockStore = store;
}

workspaces.use("*", async (c, next) => {
	if (c.req.method === "POST" && /^(?:\/api\/workspaces)?\/invites\/[^/]+\/accept$/.test(c.req.path)) {
		await next();
		return;
	}
	return authMiddleware(c, next);
});

const scopeSchema = z.object({
	projectIds: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
	chapterIds: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
	pageIndexes: z.array(z.number().int().min(0)).max(1000).optional(),
	languages: z.array(z.string().trim().min(1).max(32)).max(50).optional(),
	taskTypes: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
	assetPurposes: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
	aiCreditPolicy: z.enum(["workspace", "job_scoped", "none"]).optional(),
}).strict().optional();

const createWorkspaceSchema = z.object({
	name: z.string().trim().min(1).max(200),
}).strict();

const updateWorkspaceSchema = z.object({
	name: z.string().trim().min(1).max(200),
}).strict();

// Studio (operational) roles that may be paired with each access role. The
// access role gates real workspace capabilities, so a non-owner must not be able
// to receive an elevated studio role: e.g. PATCHing a member to
// role: "viewer"/"editor" with memberStudioRole: "owner"/"admin" must be
// rejected here rather than silently persisted by updateMember. The frontend
// derives workflow capabilities from memberStudioRole, so an unchecked elevated
// studio role would grant capabilities the access role never authorized.
// `team_lead`/`admin`/`owner` confer elevated workspace capabilities
// (member management, billing) that only the matching access role authorizes,
// so editors are limited to operational production roles and viewers to `guest`.
const STUDIO_ROLES_BY_ACCESS_ROLE: Record<"admin" | "editor" | "viewer", readonly WorkspaceStudioRole[]> = {
	admin: ["admin", "team_lead", "translator", "cleaner", "typesetter", "qc", "guest"],
	editor: ["translator", "cleaner", "typesetter", "qc", "guest"],
	viewer: ["guest"],
};

const memberUpdateSchema = z.object({
	role: z.enum(["admin", "editor", "viewer"]),
	memberStudioRole: z.enum(["owner", "admin", "team_lead", "translator", "cleaner", "typesetter", "qc", "guest"]).optional(),
	scope: scopeSchema,
}).superRefine((value, ctx) => {
	if (value.memberStudioRole === undefined) return;
	const allowed = STUDIO_ROLES_BY_ACCESS_ROLE[value.role];
	if (!allowed.includes(value.memberStudioRole)) {
		ctx.addIssue({
			code: "custom",
			path: ["memberStudioRole"],
			message: `Studio role "${value.memberStudioRole}" is not allowed for access role "${value.role}"`,
		});
	}
});

const inviteCreateSchema = z.object({
	email: z.string().trim().email().max(320),
	role: z.enum(["admin", "editor", "viewer"]),
	scope: scopeSchema,
	ttlSeconds: z.number().int().min(300).max(30 * 24 * 60 * 60).optional(),
});

const inviteAcceptSchema = z.object({
	inviteToken: z.string().trim().min(20).max(200),
});

const byoKeySetSchema = z.object({
	provider: z.enum(["openai", "openrouter"]),
	key: z.string().trim().min(1).max(4000),
}).strict();

function parseListLimit(raw: string | undefined): number | undefined | null {
	if (raw === undefined) return undefined;
	if (!/^[1-9]\d*$/.test(raw.trim())) return null;
	return Math.min(Number(raw), 500);
}

function parseRoleFilter(raw: string | undefined): WorkspaceRole | undefined | null {
	if (raw === undefined) return undefined;
	return raw === "owner" || raw === "admin" || raw === "editor" || raw === "viewer" ? raw : null;
}

function parseAuditFilter(raw: string | undefined): string | undefined | null {
	if (raw === undefined) return undefined;
	const normalized = raw.trim();
	if (!normalized || normalized.length > 120) return null;
	return /^[A-Za-z0-9_.:@-]+$/.test(normalized) ? normalized : null;
}

// Strict ISO-8601 instant: YYYY-MM-DDTHH:MM:SS with optional fractional seconds
// and a required timezone designator (Z or ±HH:MM). Unlike Date.parse this
// rejects locale strings ("May 29, 2026") and partial dates, and the captured
// groups are calendar-checked below so impossible dates such as 2026-02-30 are
// refused instead of being silently rolled into a different day.
//
// The shape is deliberately tightened so whole classes of inputs that Postgres'
// ::timestamptz cast would reject — and that would therefore escape as an
// unhandled 500 instead of the intended invalid_created_after/before 400 — can
// never get past the regex in the first place:
//   - hour is 00–23 only (24 is rejected outright; no audit filter needs the
//     ISO "24:00" end-of-day form, and admitting it dragged in a fractional
//     "24:00:00.001" edge case that Date.parse choked on),
//   - minute/second are 00–59 (the :60 leap-second form is refused: Date.parse
//     returns NaN for it and Postgres rejects it on the cast),
//   - the fractional part is capped at 1–9 digits (an over-long tail is not a
//     real sub-second value Postgres accepts),
//   - the year is 0001–9999 (0000 is excluded; see the explicit guard below).
// The timezone offset hours/minutes are still captured so an out-of-range
// offset like "+99:99" is rejected in the calendar check below.
const ISO_INSTANT_RE =
	/^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isRealCalendarInstant(match: RegExpMatchArray): boolean {
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	// Year 0000 satisfies the \d{4} shape and the calendar math below, but
	// Postgres has no year 0 (it jumps from 1 BC to 1 AD) and rejects it on the
	// ::timestamptz cast. Date.parse, unlike for the other malformed inputs, does
	// NOT return NaN for year 0 — so the structural regex and the NaN safety-net
	// both miss it and we must reject it explicitly here.
	if (year < 1) return false;
	if (month < 1 || month > 12) return false;
	if (day < 1) return false;
	// hour/minute/second ranges are already enforced structurally by the regex
	// (00–23 / 00–59), so no numeric re-check is needed here.
	// Validate the numeric timezone offset when present (groups are undefined for
	// the "Z" designator). ISO-8601 / Postgres cap the offset at ±14:00, so an
	// offset such as "+99:99" must be refused here — otherwise the bad string is
	// forwarded to ::timestamptz and Postgres raises a cast error instead of us
	// returning the intended invalid_created_after/invalid_created_before 400.
	if (match[7] !== undefined) {
		const offsetHour = Number(match[7]);
		const offsetMinute = Number(match[8]);
		if (offsetMinute > 59) return false;
		if (offsetHour > 14 || (offsetHour === 14 && offsetMinute !== 0)) return false;
	}
	const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return day <= daysInMonth[month - 1]!;
}

// Returns undefined when absent, null when invalid, or the validated ORIGINAL
// string (trimmed) when valid. The original string is preserved rather than
// round-tripped through `new Date(...).toISOString()` because the latter
// truncates to milliseconds, but audit_events.created_at (timestamptz) keeps
// microseconds — so the full-precision bound is handed straight to the
// ::timestamptz cast in workspace-access.ts.
function parseAuditDateFilter(raw: string | undefined): string | undefined | null {
	if (raw === undefined) return undefined;
	const normalized = raw.trim();
	if (!normalized || normalized.length > 40) return null;
	const match = normalized.match(ISO_INSTANT_RE);
	if (!match || !isRealCalendarInstant(match)) return null;
	// Final safety-net: every structural check above is meant to reject anything
	// the ::timestamptz cast would choke on, but rather than rely on enumerating
	// each edge case we also refuse any value Date.parse can't turn into a real
	// instant. If Date.parse returns NaN here the Postgres cast would too, so this
	// guarantees a clean invalid_created_after/before 400 instead of a 500 — even
	// for an input no explicit rule above anticipated. (Year 0 is the one shape
	// Date.parse does NOT flag, which is why the explicit year >= 1 guard stays.)
	if (Number.isNaN(Date.parse(normalized))) return null;
	return normalized;
}

// Orders two already-validated ISO-8601 instants at full sub-millisecond
// precision, returning a negative/zero/positive number like a comparator.
//
// Date.parse is offset-aware (so "...+09:00" vs "...Z" still compare as true
// instants) but collapses everything to whole milliseconds, which would let an
// inverted range that differs only below the millisecond — e.g.
// "...00.200900Z" vs "...00.200100Z" — slip past the createdAfter <=
// createdBefore guard. We therefore compare the millisecond instants first and,
// only when they tie, break the tie on the fractional-second digits BEYOND the
// first three (the microsecond/nanosecond tail the millisecond value dropped),
// matching the precision the ::timestamptz bounds already preserve.
function subMillisecondTail(instant: string): string {
	const fraction = instant.match(/\.(\d+)/);
	if (!fraction) return "";
	// Take the digits beyond the first three (the microsecond/nanosecond tail the
	// millisecond value dropped), then strip trailing zeros before padding to a
	// fixed width. Trimming first is what makes equal instants written with
	// differing trailing-zero counts — e.g. ".1234Z" vs ".1234000000Z", or
	// ".2009Z" vs ".200900Z" — normalize to the SAME tail and compare equal,
	// instead of one carrying extra "0" characters and being mis-ordered. The
	// fixed width then keeps a purely lexical compare correct across lengths.
	return fraction[1]!.slice(3).replace(/0+$/, "").padEnd(9, "0");
}

function compareAuditInstants(a: string, b: string): number {
	const millisDelta = Date.parse(a) - Date.parse(b);
	if (millisDelta !== 0) return millisDelta;
	return subMillisecondTail(a).localeCompare(subMillisecondTail(b));
}

workspaces.get("/", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const limit = parseListLimit(c.req.query("limit"));
	if (limit === null) return c.json({ error: "Invalid limit", code: "invalid_limit" }, 400);
	const cursor = c.req.query("cursor");
	if (!isValidWorkspacePageCursor(cursor, "workspaceId")) return c.json({ error: "Invalid cursor", code: "invalid_cursor" }, 400);
	const role = parseRoleFilter(c.req.query("role"));
	if (role === null) return c.json({ error: "Invalid role", code: "invalid_role" }, 400);
	// Provision the signed-in user's personal workspace on demand so a fresh sign-up
	// never gets an empty list (which renders a blank dashboard). This is the ONLY
	// self-serve list path; admin/support reads call listUser* directly and must NOT
	// provision a workspace for the arbitrary user they are inspecting.
	//
	// Intentionally NOT gated on emailVerified (unlike POST /workspaces, which gates
	// the creation of ADDITIONAL named workspaces — an abuse vector). The personal
	// workspace is a bounded singleton (exactly one per account, idempotent) and is
	// the user's default home. Email-verification enforcement is an upstream concern:
	// in dev sign-up is usable without OTP, and prod will gate access behind a
	// verify-OTP wall BEFORE the dashboard/this route is reachable — so duplicating a
	// verified-email check here would only re-introduce the blank-dashboard bug for
	// the dev/unverified flow this PR fixes. See the email-verification epic.
	await store.ensurePersonalWorkspace(user.userId);
	const page = await store.listUserWorkspacePage(user.userId, { limit: limit ?? undefined, cursor, role });
	return c.json(page);
});

workspaces.post("/", requireEmailVerified, async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = createWorkspaceSchema.safeParse(raw.data);
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

	const workspace = await store.createWorkspace({
		workspaceId: uuid(),
		name: parsed.data.name,
		ownerUserId: user.userId,
	});
	return c.json({ workspace }, 201);
});

// authMiddleware runs BEFORE turnstileVerify so an unauthenticated request is
// rejected with 401 locally instead of burning Cloudflare Siteverify
// quota/latency on a token an attacker could attach without a valid bearer.
workspaces.post("/invites/:inviteId/accept", authMiddleware, turnstileVerify({ expectedAction: "workspace_invite_accept" }), async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = inviteAcceptSchema.safeParse(raw.data);
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

	try {
		const member = await store.acceptInvite({
			inviteId: c.req.param("inviteId"),
			inviteToken: parsed.data.inviteToken,
			userId: user.userId,
			email: user.email,
		});
		return c.json({ member });
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
});

workspaces.get("/:workspaceId", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	try {
		const member = await store.requirePermission(workspaceId, user.userId, "read_workspace");
		const workspace = await store.getWorkspace(workspaceId);
		if (!workspace) throw new WorkspaceAccessError("Workspace not found", 404, "workspace_not_found");
		return c.json({ workspace, member });
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
});

// Cross-project workspace-home aggregate. Decouples the dashboard / My-Work /
// activity / pipeline widgets from whichever single chapter happens to be open
// in the editor: it fans the per-project workflow/feed readers across EVERY
// project the member can see (scope-aware) and merges them server-side.
//
// Authorization: workspace membership (`read_workspace`). Per-project visibility
// is delegated to the catalog's scope-aware summary listing (the SAME gate the
// project browser uses), so a project/language-scoped contractor only ever sees
// their own slice — never the whole workspace.
//
// N+1 control: the fan-out is capped at WORKSPACE_HOME_PROJECT_CAP projects
// (the most-recently-updated, since the summary list is ordered updated_at DESC),
// and project states are fetched concurrently. This keeps a busy workspace from
// turning one dashboard load into hundreds of state reads.
const WORKSPACE_HOME_PROJECT_CAP = 60;

// Hard bound on the SUMMARY scan itself. The summary listing is now
// workspace-scoped at the source (catalog filters by workspaceId in SQL / in
// memory), so each page returns only this workspace's projects and we normally
// stop as soon as we hit the project cap. This page cap is defense-in-depth: it
// guarantees the endpoint can never page unboundedly even if the source filter
// is bypassed or the workspace genuinely has far more than the cap of projects —
// the work done is bounded regardless of how many workspaces the user belongs to
// or whether the target workspace is empty.
const WORKSPACE_HOME_MAX_SUMMARY_PAGES = 3;

// Short-TTL memoization of the dashboard aggregate. The summary listing (paged,
// indexed) is cheap, but the per-project state reads + JSON parse of up to
// WORKSPACE_HOME_PROJECT_CAP full project blobs are the expensive, repeated work:
// every dashboard visit (and re-render that refetches) re-read + re-parsed all 60
// states. We key the cache by (workspace, viewer) — scope-aware, so two members
// never share a slice — and validate it against a cheap SIGNATURE derived from the
// summaries (each project's id + updatedAt). If no project changed since the last
// build the signatures match and we serve the cached aggregate, skipping all 60
// state reads. A short TTL bounds staleness even if a signature somehow misses a
// change, and caps cache lifetime on a write-heavy workspace.
const WORKSPACE_HOME_CACHE_TTL_MS = 15_000;
const WORKSPACE_HOME_CACHE_MAX_ENTRIES = 500;

const workspaceHomeAggregateCache = new SignatureTtlSingleFlightCache<unknown>({
	maxEntries: WORKSPACE_HOME_CACHE_MAX_ENTRIES,
	ttlMs: WORKSPACE_HOME_CACHE_TTL_MS,
});

function workspaceHomeCacheKey(workspaceId: string, userId: string): string {
	return JSON.stringify([workspaceId, userId]);
}

function workspaceHomeSignature(
	summaries: { projectId: string; updatedAt: string }[],
): string {
	// Order-stable signature: the summary list is already updated_at DESC, but sort
	// by id so a pure reordering doesn't needlessly bust the cache. Any add/remove
	// or content change (updatedAt advances on every state upsert) changes this.
	return summaries
		.map((summary) => `${summary.projectId}:${summary.updatedAt}`)
		.sort()
		.join("|");
}

workspaces.get("/:workspaceId/home", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const catalog = projectCatalogStore;
	if (!catalog) {
		return c.json({ error: "Project catalog store is not configured", code: "workspace_project_store_unavailable" }, 503);
	}
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	try {
		// Gate on workspace membership FIRST so a non-member never triggers any
		// project reads. Every workspace role has `read_workspace`.
		const member = await store.requirePermission(workspaceId, user.userId, "read_workspace");

		// Scope-aware, member-visible projects IN THIS WORKSPACE, ordered
		// updated_at DESC. The listing is workspace-scoped AT THE SOURCE
		// (`workspaceId` filter) so every page already contains only this
		// workspace's projects — paging is bounded by the workspace, never by the
		// user's entire cross-workspace project space. We stop as soon as we reach
		// the project cap; the page cap is a hard ceiling on the scan so an empty
		// target workspace (or a user in many workspaces) can never page unboundedly.
		const summaries: ProjectSummary[] = [];
		const seenProjectIds = new Set<string>();
		const collectFromWorkspace = async (
			sourceWorkspaceId: string,
			// The summary's `workspaceId` is store-dependent for projects whose state
			// carries no explicit workspaceId: the Postgres catalog reports the
			// synthetic `personal:<userId>` id, the file catalog reports `undefined`.
			// So callers that pull the synthetic personal bucket can't reuse the
			// strict `=== workspaceId` guard; they pass `acceptUnscoped` to trust the
			// SOURCE filter (which already matched on the resolved workspace id /
			// owner+null-workspace predicate — the SAME gate the Library uses) instead.
			acceptUnscoped: boolean,
		): Promise<void> => {
			let cursor: string | undefined;
			let pagesScanned = 0;
			while (summaries.length < WORKSPACE_HOME_PROJECT_CAP && pagesScanned < WORKSPACE_HOME_MAX_SUMMARY_PAGES) {
				const page = await catalog.listProjectSummaryPage({
					userId: user.userId,
					workspaceId: sourceWorkspaceId,
					cursor,
					limit: Math.min(100, WORKSPACE_HOME_PROJECT_CAP - summaries.length),
				});
				pagesScanned += 1;
				for (const summary of page.projects) {
					// Belt-and-suspenders: the source already filters by workspace, but
					// keep the JS guard so a future store that ignores `workspaceId`
					// still cannot leak other workspaces' projects into the aggregate.
					// `acceptUnscoped` skips this guard ONLY for the synthetic personal
					// bucket, whose summary.workspaceId is store-dependent (see above).
					if (!acceptUnscoped && summary.workspaceId !== sourceWorkspaceId) continue;
					if (seenProjectIds.has(summary.projectId)) continue;
					seenProjectIds.add(summary.projectId);
					summaries.push(summary);
					if (summaries.length >= WORKSPACE_HOME_PROJECT_CAP) break;
				}
				if (!page.nextCursor) break;
				cursor = page.nextCursor;
			}
		};

		await collectFromWorkspace(workspaceId, false);

		// Reconcile with the Library: a project OWNED by this user that carries NO
		// explicit workspaceId (legacy / pre-#277 / any create without a workspace
		// stamp) is dropped by the workspace-scoped listing above (its resolved
		// workspace id is the synthetic `personal:<userId>`, not this UUID) — yet the
		// project browser (`GET /api/project`, USER-ownership listing) DOES return it,
		// so the dashboard would go empty while the Library shows real projects. Fold
		// those owned, unfiled projects into the aggregate, BUT only for the user's
		// personal/default workspace so they don't appear in every team workspace the
		// user happens to own. There is no stored "personal" flag, so the default is
		// resolved the same way the system auto-provisions it: the EARLIEST-created
		// workspace the user owns (the one minted at sign-up, before any user-created
		// workspace). This never leaks a foreign project: the source query for the
		// synthetic `personal:<userId>` bucket only matches owner_user_id === this user
		// with NO workspaceId, and we never query another workspace's UUID — so a
		// project explicitly stamped to a DIFFERENT workspace can never appear here.
		if (member.role === "owner" && (await isUsersDefaultWorkspace(store, user.userId, workspaceId))) {
			await collectFromWorkspace(`personal:${user.userId}`, true);
		}

		// Series-level duties the viewer holds here: an UNASSIGNED open task whose
		// type matches a duty surfaces in My-Work with zero per-task writes (and
		// auto-covers chapters created after the assignment). Resolved per project
		// below; chapterTeam rows override (they ride ProjectState → the summary
		// signature already busts the cache when they change).
		const viewerStoryAssignments: StoryRoleAssignmentRecord[] = await store.listStoryAssignments(workspaceId, { userId: user.userId });

		// Cheap signature over the (already-fetched) summaries. If it matches a live
		// cache entry, serve the cached aggregate and skip the up-to-60 full state
		// reads + JSON parses + aggregate rebuild entirely. Cache misses for the SAME
		// key+signature are single-flighted so simultaneous TTL expiry cannot stampede
		// into duplicate state reads. The viewer's series duties feed myTasks, so they
		// are part of the signature — an assignment change invalidates the cached
		// aggregate instead of waiting out the TTL.
		const signature = workspaceHomeSignature(summaries)
			+ "::duties:" + viewerStoryAssignments.map((entry) => `${entry.storyId}=${entry.role}`).sort().join(",");
		const cacheKey = workspaceHomeCacheKey(workspaceId, user.userId);
		const aggregate = await workspaceHomeAggregateCache.getOrSet(cacheKey, signature, async () => {
			// Concurrent state reads (bounded by the cap above). A project that fails
			// to load is skipped rather than failing the whole dashboard.
			const states = await Promise.all(summaries.map(async (summary): Promise<WorkspaceHomeProjectInput | null> => {
				try {
					const state = await catalog.getProjectState(summary.projectId);
					return state ? { state, name: summary.name } : null;
				} catch (error) {
					console.warn(`[workspaces] home: failed to read project ${summary.projectId}: ${error}`);
					return null;
				}
			}));

			const projectInputs = states.filter((entry): entry is WorkspaceHomeProjectInput => entry !== null);
			const storyRoleByStoryId = indexStoryRolesByStoryId(viewerStoryAssignments);
			const viewerDutyTypesByProject = new Map<string, Set<WorkflowTaskType>>();
			for (const input of projectInputs) {
				viewerDutyTypesByProject.set(input.state.projectId, resolveViewerDutyTaskTypes(input.state, storyRoleByStoryId, user.userId));
			}
			return buildWorkspaceHomeAggregate({
				workspaceId,
				projects: projectInputs,
				// A task assignee may be stored as either the member's email or userId;
				// match against both so My-Work is correct regardless of which the
				// assigning client used.
				viewerHandles: [user.email, user.userId],
				viewerDutyTypesByProject,
			});
		});

		return c.json(aggregate);
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
});

workspaces.post("/:workspaceId/byo-key", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = byoKeySetSchema.safeParse(raw.data);
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

	try {
		const actor = await store.requirePermission(workspaceId, user.userId, "update_workspace");
		assertWorkspaceWideScope(actor.scope);
		const key = await byoApiService.setKey(workspaceId, parsed.data.provider, parsed.data.key, user.userId);
		// Adding a customer provider credential is a security-sensitive workspace
		// mutation; record it in audit_events (never the key material — only the
		// provider and last-4 hint) so incident response can see who set the key.
		await recordByoKeyAudit(store, {
			workspaceId,
			actorUserId: user.userId,
			action: "workspace_byo_key_added",
			provider: key.provider,
			metadata: { keyHint: key.keyHint },
		});
		return c.json({
			key: {
				provider: key.provider,
				keyHint: key.keyHint,
				createdAt: key.createdAt,
				lastUsedAt: key.lastUsedAt,
			},
		}, 201);
	} catch (error) {
		return byoOrWorkspaceErrorResponse(c, error);
	}
});

workspaces.delete("/:workspaceId/byo-key/:provider", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	const provider = c.req.param("provider") as ByoProvider;
	try {
		const actor = await store.requirePermission(workspaceId, user.userId, "update_workspace");
		assertWorkspaceWideScope(actor.scope);
		const removed = await byoApiService.removeKey(workspaceId, provider);
		// Revoking a customer provider credential is a security-sensitive workspace
		// mutation; record it in audit_events so incident response can see who
		// revoked the key. Only audit when something was actually disabled.
		if (removed) {
			await recordByoKeyAudit(store, {
				workspaceId,
				actorUserId: user.userId,
				action: "workspace_byo_key_removed",
				provider,
				metadata: {},
			});
		}
		return c.json({ ok: true, removed });
	} catch (error) {
		return byoOrWorkspaceErrorResponse(c, error);
	}
});

workspaces.get("/:workspaceId/byo-key", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	try {
		await store.requirePermission(workspaceId, user.userId, "read_workspace");
		return c.json({ keys: await byoApiService.listKeyHints(workspaceId) });
	} catch (error) {
		return byoOrWorkspaceErrorResponse(c, error);
	}
});

workspaces.get("/:workspaceId/byo-usage", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	const limit = parseListLimit(c.req.query("limit"));
	if (limit === null) return c.json({ error: "Invalid limit", code: "invalid_limit" }, 400);
	try {
		// BYO usage is workspace-level billing/credential metadata (provider, model,
		// task type, estimated cost). A project/chapter/language-scoped contractor
		// must not read the whole-workspace feed, so require a workspace-wide scope.
		const actor = await store.requirePermission(workspaceId, user.userId, "read_workspace");
		assertWorkspaceWideScope(actor.scope);
		return c.json({ events: await byoApiService.listUsage(workspaceId, limit ?? 100) });
	} catch (error) {
		return byoOrWorkspaceErrorResponse(c, error);
	}
});

workspaces.get("/:workspaceId/audit-events", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	try {
		const actor = await store.requirePermission(workspaceId, user.userId, "manage_members");
		assertWorkspaceWideScope(actor.scope);
		const limit = parseListLimit(c.req.query("limit"));
		if (limit === null) return c.json({ error: "Invalid limit", code: "invalid_limit" }, 400);
		const cursor = c.req.query("cursor");
		if (!isValidWorkspacePageCursor(cursor, "auditEventId")) return c.json({ error: "Invalid cursor", code: "invalid_cursor" }, 400);
		const action = parseAuditFilter(c.req.query("action"));
		if (action === null) return c.json({ error: "Invalid action", code: "invalid_action" }, 400);
		const entityType = parseAuditFilter(c.req.query("entityType"));
		if (entityType === null) return c.json({ error: "Invalid entity type", code: "invalid_entity_type" }, 400);
		const actorUserId = parseAuditFilter(c.req.query("actorUserId"));
		if (actorUserId === null) return c.json({ error: "Invalid actor user ID", code: "invalid_actor_user_id" }, 400);
		const createdAfter = parseAuditDateFilter(c.req.query("createdAfter"));
		if (createdAfter === null) return c.json({ error: "Invalid createdAfter", code: "invalid_created_after" }, 400);
		const createdBefore = parseAuditDateFilter(c.req.query("createdBefore"));
		if (createdBefore === null) return c.json({ error: "Invalid createdBefore", code: "invalid_created_before" }, 400);
		// Compare as instants (not lexically) so bounds carrying different timezone
		// offsets — e.g. "...+09:00" vs "...Z" — order correctly, AND at full
		// sub-millisecond precision so an inverted range that differs only below
		// the millisecond (e.g. ".200900Z" vs ".200100Z") is still rejected rather
		// than slipping through a Date.parse millisecond collapse. The
		// full-precision strings still reach the ::timestamptz bounds untouched.
		if (createdAfter && createdBefore && compareAuditInstants(createdAfter, createdBefore) > 0) {
			return c.json({ error: "createdAfter must not be later than createdBefore", code: "invalid_date_range" }, 400);
		}
		const page = await store.listAuditEventPage(workspaceId, {
			limit: limit ?? undefined,
			cursor,
			action,
			entityType,
			actorUserId,
			createdAfter,
			createdBefore,
		});
		return c.json(page);
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
});

workspaces.patch("/:workspaceId", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = updateWorkspaceSchema.safeParse(raw.data);
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

	try {
		const actor = await store.requirePermission(workspaceId, user.userId, "update_workspace");
		assertScopeGrantAllowed(actor.scope, undefined);
		const workspace = await store.updateWorkspace({
			workspaceId,
			name: parsed.data.name,
			actorUserId: user.userId,
		});
		return c.json({ workspace });
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
});

workspaces.get("/:workspaceId/members", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	try {
		const actor = await store.requirePermission(workspaceId, user.userId, "manage_members");
		const limit = parseListLimit(c.req.query("limit"));
		if (limit === null) return c.json({ error: "Invalid limit", code: "invalid_limit" }, 400);
		const cursor = c.req.query("cursor");
		if (!isValidWorkspacePageCursor(cursor, "userId")) return c.json({ error: "Invalid cursor", code: "invalid_cursor" }, 400);
		const role = parseRoleFilter(c.req.query("role"));
		if (role === null) return c.json({ error: "Invalid role", code: "invalid_role" }, 400);
		const page: WorkspaceMemberPage = await store.listMemberPage(workspaceId, { limit: limit ?? undefined, cursor, role, scopeCoveredBy: actor.scope });
		// Display enrichment (issue #2): the roster used to show raw user ids +
		// "API ไม่เปิดเผยอีเมล". Load each member's profile (best-effort, bounded,
		// one auth-store read each) so the panel can show real names. Email is
		// workspace-level PII — only a full-scope manager (the same gate the
		// chapter-team roster + story-assignment candidates use) may see it. The
		// route already required manage_members above; gate email on full scope.
		const canReadEmail = workspaceScopeCovers(actor.scope, undefined);
		// Batched name/email resolution (F1): one workspace_members JOIN auth_users query via
		// listMentionCandidates instead of N per-member authUserStore.load() calls (each 2
		// SELECTs incl. an unused external-identity read). The route is already
		// manage_members-gated — exactly what listMentionCandidates requires. Email stays
		// gated on canReadEmail below; only name/email are consumed.
		const candidates = await store.listMentionCandidates(workspaceId, authUserStore);
		const profileById = new Map(candidates.map((cand) => [cand.userId, cand]));
		const enrichedMembers = page.members.map((m) => {
			const profile = profileById.get(m.userId);
			return {
				...m,
				displayName: profile?.name ?? undefined,
				...(canReadEmail && profile?.email ? { email: profile.email } : {}),
			};
		});
		return c.json({ ...page, members: enrichedMembers });
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
});

workspaces.patch("/:workspaceId/members/:userId", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	const targetUserId = c.req.param("userId");
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = memberUpdateSchema.safeParse(raw.data);
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

	try {
		const actor = await store.requirePermission(workspaceId, user.userId, "manage_members");
		const target = await store.getMember(workspaceId, targetUserId);
		if (target) assertScopeGrantAllowed(actor.scope, target.scope);
		const effectiveScope = (parsed.data.scope as WorkspaceScope | undefined) ?? target?.scope;
		assertScopeGrantAllowed(actor.scope, effectiveScope);
		if (target) {
			assertWorkspaceAdminSelfMutationAllowed({
				actorUserId: user.userId,
				targetUserId,
				currentRole: target.role,
				nextRole: parsed.data.role as WorkspaceRole,
				// Targeted COUNT instead of loading the entire roster (rank 20).
				adminCount: await store.countAdmins(workspaceId),
				action: "update",
			});
		}
		const member = await store.updateMember({
			workspaceId,
			userId: targetUserId,
			role: parsed.data.role as WorkspaceRole,
			memberStudioRole: parsed.data.memberStudioRole as WorkspaceStudioRole | undefined,
			scope: parsed.data.scope as WorkspaceScope | undefined,
			actorUserId: user.userId,
			expectedScope: target?.scope,
		});
		return c.json({ member });
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
});

workspaces.post("/:workspaceId/members/me/leave", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	try {
		const member = await store.getMember(workspaceId, user.userId);
		if (!member) throw new WorkspaceAccessError("Workspace not found", 404, "workspace_not_found");
		if (member.role === "owner") {
			throw new WorkspaceAccessError(
				"Workspace owners cannot leave their workspace. Transfer ownership before leaving.",
				403,
				"workspace_owner_cannot_leave",
			);
		}
		await store.removeMember({
			workspaceId,
			userId: user.userId,
			actorUserId: user.userId,
			expectedScope: member.scope,
		});
		// Best-effort: leaving a workspace must immediately free the user's live
		// editing leases there, while preserving locks they still hold elsewhere.
		try {
			await workspaceWorkLockStore?.releaseAllByUserInWorkspace(user.userId, workspaceId);
		} catch (error) {
			console.warn("[workspaces] failed to release leaving member's work locks", {
				workspaceId,
				userId: user.userId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return c.json({ ok: true });
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
});

workspaces.delete("/:workspaceId/members/:userId", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	const targetUserId = c.req.param("userId");
	try {
		const actor = await store.requirePermission(workspaceId, user.userId, "manage_members");
		const target = await store.getMember(workspaceId, targetUserId);
		if (target) assertScopeGrantAllowed(actor.scope, target.scope);
		if (target) {
			assertWorkspaceAdminSelfMutationAllowed({
				actorUserId: user.userId,
				targetUserId,
				currentRole: target.role,
				// Targeted COUNT instead of loading the entire roster (rank 20).
				adminCount: await store.countAdmins(workspaceId),
				action: "remove",
			});
		}
		await store.removeMember({
			workspaceId,
			userId: targetUserId,
			actorUserId: user.userId,
			expectedScope: target?.scope,
		});
		// Best-effort: drop the removed member's live page/chapter leases in THIS
		// workspace so their locks don't pin pages for the 10-minute TTL. Locks
		// they hold in other workspaces are untouched; a failure here never
		// un-removes the member.
		try {
			// workspaceWorkLockStore is null in file-mode (no DATABASE_URL) — locks don't
			// exist there, so silently skip rather than logging a false failure.
			await workspaceWorkLockStore?.releaseAllByUserInWorkspace(targetUserId, workspaceId);
		} catch (error) {
			console.warn("[workspaces] failed to release removed member's work locks", {
				workspaceId,
				userId: targetUserId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return c.json({ ok: true });
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
});

// "Finish job": demote a member to a free viewer seat (frees a paid seat) while
// keeping them in the roster + their scope so they still SEE the work they did.
// The prior role is stashed so "Reopen" can restore it. manage_members-gated,
// owner-protected, never self.
workspaces.post("/:workspaceId/members/:userId/finish", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	const targetUserId = c.req.param("userId");
	try {
		const actor = await store.requirePermission(workspaceId, user.userId, "manage_members");
		const target = await store.getMember(workspaceId, targetUserId);
		if (target) assertScopeGrantAllowed(actor.scope, target.scope);
		if (target) {
			assertWorkspaceAdminSelfMutationAllowed({
				actorUserId: user.userId,
				targetUserId,
				currentRole: target.role,
				adminCount: await store.countAdmins(workspaceId),
				// Finishing demotes to viewer — same last-admin protection as remove.
				action: "remove",
			});
		}
		const member = await store.finishMember({ workspaceId, userId: targetUserId, actorUserId: user.userId });
		return c.json({ member });
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
});

// "Reopen": restore the role stashed by finish (re-consumes a seat → may 402).
workspaces.post("/:workspaceId/members/:userId/reopen", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	const targetUserId = c.req.param("userId");
	try {
		const actor = await store.requirePermission(workspaceId, user.userId, "manage_members");
		const target = await store.getMember(workspaceId, targetUserId);
		if (target) assertScopeGrantAllowed(actor.scope, target.scope);
		const member = await store.reopenMember({ workspaceId, userId: targetUserId, actorUserId: user.userId });
		return c.json({ member });
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
});

// ── Series-level duty assignments ────────────────────────────────────────────
// A story_role_assignments row gives a member a recurring duty on EVERY chapter
// of the story (incl. future ones, resolved at read time — see story-duties).
// Chapter-level roles (chapterTeam) override these on conflict.

// Anti-abuse bound mirroring MAX_CHAPTER_TEAM_MEMBERS.
const MAX_STORY_ASSIGNMENTS_PER_STORY = 100;
const MAX_STORY_ASSIGNMENT_BULK_STORIES = 50;

const storyAssignmentUpsertSchema = z.object({
	storyId: z.string().trim().min(1).max(200),
	userId: z.string().trim().min(1).max(200),
	role: z.enum(["translator", "cleaner", "typesetter", "qc"]),
	// Display-only context for the assignee's notification; never persisted.
	storyTitle: z.string().trim().min(1).max(300).optional(),
}).strict();

const storyAssignmentBulkUpsertSchema = z.object({
	storyIds: z.array(z.string().trim().min(1).max(200)).min(1).max(MAX_STORY_ASSIGNMENT_BULK_STORIES),
	userId: z.string().trim().min(1).max(200),
	role: z.enum(["translator", "cleaner", "typesetter", "qc"]),
	// Display-only context for a compact notification; never persisted.
	storyTitle: z.string().trim().min(1).max(300).optional(),
}).strict();

workspaces.get("/:workspaceId/story-assignments", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	try {
		// Every member may READ assignments (they power the story roster display);
		// mutation stays manage_members-gated below.
		const member = await store.requirePermission(workspaceId, user.userId, "read_workspace");
		const storyId = c.req.query("storyId")?.trim() || undefined;
		if (storyId && storyId.length > 200) return c.json({ error: "Invalid storyId", code: "invalid_story_id" }, 400);
		const assignments: StoryRoleAssignmentRecord[] = await store.listStoryAssignments(workspaceId, { storyId });

		// Best-effort display enrichment so every member sees names, not raw ids.
		// Bounded: unique assignee ids, capped, each a single auth-store read.
		const uniqueUserIds = Array.from(new Set(assignments.map((entry) => entry.userId))).slice(0, 200);
		const profiles = await Promise.all(uniqueUserIds.map(async (userId) => {
			const profile = await authUserStore.load(userId).catch(() => null);
			return [userId, profile] as const;
		}));
		const profileById = new Map(profiles);
		const canReadAssigneeEmail = roleHasPermission(member.role, "manage_members") && workspaceScopeCovers(member.scope, undefined);
		const enriched = assignments.map((entry) => {
			const profile = profileById.get(entry.userId);
			return {
				workspaceId: entry.workspaceId,
				storyId: entry.storyId,
				userId: entry.userId,
				role: entry.role,
				assignedBy: entry.assignedBy,
				createdAt: entry.createdAt,
				updatedAt: entry.updatedAt,
				displayName: profile?.name ?? undefined,
				// Assignment reads are available to all members; email remains manager-only PII.
				...(canReadAssigneeEmail && profile?.email ? { email: profile.email } : {}),
			};
		});

		// Assignable-member candidates (id + name/email) only for callers who can
		// actually WRITE assignments: manage_members role + workspace-wide scope
		// (the same gate the PUT/DELETE below enforce). A fine-grained-scoped
		// admin must not receive the full member list for a picker whose every
		// action would 403. The dialog derives its manage mode from the presence
		// of `candidates`, so this also keeps the UI honest for scoped admins.
		const canManage = roleHasPermission(member.role, "manage_members") && workspaceScopeCovers(member.scope, undefined);
		const candidates = canManage ? await store.listMentionCandidates(workspaceId, authUserStore) : undefined;
		return c.json({ assignments: enriched, ...(candidates ? { candidates } : {}) });
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
});

workspaces.put("/:workspaceId/story-assignments", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = storyAssignmentUpsertSchema.safeParse(raw.data);
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

	try {
		const actor = await store.requirePermission(workspaceId, user.userId, "manage_members");
		assertWorkspaceWideScope(actor.scope);
		// The assignee must be an ACTIVE member of this workspace.
		const target = await store.getMember(workspaceId, parsed.data.userId);
		if (!target || target.disabledAt) {
			return c.json({ error: "Assignee is not an active workspace member", code: "story_assignment_target_not_member" }, 404);
		}
		const existing: StoryRoleAssignmentRecord[] = await store.listStoryAssignments(workspaceId, { storyId: parsed.data.storyId });
		// Multi-duty: a member may hold several roles on a story, so the dedup key
		// is the exact (user, role) pair — a brand-new role for an existing member
		// is still a fresh assignment to notify about.
		const priorExactRole = existing.find((entry) => entry.userId === target.userId && entry.role === parsed.data.role);
		const userAlreadyOnStory = existing.some((entry) => entry.userId === target.userId);
		const distinctUsers = new Set(existing.map((entry) => entry.userId)).size;
		if (!userAlreadyOnStory && distinctUsers >= MAX_STORY_ASSIGNMENTS_PER_STORY) {
			return c.json({ error: "Too many assignments for this story", code: "story_assignment_limit" }, 409);
		}
		const assignment = await store.upsertStoryAssignment({
			workspaceId,
			storyId: parsed.data.storyId,
			userId: target.userId,
			role: parsed.data.role as StoryAssignmentRole,
			actorUserId: user.userId,
		});
		// Notify the assignee (in-app + email per prefs) — skip a no-op re-save and
		// never notify yourself. Baked English title; in-app row localized via keys.
		if (target.userId !== user.userId && !priorExactRole) {
			const actorHandle = user.email ?? user.userId;
			const storyLabel = parsed.data.storyTitle ?? assignment.storyId;
			await notify({
				userId: target.userId,
				type: "work_assigned",
				title: `${actorHandle} assigned you ${assignment.role} duty on ${storyLabel}`,
				body: "The duty applies to every chapter of the story, including new ones.",
				workspaceId,
				linkUrl: "/library",
				metadata: {
					storyId: assignment.storyId,
					role: assignment.role,
					titleKey: "notifications.message.storyDutyAssignedTitle",
					titleParams: { actor: actorHandle, role: assignment.role, story: storyLabel },
					bodyKey: "notifications.message.storyDutyAssignedBody",
					bodyParams: {},
				},
			}).catch(() => {/* best-effort */});
		}
		return c.json({ assignment });
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
});

workspaces.put("/:workspaceId/story-assignments/bulk", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = storyAssignmentBulkUpsertSchema.safeParse(raw.data);
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	const storyIds = Array.from(new Set(parsed.data.storyIds.map((storyId) => storyId.trim()).filter(Boolean)));
	if (storyIds.length === 0) return c.json({ error: "At least one storyId is required", code: "story_assignment_story_ids_required" }, 400);

	try {
		const actor = await store.requirePermission(workspaceId, user.userId, "manage_members");
		assertWorkspaceWideScope(actor.scope);
		// The assignee must be an ACTIVE member of this workspace.
		const target = await store.getMember(workspaceId, parsed.data.userId);
		if (!target || target.disabledAt) {
			return c.json({ error: "Assignee is not an active workspace member", code: "story_assignment_target_not_member" }, 404);
		}

		// Multi-duty: dedup on the EXACT (user, role) pair, and cap on DISTINCT
		// USERS — mirrors the single-PUT route. Row-count ≠ user-count once a
		// member can hold several duties, so the old userId-only `prior` would
		// both mis-fire notifications and over-restrict the cap.
		const alreadyHadExactRole = new Set<string>();
		for (const storyId of storyIds) {
			const existing: StoryRoleAssignmentRecord[] = await store.listStoryAssignments(workspaceId, { storyId });
			if (existing.some((entry) => entry.userId === target.userId && entry.role === (parsed.data.role as StoryAssignmentRole))) {
				alreadyHadExactRole.add(storyId);
			}
			const userOnStory = existing.some((entry) => entry.userId === target.userId);
			const distinctUsers = new Set(existing.map((entry) => entry.userId)).size;
			if (!userOnStory && distinctUsers >= MAX_STORY_ASSIGNMENTS_PER_STORY) {
				return c.json({ error: "Too many assignments for this story", code: "story_assignment_limit", storyId }, 409);
			}
		}

		const assignments = await store.upsertStoryAssignments({
			workspaceId,
			storyIds,
			userId: target.userId,
			role: parsed.data.role as StoryAssignmentRole,
			actorUserId: user.userId,
		});
		const changedAssignments = assignments.filter((assignment: StoryRoleAssignmentRecord) => !alreadyHadExactRole.has(assignment.storyId));
		// Bulk assignment is one operator action; notify once so a 30-chapter story
		// does not become 30 separate emails/in-app rows for the same duty.
		if (target.userId !== user.userId && changedAssignments.length > 0) {
			const actorHandle = user.email ?? user.userId;
			const storyLabel = parsed.data.storyTitle
				?? (storyIds.length === 1 ? storyIds[0] : `${storyIds.length} stories`);
			await notify({
				userId: target.userId,
				type: "work_assigned",
				title: `${actorHandle} assigned you ${parsed.data.role} duty on ${storyLabel}`,
				body: "The duty applies to every chapter of the selected story scope, including new ones.",
				workspaceId,
				linkUrl: "/library",
				metadata: {
					storyIds,
					role: parsed.data.role,
					count: changedAssignments.length,
					titleKey: "notifications.message.storyDutyAssignedTitle",
					titleParams: { actor: actorHandle, role: parsed.data.role, story: storyLabel },
					bodyKey: "notifications.message.storyDutyAssignedBody",
					bodyParams: {},
				},
			}).catch(() => {/* best-effort */});
		}
		return c.json({ assignments, changedCount: changedAssignments.length });
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
});

workspaces.delete("/:workspaceId/story-assignments/:storyId/:userId", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	const storyId = c.req.param("storyId");
	const targetUserId = c.req.param("userId");
	if (storyId.length > 200 || targetUserId.length > 200) {
		return c.json({ error: "Invalid identifier", code: "invalid_identifier" }, 400);
	}
	// `?role=` removes ONE duty (multi-duty); omitted ⇒ clears every duty the
	// member holds on the story. An unrecognized role value is rejected.
	const roleParam = c.req.query("role")?.trim();
	if (roleParam && !STORY_ASSIGNMENT_ROLES.includes(roleParam as StoryAssignmentRole)) {
		return c.json({ error: "Invalid duty role", code: "invalid_story_role" }, 400);
	}
	try {
		const actor = await store.requirePermission(workspaceId, user.userId, "manage_members");
		assertWorkspaceWideScope(actor.scope);
		const removed = await store.removeStoryAssignment({
			workspaceId,
			storyId,
			userId: targetUserId,
			role: roleParam ? (roleParam as StoryAssignmentRole) : undefined,
			actorUserId: user.userId,
		});
		// Idempotent: removing an absent assignment is success with removed:false.
		return c.json({ ok: true, removed });
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
});

workspaces.get("/:workspaceId/invites", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	try {
		const actor = await store.requirePermission(workspaceId, user.userId, "invite_members");
		const limit = parseListLimit(c.req.query("limit"));
		if (limit === null) return c.json({ error: "Invalid limit", code: "invalid_limit" }, 400);
		const cursor = c.req.query("cursor");
		if (!isValidWorkspacePageCursor(cursor, "inviteId")) return c.json({ error: "Invalid cursor", code: "invalid_cursor" }, 400);
		const page = await store.listInvitePage(workspaceId, { limit: limit ?? undefined, cursor, scopeCoveredBy: actor.scope });
		return c.json(page);
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
});

workspaces.post("/:workspaceId/invites", requireEmailVerified, async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = inviteCreateSchema.safeParse(raw.data);
	if (!parsed.success) return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);

	try {
		const actor = await store.requirePermission(workspaceId, user.userId, "invite_members");
		assertScopeGrantAllowed(actor.scope, parsed.data.scope as WorkspaceScope | undefined);
		const invite = await store.createInvite({
			workspaceId,
			email: parsed.data.email,
			role: parsed.data.role as WorkspaceRole,
			scope: parsed.data.scope as WorkspaceScope | undefined,
			ttlSeconds: parsed.data.ttlSeconds,
			invitedByUserId: user.userId,
			replaceWithinScope: actor.scope,
		});
		const { inviteEmailSendFailed } = await dispatchWorkspaceInviteCreated({
			store,
			workspaceId,
			invite,
			actor: user,
		});
		return c.json({ invite, inviteEmailSendFailed }, 201);
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
});

workspaces.delete("/:workspaceId/invites/:inviteId", async (c) => {
	const store = requireWorkspaceStore(c);
	if (store instanceof Response) return store;
	const user = requireUser(c);
	const workspaceId = c.req.param("workspaceId");
	const inviteId = c.req.param("inviteId");
	try {
		const actor = await store.requirePermission(workspaceId, user.userId, "invite_members");
		const invite = await store.getInvite(workspaceId, inviteId);
		if (invite) assertScopeGrantAllowed(actor.scope, invite.scope);
		const revokedInvite = await store.revokeInvite({
			workspaceId,
			inviteId,
			actorUserId: user.userId,
			expectedScope: invite?.scope,
		});
		return c.json({ invite: revokedInvite });
	} catch (error) {
		return workspaceErrorResponse(c, error);
	}
});

function requireWorkspaceStore(c: any) {
	if (!workspaceAccessStore) {
		return c.json({
			error: "Workspace store is not configured",
			code: "workspace_store_unavailable",
		}, 503);
	}
	return workspaceAccessStore;
}

function requireUser(c: any): JWTPayload {
	return getAuthUser(c) as JWTPayload;
}

function buildAppUrl(path: string): string {
	const base = readMailerEnvConfig().appUrl.replace(/\/+$/, "");
	return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function buildWorkspaceInviteAcceptUrl(invite: CreatedWorkspaceInvite): string {
	return buildAppUrl(`/invite/${encodeURIComponent(invite.inviteId)}?token=${encodeURIComponent(invite.inviteToken)}`);
}

function describeWorkspaceInviteDispatchError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function dispatchWorkspaceInviteCreated(input: {
	store: NonNullable<typeof workspaceAccessStore>;
	workspaceId: string;
	invite: CreatedWorkspaceInvite;
	actor: JWTPayload;
}): Promise<{ inviteEmailSendFailed: boolean }> {
	const { store, workspaceId, invite, actor } = input;
	// Best-effort from the very first step: readMailerEnvConfig() (inside
	// buildWorkspaceInviteAcceptUrl) THROWS on a malformed MAILER_PROVIDER, and
	// the invite row is already persisted — a config fault must degrade to
	// 201 + inviteEmailSendFailed, never a 500 (review #589 P2).
	let acceptUrl: string;
	try {
		acceptUrl = buildWorkspaceInviteAcceptUrl(invite);
	} catch (error) {
		console.warn("[workspace-invite] mailer config unavailable for invite email", {
			workspaceId,
			inviteId: invite.inviteId,
			error: describeWorkspaceInviteDispatchError(error),
		});
		return { inviteEmailSendFailed: true };
	}
	const workspace = await store.getWorkspace(workspaceId).catch((error) => {
		console.warn("[workspace-invite] workspace lookup failed for invite email", {
			workspaceId,
			inviteId: invite.inviteId,
			error: describeWorkspaceInviteDispatchError(error),
		});
		return null;
	});
	const inviter = await authUserStore.load(actor.userId).catch((error) => {
		console.warn("[workspace-invite] inviter lookup failed for invite email", {
			workspaceId,
			inviteId: invite.inviteId,
			userId: actor.userId,
			error: describeWorkspaceInviteDispatchError(error),
		});
		return null;
	});
	const invitee = await authUserStore.findByEmail(invite.email).catch((error) => {
		console.warn("[workspace-invite] invitee lookup failed for in-app notification", {
			workspaceId,
			inviteId: invite.inviteId,
			error: describeWorkspaceInviteDispatchError(error),
		});
		return null;
	});
	const workspaceName = workspace?.name?.trim() || "your workspace";
	const inviterName = inviter?.name?.trim() || actor.email || "A workspace admin";
	const inviteeName = invitee?.name?.trim() || invite.email;
	let inviteEmailSendFailed = false;
	let sendError: string | null = null;
	try {
		const sendResult = await workspaceInviteEmailSender("workspace-invite", {
			invitee: { name: inviteeName, email: invite.email },
			workspaceName,
			inviterName,
			acceptUrl,
			expiresAt: invite.expiresAt,
		}, invitee?.locale ?? "en", {
			idempotencyKey: `workspace-invite:${invite.inviteId}`,
			tags: [
				{ name: "workspace", value: workspaceId },
				{ name: "invite", value: invite.inviteId },
			],
		});
		if (!sendResult.success) {
			inviteEmailSendFailed = true;
			sendError = sendResult.error ?? sendResult.status;
		} else if (sendResult.provider === "null") {
			// The null mailer "succeeds" by logging-and-skipping — no email will
			// arrive. Report unsent so the panel keeps the manual copy-link flow
			// primary on mailer-less deployments (review #589 r2).
			inviteEmailSendFailed = true;
			sendError = "mailer provider is null (no delivery)";
		}
	} catch (error) {
		inviteEmailSendFailed = true;
		sendError = describeWorkspaceInviteDispatchError(error);
	}
	if (inviteEmailSendFailed) {
		console.warn("[workspace-invite] email delivery failed", {
			workspaceId,
			inviteId: invite.inviteId,
			email: invite.email,
			error: sendError,
		});
	}

	if (invitee?.isActive) {
		try {
			await workspaceInviteNotifier({
				userId: invitee.id,
				type: "invite_received",
				title: `You were invited to ${workspaceName}`,
				body: `${inviterName} invited you to join ${workspaceName}. Check your email for the secure accept link.`,
				// Deliberately NO top-level workspaceId: the notifications API hides
				// workspace-tagged rows from non-members, and a PENDING invitee is not
				// a member yet — tagging it would bury the invite until after they
				// accept, defeating the notification (review #589 r2). The metadata
				// below still carries the workspace for the client deep-link.
				// Do not persist the one-time invite token in notification rows; only the
				// transactional email may carry the plaintext secret created above.
				metadata: {
					workspaceId,
					inviteId: invite.inviteId,
					role: invite.role,
				},
				channels: ["in_app"],
				inAppDedupeKey: `workspace-invite:${invite.inviteId}:in-app`,
			});
		} catch (error) {
			console.warn("[workspace-invite] in-app notification failed", {
				workspaceId,
				inviteId: invite.inviteId,
				userId: invitee.id,
				error: describeWorkspaceInviteDispatchError(error),
			});
		}
	}
	return { inviteEmailSendFailed };
}

// True when `workspaceId` is the user's personal/default workspace — the
// EARLIEST-created workspace they own, i.e. the one auto-provisioned at sign-up
// before any user-created workspace. There is no stored "personal" flag, so this
// mirrors the auto-provision contract deterministically and identically in file +
// Postgres mode. Used to scope the null-workspace-project reconciliation in /home
// so unfiled projects fold into ONLY the default dashboard, not every owned team
// workspace. Ties on createdAt break on workspaceId so the choice is stable.
async function isUsersDefaultWorkspace(
	store: NonNullable<typeof workspaceAccessStore>,
	userId: string,
	workspaceId: string,
): Promise<boolean> {
	const owned = (await store.listUserWorkspaces(userId)).filter((ws) => ws.memberRole === "owner");
	if (owned.length === 0) return false;
	const primary = owned.reduce((earliest, ws) => {
		const byTime = ws.createdAt.localeCompare(earliest.createdAt);
		if (byTime < 0) return ws;
		if (byTime === 0 && ws.workspaceId.localeCompare(earliest.workspaceId) < 0) return ws;
		return earliest;
	});
	return primary.workspaceId === workspaceId;
}

function workspaceErrorResponse(c: any, error: unknown): Response {
	if (error instanceof AdminSelfProtectionError) {
		return c.json({ error: error.message, reason: error.reason }, error.status);
	}
	if (error instanceof WorkspaceAccessError) {
		return c.json({ error: error.message, code: error.code }, error.status);
	}
	throw error;
}

function byoOrWorkspaceErrorResponse(c: any, error: unknown): Response {
	if (error instanceof ByoApiError) {
		return c.json({ error: error.message, code: error.code }, error.status);
	}
	return workspaceErrorResponse(c, error);
}

function assertScopeGrantAllowed(actorScope: WorkspaceScope, requestedScope: WorkspaceScope | undefined): void {
	if (!workspaceScopeCovers(actorScope, requestedScope)) {
		throw new WorkspaceAccessError("Forbidden: cannot grant or manage a broader workspace scope", 403, "workspace_scope_grant_denied");
	}
}

function assertWorkspaceWideScope(actorScope: WorkspaceScope): void {
	if (!workspaceScopeCovers(actorScope, undefined)) {
		throw new WorkspaceAccessError("Forbidden: workspace-wide scope required", 403, "workspace_scope_required");
	}
}

// Best-effort audit for BYO key add/remove. The credential mutation has already
// committed to the BYO store by the time this runs, so a transient audit-write
// failure must not turn a successful 201/200 into a 500 — we log instead.
// `entityId` is the workspace+provider pair; the raw key is never recorded.
async function recordByoKeyAudit(
	store: NonNullable<typeof workspaceAccessStore>,
	input: { workspaceId: string; actorUserId: string; action: string; provider: ByoProvider; metadata: Record<string, unknown> },
): Promise<void> {
	try {
		await store.recordAuditEvent({
			workspaceId: input.workspaceId,
			actorUserId: input.actorUserId,
			action: input.action,
			entityType: "workspace_api_key",
			entityId: `${input.workspaceId}:${input.provider}`,
			metadata: { provider: input.provider, ...input.metadata },
		});
	} catch (error) {
		console.warn(`[workspaces] Failed to record BYO key audit (${input.action}) for ${input.workspaceId}: ${error}`);
	}
}

export { workspaces, parseAuditDateFilter, compareAuditInstants };
