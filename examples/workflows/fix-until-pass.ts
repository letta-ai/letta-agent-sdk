/**
 * Fix-until-pass workflow: run a check command, fan out fixer agents over
 * the failures, and repeat until the check passes or two rounds in a row
 * make no progress.
 *
 * Usage:
 *   bun examples/workflows/fix-until-pass.ts "<check command>"
 *   bun examples/workflows/fix-until-pass.ts "bunx tsc --noEmit"
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { agent, parallel, phase, log, printSummary } from './runtime.js';

const exec = promisify(execFile);

const checkCommandArg = process.argv[2];
if (!checkCommandArg) {
  console.error('Usage: bun fix-until-pass.ts "<check command>"');
  process.exit(1);
}
const checkCommand: string = checkCommandArg;

const MAX_ROUNDS = 5;
const FIX_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'];

async function runCheck(): Promise<{ passed: boolean; output: string }> {
  try {
    await exec('sh', ['-c', checkCommand], { maxBuffer: 10 * 1024 * 1024 });
    return { passed: true, output: '' };
  } catch (error: any) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    return { passed: false, output };
  }
}

/** Group failure lines by leading `path:` / `path(` so fixers can run per file. */
function groupByFile(output: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  let current = 'general';
  for (const line of output.split('\n')) {
    const match = line.match(/^(\S+\.\w+)[(:]/);
    if (match?.[1]) current = match[1];
    if (!groups.has(current)) groups.set(current, []);
    groups.get(current)!.push(line);
  }
  return groups;
}

let previousFailureSize = Infinity;
let stalledRounds = 0;

for (let round = 1; round <= MAX_ROUNDS; round++) {
  phase(`Round ${round}: check`);
  const check = await runCheck();
  if (check.passed) {
    console.log(`\nCheck passed: ${checkCommand}`);
    await printSummary();
    process.exit(0);
  }

  const failureSize = check.output.split('\n').length;
  log(`${failureSize} lines of failure output`);
  if (failureSize >= previousFailureSize) {
    stalledRounds++;
    if (stalledRounds >= 2) {
      console.log('\nNo progress for two rounds — stopping.');
      break;
    }
  } else {
    stalledRounds = 0;
  }
  previousFailureSize = failureSize;

  phase(`Round ${round}: fix`);
  const grouped = groupByFile(check.output);
  if (grouped.size > 1) grouped.delete('general');
  const groups = [...grouped.entries()];
  await parallel(
    groups.map(([file, lines]) => () =>
      agent(
        `The command \`${checkCommand}\` is failing. Fix the failures below with minimal changes — do not refactor unrelated code.\n\n${lines.join('\n').slice(0, 8000)}\n\nWhen done, reply with one sentence describing what you changed.`,
        {
          label: `fix ${file}`,
          allowedTools: FIX_TOOLS,
          cwd: process.cwd(),
        },
      ),
    ),
  );
}

const final = await runCheck();
console.log(final.passed ? `\nCheck passed: ${checkCommand}` : `\nStill failing after ${MAX_ROUNDS} rounds:\n${final.output.slice(0, 2000)}`);
await printSummary();
