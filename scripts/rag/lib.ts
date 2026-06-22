import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export type RagKind =
  | "bootstrap"
  | "memory"
  | "docs"
  | "frontend"
  | "backend"
  | "worker"
  | "config"
  | "tests"
  | "scripts"
  | "other";

export type RagChunk = {
  id: string;
  path: string;
  kind: RagKind;
  title: string;
  heading: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  termFrequency: Record<string, number>;
  termCount: number;
};

export type RagSource = {
  path: string;
  size: number;
  mtimeMs: number;
  hash: string;
};

export type RagIndex = {
  version: 1;
  generatedAt: string;
  root: string;
  sources: RagSource[];
  chunks: RagChunk[];
  docFrequency: Record<string, number>;
  averageTermCount: number;
};

export type BuildOptions = {
  root: string;
  outputPath?: string;
  scope?: "all" | "knowledge";
  incremental?: boolean;
};

export type SearchOptions = {
  limit?: number;
  kind?: RagKind;
};

export type SearchResult = {
  chunk: RagChunk;
  score: number;
  snippet: string;
};

const INDEX_VERSION = 1 as const;
const DEFAULT_INDEX_DIRECTORY = path.join(".codex", "rag");
const MAX_FILE_BYTES = 300_000;
const MAX_CHUNK_CHARS = 5_000;
const MIN_TOKEN_LENGTH = 2;

