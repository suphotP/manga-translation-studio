import { describe, expect, test } from "bun:test";
import { InMemoryWorkLockStore } from "../services/work-locks.js";
import {
	InMemoryWorkStateStore,
	PostgresWorkStateStore,
	WorkStateConflictError,
	WorkStatePermissionError,
	WorkStateTransitionError,
	type WorkStateSqlClient,
} from "../services/work-states.js";
import { resolveWorkActorRoleForRequest, shouldNotifyAssignment } from "../routes/work-states.js";

class FakeWorkStateSqlClient implements WorkStateSqlClient {
	readonly queries: Array<{ query: string; params: unknown[] }> = [];
	state = {
		id: "state-1",
		subject_kind: "page",
		subject_id: "page-1",
		state: "in_qc",
		assignee_user_id: null,
		due_at: null,
		comment: null,
		transitioned_by: null,
		created_by: "creator-1",
		created_at: "2026-06-02T10:00:00.000Z",
		updated_at: "2026-06-02T10:00:00.000Z",
	};

	async begin<T>(fn: (transaction: WorkStateSqlClient) => Promise<T>): Promise<T> {
		return fn(this);
	}

	async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
		this.queries.push({ query, params });
		if (query.includes("INSERT INTO work_states")) return [this.state] as T[];
		if (query.includes("UPDATE work_states")) {
			if (params[8] !== this.state.state) return [] as T[];
			this.state = {
				...this.state,
				state: params[2] as string,
				assignee_user_id: params[3] as string | null,
				due_at: params[4] as string | null,
				comment: params[5] as string | null,
				transitioned_by: params[6] as string | null,
				updated_at: params[7] as string,
			};
			return [this.state] as T[];
		}
		if (query.includes("INSERT INTO work_state_transitions")) return [] as T[];
		return [] as T[];
	}
}

