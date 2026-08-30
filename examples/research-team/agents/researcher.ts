/**
 * Researcher Agent
 * 
 * Finds and evaluates academic sources for research tasks.
 * Learns which sources are reliable and effective search strategies.
 */

import { type LettaCodeSession } from '../../../src/index.js';
import { createAgentSession, createExampleClient, resumeExampleSession } from '../../create-agent-session.js';
import type { Depth } from '../types.js';
import { DEPTH_CONFIGS } from '../types.js';
import { ARTIFACTS } from '../tools/file-store.js';

const client = createExampleClient({ backend: 'local' });

// web_search is a server-side base tool. It does not belong in allowedTools,
// which controls the client-side tools for this SDK session.

const RESEARCHER_SYSTEM_PROMPT = `You are a Research Specialist on an academic research team.

## Your Role
You find and evaluate academic sources (papers, articles, documentation) relevant to research queries. A TypeScript workflow gives you a task, then an Analyst synthesizes your findings.

## Your Tools
- **web_search**: Your primary tool for finding sources. Use it to search for papers, articles, and documentation.
- **Write**: Save your findings to markdown files for the team.

## Your Process
1. Receive a research query from the workflow
2. Use web_search to find relevant academic sources (try multiple search queries)
3. Evaluate each source for relevance and quality
4. Write your findings to a markdown file
5. Report completion in your response

## Search Tips
- Try different query variations (e.g., "topic overview", "topic research paper", "topic survey")
- Look for academic sources (.edu, arxiv.org, scholar articles, journal papers)
- Prefer recent sources but include foundational/seminal works

## Quality Criteria for Sources
- **Relevance**: How directly does it address the query? (1-10)
- **Quality**: Publication venue reputation, author credentials, recency (1-10)
- **Authority**: Academic institutions, peer-reviewed venues, known experts

## Memory Usage
Use focused memory files that persist across sessions:
- **reference/source-quality.md**: Track reliability scores for sources, venues, and authors you encounter
- **reference/search-strategies.md**: Record effective search patterns and query approaches
- **reference/domain-knowledge.md**: Build knowledge of key concepts and influential works

When you find a particularly good or bad source, update reference/source-quality.md.
When a search strategy works well, record it in reference/search-strategies.md.

## Output Format
Write findings to a markdown file with:
- Source title, authors (if available), URL
- Relevance score (1-10) with justification
- Quality score (1-10) with justification  
- Key findings summary

Be thorough but concise. The Analyst depends on your evaluations.`;

/**
 * Create or resume the researcher agent
 */
export async function createResearcher(
  existingAgentId?: string | null,
  depth: Depth = 'standard'
): Promise<LettaCodeSession> {
  const config = DEPTH_CONFIGS[depth];
  
  if (existingAgentId) {
    return resumeExampleSession(existingAgentId, {
      model: 'haiku',
      allowedTools: ['Glob', 'Read', 'Write'],
      permissionMode: 'unrestricted',
    }, client);
  }
  
  return createAgentSession({
    model: 'haiku',
    instructions: RESEARCHER_SYSTEM_PROMPT,
    allowedTools: ['Glob', 'Read', 'Write'],
    permissionMode: 'unrestricted',
  }, client);
}

/**
 * Run a research task
 */
export async function runResearchTask(
  session: LettaCodeSession,
  taskId: string,
  query: string,
  depth: Depth
): Promise<{ success: boolean; findingsPath: string; sourcesFound: number }> {
  const config = DEPTH_CONFIGS[depth];
  
  // Build search guidance based on depth
  const searchGuidance = {
    quick: 'Do 1-2 focused searches. Prioritize recent, high-quality sources.',
    standard: 'Do 2-3 searches with different angles. Mix recent and foundational sources.',
    comprehensive: 'Do 3-4 searches covering different aspects. Include seminal papers and recent developments.',
  };
  
  // Ask the researcher to search and evaluate sources
  const prompt = `## Research Task

**Query**: ${query}
**Depth**: ${depth}
**Target Sources**: ${config.sourcesCount}

Use the **web_search** tool to find academic papers, articles, and authoritative sources on this topic.

**Search Strategy**: ${searchGuidance[depth]}

**Instructions**:
1. Use web_search to find relevant sources (try searches like "${query}", "${query} research", "${query} review paper")
2. Evaluate each source for relevance and quality
3. Write your findings to: \`examples/research-team/output/${ARTIFACTS.findings(taskId)}\`

**For each source, include**:
- Title, authors, publication venue/year (if available)
- URL
- Relevance score (1-10) with justification
- Quality score (1-10) based on source reputation
- Key findings or insights relevant to the query

**After writing findings**, update your memory:
- Note reliable sources/domains you discovered
- Record effective search strategies for this topic

Find at least ${config.sourcesCount} high-quality sources, then confirm completion.`;
  
  // Note: sourcesFound is now estimated since the agent does the searching
  const estimatedSources = config.sourcesCount;

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
    findingsPath: ARTIFACTS.findings(taskId),
    sourcesFound: estimatedSources,
  };
}

/**
 * Ask researcher to reflect on task performance
 */
export async function reflectOnTask(
  session: LettaCodeSession,
  taskId: string,
  feedback?: { rating: number; comment?: string }
): Promise<string> {
  let prompt = `## Post-Task Reflection

The research task "${taskId}" is complete.`;

  if (feedback) {
    prompt += `

User feedback:
- Rating: ${feedback.rating}/5 stars
- Comment: ${feedback.comment || 'None provided'}`;
  }

  prompt += `

Please reflect on this task:
1. What search strategies worked well?
2. What could you have done better?
3. Any sources or patterns worth remembering?

Update your memory files with any insights, then summarize your reflection.`;

  await session.send(prompt);
  
  let reflection = '';
  for await (const msg of session.stream()) {
    if (msg.type === 'assistant') {
      reflection += msg.content;
    }
  }
  
  return reflection;
}
