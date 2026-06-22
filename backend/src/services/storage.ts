import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";
import { S3Client } from "bun";
import { PROJECTS_DIR, serverConfig } from "../config.js";
import { safePath } from "../utils/security.js";
import { withTimeout } from "./monitoring.js";
import type { StorageDriver } from "../types/index.js";

// Bound every R2/S3 network op so a slow/black-holed bucket REJECTS instead of
// hanging — a hang would defeat the existing fallbacks (presign→through-backend,
// read→404/skip, GC→skip) which only fire on a rejection (#4 Batch G). 8s is well
// above normal R2 latency for a single object op.
const R2_REQUEST_TIMEOUT_MS = 8000;

export interface StoredObject {
	driver: StorageDriver;
	key: string;
	localPath?: string;
}

export interface ProjectImagePutInput {
	projectId: string;
	imageId: string;
	buffer: Buffer;
}

export interface ProjectImageReadInput {
	projectId: string;
	imageId: string;
}

export interface ProjectDerivativePutInput {
	projectId: string;
	derivativeId: string;
	buffer: Buffer;
}

export interface ProjectDerivativeReadInput {
	projectId: string;
	derivativeId: string;
}

export interface ProjectExportPutInput {
	projectId: string;
	exportId: string;
	buffer: Buffer;
}

export interface ProjectExportReadInput {
	projectId: string;
	exportId: string;
}

// A streamed export read: the object's bytes as a web ReadableStream plus the
// known total size. Size is required so the egress meter can reserve/record the
// exact byte count WITHOUT the route having to buffer the whole object first
// (that buffering was the unmetered-memory-blowup the streaming path fixes).
export interface ProjectExportStream {
	stream: ReadableStream<Uint8Array>;
	sizeBytes: number;
}

export interface ContentBlobInput {
	sha256: string;
	buffer: Buffer;
}

export interface ContentBlobReadInput {
	sha256: string;
}

export type ProjectObjectKind = "image" | "derivative" | "export";

export interface PresignProjectObjectInput {
	projectId: string;
	objectId: string;
	kind: ProjectObjectKind;
	expiresInSeconds: number;
	method?: "GET";
}

export interface ObjectStorage {
	readonly driver: StorageDriver;
	// Generate a short-TTL presigned URL for direct client delivery of a project
	// object from a PRIVATE bucket. Returns undefined when the driver cannot
	// presign (e.g. local disk), signalling the caller to fall back to the
	// through-backend serving path.
	presignProjectObject(input: PresignProjectObjectInput): string | undefined;
	putProjectImage(input: ProjectImagePutInput): Promise<StoredObject>;
	getProjectImage(input: ProjectImageReadInput): Promise<Buffer | undefined>;
	getProjectImagePath(input: ProjectImageReadInput): string | undefined;
	/**
	 * Best-effort STORAGE-LEVEL creation/modification time of a project image
	 * object, in epoch milliseconds. Used ONLY by the deploy-time grandfather
	 * backfill to enforce a time cutoff: an attacker cannot backdate this value
	 * (it is set by the filesystem / R2 at write time, not by client input).
	 * Returns `undefined` when the object is missing OR the driver cannot report a
	 * trustworthy timestamp — callers MUST treat `undefined` as "do not grandfather"
	 * (fail closed).
	 */
	getProjectImageCreatedAtMs(input: ProjectImageReadInput): Promise<number | undefined>;
	hasProjectImage(input: ProjectImageReadInput): boolean | Promise<boolean>;
	deleteProjectImage(input: ProjectImageReadInput): Promise<boolean>;
	putProjectDerivative(input: ProjectDerivativePutInput): Promise<StoredObject>;
	getProjectDerivative(input: ProjectDerivativeReadInput): Promise<Buffer | undefined>;
	getProjectDerivativePath(input: ProjectDerivativeReadInput): string | undefined;
	hasProjectDerivative(input: ProjectDerivativeReadInput): boolean | Promise<boolean>;
	deleteProjectDerivative(input: ProjectDerivativeReadInput): Promise<boolean>;
	putProjectExport(input: ProjectExportPutInput): Promise<StoredObject>;
	getProjectExport(input: ProjectExportReadInput): Promise<Buffer | undefined>;
	// Stream a stored export object instead of buffering the whole thing into
	// memory. Returns undefined when the object is missing. Used by the
	// through-backend export download routes so a multi-hundred-MB chapter ZIP is
	// piped to the client (and metered by its known size) rather than allocated as
	// one Buffer per request.
	getProjectExportStream(input: ProjectExportReadInput): Promise<ProjectExportStream | undefined>;
	getProjectExportPath(input: ProjectExportReadInput): string | undefined;
	hasProjectExport(input: ProjectExportReadInput): boolean | Promise<boolean>;
	deleteProjectExport(input: ProjectExportReadInput): Promise<boolean>;
	putContentBlob(input: ContentBlobInput): Promise<StoredObject>;
	getContentBlob(input: ContentBlobReadInput): Promise<Buffer | undefined>;
	hasContentBlob(input: ContentBlobReadInput): boolean | Promise<boolean>;
	deleteContentBlob(input: ContentBlobReadInput): Promise<boolean>;
}