describe("work states", () => {
	test("route role resolver rejects client-supplied privileged workflow roles for editors/viewers", () => {
		expect(resolveWorkActorRoleForRequest("editor")).toBe("translator");
		expect(resolveWorkActorRoleForRequest("editor", "cleaner")).toBe("cleaner");
		expect(resolveWorkActorRoleForRequest("editor", "qc")).toBeNull();
		expect(resolveWorkActorRoleForRequest("editor", "owner")).toBeNull();
		expect(resolveWorkActorRoleForRequest("viewer")).toBe("guest");
		expect(resolveWorkActorRoleForRequest("viewer", "translator")).toBeNull();
		expect(resolveWorkActorRoleForRequest("admin", "qc")).toBe("qc");
	});

	test("route role resolver authorizes scoped workspace QC assignments", () => {
		const qcMember = {
			workspaceId: "workspace-1",
			userId: "editor-qc",
			role: "editor" as const,
			scope: { taskTypes: ["qc"] },
			createdAt: "2026-06-02T10:00:00.000Z",
			updatedAt: "2026-06-02T10:00:00.000Z",
		};
		const translateMember = {
			...qcMember,
			userId: "editor-translator",
			scope: { taskTypes: ["translate"] },
		};

		expect(resolveWorkActorRoleForRequest("editor", "qc", qcMember)).toBe("qc");
		expect(resolveWorkActorRoleForRequest("editor", undefined, qcMember)).toBe("qc");
		expect(resolveWorkActorRoleForRequest("editor", "qc", translateMember)).toBeNull();
	});

	test("submit releases all locks by submitter on the subject", async () => {
		const locks = new InMemoryWorkLockStore();
		const states = new InMemoryWorkStateStore(locks);
		await locks.acquireLock("page", "page-1", "translator-1", 10, { chapterId: "chapter-1" });
		await locks.acquireLock("layer", "layer-1", "translator-1", 10, { chapterId: "chapter-1" });
		await locks.acquireLock("page", "page-2", "other-user", 10, { chapterId: "chapter-1" });

		await states.transitionWorkState({
			subjectKind: "chapter",
			subjectId: "chapter-1",
			toState: "in_progress",
			actorUserId: "translator-1",
			actorRole: "translator",
		});
		const submitted = await states.transitionWorkState({
			subjectKind: "chapter",
			subjectId: "chapter-1",
			toState: "submitted",
			actorUserId: "translator-1",
			actorRole: "translator",
		});

		expect(submitted.state).toBe("submitted");
		const activeLocks = await locks.listLocksForChapter("chapter-1");
		expect(activeLocks).toHaveLength(1);
		expect(activeLocks[0].ownerUserId).toBe("other-user");
	});

	test("state transitions enforce role permissions", async () => {
		const states = new InMemoryWorkStateStore();

		await expect(states.transitionWorkState({
			subjectKind: "page",
			subjectId: "page-1",
			toState: "in_progress",
			actorUserId: "viewer-1",
			actorRole: "viewer",
		})).rejects.toBeInstanceOf(WorkStatePermissionError);
	});

	test("translator can submit, QC can approve, and invalid jumps are rejected", async () => {
		const states = new InMemoryWorkStateStore();
		await states.transitionWorkState({
			subjectKind: "chapter",
			subjectId: "chapter-1",
			toState: "in_progress",
			actorUserId: "translator-1",
			actorRole: "translator",
		});
		await states.transitionWorkState({
			subjectKind: "chapter",
			subjectId: "chapter-1",
			toState: "submitted",
			actorUserId: "translator-1",
			actorRole: "translator",
		});
		await states.transitionWorkState({
			subjectKind: "chapter",
			subjectId: "chapter-1",
			toState: "in_qc",
			actorUserId: "qc-1",
			actorRole: "qc",
		});
		const approved = await states.transitionWorkState({
			subjectKind: "chapter",
			subjectId: "chapter-1",
			toState: "approved",
			actorUserId: "qc-1",
			actorRole: "qc",
		});

		expect(approved.state).toBe("approved");
		await expect(states.transitionWorkState({
			subjectKind: "chapter",
			subjectId: "chapter-1",
			toState: "submitted",
			actorUserId: "translator-1",
			actorRole: "translator",
		})).rejects.toBeInstanceOf(WorkStateTransitionError);
	});

	test("reject records rejected state and allows bounce back to in_progress", async () => {
		const states = new InMemoryWorkStateStore();
		await states.transitionWorkState({
			subjectKind: "page",
			subjectId: "page-1",
			toState: "in_progress",
			actorUserId: "translator-1",
			actorRole: "translator",
		});
		await states.transitionWorkState({
			subjectKind: "page",
			subjectId: "page-1",
			toState: "submitted",
			actorUserId: "translator-1",
			actorRole: "translator",
		});
		const rejected = await states.transitionWorkState({
			subjectKind: "page",
			subjectId: "page-1",
			toState: "rejected",
			actorUserId: "qc-1",
			actorRole: "qc",
			comment: "Fix line break",
		});

		expect(rejected.state).toBe("rejected");
		const bounced = await states.transitionWorkState({
			subjectKind: "page",
			subjectId: "page-1",
			toState: "in_progress",
			actorUserId: "translator-1",
			actorRole: "translator",
		});
		expect(bounced.state).toBe("in_progress");
	});

	test("admin force transition works and records forced=true in the transition log", async () => {
		const states = new InMemoryWorkStateStore();
		const released = await states.transitionWorkState({
			subjectKind: "chapter",
			subjectId: "chapter-1",
			toState: "released",
			actorUserId: "admin-1",
			actorRole: "admin",
			force: true,
		});

		expect(released.state).toBe("released");
		expect(released.transitionedBy).toEqual("admin-1");

		const history = await states.listTransitionHistory("chapter", "chapter-1");
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			fromState: "draft",
			toState: "released",
			userId: "admin-1",
			role: "admin",
			forced: true,
		});
	});

	test("reject from in_qc requires a comment", async () => {
		const states = new InMemoryWorkStateStore();
		// Drive the pipeline draft -> in_progress -> submitted -> in_qc.
		await states.transitionWorkState({ subjectKind: "page", subjectId: "page-3", toState: "in_progress", actorUserId: "t-1", actorRole: "translator" });
		await states.transitionWorkState({ subjectKind: "page", subjectId: "page-3", toState: "submitted", actorUserId: "t-1", actorRole: "translator" });
		await states.transitionWorkState({ subjectKind: "page", subjectId: "page-3", toState: "in_qc", actorUserId: "qc-1", actorRole: "qc" });

		// Reject WITHOUT a comment must fail.
		await expect(states.transitionWorkState({
			subjectKind: "page",
			subjectId: "page-3",
			toState: "rejected",
			actorUserId: "qc-1",
			actorRole: "qc",
		})).rejects.toBeInstanceOf(WorkStateTransitionError);

		// Reject WITH a comment succeeds.
		const rejected = await states.transitionWorkState({
			subjectKind: "page",
			subjectId: "page-3",
			toState: "rejected",
			actorUserId: "qc-1",
			actorRole: "qc",
			comment: "Translation off-tone",
		});
		expect(rejected.state).toEqual("rejected");
		expect(rejected.comment).toEqual("Translation off-tone");
	});

	test("non-QC roles cannot move submitted -> in_qc / approved / rejected", async () => {
		const states = new InMemoryWorkStateStore();
		await states.transitionWorkState({ subjectKind: "page", subjectId: "page-4", toState: "in_progress", actorUserId: "t-1", actorRole: "translator" });
		await states.transitionWorkState({ subjectKind: "page", subjectId: "page-4", toState: "submitted", actorUserId: "t-1", actorRole: "translator" });
		// Translator trying to put work in QC is forbidden (only QC + team_lead).
		await expect(states.transitionWorkState({
			subjectKind: "page",
			subjectId: "page-4",
			toState: "in_qc",
			actorUserId: "t-1",
			actorRole: "translator",
		})).rejects.toBeInstanceOf(WorkStatePermissionError);
	});

	test("approved -> released requires team_lead/admin/owner; QC cannot release", async () => {
		const states = new InMemoryWorkStateStore();
		// Walk the pipeline to approved.
		await states.transitionWorkState({ subjectKind: "page", subjectId: "page-5", toState: "in_progress", actorUserId: "t-1", actorRole: "translator" });
		await states.transitionWorkState({ subjectKind: "page", subjectId: "page-5", toState: "submitted", actorUserId: "t-1", actorRole: "translator" });
		await states.transitionWorkState({ subjectKind: "page", subjectId: "page-5", toState: "in_qc", actorUserId: "qc-1", actorRole: "qc" });
		await states.transitionWorkState({ subjectKind: "page", subjectId: "page-5", toState: "approved", actorUserId: "qc-1", actorRole: "qc" });
		// QC cannot release.
		await expect(states.transitionWorkState({
			subjectKind: "page",
			subjectId: "page-5",
			toState: "released",
			actorUserId: "qc-1",
			actorRole: "qc",
		})).rejects.toBeInstanceOf(WorkStatePermissionError);
		// Team lead can.
		const released = await states.transitionWorkState({
			subjectKind: "page",
			subjectId: "page-5",
			toState: "released",
			actorUserId: "lead-1",
			actorRole: "team_lead",
		});
		expect(released.state).toEqual("released");
	});

	test("guest role cannot transition anything", async () => {
		const states = new InMemoryWorkStateStore();
		await expect(states.transitionWorkState({
			subjectKind: "page",
			subjectId: "page-9",
			toState: "in_progress",
			actorUserId: "guest-1",
			actorRole: "guest",
		})).rejects.toBeInstanceOf(WorkStatePermissionError);
	});

	test("listTransitionHistory returns transitions newest-first and respects the limit", async () => {
		const states = new InMemoryWorkStateStore();
		// Three transitions on the same subject.
		await states.transitionWorkState({ subjectKind: "page", subjectId: "page-10", toState: "in_progress", actorUserId: "t-1", actorRole: "translator", now: new Date("2026-06-02T10:00:00.000Z") });
		await states.transitionWorkState({ subjectKind: "page", subjectId: "page-10", toState: "submitted", actorUserId: "t-1", actorRole: "translator", now: new Date("2026-06-02T11:00:00.000Z") });
		await states.transitionWorkState({ subjectKind: "page", subjectId: "page-10", toState: "in_qc", actorUserId: "qc-1", actorRole: "qc", now: new Date("2026-06-02T12:00:00.000Z") });

		const all = await states.listTransitionHistory("page", "page-10");
		expect(all).toHaveLength(3);
		expect(all[0]!.toState).toEqual("in_qc");
		expect(all[2]!.toState).toEqual("in_progress");

		const limited = await states.listTransitionHistory("page", "page-10", { limit: 2 });
		expect(limited).toHaveLength(2);
	});

	test("non-admin force flag is ignored and rolewise rules still apply", async () => {
		const states = new InMemoryWorkStateStore();
		// translator can NOT skip from draft straight to approved even with force=true.
		await expect(states.transitionWorkState({
			subjectKind: "page",
			subjectId: "page-11",
			toState: "approved",
			actorUserId: "t-1",
			actorRole: "translator",
			force: true,
		})).rejects.toBeInstanceOf(WorkStateTransitionError);
	});

	test("postgres path validates rejection comments before writing state", async () => {
		const client = new FakeWorkStateSqlClient();
		const store = new PostgresWorkStateStore(client);

		await expect(store.transitionWorkState({
			subjectKind: "page",
			subjectId: "page-1",
			toState: "rejected",
			actorUserId: "qc-1",
			actorRole: "qc",
		})).rejects.toBeInstanceOf(WorkStateTransitionError);

		expect(client.queries.some((entry) => entry.query.includes("UPDATE work_states"))).toBeFalse();
	});

	test("postgres path compares the current state when recording a transition", async () => {
		const client = new FakeWorkStateSqlClient();
		const store = new PostgresWorkStateStore(client);

		const approved = await store.transitionWorkState({
			subjectKind: "page",
			subjectId: "page-1",
			toState: "approved",
			actorUserId: "qc-1",
			actorRole: "qc",
			comment: "Looks good",
		});

		expect(approved.state).toBe("approved");
		const update = client.queries.find((entry) => entry.query.includes("UPDATE work_states"));
		expect(update?.query).toContain("AND state = $9");
		expect(update?.params[8]).toBe("in_qc");
	});

	test("postgres path raises a retryable WorkStateConflictError when the row changed before the guarded update landed", async () => {
		// A client whose guarded UPDATE matches zero rows simulates a concurrent
		// transition landing first (optimistic-CAS loss). The route maps this to 409.
		class ConflictingClient extends FakeWorkStateSqlClient {
			async unsafe<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
				this.queries.push({ query, params });
				if (query.includes("INSERT INTO work_states")) return [this.state] as T[];
				if (query.includes("UPDATE work_states")) return [] as T[];
				return [] as T[];
			}
		}
		const store = new PostgresWorkStateStore(new ConflictingClient());

		const err = await store.transitionWorkState({
			subjectKind: "page",
			subjectId: "page-1",
			toState: "approved",
			actorUserId: "qc-1",
			actorRole: "qc",
			comment: "Looks good",
		}).catch((e) => e);

		expect(err).toBeInstanceOf(WorkStateConflictError);
		// Backward-compat: still satisfies existing WorkStateTransitionError handlers.
		expect(err).toBeInstanceOf(WorkStateTransitionError);
	});
});

