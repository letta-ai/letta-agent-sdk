import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_LIMIT = 900;

// Existing debt ceilings. These are intentionally close to today's sizes so
// large modules cannot grow while they wait for their own focused extraction.
const FILE_LIMITS: Record<string, number> = {
  "app-server-session.ts": 950,
  "cloud-session.ts": 1_350,
  "types.ts": 1_350,
};

const sourceDir = join(import.meta.dir, "..", "src");
const violations: string[] = [];

for (const filename of readdirSync(sourceDir).sort()) {
  if (!filename.endsWith(".ts")) continue;
  const contents = readFileSync(join(sourceDir, filename), "utf8");
  const lines = contents.split(/\r?\n/).length;
  const limit = FILE_LIMITS[filename] ?? DEFAULT_LIMIT;
  if (lines > limit) {
    violations.push(`${filename}: ${lines} lines (limit ${limit})`);
  }
}

if (violations.length > 0) {
  console.error(
    [
      "Production source-size budget exceeded:",
      ...violations.map((violation) => `- ${violation}`),
      "Extract a coherent module or deliberately ratchet the documented debt ceiling.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log("Production source-size budgets pass.");