const TEXT_EXTENSIONS = new Set([
  ".css",
  ".env.example",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".py",
  ".svelte",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const SKIP_DIRECTORIES = new Set([
  ".bun",
  ".codex-dev-logs",
  ".git",
  ".playwright-mcp",
  ".svelte-kit",
  "ai-provider-tests",
  "backend/data",
  "backend/ai-provider-tests",
  "build",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

const SKIP_DIRECTORY_NAMES = new Set([
  ".bun",
  ".git",
  ".svelte-kit",
  "build",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

const SKIP_FILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const KNOWLEDGE_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "PERFORMANCE_AUDIT_REPORT.md",
  "docs/",
  ".claude/memory/",
  "backend/README.md",
  "backend/AUTHENTICATION.md",
  "backend/AUTH_IMPLEMENTATION_SUMMARY.md",
];

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "with",
]);

export function defaultIndexPath(root: string, scope: "all" | "knowledge" = "all"): string {
  return path.join(root, DEFAULT_INDEX_DIRECTORY, `project-index-${scope}.json`);
}

export function buildIndex(options: BuildOptions): RagIndex {
  const root = path.resolve(options.root);
  const scope = options.scope ?? "all";
  const outputPath = options.outputPath
    ? path.resolve(root, options.outputPath)
    : defaultIndexPath(root, scope);
  const previousIndex = options.incremental
    ? loadIndex(root, options.outputPath, scope)
    : null;
  const previousSources = previousIndex
    ? new Map(previousIndex.sources.map((source) => [source.path, source]))
    : new Map<string, RagSource>();
  const previousChunks = previousIndex
    ? groupChunksByPath(previousIndex.chunks)
    : new Map<string, RagChunk[]>();
  const files = discoverTextFiles(root, scope);
  const chunks: RagChunk[] = [];
  const sources: RagSource[] = [];

  for (const relativePath of files) {
    const absolutePath = path.join(root, relativePath);
    const normalizedPath = toPosix(relativePath);
    const stat = statSync(absolutePath);
    const previousSource = previousSources.get(normalizedPath);
    if (
      previousSource &&
      previousSource.size === stat.size &&
      previousSource.mtimeMs === Math.round(stat.mtimeMs)
    ) {
      sources.push(previousSource);
      chunks.push(...(previousChunks.get(normalizedPath) ?? []));
      continue;
    }

    const content = readFileSafe(absolutePath);

    if (!content.trim()) {
      continue;
    }

    sources.push({
      path: normalizedPath,
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      hash: sha256(content),
    });

    chunks.push(...chunkFile(normalizedPath, content));
  }

  const docFrequency: Record<string, number> = {};
  let totalTermCount = 0;

  for (const chunk of chunks) {
    totalTermCount += chunk.termCount;
    for (const term of Object.keys(chunk.termFrequency)) {
      docFrequency[term] = (docFrequency[term] ?? 0) + 1;
    }
  }

  const index: RagIndex = {
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    root,
    sources,
    chunks,
    docFrequency,
    averageTermCount: chunks.length > 0 ? totalTermCount / chunks.length : 0,
  };

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}

export function loadIndex(
  root: string,
  indexPath?: string,
  scope: "all" | "knowledge" = "all",
): RagIndex | null {
  const resolvedPath = indexPath ? path.resolve(root, indexPath) : defaultIndexPath(root, scope);
  if (!existsSync(resolvedPath)) {
    return null;
  }

  const parsed = JSON.parse(readFileSync(resolvedPath, "utf8")) as RagIndex;
  if (parsed.version !== INDEX_VERSION) {
    return null;
  }

  return parsed;
}

export function isIndexStale(index: RagIndex, root: string, scope: "all" | "knowledge" = "all"): boolean {
  const currentFiles = discoverTextFiles(root, scope);
  if (currentFiles.length !== index.sources.length) {
    return true;
  }

  const indexed = new Map(index.sources.map((source) => [source.path, source]));
  for (const relativePath of currentFiles) {
    const normalizedPath = toPosix(relativePath);
    const source = indexed.get(normalizedPath);
    if (!source) {
      return true;
    }

    const stat = statSync(path.join(root, relativePath));
    if (source.size !== stat.size || source.mtimeMs !== Math.round(stat.mtimeMs)) {
      return true;
    }
  }

  return false;
}

export function ensureIndex(options: BuildOptions & { reindex?: boolean }): RagIndex {
  const scope = options.scope ?? "all";
  const existing = options.reindex ? null : loadIndex(options.root, options.outputPath, scope);
  if (existing && !isIndexStale(existing, path.resolve(options.root), scope)) {
    return existing;
  }

  return buildIndex({ ...options, scope, incremental: Boolean(existing) && !options.reindex });
}

export function searchIndex(index: RagIndex, query: string, options: SearchOptions = {}): SearchResult[] {
  const queryTerms = unique(tokenize(query));
  const normalizedQuery = normalizeForSearch(query);
  const limit = options.limit ?? 8;
  const results: SearchResult[] = [];
  const chunkCount = Math.max(index.chunks.length, 1);
  const averageTermCount = Math.max(index.averageTermCount, 1);

  for (const chunk of index.chunks) {
    if (options.kind && chunk.kind !== options.kind) {
      continue;
    }

    const searchableHeader = normalizeForSearch(
      `${chunk.path} ${chunk.kind} ${chunk.title} ${chunk.heading}`,
    );
    const searchableText = normalizeForSearch(chunk.text);
    let score = 0;

    for (const term of queryTerms) {
      const frequency = chunk.termFrequency[term] ?? 0;
      const docFrequency = index.docFrequency[term] ?? 0;

      if (frequency > 0) {
        score += bm25({
          frequency,
          docFrequency,
          chunkCount,
          chunkTermCount: chunk.termCount,
          averageTermCount,
        });
      }

      if (searchableHeader.includes(term)) {
        score += 1.5;
      }
    }

    if (normalizedQuery.length > 0) {
      if (searchableText.includes(normalizedQuery)) {
        score += 5;
      }

      if (searchableHeader.includes(normalizedQuery)) {
        score += 4;
      }
    }

    if (score <= 0) {
      continue;
    }

    results.push({
      chunk,
      score: score * kindBoost(chunk.kind) * utilityPenalty(chunk, queryTerms),
      snippet: makeSnippet(chunk.text, query, queryTerms),
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function discoverTextFiles(root: string, scope: "all" | "knowledge" = "all"): string[] {
  const resolvedRoot = path.resolve(root);
  const results: string[] = [];

  walk(resolvedRoot, resolvedRoot, results, scope);
  return results.sort((a, b) => toPosix(a).localeCompare(toPosix(b)));
}

export function tokenize(input: string): string[] {
  const normalized = normalizeForSearch(input)
    .replace(/[`"'“”‘’()[\]{}<>.,:;!?|/\\+=*&^%$#@~]/g, " ")
    .replace(/\s+/g, " ");
  const rawTokens = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const tokens: string[] = [];

  for (const token of rawTokens) {
    if (token.length < MIN_TOKEN_LENGTH || STOP_WORDS.has(token)) {
      continue;
    }

    tokens.push(token);
    for (const part of token.split(/[_-]/g)) {
      if (part.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(part)) {
        tokens.push(part);
      }
    }
  }

  return tokens;
}

function walk(root: string, directory: string, results: string[], scope: "all" | "knowledge"): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = toPosix(path.relative(root, absolutePath));

    if (entry.isDirectory()) {
      if (shouldSkipDirectory(relativePath)) {
        continue;
      }

      walk(root, absolutePath, results, scope);
      continue;
    }

    if (!entry.isFile() || shouldSkipFile(relativePath, absolutePath, scope)) {
      continue;
    }

    results.push(relativePath);
  }
}

function shouldSkipDirectory(relativePath: string): boolean {
  const normalizedPath = toPosix(relativePath);
  const baseName = path.basename(normalizedPath);

  if (SKIP_DIRECTORY_NAMES.has(baseName)) {
    return true;
  }

  for (const skipDirectory of SKIP_DIRECTORIES) {
    if (normalizedPath === skipDirectory || normalizedPath.startsWith(`${skipDirectory}/`)) {
      return true;
    }
  }

  if (normalizedPath === ".codex/rag" || normalizedPath.startsWith(".codex/rag/")) {
    return true;
  }

  return false;
}

function shouldSkipFile(relativePath: string, absolutePath: string, scope: "all" | "knowledge"): boolean {
  const normalizedPath = toPosix(relativePath);
  const baseName = path.basename(normalizedPath);

  if (scope === "knowledge" && !isKnowledgePath(normalizedPath)) {
    return true;
  }

  if (SKIP_FILES.has(baseName)) {
    return true;
  }

  if (
    baseName.startsWith(".env") &&
    baseName !== ".env.example"
  ) {
    return true;
  }

  if (
    normalizedPath.endsWith(".log") ||
    normalizedPath.endsWith(".png") ||
    normalizedPath.endsWith(".jpg") ||
    normalizedPath.endsWith(".jpeg") ||
    normalizedPath.endsWith(".webp") ||
    normalizedPath.endsWith(".gif") ||
    normalizedPath.endsWith(".zip") ||
    normalizedPath.endsWith(".sqlite") ||
    normalizedPath.endsWith(".db") ||
    normalizedPath.endsWith(".txt")
  ) {
    return true;
  }

  const absoluteSize = statSync(absolutePath).size;
  if (absoluteSize > MAX_FILE_BYTES) {
    return true;
  }

  return !isTextExtension(normalizedPath);
}

function isKnowledgePath(relativePath: string): boolean {
  return KNOWLEDGE_PATHS.some((knowledgePath) => {
    if (knowledgePath.endsWith("/")) {
      return relativePath.startsWith(knowledgePath);
    }

    return relativePath === knowledgePath;
  });
}

function isTextExtension(relativePath: string): boolean {
  if (relativePath.endsWith(".env.example")) {
    return true;
  }

  return TEXT_EXTENSIONS.has(path.extname(relativePath));
}

function chunkFile(relativePath: string, content: string): RagChunk[] {
  if (relativePath.endsWith(".md")) {
    return chunkMarkdown(relativePath, content);
  }

  return chunkByLines(relativePath, content, "");
}

function chunkMarkdown(relativePath: string, content: string): RagChunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: RagChunk[] = [];
  const headingStack: string[] = [];
  let currentLines: string[] = [];
  let currentStart = 1;
  let currentHeading = "";

  const flush = (lineEnd: number): void => {
    if (currentLines.join("\n").trim().length === 0) {
      currentLines = [];
      return;
    }

    chunks.push(
      ...chunkByLines(
        relativePath,
        currentLines.join("\n"),
        currentHeading,
        currentStart,
        lineEnd,
      ),
    );
    currentLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);

    if (headingMatch) {
      flush(index);
      const level = headingMatch[1].length;
      headingStack[level - 1] = headingMatch[2].trim();
      headingStack.length = level;
      currentHeading = headingStack.filter(Boolean).join(" > ");
      currentStart = index + 1;
    }

    if (currentLines.length === 0) {
      currentStart = index + 1;
    }
    currentLines.push(line);
  }

  flush(lines.length);
  return chunks;
}

function chunkByLines(
  relativePath: string,
  content: string,
  heading: string,
  originalStart = 1,
  originalEnd?: number,
): RagChunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: RagChunk[] = [];
  let startIndex = 0;

  while (startIndex < lines.length) {
    let endIndex = startIndex;
    let charCount = 0;

    while (endIndex < lines.length && charCount < MAX_CHUNK_CHARS) {
      charCount += lines[endIndex].length + 1;
      endIndex += 1;
    }

    const text = lines.slice(startIndex, endIndex).join("\n").trim();
    if (text.length > 0) {
      chunks.push(makeChunk({
        relativePath,
        heading,
        lineStart: originalStart + startIndex,
        lineEnd: originalEnd ? Math.min(originalEnd, originalStart + endIndex - 1) : originalStart + endIndex - 1,
        text,
        ordinal: chunks.length,
      }));
    }

    if (endIndex >= lines.length) {
      break;
    }

    startIndex = Math.max(endIndex - 8, startIndex + 1);
  }

  return chunks;
}

function groupChunksByPath(chunks: RagChunk[]): Map<string, RagChunk[]> {
  const grouped = new Map<string, RagChunk[]>();

  for (const chunk of chunks) {
    const existing = grouped.get(chunk.path) ?? [];
    existing.push(chunk);
    grouped.set(chunk.path, existing);
  }

  return grouped;
}

function makeChunk(options: {
  relativePath: string;
  heading: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  ordinal: number;
}): RagChunk {
  const title = path.basename(options.relativePath);
  const kind = classifyKind(options.relativePath);
  const headerText = `${options.relativePath} ${kind} ${title} ${options.heading}`;
  const tokens = tokenize(`${headerText}\n${options.text}`);
  const termFrequency: Record<string, number> = {};

  for (const token of tokens) {
    termFrequency[token] = (termFrequency[token] ?? 0) + 1;
  }

  const id = sha256(`${options.relativePath}:${options.lineStart}:${options.lineEnd}:${options.ordinal}`).slice(0, 16);

  return {
    id,
    path: options.relativePath,
    kind,
    title,
    heading: options.heading,
    lineStart: options.lineStart,
    lineEnd: options.lineEnd,
    text: options.text,
    termFrequency,
    termCount: tokens.length,
  };
}

function classifyKind(relativePath: string): RagKind {
  if (relativePath === "AGENTS.md" || relativePath === "CLAUDE.md") {
    return "bootstrap";
  }

  if (relativePath.startsWith(".claude/memory/")) {
    return "memory";
  }

  if (relativePath.startsWith("docs/") || relativePath.endsWith(".md")) {
    return "docs";
  }

  if (relativePath.includes("__tests__") || relativePath.startsWith("frontend/e2e/")) {
    return "tests";
  }

  if (relativePath.startsWith("frontend/")) {
    return "frontend";
  }

  if (relativePath.startsWith("backend/worker/") || relativePath.endsWith(".py")) {
    return "worker";
  }

  if (relativePath.startsWith("backend/")) {
    return "backend";
  }

  if (relativePath.startsWith("scripts/")) {
    return "scripts";
  }

  if (
    relativePath.endsWith(".json") ||
    relativePath.endsWith(".yaml") ||
    relativePath.endsWith(".yml") ||
    relativePath.endsWith(".toml") ||
    relativePath === ".env.example" ||
    relativePath === "docker-compose.yml"
  ) {
    return "config";
  }

  return "other";
}

function bm25(options: {
  frequency: number;
  docFrequency: number;
  chunkCount: number;
  chunkTermCount: number;
  averageTermCount: number;
}): number {
  const k1 = 1.45;
  const b = 0.72;
  const idf = Math.log(
    1 + (options.chunkCount - options.docFrequency + 0.5) / (options.docFrequency + 0.5),
  );
  const lengthNorm = 1 - b + b * (options.chunkTermCount / options.averageTermCount);
  return idf * ((options.frequency * (k1 + 1)) / (options.frequency + k1 * lengthNorm));
}

function kindBoost(kind: RagKind): number {
  switch (kind) {
    case "bootstrap":
      return 1.35;
    case "memory":
      return 1.25;
    case "docs":
      return 1.15;
    case "tests":
      return 0.92;
    default:
      return 1;
  }
}

function utilityPenalty(chunk: RagChunk, queryTerms: string[]): number {
  const isToolingQuery = queryTerms.some((term) => (
    term === "rag" ||
    term === "index" ||
    term === "search" ||
    term === "command" ||
    term === "commands" ||
    term === "script" ||
    term === "scripts"
  ));

  if (isToolingQuery) {
    return 1;
  }

  if (chunk.path === "docs/LOCAL_RAG.md") {
    return 0.18;
  }

  if (chunk.heading.toLowerCase().includes("common commands")) {
    return 0.35;
  }

  return 1;
}

function makeSnippet(text: string, query: string, queryTerms: string[]): string {
  const normalizedText = normalizeForSearch(text);
  const normalizedQuery = normalizeForSearch(query);
  let index = normalizedQuery ? normalizedText.indexOf(normalizedQuery) : -1;

  if (index < 0) {
    index = findTokenBoundaryIndex(normalizedText, queryTerms);
  }

  if (index < 0) {
    index = 0;
  }

  const start = Math.max(0, index - 180);
  const end = Math.min(text.length, index + 420);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

function findTokenBoundaryIndex(normalizedText: string, queryTerms: string[]): number {
  for (const term of queryTerms) {
    const escaped = escapeRegExp(term);
    const match = new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}(?=$|[^\\p{L}\\p{N}_-])`, "u")
      .exec(normalizedText);
    if (match) {
      return match.index + match[1].length;
    }
  }

  for (const term of queryTerms) {
    const index = normalizedText.indexOf(term);
    if (index >= 0) {
      return index;
    }
  }

  return -1;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readFileSafe(absolutePath: string): string {
  const buffer = readFileSync(absolutePath);
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeForSearch(input: string): string {
  return input.normalize("NFKC").toLowerCase();
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function toPosix(input: string): string {
  return input.split(path.sep).join("/");
}
