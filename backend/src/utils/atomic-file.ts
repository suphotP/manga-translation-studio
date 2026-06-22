// Crash-safe file writes.
//
// A plain `writeFileSync(path, data)` truncates the target and then streams the
// new bytes in place: a crash (or a full disk) mid-write leaves a TRUNCATED /
// partial file on disk. For our durable stores (`state.json`, version records,
// the file-backed AI queue) that partial file is unparseable JSON — the project
// becomes un-openable or the queue snapshot is silently dropped as "malformed".
//
// `writeFileAtomic` removes that window: it writes the full payload to a temp
// file IN THE SAME DIRECTORY (so the final rename is a same-filesystem, atomic
// operation), fsyncs the bytes to disk, then renames the temp over the target.
// A reader therefore only ever sees either the previous complete file or the new
// complete file — never a half-written one. A crash before the rename leaves the
// (now-orphaned) temp file, which the next successful write replaces; we also
// best-effort unlink it on failure.

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "fs";
import { dirname, join } from "path";

let tempCounter = 0;

/**
 * Atomically write `data` to `path` (temp file in the same dir → fsync → rename).
 * Ensures the parent directory exists. Throws on any I/O error after best-effort
 * cleanup of the temp file so a failed write never leaves a partial target.
 *
 * `beforeCommit`, when supplied, runs SYNCHRONOUSLY in the instant before the
 * atomic `renameSync` — after the temp file is fully written + fsynced but before
 * it becomes visible at `path`. It is the last reclaimable-free point in the
 * write: a caller can re-verify a fencing token there so the check→commit pair is
 * back-to-back (no I/O of its own data, no async yield) right against the rename.
 * If it throws, the rename is skipped and the temp file is cleaned up (nothing is
 * published). This is how the support-claim CAS fences a stale-reclaimed lock so a
 * tight TOCTOU window between the token re-read and the commit cannot exist.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array, beforeCommit?: () => void): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	// Unique per-write temp name in the SAME directory so `rename` stays atomic
	// (cross-device renames would fall back to a non-atomic copy). pid + a process
	// counter + time keeps concurrent writers in one process from colliding.
	tempCounter = (tempCounter + 1) % Number.MAX_SAFE_INTEGER;
	const tempPath = join(dir, `.${process.pid}.${tempCounter}.${Date.now()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(tempPath, "wx");
		// `writeSync` may perform a SHORT write (return fewer bytes than requested,
		// e.g. under signal interruption or near a full disk), so loop until every
		// byte is on the fd. Renaming a short temp over the target would publish a
		// truncated "complete" file — the exact corruption this util exists to stop.
		const buffer = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
		let offset = 0;
		while (offset < buffer.length) {
			offset += writeSync(fd, buffer, offset, buffer.length - offset);
		}
		// Flush the new bytes to the physical disk before the rename so a power loss
		// right after rename cannot expose a rename that points at unflushed data.
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		// Final fence point: run the caller's pre-commit guard back-to-back with the
		// rename. Everything expensive (serialize, write, fsync) is already done, so the
		// guard→rename pair is a tiny synchronous span with nothing reclaimable between
		// them. If the guard throws (e.g. our lock was stale-reclaimed) we skip the
		// rename and the catch below removes the temp file — nothing is published.
		if (beforeCommit) beforeCommit();
		renameSync(tempPath, path);
		// Durably commit the directory entry created by the rename. fsync on the file
		// only flushes its data/inode; without fsyncing the PARENT directory a crash
		// right after this call can lose/revert the rename even though we returned
		// success to a caller treating the state/version/queue write as committed.
		// Best-effort + platform-aware: some filesystems/OSes (notably Windows) cannot
		// fsync a directory handle — there the file fsync above is the durability we
		// can offer, so a failure here must not fail an otherwise-committed write.
		let dirFd: number | undefined;
		try {
			dirFd = openSync(dir, "r");
			fsyncSync(dirFd);
		} catch {
			// directory fsync unsupported on this platform/fs — best-effort only
		} finally {
			if (dirFd !== undefined) {
				try {
					closeSync(dirFd);
				} catch {
					// best-effort close
				}
			}
		}
	} catch (error) {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// already closing on the error path
			}
		}
		try {
			rmSync(tempPath, { force: true });
		} catch {
			// best-effort temp cleanup; surface the original error
		}
		throw error;
	}
}
