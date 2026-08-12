/**
 * Migration workflow: transform many files in parallel, each in an isolated
 * environment, and collect the results deterministically.
 *
 * Runs on the cloud backend: every worker session gets its own managed
 * sandbox with a fresh clone of the repository, so concurrent edits can
 * never conflict. Workers return a unified diff and the script collects the
 * patches into ./migrated/, ready for `git apply`.
 *
 * Usage:
 *   LETTA_API_KEY=... bun examples/workflows/migrate-files.ts <owner/repo> <path-prefix> "<transformation>"
 *   LETTA_API_KEY=... bun examples/workflows/migrate-files.ts letta-ai/letta-agent-sdk examples/bug-fixer "convert console.log color codes to a chalk-style helper"
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { agent, pipeline, phase, log, printSummary, setWorkflowClient, sandboxRepo } from './runtime.js';
import { LettaAgentClient } from '../../src/index.js';

const [repoArg, pathPrefix, transformation] = process.argv.slice(2);
if (!repoArg || !pathPrefix || !transformation || !repoArg.includes('/')) {
  console.error('Usage: bun migrate-files.ts <owner/repo> <path-prefix> "<transformation>"');
  process.exit(1);
}
if (!process.env.LETTA_API_KEY) {
  console.error('LETTA_API_KEY is required: isolated per-worker sandboxes are a cloud feature.');
  process.exit(1);
}

setWorkflowClient(
  new LettaAgentClient({ backend: 'cloud', apiKey: process.env.LETTA_API_KEY }),
);

// Every worker gets its own sandbox clone, so parallel edits cannot collide.
const { sandbox, cwd } = sandboxRepo(repoArg);
const repo = repoArg.split('/')[1]!;
const READ_TOOLS = ['Read', 'Grep', 'Glob', 'LS'];
const MAX_FILES = 10;
const OUT_DIR = process.env.MIGRATE_OUT ?? 'migrated';

phase('Discover');
const discovered = await agent<{ files: string[] }>(
  // Only enumerate here. Deciding what actually needs changing is the
  // per-file workers' job, and they can do it in parallel.
  `In the ${repo} repository clone, list every TypeScript file under ${pathPrefix}/ with Glob. Do not read them. Return paths relative to the repository root.`,
  {
    label: `scan ${pathPrefix}/`,
    allowedTools: READ_TOOLS,
    sandbox,
    cwd,
    schema: {
      type: 'object',
      required: ['files'],
      properties: { files: { type: 'array', items: { type: 'string' } } },
    },
  },
);

if (!discovered || discovered.files.length === 0) {
  console.error('Discovery failed or found no files.');
  await printSummary();
  process.exit(1);
}

let files = discovered.files;
if (files.length > MAX_FILES) {
  log(`Migrating first ${MAX_FILES} of ${files.length} files (${files.length - MAX_FILES} dropped).`);
  files = files.slice(0, MAX_FILES);
}

phase('Migrate and check');
// Each file is migrated in its own sandbox clone, then reviewed by an
// independent checker — no barrier, so checks start as migrations finish.
const results = await pipeline(
  files,
  // The deliverable is a patch, not the rewritten file. Asking a worker to
  // echo a whole file back through a JSON field silently truncates it; a
  // truncated patch, by contrast, simply fails to apply.
  (file: string) =>
    agent<{ diff: string; changed: boolean }>(
      `In the ${repo} repository clone, apply this transformation to ${file}: ${transformation}\n\nEdit the file in place. Then run \`git diff -- ${file}\` and return that unified diff exactly as git printed it. Set changed=false if the file needs no changes.`,
      {
        label: `migrate ${file}`,
        allowedTools: [...READ_TOOLS, 'Edit', 'Write', 'Bash'],
        sandbox,
        cwd,
        schema: {
          type: 'object',
          required: ['diff', 'changed'],
          properties: { diff: { type: 'string' }, changed: { type: 'boolean' } },
        },
      },
    ),
  async (migrated: { diff: string; changed: boolean } | null, file: string) => {
    if (!migrated || !migrated.changed || !migrated.diff.trim()) return null;
    const review = await agent<{ ok: boolean; problem: string }>(
      `In the ${repo} repository clone, read the ORIGINAL ${file}. Then check whether this diff correctly applies "${transformation}" without dropping or breaking existing behavior.\n\n--- diff ---\n${migrated.diff.slice(0, 12000)}`,
      {
        label: `check ${file}`,
        allowedTools: READ_TOOLS,
        sandbox,
        cwd,
        schema: {
          type: 'object',
          required: ['ok', 'problem'],
          properties: { ok: { type: 'boolean' }, problem: { type: 'string' } },
        },
      },
    );
    return { file, diff: migrated.diff, ok: review?.ok ?? false, problem: review?.problem ?? 'check failed' };
  },
);

phase('Collect');
const migrated = results.filter(Boolean) as Array<{ file: string; diff: string; ok: boolean; problem: string }>;
for (const entry of migrated) {
  const target = join(OUT_DIR, `${entry.file}.patch`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, entry.diff.endsWith('\n') ? entry.diff : `${entry.diff}\n`);
  console.log(entry.ok ? `  ${entry.file} → ${target}` : `  ${entry.file} → ${target} (check flagged: ${entry.problem})`);
}
log(
  `${migrated.length} patches in ${OUT_DIR}/, ${files.length - migrated.length} unchanged or failed. ` +
    `Apply with: git apply ${OUT_DIR}/<file>.patch`,
);

await printSummary();
