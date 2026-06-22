import {
	applyPendingMigrations,
	createMigrationClient,
	getMigrationStatus,
	loadMigrations,
	type MigrationStatusEntry,
} from "../services/migrations.js";

const command = process.argv[2] ?? "status";

async function main(): Promise<void> {
	const client = createMigrationClient();
	try {
		const migrations = loadMigrations();
		if (command === "up") {
			const applied = await applyPendingMigrations({ client, migrations });
			if (applied.length === 0) {
				console.log("Database migrations are already up to date.");
				return;
			}
			for (const result of applied) {
				console.log(`Applied ${result.migration.id} (${result.executionMs}ms)`);
			}
			return;
		}

		if (command === "status" || command === "check") {
			const status = await getMigrationStatus({ client, migrations });
			printStatus(status);
			const unsafe = status.filter((entry) => entry.state === "changed" || entry.state === "missing");
			if (unsafe.length > 0 || (command === "check" && status.some((entry) => entry.state === "pending"))) {
				process.exitCode = 1;
			}
			return;
		}

		throw new Error(`Unknown migration command "${command}". Use "status", "check", or "up".`);
	} finally {
		await client.close?.();
	}
}

function printStatus(status: MigrationStatusEntry[]): void {
	if (status.length === 0) {
		console.log("No migrations found.");
		return;
	}

	for (const entry of status) {
		const suffix = entry.appliedAt ? ` applied_at=${entry.appliedAt}` : "";
		console.log(`${entry.id} ${entry.state}${suffix}`);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