// Guards the anti-spam contract on the transition route: a `work_assigned`
// notification must fire ONLY on a real assignment change, never on a later
// status-only transition that merely carries the existing assignee forward.
describe("work_assigned notification firing (shouldNotifyAssignment)", () => {
	test("(a) assigning to a new user fires once", () => {
		expect(
			shouldNotifyAssignment({
				requestedAssigneeUserId: "user-a",
				previousAssigneeUserId: undefined,
				nextAssigneeUserId: "user-a",
				actorUserId: "actor-1",
			}),
		).toBe(true);
	});

	test("(b) a status-only transition with an existing assignee fires nothing", () => {
		// No assignee_user_id in the request; the store carries "user-a" forward.
		expect(
			shouldNotifyAssignment({
				requestedAssigneeUserId: undefined,
				previousAssigneeUserId: "user-a",
				nextAssigneeUserId: "user-a",
				actorUserId: "actor-1",
			}),
		).toBe(false);
	});

	test("(c) reassigning A -> B fires once for B", () => {
		expect(
			shouldNotifyAssignment({
				requestedAssigneeUserId: "user-b",
				previousAssigneeUserId: "user-a",
				nextAssigneeUserId: "user-b",
				actorUserId: "actor-1",
			}),
		).toBe(true);
	});

	test("(d) re-setting the same assignee fires nothing", () => {
		expect(
			shouldNotifyAssignment({
				requestedAssigneeUserId: "user-a",
				previousAssigneeUserId: "user-a",
				nextAssigneeUserId: "user-a",
				actorUserId: "actor-1",
			}),
		).toBe(false);
	});

	test("(e) self-assign fires nothing", () => {
		expect(
			shouldNotifyAssignment({
				requestedAssigneeUserId: "actor-1",
				previousAssigneeUserId: undefined,
				nextAssigneeUserId: "actor-1",
				actorUserId: "actor-1",
			}),
		).toBe(false);
	});

	test("self-reassignment (someone else -> me) does not fire", () => {
		// Actor reassigns work from user-a to themselves: still no spam to the actor.
		expect(
			shouldNotifyAssignment({
				requestedAssigneeUserId: "actor-1",
				previousAssigneeUserId: "user-a",
				nextAssigneeUserId: "actor-1",
				actorUserId: "actor-1",
			}),
		).toBe(false);
	});
});
