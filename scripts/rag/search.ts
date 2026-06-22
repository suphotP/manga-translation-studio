import path from "node:path";
import {
  ensureIndex,
  type RagKind,
  searchIndex,
} from "./lib";

type CliOptions = {
  root: string;
  output?: string;
  query: string;
  limit: number;
  kind?: RagKind;
  json: boolean;
  reindex: boolean;
  scope: "all" | "knowledge";
};

const options = parseArgs(process.argv.slice(2));

if (!options.query.trim()) {
  printUsage();
  process.exit(1);
}

const index = ensureIndex({
  root: options.root,
  outputPath: options.output,
  reindex: options.reindex,
  scope: options.scope,
});
const results = searchIndex(index, options.query, {
  limit: options.limit,
  kind: options.kind,
});

if (options.json) {
  console.log(JSON.stringify({
    query: options.query,
    generatedAt: index.generatedAt,
    chunkCount: index.chunks.length,
    results,
  }, null, 2));
  process.exit(0);
}

console.log(`Project RAG search: "${options.query}"`);
console.log(`Index: ${index.sources.length} sources, ${index.chunks.length} chunks, generated ${index.generatedAt}`);

if (results.length === 0) {
  console.log("No matches found. Try fewer words or run with --scope all.");
  process.exit(0);
}

const filesToRead = new Map<string, number>();

for (const [index, result] of results.entries()) {
  const chunk = result.chunk;
  if (!filesToRead.has(chunk.path)) {
    filesToRead.set(chunk.path, chunk.lineStart);
  }

  console.log("");
  console.log(`#${index + 1} ${chunk.path}:${chunk.lineStart} [${chunk.kind}] score=${result.score.toFixed(2)}`);
  if (chunk.heading) {
    console.log(`   ${chunk.heading}`);
  }
  console.log(`   ${result.snippet}`);
}

console.log("");
console.log("Suggested files to open:");
for (const [filePath, line] of filesToRead.entries()) {
  console.log(`- ${filePath}:${line}`);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    root: process.cwd(),
    query: "",
    limit: 8,
    json: false,
    reindex: false,
    scope: "all",
  };
  const queryParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--root") {
      options.root = path.resolve(args[index + 1] ?? process.cwd());
      index += 1;
      continue;
    }

    if (arg === "--output") {
      options.output = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      options.limit = Number.parseInt(args[index + 1] ?? "8", 10);
      index += 1;
      continue;
    }

    if (arg === "--kind") {
      options.kind = args[index + 1] as RagKind;
      index += 1;
      continue;
    }

    if (arg === "--scope") {
      const scope = args[index + 1];
      if (scope !== "all" && scope !== "knowledge") {
        throw new Error(`Unknown scope "${scope}". Use "all" or "knowledge".`);
      }

      options.scope = scope;
      index += 1;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--reindex") {
      options.reindex = true;
      continue;
    }

    queryParts.push(arg);
  }

  options.query = queryParts.join(" ");
  return options;
}

function printUsage(): void {
  console.log("Usage:");
  console.log("  bun run rag:search \"canvas imageBounds crop\" --limit 5");
  console.log("  bun run scripts/rag/search.ts \"Workspace Dashboard\" --scope knowledge");
  console.log("");
  console.log("Options:");
  console.log("  --limit <n>        Number of results, default 8");
  console.log("  --kind <kind>      bootstrap, memory, docs, frontend, backend, worker, config, tests, scripts, other");
  console.log("  --scope <scope>    all or knowledge, default all");
  console.log("  --reindex          Rebuild before searching");
  console.log("  --json             Output raw JSON");
}
