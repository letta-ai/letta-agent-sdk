/**
 * Writer Agent
 * 
 * Produces final research reports from analysis.
 * Learns writing style preferences and effective report structures.
 */

import { type LettaCodeSession } from '../../../src/index.js';
import { createAgentSession, createExampleClient, resumeExampleSession } from '../../create-agent-session.js';
import type { Depth } from '../types.js';
import { DEPTH_CONFIGS } from '../types.js';
import { ARTIFACTS, getOutputPath } from '../tools/file-store.js';

const client = createExampleClient({ backend: 'local' });

const WRITER_SYSTEM_PROMPT = `You are a Research Writer on an academic research team.

## Your Role
You produce the final research report from the Analyst's synthesis. Your reports should be clear, well-structured, and accessible while maintaining academic rigor.

## Your Process
1. Receive the analysis document from the Analyst
2. Structure the report according to depth requirements
3. Write clear, engaging prose
4. Ensure proper citations and attribution
5. Add executive summary and conclusions
6. Write the final report to a markdown file

## Writing Principles
- **Clarity**: Use clear, precise language
- **Structure**: Logical flow with clear sections
- **Evidence**: Support claims with citations
- **Accessibility**: Define technical terms
- **Honesty**: Acknowledge limitations

## Report Structure by Depth

### Quick (3-5 sections)
- Summary
- Key Findings
- Sources

### Standard (5-6 sections)  
- Summary
- Background
- Key Findings
- Analysis
- Conclusions
- Sources

### Comprehensive (7-8 sections)
- Executive Summary
- Background
- Methodology
- Findings
- Analysis
- Implications
- Future Directions
- Sources

## Memory Usage
Your memory blocks:
- **writing-style**: Tone and structure preferences learned from feedback
- **output-templates**: Successful report structures
- **improvement-log**: User feedback and areas to improve

Update these based on user feedback to improve over time.`;

/**
 * Create or resume the writer agent
 */
export async function createWriter(
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
    systemPrompt: WRITER_SYSTEM_PROMPT,
    memory: [
      {
        label: 'writing-style',
        value: `# Writing Style Guide

## Tone
- Professional but accessible
- Confident but not overreaching
- Engaging but not sensational

## Preferences
- Use active voice when possible
- Keep paragraphs focused (3-5 sentences)
- Include transition sentences between sections

## User Preferences
[Updated based on feedback]
`,
        description: 'Tone, structure preferences learned from user feedback',
      },
      {
        label: 'output-templates',
        value: `# Report Templates

## Quick Report Template
\`\`\`
# [Title]
## Summary
## Key Findings
## Sources
\`\`\`

## Standard Report Template
\`\`\`
# [Title]
## Summary
## Background
## Key Findings
## Analysis
## Conclusions
## Sources
\`\`\`

## Comprehensive Report Template
\`\`\`
# [Title]
## Executive Summary
## Background
## Methodology
## Findings
## Analysis
## Implications
## Future Directions
## Sources
\`\`\`

## Effective Structures
[Add successful patterns here]
`,
        description: 'Successful report structures and templates',
      },
      {
        label: 'improvement-log',
        value: `# Improvement Log

## User Feedback History
[Track feedback to improve]

## Areas to Improve
[Note recurring issues]

## Successes
[Note what works well]
`,
        description: 'User feedback and improvement areas',
      },
    ],
    allowedTools: ['Glob', 'Read', 'Write'],
    permissionMode: 'unrestricted',
  }, client);
}

/**
 * Write the final research report
 */
export async function writeReport(
  session: LettaCodeSession,
  taskId: string,
  query: string,
  depth: Depth
): Promise<{ success: boolean; reportPath: string }> {
  const config = DEPTH_CONFIGS[depth];
  const analysisPath = getOutputPath(ARTIFACTS.analysis(taskId));
  const reportPath = ARTIFACTS.report(taskId);
  
  const sectionsGuidance = config.reportSections.map(s => 
    s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  ).join(', ');
  
  const prompt = `## Writing Task

**Research Query**: ${query}
**Report Depth**: ${depth}
**Analysis File**: \`${analysisPath}\`
**Output File**: \`examples/research-team/output/${reportPath}\`

Please:
1. Read the analysis document
2. Write a polished research report

**Required Sections**: ${sectionsGuidance}

**Guidelines**:
- Start with a compelling title
- Write an engaging summary that captures the essence
- Use clear section headers
- Include inline citations (Author, Year)
- End with a complete sources list
- Aim for ${depth === 'quick' ? '500-800' : depth === 'standard' ? '1000-1500' : '2000-3000'} words

Check your writing-style memory for any user preferences to follow.

Write the complete report to the output file, then confirm completion.`;

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
    reportPath,
  };
}

/**
 * Ask writer to reflect on task and incorporate feedback
 */
export async function reflectOnTask(
  session: LettaCodeSession,
  taskId: string,
  feedback?: { rating: number; comment?: string }
): Promise<string> {
  let prompt = `## Post-Task Reflection

The writing task "${taskId}" is complete.`;

  if (feedback) {
    prompt += `

User feedback:
- Rating: ${feedback.rating}/5 stars
- Comment: ${feedback.comment || 'None provided'}

This feedback is valuable! Please:
1. Update your improvement-log memory with this feedback
2. If the rating was low, note what to improve
3. If positive feedback mentioned something specific, note that in writing-style`;
  }

  prompt += `

Reflect on:
1. What worked well in this report?
2. What could be improved?
3. Any structural patterns worth remembering?

Update your memory blocks, then summarize your reflection.`;

  await session.send(prompt);
  
  let reflection = '';
  for await (const msg of session.stream()) {
    if (msg.type === 'assistant') {
      reflection += msg.content;
    }
  }
  
  return reflection;
}