function projectImageKey(projectId: string, imageId: string): string {
	return `projects/${projectId}/images/${imageId}`;
}

function projectDerivativeKey(projectId: string, derivativeId: string): string {
	return `projects/${projectId}/derivatives/${derivativeId}`;
}

function projectExportKey(projectId: string, exportId: string): string {
	return `projects/${projectId}/exports/${exportId}`;
}

function contentBlobKey(sha256: string): string {
	return `content/${sha256}`;
}

function projectObjectKey(input: PresignProjectObjectInput): string {
	switch (input.kind) {
		case "image":
			return projectImageKey(input.projectId, input.objectId);
		case "derivative":
			return projectDerivativeKey(input.projectId, input.objectId);
		case "export":
			return projectExportKey(input.projectId, input.objectId);
	}
}

class LocalProjectStorage implements ObjectStorage {
	readonly driver = "local" as const;

	// Local disk cannot mint presigned URLs; callers fall back to through-backend.
	presignProjectObject(_input: PresignProjectObjectInput): undefined {
		return undefined;
	}

	putProjectImage(input: ProjectImagePutInput): Promise<StoredObject> {
		const localPath = safePath(PROJECTS_DIR, input.projectId, "images", input.imageId);
		mkdirSync(dirname(localPath), { recursive: true });
		writeFileSync(localPath, input.buffer);
		return Promise.resolve({
			driver: this.driver,
			key: projectImageKey(input.projectId, input.imageId),
			localPath,
		});
	}

	getProjectImage(input: ProjectImageReadInput): Promise<Buffer | undefined> {
		const localPath = this.getProjectImagePath(input);
		if (!localPath || !existsSync(localPath)) return Promise.resolve(undefined);
		return Promise.resolve(readFileSync(localPath));
	}

	getProjectImagePath(input: ProjectImageReadInput): string {
		return safePath(PROJECTS_DIR, input.projectId, "images", input.imageId);
	}

	getProjectImageCreatedAtMs(input: ProjectImageReadInput): Promise<number | undefined> {
		const localPath = this.getProjectImagePath(input);
		if (!existsSync(localPath)) return Promise.resolve(undefined);
		try {
			const stat = statSync(localPath);
			// Use the LATEST of mtime + birthtime so a freshly written object reports a
			// recent time and is therefore NOT grandfathered (the cutoff fails closed on
			// anything that looks post-cutoff). birthtime (inode creation) cannot be
			// moved backwards by `utimes`, so it catches an attacker who writes a new
			// object today then backdates only its mtime. ctime is deliberately EXCLUDED:
			// it tracks any metadata change (incl. a legitimate chmod / fs migration of a
			// genuine legacy file) and would cause false "post-cutoff" rejections.
			// birthtime is 0 on filesystems that do not record it, so it is only
			// considered when positive.
			const candidates = [stat.mtimeMs];
			if (stat.birthtimeMs > 0) candidates.push(stat.birthtimeMs);
			const latest = Math.max(...candidates);
			return Promise.resolve(Number.isFinite(latest) && latest > 0 ? latest : undefined);
		} catch {
			return Promise.resolve(undefined);
		}
	}

	hasProjectImage(input: ProjectImageReadInput): boolean {
		return existsSync(this.getProjectImagePath(input));
	}

	deleteProjectImage(input: ProjectImageReadInput): Promise<boolean> {
		const localPath = this.getProjectImagePath(input);
		if (!existsSync(localPath)) return Promise.resolve(false);
		unlinkSync(localPath);
		return Promise.resolve(true);
	}

