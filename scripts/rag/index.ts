import path from "node:path";
import { buildIndex, defaultIndexPath } from "./lib";

type CliOptions = {
  root: string;
  output?: string;
  scope: "all" | "knowledge";
  incremental: boolean;
};

const options = parseArgs(process.argv.slice(2));
const startedAt = Date.now();
const index = buildIndex({
  root: options.root,
  outputPath: options.output,
  scope: options.scope,
  incremental: options.incremental,
});
const outputPath = options.output
  ? path.resolve(options.root, options.output)
  : defaultIndexPath(options.root, options.scope);

console.log("Project RAG index built");
console.log(`- Output: ${path.relative(options.root, outputPath)}`);
console.log(`- Scope: ${options.scope}`);
console.log(`- Mode: ${options.incremental ? "incremental" : "full"}`);
console.log(`- Sources: ${index.sources.length}`);
console.log(`- Chunks: ${index.chunks.length}`);
console.log(`- Terms: ${Object.keys(index.docFrequency).length}`);
console.log(`- Time: ${Date.now() - startedAt}ms`);

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    root: process.cwd(),
    scope: "all",
    incremental: false,
  };

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

    if (arg === "--scope") {
      const scope = args[index + 1];
      if (scope !== "all" && scope !== "knowledge") {
        throw new Error(`Unknown scope "${scope}". Use "all" or "knowledge".`);
      }

      options.scope = scope;
      index += 1;
      continue;
    }

    if (arg === "--incremental") {
      options.incremental = true;
    }
  }

  return options;
}
