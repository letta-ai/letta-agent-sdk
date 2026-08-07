/**
 * Judge-panel workflow: draft an implementation plan from several independent
 * angles in parallel — each angle on a different model provider — score the
 * drafts with a judge, and synthesize a final plan from the winner plus the
 * best ideas of the runners-up.
 *
 * Letta agents take any configured provider through a model handle, so the
 * panel is genuinely diverse: an Anthropic drafter, an OpenAI drafter, and a
 * Moonshot drafter, judged by a fourth model. Each draft is an independent
 * agent, so one provider being slow or unavailable costs one draft, not the
 * run. Override the lineup with PANEL_MODELS (comma-separated handles) and
 * JUDGE_MODEL.
 *
 * With LETTA_API_KEY set, workers run on Letta Cloud, where every provider in
 * the catalog is reachable. Without it they run on the local backend, which
 * only reaches providers this machine has credentials for — set PANEL_MODELS
 * accordingly.
 *
 * Usage:
 *   LETTA_API_KEY=... bun examples/workflows/plan-panel.ts "task description"
 */

import { agent, parallel, phase, log, printSummary, setWorkflowClient, sandboxRepo } from './runtime.js';
import { LettaAgentClient } from '../../src/index.js';

const task = process.argv[2];
if (!task) {
  console.error('Usage: bun plan-panel.ts "task description"');
  process.exit(1);
}

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'LS'];

// On cloud, drafters read the repository from a managed sandbox clone;
// locally they read the working directory directly.
const repoArg = process.env.PANEL_REPO;
const onCloud = Boolean(process.env.LETTA_API_KEY);
if (onCloud) {
  setWorkflowClient(new LettaAgentClient({ backend: 'cloud', apiKey: process.env.LETTA_API_KEY }));
}
const context = onCloud
  ? repoArg && repoArg.includes('/')
    ? { ...sandboxRepo(repoArg), allowedTools: READ_TOOLS }
    : {}
  : { allowedTools: READ_TOOLS, cwd: process.cwd() };

// Without repository access, say so — otherwise drafters "explore" an empty
// sandbox and pad the plan with invented file paths.
const grounding = context.allowedTools
  ? 'Explore the repository first and ground the plan in the files you actually find.'
  : 'You have no repository access. Plan from the description alone and state your assumptions instead of inventing file paths.';

const PANEL_MODELS = (
  process.env.PANEL_MODELS ??
  'anthropic/claude-sonnet-5,openai/gpt-5.6-sol,moonshot/kimi-k3'
).split(',');
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? 'anthropic/claude-opus-5';

const ANGLES = [
  {
    key: 'mvp-first',
    brief: 'Optimize for the smallest change that ships value. Cut scope aggressively; defer everything deferrable.',
  },
  {
    key: 'risk-first',
    brief: 'Optimize for de-risking. Identify what could go wrong (migrations, compatibility, edge cases) and sequence the plan to surface failures early.',
  },
  {
    key: 'maintainer-first',
    brief: 'Optimize for the long-term shape of the codebase. Prefer existing patterns and native mechanisms over new abstractions.',
  },
].map((angle, index) => ({ ...angle, model: PANEL_MODELS[index % PANEL_MODELS.length]! }));

phase('Draft');
log(`panel: ${ANGLES.map((angle) => `${angle.key} on ${angle.model}`).join(', ')}`);
log(
  onCloud
    ? repoArg
      ? `cloud workers, each with a sandbox clone of ${repoArg}`
      : 'cloud workers with no repository access (set PANEL_REPO=owner/repo to ground the plans)'
    : `local workers reading ${process.cwd()}`,
);
// Barrier is intentional here: the judge needs all drafts at once.
const drafts = (
  await parallel(
    ANGLES.map((angle) => () =>
      agent(
        `Write an implementation plan for the following task. ${grounding}\n\nTask: ${task}\n\nPlanning lens: ${angle.brief}\n\nReturn the plan as markdown: numbered steps, files to touch, and open questions.`,
        {
          label: `draft ${angle.key} (${angle.model})`,
          model: angle.model,
          ...context,
        },
      ),
    ),
  )
).map((plan, index) => ({ angle: ANGLES[index]!.key, model: ANGLES[index]!.model, plan }))
  .filter((draft) => draft.plan !== null);

if (drafts.length === 0) {
  console.error(
    'All drafts failed. Each panel model needs credentials configured in Letta;\n' +
      'set PANEL_MODELS to handles your deployment can actually reach.',
  );
  await printSummary();
  process.exit(1);
}
if (drafts.length < ANGLES.length) {
  log(`${ANGLES.length - drafts.length} of ${ANGLES.length} drafts failed; judging the rest.`);
}

phase('Judge');
const verdict = await agent<{
  scores: Array<{ angle: string; score: number; strengths: string; weaknesses: string }>;
  winner: string;
}>(
  `Score these ${drafts.length} implementation plans for the task: "${task}". Judge on correctness, scope discipline, and sequencing. Score each 1-10.\n\n${drafts
    .map((draft) => `## Plan (${draft.angle})\n${draft.plan}`)
    .join('\n\n')}`,
  {
    label: `judge panel (${JUDGE_MODEL})`,
    model: JUDGE_MODEL,
    schema: {
      type: 'object',
      required: ['scores', 'winner'],
      properties: {
        scores: {
          type: 'array',
          items: {
            type: 'object',
            required: ['angle', 'score', 'strengths', 'weaknesses'],
            properties: {
              angle: { type: 'string' },
              score: { type: 'number' },
              strengths: { type: 'string' },
              weaknesses: { type: 'string' },
            },
          },
        },
        winner: { type: 'string' },
      },
    },
  },
);

if (!verdict) {
  console.error('Judging failed; printing raw drafts.');
  for (const draft of drafts) console.log(`\n## ${draft.angle}\n${draft.plan}`);
  process.exit(1);
}

for (const score of verdict.scores) {
  const model = drafts.find((draft) => draft.angle === score.angle)?.model ?? '?';
  console.log(`  ${score.angle} (${model}): ${score.score}/10 — ${score.strengths}`);
}

phase('Synthesize');
const winning = drafts.find((draft) => draft.angle === verdict.winner) ?? drafts[0]!;
const others = drafts.filter((draft) => draft !== winning);

const finalPlan = await agent(
  `Produce the final implementation plan for: "${task}".\n\nStart from the winning plan below. Fold in any runner-up ideas the judge called out as strengths, and address the winner's weaknesses (${verdict.scores.find((s) => s.angle === winning.angle)?.weaknesses ?? 'none noted'}).\n\n## Winning plan (${winning.angle})\n${winning.plan}\n\n${others.map((draft) => `## Runner-up (${draft.angle})\n${draft.plan}`).join('\n\n')}`,
  { label: 'synthesize', model: JUDGE_MODEL, ...context },
);

console.log(`\n${finalPlan ?? winning.plan}`);
await printSummary();
