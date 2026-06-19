import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the Letta Code CLI entrypoint used by SDK-owned transports.
 *
 * Resolution order intentionally matches the historical subprocess transport:
 * explicit LETTA_CLI_PATH first, then the installed @letta-ai/letta-code package,
 * then local development fallbacks.
 */
export function findLettaCli(): string {
  const envPath = process.env.LETTA_CLI_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  try {
    return require.resolve("@letta-ai/letta-code");
  } catch {
    // Fall through to local development paths.
  }

  const localPaths = [
    join(__dirname, "..", "node_modules", "@letta-ai", "letta-code", "letta.js"),
    join(__dirname, "../../@letta-ai/letta-code/letta.js"),
    join(__dirname, "../../../letta-code-prod/letta.js"),
    join(__dirname, "../../../letta-code/letta.js"),
    join(__dirname, "..", "..", "letta-code", "letta.js"),
  ];

  for (const path of localPaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  throw new Error(
    "Could not find Letta Code CLI. Set LETTA_CLI_PATH environment variable or install @letta-ai/letta-code.",
  );
}
