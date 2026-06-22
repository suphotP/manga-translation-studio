import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildIndex,
  ensureIndex,
  searchIndex,
} from "./lib";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("RAG index", () => {
  it("refreshes stale indexes incrementally and drops deleted files", () => {
    const root = createTempRoot();
    mkdirSync(path.join(root, "docs"), { recursive: true });
    mkdirSync(path.join(root, "frontend", "src"), { recursive: true });

    writeFileSync(path.join(root, "AGENTS.md"), "# Bootstrap\n", "utf8");
    writeFileSync(path.join(root, "docs", "flow.md"), "# Flow\nAlpha Flow100 copy\n", "utf8");
    writeFileSync(path.join(root, "frontend", "src", "app.ts"), "export const marker = \"kept\";\n", "utf8");

    const first = buildIndex({ root });
    expect(first.sources.map((source) => source.path)).toContain("docs/flow.md");
    expect(searchIndex(first, "Alpha Flow100", { limit: 1 })).toHaveLength(1);

    writeFileSync(path.join(root, "docs", "flow.md"), "# Flow\nBeta Flow287 copy\n", "utf8");
    rmSync(path.join(root, "frontend", "src", "app.ts"));

    const refreshed = ensureIndex({ root });
    const refreshedPaths = refreshed.sources.map((source) => source.path);

    expect(refreshedPaths).toContain("docs/flow.md");
    expect(refreshedPaths).not.toContain("frontend/src/app.ts");
    expect(searchIndex(refreshed, "Beta Flow287", { limit: 1 })).toHaveLength(1);
    expect(searchIndex(refreshed, "Alpha Flow100", { limit: 1 })).toHaveLength(0);
  });
});

function createTempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "manga-rag-"));
  tempRoots.push(root);
  return root;
}
