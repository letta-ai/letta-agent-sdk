#!/usr/bin/env bun

/**
 * Build script for Letta Agent SDK
 * Bundles TypeScript source and generates declarations
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));
const version = pkg.version;

console.log(`📦 Building Letta Agent SDK v${version}...`);

const sharedBuildOptions = {
  outdir: "./dist",
  format: "esm" as const,
  minify: false,
  sourcemap: "external" as const,
};

// Keep the package root Node-focused for local process execution.
const nodeBuild = await Bun.build({
  ...sharedBuildOptions,
  entrypoints: ["./src/index.ts"],
  target: "node",
  // Prompt text lives in .md files (src/dream/prompts/); inline as strings.
  loader: { ".md": "text" },
});
if (!nodeBuild.success) {
  throw new AggregateError(nodeBuild.logs, "Node entry build failed");
}

// `/client` is the portable remote/cloud surface used by browsers and React
// Native. A browser-targeted build catches unsupported imports in its graph.
const portableBuild = await Bun.build({
  ...sharedBuildOptions,
  entrypoints: ["./src/client-entry.ts"],
  target: "browser",
});
if (!portableBuild.success) {
  throw new AggregateError(portableBuild.logs, "Portable client build failed");
}

const portableOutput = readFileSync(
  join(__dirname, "dist", "client-entry.js"),
  "utf-8",
);
const forbiddenNodeImport = /(?:from\s*|import\s*\()\s*["']node:/;
if (forbiddenNodeImport.test(portableOutput)) {
  throw new Error(
    'Portable client build contains a Node builtin import. Keep Node-only modules behind the package root.',
  );
}

// Generate type declarations
console.log("📝 Generating type declarations...");
const tscResult = Bun.spawnSync(["bunx", "tsc", "-p", "tsconfig.build.json"]);
if (tscResult.exitCode !== 0) {
  console.error("Type generation failed:", tscResult.stderr.toString());
  process.exit(1);
}

console.log("✅ Build complete!");
console.log(`   Output: dist/`);
