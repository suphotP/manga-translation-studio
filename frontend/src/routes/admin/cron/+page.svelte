<!--
Admin cron jobs.

Backed by the real CronScheduler via /api/admin/cron/jobs (list) and
/api/admin/cron/jobs/:name/trigger (force run) — see
backend/src/routes/admin-cron.ts. The `$lib/api/admin.ts` client maps the
backend ScheduledJobRow shape onto the AdminCronJob the UI renders, and turns a
force-trigger CronRunResult into an ok/error feedback message. Only one job may
be triggered at a time (the buttons disable while any run is in flight).
-->
<script lang="ts">
	import { onMount } from "svelte";
	import {
		listCron,
		triggerCron,
		AdminApiError,
		type AdminCronJob,
	} from "$lib/api/admin.ts";

	let jobs = $state<AdminCronJob[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let triggering = $state<string | null>(null);
	let messages = $state<Record<string, { kind: "ok" | "error"; text: string }>>({});

	async function reload() {
		loading = true;
		error = null;
		try {
			const result = await listCron();
			jobs = result.jobs;
		} catch (cause) {
			error = describeError(cause);
		} finally {
			loading = false;
		}
	}

	function describeError(cause: unknown): string {
		if (cause instanceof AdminApiError) return `${cause.status}: ${cause.message}`;
		if (cause instanceof Error) return cause.message;
		return "เรียก cron ไม่ได้";
	}

	async function trigger(job: AdminCronJob) {
		// Guard against a double-trigger: only one job may run at a time, and a
		// re-click on the in-flight job is a no-op. `triggering` holds the id of
		// the single job currently running (the buttons disable on it below).
		if (triggering !== null) return;
		triggering = job.id;
		try {
			const result = await triggerCron(job.id);
			messages = {
				...messages,
				[job.id]: {
					kind: result.ok ? "ok" : "error",
					text: result.message,
				},
			};
			// Re-pull the list so lastRun status / timestamps reflect the run we
			// just forced (the page is otherwise static after onMount).
			await reload();
		} catch (cause) {
			messages = { ...messages, [job.id]: { kind: "error", text: describeError(cause) } };
		} finally {
			triggering = null;
		}
	}

	function statusPill(status: AdminCronJob["lastRunStatus"]): string {
		switch (status) {
			case "ok": return "pill-ok";
			case "failed": return "pill-failed";
			case "skipped": return "pill-skipped";
			default: return "pill-idle";
		}
	}

	onMount(reload);
</script>

<header class="page-head">
	<div>
		<h1>Cron</h1>
		<p class="page-sub">งาน background ของระบบ (GDPR hard-delete, export cleanup, usage rollup …)</p>
	</div>
	<button type="button" class="btn ws-btn-ghost" onclick={() => void reload()} disabled={loading}>รีเฟรช</button>
</header>

{#if error}
	<p class="alert error" role="alert">{error}</p>
{/if}

{#if loading && jobs.length === 0}
	<p class="muted">กำลังโหลด…</p>
{:else if jobs.length === 0}
	<p class="muted">ยังไม่มี cron job ในระบบ</p>
{:else}
	<ul class="jobs" role="list">
		{#each jobs as job (job.id)}
			<li class="job ws-panel">
				<header>
					<div>
						<strong>{job.name}</strong>
						<code class="muted">{job.id}</code>
					</div>
					<span class="pill {statusPill(job.lastRunStatus ?? null)}">{job.lastRunStatus ?? "idle"}</span>
				</header>
				<dl>
					<div><dt>Schedule</dt><dd>{job.schedule ?? "—"}</dd></div>
					<div><dt>Last run</dt><dd>{job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "—"}</dd></div>
					<div><dt>Next run</dt><dd>{job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "—"}</dd></div>
				</dl>
				<footer>
					{#if messages[job.id]}
						<p class="msg msg-{messages[job.id].kind}">{messages[job.id].text}</p>
					{/if}
					<button
						type="button"
						class="btn primary ws-grad-primary"
						onclick={() => void trigger(job)}
						disabled={triggering !== null}
					>{triggering === job.id ? "กำลังสั่ง…" : "Force trigger"}</button>
				</footer>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.page-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		margin-bottom: 16px;
		gap: 12px;
		flex-wrap: wrap;
	}
	.page-head h1 { font-size: 22px; margin: 0; color: var(--color-ws-ink); }
	.page-sub { margin: 4px 0 0; color: color-mix(in srgb, var(--color-ws-ink) 60%, transparent); font-size: 13px; }
	.btn {
		min-height: 36px;
		background: color-mix(in srgb, var(--color-ws-ink) 6%, transparent);
		color: var(--color-ws-ink);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 9%, transparent);
		border-radius: var(--radius-ws-ctrl);
		padding: 8px 14px;
		font-size: 13px;
		cursor: pointer;
	}
	.btn:hover { background: color-mix(in srgb, var(--color-ws-ink) 9%, transparent); }
	.btn[disabled] { opacity: 0.55; cursor: progress; }
	.btn.primary {
		background: linear-gradient(100deg, var(--color-ws-violet) 0%, var(--color-ws-rose) 100%);
		border-color: transparent;
	}
	.btn.primary:hover { filter: brightness(1.08); }
	.alert {
		font-size: 13px;
		padding: 8px 12px;
		border-radius: var(--radius-ws-ctrl);
		margin-bottom: 12px;
		color: var(--color-ws-rose);
		background: color-mix(in srgb, var(--color-ws-rose) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-rose) 18%, transparent);
	}
	.muted { color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); font-size: 12px; }
	.jobs {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 14px;
	}
	.job {
		background: var(--color-ws-surface);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 7%, transparent);
		border-radius: var(--radius-ws-card);
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.job > header {
		display: flex;
		justify-content: space-between;
		gap: 10px;
	}
	.job > header strong {
		display: block;
		color: var(--color-ws-ink);
		font-size: 14px;
		margin-bottom: 4px;
	}
	dl {
		margin: 0;
		display: grid;
		grid-template-columns: 1fr 1.6fr;
		gap: 4px 10px;
		font-size: 12.5px;
	}
	dl > div { display: contents; }
	dt { color: color-mix(in srgb, var(--color-ws-ink) 55%, transparent); }
	dd { margin: 0; color: color-mix(in srgb, var(--color-ws-ink) 86%, transparent); }
	.pill {
		display: inline-block;
		padding: 2px 8px;
		font-size: 11.5px;
		background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-ws-ink) 8%, transparent);
		border-radius: 999px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		height: fit-content;
	}
	.pill-ok { background: color-mix(in srgb, var(--color-ws-green) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-green) 30%, transparent); color: var(--color-ws-green); }
	.pill-failed { background: color-mix(in srgb, var(--color-ws-rose) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-rose) 30%, transparent); color: var(--color-ws-rose); }
	.pill-skipped { background: color-mix(in srgb, var(--color-ws-amber) 12%, transparent); border-color: color-mix(in srgb, var(--color-ws-amber) 30%, transparent); color: var(--color-ws-amber); }
	.pill-idle { background: color-mix(in srgb, var(--color-ws-ink) 5%, transparent); color: color-mix(in srgb, var(--color-ws-ink) 60%, transparent); }
	.job > footer { display: flex; flex-direction: column; gap: 8px; }
	.msg { margin: 0; font-size: 12px; }
	.msg-ok { color: var(--color-ws-green); }
	.msg-error { color: var(--color-ws-rose); }
</style>
