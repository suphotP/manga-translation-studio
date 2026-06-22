import { readFileSync } from "fs";

export function stripUtf8Bom(raw: string): string {
	return raw.replace(/^\uFEFF/, "");
}

export function parseJsonText<T>(raw: string): T {
	return JSON.parse(stripUtf8Bom(raw)) as T;
}

export function readJsonFile<T>(path: string): T {
	return parseJsonText<T>(readFileSync(path, "utf-8"));
}
