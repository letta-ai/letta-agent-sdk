/**
 * Analyst Agent
 * 
 * Synthesizes research findings, identifies patterns, and produces analysis.
 * Learns effective analytical frameworks and quality standards.
 */

import { type LettaCodeSession } from '../../../src/index.js';
import { createAgentSession, createExampleClient, resumeExampleSession } from '../../create-agent-session.js';
import type { Depth } from '../types.js';
import { DEPTH_CONFIGS } from '../types.js';
import { ARTIFACTS, getOutputPath } from '../tools/file-store.js';

const client = createExampleClient({ backend: 'local' });

const ANALYST_SYSTEM_PROMPT = `You are a Research Analyst on an academic research team.

## Your Role
You synthesize findings from the Researcher, identify patterns and themes, and produce analytical insights. Your analysis feeds into the final research report produced by the Writer.

## Your Process
1. Receive findings from the Researcher via a shared file
2. Read and understand all sources and their evaluations
3. Identify key themes, patterns, and connections
4. Note gaps, contradictions, and limitations
5. Produce a structured analysis document
6. Report completion in your response

## Analysis Framework
For each analysis, address:
1. **Synthesis**: What are the main findings across sources?
2. **Themes**: What 3-5 major themes emerge?
3. **Patterns**: How do findings relate? What patterns exist?
4. **Gaps**: What questions remain unanswered?
5. **Implications**: What are the key takeaways?

## Quality Standards
- Cite specific sources for claims
- Distinguish between consensus views and contested claims
- Note the strength of evidence for each finding
- Be intellectually honest about limitations

## Memory Usage
Use focused memory files that persist:
- **reference/analysis-patterns.md**: Effective frameworks and synthesis techniques
- **reference/quality-standards.md**: What makes good analysis, common pitfalls
- **reference/citation-practices.md**: How to properly cite and attribute

Update these when you discover effective approaches or learn from mistakes.`;

/**
 * Create or resume the analyst agent
 */
export async function createAnalyst(
  existingAgentId?: string | null,
  depth: Depth = 'standard'
): Promise<LettaCodeSession> {
  if (existingAgentId) {
    return resumeExampleSession(existingAgentId, {
      model: 'haiku',
      allowedTools: ['Glob', 'Read', 'Write'],
      permissionMode: 'unrestricted',
    }, client);
  }
  
  return createAgentSession({
    model: 'haiku',
    systemPrompt: ANALYST_SYSTEM_PROMPT,
    allowedTools: ['Glob', 'Read', 'Write'],
    permissionMode: 'unrestricted',
  }, client);
}

/**
 * Run analysis on research findings
 */
export async function runAnalysis(
  session: LettaCodeSession,
  taskId: string,
  query: string,
  depth: Depth
): Promise<{ success: boolean; analysisPath: string }> {
  const config = DEPTH_CONFIGS[depth];
  const findingsPath = getOutputPath(ARTIFACTS.findings(taskId));
  const analysisPath = ARTIFACTS.analysis(taskId);
  
  const depthGuidance = {
    quick: 'Provide a brief analysis focusing on the top 2-3 key findings.',
    standard: 'Provide a thorough analysis covering all major themes and their connections.',
    comprehensive: 'Provide an extensive analysis with detailed examination of all themes, patterns, sub-themes, and implications.',
  };
  
  const prompt = `## Analysis Task

**Original Query**: ${query}
**Analysis Depth**: ${depth}
**Findings File**: \`${findingsPath}\`

Please:
1. Read the findings file from the Researcher
2. Identify key themes and patterns across sources
3. Synthesize the main findings
4. Note any gaps or limitations
5. Write your analysis to: \`examples/research-team/output/${analysisPath}\`

**Depth Guidance**: ${depthGuidance[depth]}

Your analysis should include:
- Summary of key findings
- ${depth === 'quick' ? '2-3' : depth === 'standard' ? '3-5' : '5-7'} major themes with supporting evidence
- Patterns and connections between findings
- Gaps and limitations
- Key implications/takeaways

Cite specific sources using (Author, Year) format.

Confirm when complete.`;

  await session.send(prompt);
  
  let success = false;
  let response = '';
  
  for await (const msg of session.stream()) {
    if (msg.type === 'assistant') {
      response += msg.content;
      process.stdout.write('.'); // Progress indicator
    }
    if (msg.type === 'result') {
      success = msg.success;
      console.log(''); // Newline after progress dots
    }
  }
  
  return {
    success,
    analysisPath,
  };
}

/**
 * Ask analyst to reflect on task performance
 */
export async function reflectOnTask(
  session: LettaCodeSession,
  taskId: string,
  feedback?: { rating: number; comment?: string }
): Promise<string> {
  let prompt = `## Post-Task Reflection

The analysis task "${taskId}" is complete.`;

  if (feedback) {
    prompt += `

User feedback:
- Rating: ${feedback.rating}/5 stars
- Comment: ${feedback.comment || 'None provided'}`;
  }

  prompt += `

Please reflect:
1. What analytical approaches worked well?
2. What could improve your synthesis?
3. Any frameworks or patterns worth remembering?

Update your memory with insights, then summarize your reflection.`;

  await session.send(prompt);
  
  let reflection = '';
  for await (const msg of session.stream()) {
    if (msg.type === 'assistant') {
      reflection += msg.content;
    }
  }
  
  return reflection;
}
