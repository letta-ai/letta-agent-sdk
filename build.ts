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

// Bundle with Bun
await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "external",
});

// Generate type declarations
console.log("📝 Generating type declarations...");
const tscResult = Bun.spawnSync(["bunx", "tsc", "-p", "tsconfig.build.json"]);
if (tscResult.exitCode !== 0) {
  console.error("Type generation failed:", tscResult.stderr.toString());
  process.exit(1);
}

console.log("✅ Build complete!");
console.log(`   Output: dist/`);
