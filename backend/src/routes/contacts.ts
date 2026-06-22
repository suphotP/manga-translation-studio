// Workspace contacts ("friends / followers") API — a per-user address book for
// fast re-invite into chapter teams. Every handler is scoped to the authenticated
// caller (`getAuthUser(c).userId` == the contact-book owner): a user only ever
// reads/writes their OWN contacts. NOT an access grant — see workspace-contacts.ts.
//
// Routes:
//   GET    /api/contacts                  — list my contacts
//   POST   /api/contacts                  — add a contact (by UID or email)
//   DELETE /api/contacts/:contactId       — remove a contact
//   POST   /api/contacts/:contactId/invite-target — resolve a contact into an
//                                            invite target (UID/email/role) the
//                                            chapter-team invite endpoint consumes.

import { Hono } from "hono";
import { z } from "zod/v4";

import { authMiddleware, getAuthUser } from "../middleware/auth.middleware.js";
import type { JWTPayload } from "../types/auth.js";
import { readJsonBody } from "../utils/request-body.js";
import { authUserStore } from "../services/auth-users.js";
import {
	WorkspaceContactError,
	workspaceContactStore,
	CHAPTER_TEAM_ROLES,
} from "../services/workspace-contacts.js";

const contacts = new Hono();
contacts.use("*", authMiddleware);

const chapterTeamRoleSchema = z.enum(["translator", "cleaner", "typesetter", "qc", "guest"]);

const createContactSchema = z
	.object({
		// Add by UID (the product user id) OR email. At least one is required.
		contactUserId: z.string().trim().min(1).max(200).optional(),
		email: z.string().trim().email().max(320).optional(),
		displayName: z.string().trim().min(1).max(200).optional(),
		relationship: z.enum(["friend", "follower", "recent_collaborator"]).optional(),
		suggestedRole: chapterTeamRoleSchema.optional(),
	})
	.strict()
	.refine((value) => Boolean(value.contactUserId) || Boolean(value.email), {
		message: "A contact needs a UID or an email",
		path: ["contactUserId"],
	});

function requireUser(c: any): JWTPayload {
	return getAuthUser(c) as JWTPayload;
}

function contactErrorResponse(c: any, error: unknown): Response {
	if (error instanceof WorkspaceContactError) {
		return c.json({ error: error.message, code: error.code }, error.status);
	}
	throw error;
}

contacts.get("/", async (c) => {
	const user = requireUser(c);
	const list = await workspaceContactStore.listForOwner(user.userId);
	return c.json({ contacts: list, roles: CHAPTER_TEAM_ROLES });
});

contacts.post("/", async (c) => {
	const user = requireUser(c);
	const raw = await readJsonBody(c);
	if (!raw.ok) return raw.response;
	const parsed = createContactSchema.safeParse(raw.data);
	if (!parsed.success) {
		return c.json({ error: "Validation failed", code: "validation_failed", details: parsed.error.issues }, 400);
	}

	// A UID add resolves the platform user (the caller already knows the UID — NOT email
	// enumeration) so the card carries a display name + canonical email; an unknown UID
	// is rejected so a contact never claims a fake UID.
	//
	// An EMAIL add is NEVER resolved against the account store — not even internally.
	// Contacts are not an access grant, so there is no need to link the account, and
	// resolving would leak (via GET /contacts + invite-target) whether the email maps to
	// a registered user. We persist ONLY the raw email + caller-supplied displayName, so
	// a registered and an unregistered email produce byte-identical stored rows. The
	// account is resolved + linked LATER, only when the invitee accepts a chapter-team
	// invite (codex P1-3 enumeration oracle).
	let displayName = parsed.data.displayName;
	let email = parsed.data.email;
	let contactUserId = parsed.data.contactUserId;
	if (contactUserId) {
		const target = await authUserStore.load(contactUserId);
		if (!target || !target.isActive) {
			return c.json({ error: "No active user with that UID", code: "contact_uid_not_found" }, 404);
		}
		displayName = displayName ?? target.name;
		email = email ?? target.email;
	}

	try {
		const contact = await workspaceContactStore.create({
			ownerUserId: user.userId,
			contactUserId,
			email,
			displayName,
			relationship: parsed.data.relationship,
			suggestedRole: parsed.data.suggestedRole,
		});
		return c.json({ contact }, 201);
	} catch (error) {
		return contactErrorResponse(c, error);
	}
});

contacts.delete("/:contactId", async (c) => {
	const user = requireUser(c);
	const removed = await workspaceContactStore.delete(user.userId, c.req.param("contactId"));
	if (!removed) return c.json({ error: "Contact not found", code: "contact_not_found" }, 404);
	return c.json({ ok: true });
});

// Resolve a saved contact into the invite-target shape the chapter-team invite
// endpoint consumes (UID/email/suggested role). Keeps the "invite from contacts"
// flow server-validated (a stale contactId 404s) instead of trusting client state.
contacts.post("/:contactId/invite-target", async (c) => {
	const user = requireUser(c);
	const contact = await workspaceContactStore.getForOwner(user.userId, c.req.param("contactId"));
	if (!contact) return c.json({ error: "Contact not found", code: "contact_not_found" }, 404);
	return c.json({
		target: {
			userId: contact.contactUserId,
			email: contact.email,
			displayName: contact.displayName,
			role: contact.suggestedRole ?? "translator",
		},
	});
});

export { contacts };