	putProjectDerivative(input: ProjectDerivativePutInput): Promise<StoredObject> {
		const localPath = safePath(PROJECTS_DIR, input.projectId, "derivatives", input.derivativeId);
		mkdirSync(dirname(localPath), { recursive: true });
		writeFileSync(localPath, input.buffer);
		return Promise.resolve({
			driver: this.driver,
			key: projectDerivativeKey(input.projectId, input.derivativeId),
			localPath,
		});
	}

	getProjectDerivative(input: ProjectDerivativeReadInput): Promise<Buffer | undefined> {
		const localPath = this.getProjectDerivativePath(input);
		if (!localPath || !existsSync(localPath)) return Promise.resolve(undefined);
		return Promise.resolve(readFileSync(localPath));
	}

	getProjectDerivativePath(input: ProjectDerivativeReadInput): string {
		return safePath(PROJECTS_DIR, input.projectId, "derivatives", input.derivativeId);
	}

	hasProjectDerivative(input: ProjectDerivativeReadInput): boolean {
		return existsSync(this.getProjectDerivativePath(input));
	}

	deleteProjectDerivative(input: ProjectDerivativeReadInput): Promise<boolean> {
		const localPath = this.getProjectDerivativePath(input);
		if (!existsSync(localPath)) return Promise.resolve(false);
		unlinkSync(localPath);
		return Promise.resolve(true);
	}

	putProjectExport(input: ProjectExportPutInput): Promise<StoredObject> {
		const localPath = safePath(PROJECTS_DIR, input.projectId, "exports", input.exportId);
		mkdirSync(dirname(localPath), { recursive: true });
		writeFileSync(localPath, input.buffer);
		return Promise.resolve({
			driver: this.driver,
			key: projectExportKey(input.projectId, input.exportId),
			localPath,
		});
	}

	getProjectExport(input: ProjectExportReadInput): Promise<Buffer | undefined> {
		const localPath = this.getProjectExportPath(input);
		if (!localPath || !existsSync(localPath)) return Promise.resolve(undefined);
		return Promise.resolve(readFileSync(localPath));
	}

	getProjectExportStream(input: ProjectExportReadInput): Promise<ProjectExportStream | undefined> {
		const localPath = this.getProjectExportPath(input);
		if (!localPath || !existsSync(localPath)) return Promise.resolve(undefined);
		// Bun.file(...).stream() yields a web ReadableStream WITHOUT reading the whole
		// file into memory; .size is the on-disk byte count, so the route can meter the
		// exact egress without buffering. stat() as a defensive fallback for size.
		const file = Bun.file(localPath);
		const sizeBytes = file.size > 0 ? file.size : statSync(localPath).size;
		return Promise.resolve({ stream: file.stream(), sizeBytes });
	}

	getProjectExportPath(input: ProjectExportReadInput): string {
		return safePath(PROJECTS_DIR, input.projectId, "exports", input.exportId);
	}

	hasProjectExport(input: ProjectExportReadInput): boolean {
		return existsSync(this.getProjectExportPath(input));
	}

	deleteProjectExport(input: ProjectExportReadInput): Promise<boolean> {
		const localPath = this.getProjectExportPath(input);
		if (!existsSync(localPath)) return Promise.resolve(false);
		unlinkSync(localPath);
		return Promise.resolve(true);
	}

	putContentBlob(input: ContentBlobInput): Promise<StoredObject> {
		const localPath = safePath(PROJECTS_DIR, "_content", input.sha256);
		mkdirSync(dirname(localPath), { recursive: true });
		writeFileSync(localPath, input.buffer);
		return Promise.resolve({
			driver: this.driver,
			key: contentBlobKey(input.sha256),
			localPath,
		});
	}

	getContentBlob(input: ContentBlobReadInput): Promise<Buffer | undefined> {
		const localPath = safePath(PROJECTS_DIR, "_content", input.sha256);
		if (!existsSync(localPath)) return Promise.resolve(undefined);
		return Promise.resolve(readFileSync(localPath));
	}

	hasContentBlob(input: ContentBlobReadInput): boolean {
		return existsSync(safePath(PROJECTS_DIR, "_content", input.sha256));
	}

