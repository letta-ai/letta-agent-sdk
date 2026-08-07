/**
 * Audit workflow: fan out one auditor per file, adversarially verify each
 * finding before reporting it.
 *
 * Usage:
 *   bun examples/workflows/audit-files.ts [directory] ["concern"]
 *
 * Defaults to auditing src/ for missing error handling.
 */

import { agent, parallel, pipeline, phase, log, printSummary } from './runtime.js';

const directory = process.argv[2] ?? 'src';
const concern = process.argv[3] ?? 'missing error handling around I/O, network, and subprocess calls';
const MAX_FILES = 15;

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'LS'];

interface Finding {
  file: string;
  line: number;
  summary: string;
  severity: 'low' | 'medium' | 'high';
}

interface Verdict {
  confirmed: boolean;
  reason: string;
}

phase('Discover');
const discovered = await agent<{ files: string[] }>(
  `List the TypeScript source files directly under ${directory}/ (not tests, not generated files). Use Glob. Return paths relative to the repository root, e.g. "${directory}/foo.ts".`,
  {
    label: `list ${directory}/`,
    allowedTools: READ_TOOLS,
    cwd: process.cwd(),
    schema: {
      type: 'object',
      required: ['files'],
      properties: { files: { type: 'array', items: { type: 'string' } } },
    },
  },
);

if (!discovered || discovered.files.length === 0) {
  console.error('Discovery failed or found no files.');
  process.exit(1);
}

let files = discovered.files;
if (files.length > MAX_FILES) {
  log(`Auditing first ${MAX_FILES} of ${files.length} files (${files.length - MAX_FILES} dropped).`);
  files = files.slice(0, MAX_FILES);
}

phase('Audit and verify');
// Each file flows through audit → verify independently: findings in one file
// are being verified while other files are still being audited.
const results = await pipeline(
  files,
  (file: string) =>
    agent<{ findings: Finding[] }>(
      `Audit ${file} for: ${concern}. Read the file and report real issues only — an empty list is a valid answer.`,
      {
        label: `audit ${file}`,
        allowedTools: READ_TOOLS,
        cwd: process.cwd(),
        schema: {
          type: 'object',
          required: ['findings'],
          properties: {
            findings: {
              type: 'array',
              items: {
                type: 'object',
                required: ['file', 'line', 'summary', 'severity'],
                properties: {
                  file: { type: 'string' },
                  line: { type: 'number' },
                  summary: { type: 'string' },
                  severity: { enum: ['low', 'medium', 'high'] },
                },
              },
            },
          },
        },
      },
    ),
  (audit: { findings: Finding[] } | null, file: string) => {
    if (!audit) return [];
    return parallel(
      audit.findings.map((finding) => async () => {
        const verdict = await agent<Verdict>(
          `A code auditor claims: "${finding.summary}" at ${finding.file}:${finding.line}. Read the surrounding code and try to REFUTE the claim — is the concern actually handled, unreachable, or misread? Default to confirmed=false if uncertain.`,
          {
            label: `verify ${file}:${finding.line}`,
            allowedTools: READ_TOOLS,
            cwd: process.cwd(),
            schema: {
              type: 'object',
              required: ['confirmed', 'reason'],
              properties: { confirmed: { type: 'boolean' }, reason: { type: 'string' } },
            },
          },
        );
        return verdict?.confirmed ? { ...finding, reason: verdict.reason } : null;
      }),
    );
  },
);

const confirmed = results
  .filter(Boolean)
  .flat()
  .filter(Boolean) as Array<Finding & { reason: string }>;

phase('Report');
if (confirmed.length === 0) {
  console.log('No findings survived verification.');
} else {
  const order = { high: 0, medium: 1, low: 2 };
  confirmed.sort((a, b) => order[a.severity] - order[b.severity]);
  for (const finding of confirmed) {
    console.log(`\n[${finding.severity}] ${finding.file}:${finding.line}`);
    console.log(`  ${finding.summary}`);
    console.log(`  verified: ${finding.reason}`);
  }
}

await printSummary();
