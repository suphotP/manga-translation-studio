/*
 * One-shot platform-admin promotion (admin-audit bootstrap).
 * Usage:  bun run scripts/promote-admin.ts <email> [role]
 * role defaults to "owner". Promotes an ALREADY-REGISTERED account to a platform
 * role so it can reach /admin. Idempotent; refuses to create accounts or demote.
 */
import { authUserStore } from "../src/services/auth-users.js";
import { isPlatformAdmin, type UserRole } from "../src/types/auth.js";

const email = process.argv[2]?.trim().toLowerCase();
const role = (process.argv[3]?.trim() as UserRole) || "owner";
if (!email) {
	console.error("usage: bun run scripts/promote-admin.ts <email> [owner|admin|support|accountant]");
	process.exit(1);
}
if (!["owner", "admin", "support", "accountant"].includes(role)) {
	console.error(`refusing to set non-platform role "${role}"`);
	process.exit(1);
}
const user = await authUserStore.findByEmail(email);
if (!user) {
	console.error(`no account for ${email} — register it first, then re-run.`);
	process.exit(1);
}
if (user.role === role) {
	console.log(`${email} is already ${role}; nothing to do.`);
	process.exit(0);
}
await authUserStore.update(user.id, { role });
console.log(`promoted ${email}: ${user.role} -> ${role}${isPlatformAdmin(role) ? " (platform admin)" : ""}`);
process.exit(0);