	deleteContentBlob(input: ContentBlobReadInput): Promise<boolean> {
		const localPath = safePath(PROJECTS_DIR, "_content", input.sha256);
		if (!existsSync(localPath)) return Promise.resolve(false);
		unlinkSync(localPath);
		return Promise.resolve(true);
	}
}

export interface R2StorageCredentials {
	accountId: string;
	bucket: string;
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
}

class R2ProjectStorage implements ObjectStorage {
	readonly driver = "r2" as const;
	private readonly client: S3Client;

	constructor(credentials: R2StorageCredentials = serverConfig.r2) {
		const endpoint = credentials.endpoint || (credentials.accountId
			? `https://${credentials.accountId}.r2.cloudflarestorage.com`
			: "");
		this.client = new S3Client({
			accessKeyId: credentials.accessKeyId,
			secretAccessKey: credentials.secretAccessKey,
			bucket: credentials.bucket,
			endpoint,
		});
	}

	// Race any single R2 op against R2_REQUEST_TIMEOUT_MS so a hung connection
	// rejects (and the caller's existing fallback/try-catch fires) instead of
	// pinning the request forever.
	private bound<T>(op: Promise<T>): Promise<T> {
		return withTimeout(op, R2_REQUEST_TIMEOUT_MS);
	}

	// Mint a short-TTL SigV4 presigned URL via Bun's S3-compatible client so a
	// PRIVATE R2 bucket can serve the object directly without streaming every
	// byte through the backend. Defensive: a presign failure returns undefined so
	// the route falls back to the through-backend path rather than 500-ing.
	presignProjectObject(input: PresignProjectObjectInput): string | undefined {
		try {
			return this.client.presign(projectObjectKey(input), {
				expiresIn: input.expiresInSeconds,
				method: input.method ?? "GET",
			});
		} catch (error) {
			console.warn("[storage] R2 presign failed; falling back to through-backend delivery", {
				projectId: input.projectId,
				objectId: input.objectId,
				kind: input.kind,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	async putProjectImage(input: ProjectImagePutInput): Promise<StoredObject> {
		const key = projectImageKey(input.projectId, input.imageId);
		await this.bound(this.client.write(key, input.buffer));
		return { driver: this.driver, key };
	}

	async getProjectImage(input: ProjectImageReadInput): Promise<Buffer | undefined> {
		return this.readObject(projectImageKey(input.projectId, input.imageId));
	}

	getProjectImagePath(_input: ProjectImageReadInput): undefined {
		return undefined;
	}

	async getProjectImageCreatedAtMs(input: ProjectImageReadInput): Promise<number | undefined> {
		const key = projectImageKey(input.projectId, input.imageId);
		try {
			// R2/S3 HEAD returns the server-set LastModified, which the client cannot
			// backdate. If stat is unsupported / missing / unparseable, return
			// undefined so the backfill fails closed (does not grandfather).
			const stat = await this.bound(this.client.stat(key));
			const lastModified = (stat as { lastModified?: Date | string | number }).lastModified;
			if (lastModified == null) return undefined;
			const ms = lastModified instanceof Date ? lastModified.getTime() : new Date(lastModified).getTime();
			return Number.isFinite(ms) && ms > 0 ? ms : undefined;
		} catch {
			return undefined;
		}
	}

	hasProjectImage(input: ProjectImageReadInput): Promise<boolean> {
		return this.bound(this.client.exists(projectImageKey(input.projectId, input.imageId)));
	}

	async deleteProjectImage(input: ProjectImageReadInput): Promise<boolean> {
		const key = projectImageKey(input.projectId, input.imageId);
		const existed = await this.bound(this.client.exists(key));
		if (!existed) return false;
		await this.bound(this.client.delete(key));
		return true;
	}

	async putProjectDerivative(input: ProjectDerivativePutInput): Promise<StoredObject> {
		const key = projectDerivativeKey(input.projectId, input.derivativeId);
		await this.bound(this.client.write(key, input.buffer));
		return { driver: this.driver, key };
	}

	async getProjectDerivative(input: ProjectDerivativeReadInput): Promise<Buffer | undefined> {
		return this.readObject(projectDerivativeKey(input.projectId, input.derivativeId));
	}

	getProjectDerivativePath(_input: ProjectDerivativeReadInput): undefined {
		return undefined;
	}

	hasProjectDerivative(input: ProjectDerivativeReadInput): Promise<boolean> {
		return this.bound(this.client.exists(projectDerivativeKey(input.projectId, input.derivativeId)));
	}

	async deleteProjectDerivative(input: ProjectDerivativeReadInput): Promise<boolean> {
		const key = projectDerivativeKey(input.projectId, input.derivativeId);
		const existed = await this.bound(this.client.exists(key));
		if (!existed) return false;
		await this.bound(this.client.delete(key));
		return true;
	}

	async putProjectExport(input: ProjectExportPutInput): Promise<StoredObject> {
		const key = projectExportKey(input.projectId, input.exportId);
		await this.bound(this.client.write(key, input.buffer));
		return { driver: this.driver, key };
	}

	async getProjectExport(input: ProjectExportReadInput): Promise<Buffer | undefined> {
		return this.readObject(projectExportKey(input.projectId, input.exportId));
	}

	async getProjectExportStream(input: ProjectExportReadInput): Promise<ProjectExportStream | undefined> {
		const key = projectExportKey(input.projectId, input.exportId);
		try {
			// HEAD first for existence + the server-set size (used to meter egress
			// without buffering the object). S3File.stream() returns a web
			// ReadableStream that pulls from R2 lazily, so a huge chapter ZIP is never
			// fully materialized in backend memory.
			const stat = await this.bound(this.client.stat(key));
			const sizeBytes = Number((stat as { size?: number }).size ?? 0);
			if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return undefined;
			return { stream: this.client.file(key).stream(), sizeBytes };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("404") || message.toLowerCase().includes("not found")) return undefined;
			throw error;
		}
	}

	getProjectExportPath(_input: ProjectExportReadInput): undefined {
		return undefined;
	}

	hasProjectExport(input: ProjectExportReadInput): Promise<boolean> {
		return this.bound(this.client.exists(projectExportKey(input.projectId, input.exportId)));
	}

	async deleteProjectExport(input: ProjectExportReadInput): Promise<boolean> {
		const key = projectExportKey(input.projectId, input.exportId);
		const existed = await this.bound(this.client.exists(key));
		if (!existed) return false;
		await this.bound(this.client.delete(key));
		return true;
	}

	async putContentBlob(input: ContentBlobInput): Promise<StoredObject> {
		const key = contentBlobKey(input.sha256);
		await this.bound(this.client.write(key, input.buffer));
		return { driver: this.driver, key };
	}

	getContentBlob(input: ContentBlobReadInput): Promise<Buffer | undefined> {
		return this.readObject(contentBlobKey(input.sha256));
	}

	hasContentBlob(input: ContentBlobReadInput): Promise<boolean> {
		return this.bound(this.client.exists(contentBlobKey(input.sha256)));
	}

	async deleteContentBlob(input: ContentBlobReadInput): Promise<boolean> {
		const key = contentBlobKey(input.sha256);
		const existed = await this.bound(this.client.exists(key));
		if (!existed) return false;
		await this.bound(this.client.delete(key));
		return true;
	}

	private async readObject(key: string): Promise<Buffer | undefined> {
		try {
			if (!(await this.bound(this.client.exists(key)))) return undefined;
			return Buffer.from(await this.bound(this.client.file(key).arrayBuffer()));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("404") || message.toLowerCase().includes("not found")) return undefined;
			throw error;
		}
	}
}

// Build an R2-backed object storage from explicit credentials. Exposed so the
// presign path can be exercised with mock credentials (no live R2 required) and
// so callers can construct an R2 storage independent of the import-time
// singleton's environment snapshot.
export function createR2ObjectStorage(credentials: R2StorageCredentials): ObjectStorage {
	return new R2ProjectStorage(credentials);
}

function createObjectStorage(): ObjectStorage {
	if (serverConfig.storageDriver === "r2") {
		if (!serverConfig.r2.bucket || (!serverConfig.r2.endpoint && !serverConfig.r2.accountId) || !serverConfig.r2.accessKeyId || !serverConfig.r2.secretAccessKey) {
			throw new Error("R2 storage requires R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and either R2_ENDPOINT or R2_ACCOUNT_ID.");
		}
		return new R2ProjectStorage();
	}

	return new LocalProjectStorage();
}

export const objectStorage = createObjectStorage();
