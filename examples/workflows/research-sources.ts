/**
 * Research workflow: fan out searchers across independent angles, dedupe the
 * claims they surface, cross-check each claim with a verifier, and report
 * only claims that survive with their sources.
 *
 * Workers use Letta's server-side web_search and fetch_webpage tools,
 * attached at agent creation via baseTools. Those tools are executed by the
 * Letta server, so this workflow runs on the cloud backend — the local
 * app-server backend attaches no server-side tools.
 *
 * Usage:
 *   LETTA_API_KEY=... bun examples/workflows/research-sources.ts "research question"
 */

import { agent, parallel, phase, log, printSummary, setWorkflowClient } from './runtime.js';
import { LettaAgentClient } from '../../src/index.js';

const question = process.argv[2];
if (!question) {
  console.error('Usage: bun research-sources.ts "research question"');
  process.exit(1);
}
if (!process.env.LETTA_API_KEY) {
  console.error('LETTA_API_KEY is required: web_search is a server-side tool on the cloud backend.');
  process.exit(1);
}

setWorkflowClient(
  new LettaAgentClient({ backend: 'cloud', apiKey: process.env.LETTA_API_KEY }),
);

const WEB_TOOLS = ['web_search', 'fetch_webpage'];

const SEARCH_ANGLES = [
  'official documentation and primary sources',
  'recent news, changelogs, and release notes',
  'critical takes, known problems, and counterexamples',
];

interface Claim {
  claim: string;
  source: string;
}

phase('Search');
const found = await parallel(
  SEARCH_ANGLES.map((searchAngle) => () =>
    agent<{ claims: Claim[] }>(
      `Research this question, focusing on ${searchAngle}: ${question}\n\nSearch the web and read the most relevant pages. Report 3-6 specific factual claims, each with the URL it came from.`,
      {
        label: `search: ${searchAngle.split(',')[0]}`,
        baseTools: WEB_TOOLS,
        schema: {
          type: 'object',
          required: ['claims'],
          properties: {
            claims: {
              type: 'array',
              items: {
                type: 'object',
                required: ['claim', 'source'],
                properties: { claim: { type: 'string' }, source: { type: 'string' } },
              },
            },
          },
        },
      },
    ),
  ),
);

const claims = found.filter(Boolean).flatMap((result) => result!.claims);
// Rough dedupe: drop claims whose normalized text repeats.
const seen = new Set<string>();
const unique = claims.filter((entry) => {
  const key = entry.claim.toLowerCase().replace(/\W+/g, ' ').trim();
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
log(`${claims.length} claims found, ${unique.length} after dedupe`);

phase('Verify');
const verified = await parallel(
  unique.map((entry) => async () => {
    const verdict = await agent<{ verdict: 'supported' | 'refuted' | 'unverifiable'; note: string }>(
      `Cross-check this claim against sources OTHER than ${entry.source}:\n\n"${entry.claim}"\n\nSearch independently. Report supported only if a second source agrees; refuted if a credible source contradicts it; unverifiable otherwise.`,
      {
        label: `verify: ${entry.claim.slice(0, 50)}`,
        baseTools: WEB_TOOLS,
        schema: {
          type: 'object',
          required: ['verdict', 'note'],
          properties: {
            verdict: { enum: ['supported', 'refuted', 'unverifiable'] },
            note: { type: 'string' },
          },
        },
      },
    );
    return verdict ? { ...entry, ...verdict } : null;
  }),
);

phase('Report');
const results = verified.filter(Boolean) as Array<Claim & { verdict: string; note: string }>;
const supported = results.filter((entry) => entry.verdict === 'supported');
const unverifiable = results.filter((entry) => entry.verdict === 'unverifiable');

console.log(`\n# ${question}\n`);
for (const entry of supported) {
  console.log(`- ${entry.claim}\n  source: ${entry.source}\n  cross-check: ${entry.note}`);
}
if (unverifiable.length > 0) {
  console.log(`\nUnverified (single-source):`);
  for (const entry of unverifiable) {
    console.log(`- ${entry.claim} (${entry.source})`);
  }
}
log(`${supported.length} supported, ${unverifiable.length} unverifiable, ${results.filter((entry) => entry.verdict === 'refuted').length} refuted`);

await printSummary();
