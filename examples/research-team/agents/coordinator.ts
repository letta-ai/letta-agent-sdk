/**
 * Coordinator Agent
 * 
 * Orchestrates the research workflow, manages quality control,
 * and tracks team performance over time.
 */

import { type LettaCodeSession } from '../../../src/index.js';
import { createAgentSession, createExampleClient, formatAgentLink, resumeExampleSession } from '../../create-agent-session.js';
import type { Depth, ResearchTask, UserFeedback } from '../types.js';
import { DEPTH_CONFIGS, generateTaskId, formatDuration } from '../types.js';
import { loadTeamState, saveTeamState, ARTIFACTS, readOutput, getOutputPath, outputExists } from '../tools/file-store.js';
import { createResearcher, runResearchTask, reflectOnTask as researcherReflect } from './researcher.js';
import { createAnalyst, runAnalysis, reflectOnTask as analystReflect } from './analyst.js';
import { createWriter, writeReport, reflectOnTask as writerReflect } from './writer.js';

const client = createExampleClient({ backend: 'local' });

const COORDINATOR_SYSTEM_PROMPT = `You are the Research Team Coordinator.

## Your Role
You orchestrate a research team of specialists:
- **Researcher**: Finds and evaluates academic sources
- **Analyst**: Synthesizes findings and identifies patterns
- **Writer**: Produces the final research report

You manage workflow, ensure quality, and learn from each task to improve team performance.

## Your Responsibilities
1. Receive research queries from users
2. Plan the research approach based on depth
3. Delegate tasks to team members
4. Review intermediate outputs for quality
5. Request iterations if quality is insufficient
6. Collect and distribute user feedback
7. Track team performance metrics

## Quality Thresholds
- Quick: Accept reasonable coverage of the topic
- Standard: Require thorough coverage with good synthesis
- Comprehensive: Require extensive coverage, deep analysis, polished writing

## Memory Usage
Use focused memory files:
- **reference/team-performance.md**: Track metrics, success patterns, agent strengths
- **reference/user-preferences.md**: Store feedback, preferred styles, past requests
- **reference/research-history.md**: Brief summaries of completed research tasks

Use these to improve coordination over time.`;

/**
 * Create or resume the coordinator agent
 */
export async function createCoordinator(
  existingAgentId?: string | null
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
    systemPrompt: COORDINATOR_SYSTEM_PROMPT,
    allowedTools: ['Glob', 'Read', 'Write'],
    permissionMode: 'unrestricted',
  }, client);
}

/**
 * Run a complete research workflow
 */
export async function runResearchWorkflow(
  query: string,
  depth: Depth,
  onProgress?: (phase: string, message: string) => void
): Promise<{
  success: boolean;
  taskId: string;
  reportPath: string;
  durationMs: number;
}> {
  const startTime = Date.now();
  const taskId = generateTaskId();
  const config = DEPTH_CONFIGS[depth];
  
  const log = (phase: string, message: string) => {
    onProgress?.(phase, message);
    console.log(`[${phase}] ${message}`);
  };
  
  // Load team state
  const teamState = await loadTeamState();
  
  log('Init', `Starting research task: ${taskId}`);
  log('Init', `Query: "${query}"`);
  log('Init', `Depth: ${depth} (est. ${config.estimatedMinutes} min)`);
  
  // Phase 1: Research
  log('Research', 'Initializing researcher agent...');
  const isNewResearcher = !teamState.agentIds.researcher;
  const researcher = await createResearcher(teamState.agentIds.researcher, depth);
  
  log('Research', `Searching for ${config.sourcesCount} sources...`);
  const researchResult = await runResearchTask(researcher, taskId, query, depth);
  
  // Save agent ID after first message exchange (when it becomes available)
  if (isNewResearcher && researcher.agentId) {
    teamState.agentIds.researcher = researcher.agentId;
    await saveTeamState(teamState);
    log('Research', `Created researcher agent: ${researcher.agentId}`);
  } else if (researcher.agentId) {
    log('Research', `Resumed researcher agent: ${researcher.agentId}`);
  }
  log('Research', `  → ${formatAgentLink(researcher.agentId, client)}`);
  
  if (!researchResult.success) {
    researcher.close();
    return { success: false, taskId, reportPath: '', durationMs: Date.now() - startTime };
  }
  
  log('Research', `Found ${researchResult.sourcesFound} sources`);
  log('Research', `Findings written to: ${researchResult.findingsPath}`);
  researcher.close();
  
  // Phase 2: Analysis
  log('Analysis', 'Initializing analyst agent...');
  const isNewAnalyst = !teamState.agentIds.analyst;
  const analyst = await createAnalyst(teamState.agentIds.analyst, depth);
  
  log('Analysis', 'Synthesizing findings...');
  const analysisResult = await runAnalysis(analyst, taskId, query, depth);
  
  // Save agent ID after first message exchange
  if (isNewAnalyst && analyst.agentId) {
    teamState.agentIds.analyst = analyst.agentId;
    await saveTeamState(teamState);
    log('Analysis', `Created analyst agent: ${analyst.agentId}`);
  } else if (analyst.agentId) {
    log('Analysis', `Resumed analyst agent: ${analyst.agentId}`);
  }
  log('Analysis', `  → ${formatAgentLink(analyst.agentId, client)}`);
  
  if (!analysisResult.success) {
    analyst.close();
    return { success: false, taskId, reportPath: '', durationMs: Date.now() - startTime };
  }
  
  log('Analysis', `Analysis written to: ${analysisResult.analysisPath}`);
  analyst.close();
  
  // Phase 3: Writing
  log('Writing', 'Initializing writer agent...');
  const isNewWriter = !teamState.agentIds.writer;
  const writer = await createWriter(teamState.agentIds.writer, depth);
  
  log('Writing', 'Writing final report...');
  const writeResult = await writeReport(writer, taskId, query, depth);
  
  // Save agent ID after first message exchange
  if (isNewWriter && writer.agentId) {
    teamState.agentIds.writer = writer.agentId;
    await saveTeamState(teamState);
    log('Writing', `Created writer agent: ${writer.agentId}`);
  } else if (writer.agentId) {
    log('Writing', `Resumed writer agent: ${writer.agentId}`);
  }
  log('Writing', `  → ${formatAgentLink(writer.agentId, client)}`);
  
  if (!writeResult.success) {
    writer.close();
    return { success: false, taskId, reportPath: '', durationMs: Date.now() - startTime };
  }
  
  log('Writing', `Report written to: ${writeResult.reportPath}`);
  writer.close();
  
  // Update team state
  teamState.completedTasks++;
  await saveTeamState(teamState);
  
  const durationMs = Date.now() - startTime;
  log('Complete', `Research complete in ${formatDuration(durationMs)}`);
  
  return {
    success: true,
    taskId,
    reportPath: writeResult.reportPath,
    durationMs,
  };
}

/**
 * Process user feedback and trigger reflections
 */
export async function processFeedback(
  taskId: string,
  feedback: UserFeedback
): Promise<void> {
  const teamState = await loadTeamState();
  
  console.log('\n[Feedback] Processing feedback and triggering reflections...\n');
  
  // Trigger reflections from each agent
  if (teamState.agentIds.researcher) {
    console.log('[Feedback] Researcher reflecting...');
    const researcher = await createResearcher(teamState.agentIds.researcher);
    const reflection = await researcherReflect(researcher, taskId, feedback);
    console.log(`[Researcher] ${reflection.slice(0, 200)}...`);
    researcher.close();
  }
  
  if (teamState.agentIds.analyst) {
    console.log('[Feedback] Analyst reflecting...');
    const analyst = await createAnalyst(teamState.agentIds.analyst);
    const reflection = await analystReflect(analyst, taskId, feedback);
    console.log(`[Analyst] ${reflection.slice(0, 200)}...`);
    analyst.close();
  }
  
  if (teamState.agentIds.writer) {
    console.log('[Feedback] Writer reflecting...');
    const writer = await createWriter(teamState.agentIds.writer);
    const reflection = await writerReflect(writer, taskId, feedback);
    console.log(`[Writer] ${reflection.slice(0, 200)}...`);
    writer.close();
  }
  
  console.log('\n[Feedback] All agents have reflected on the feedback.');
}

/**
 * Get team status
 */
export async function getTeamStatus(): Promise<{
  initialized: boolean;
  agentIds: Record<string, string | null>;
  completedTasks: number;
}> {
  const state = await loadTeamState();
  const initialized = Object.values(state.agentIds).some(id => id !== null);
  
  return {
    initialized,
    agentIds: state.agentIds,
    completedTasks: state.completedTasks,
  };
}

/**
 * Reset team (delete all agent IDs and start fresh)
 */
export async function resetTeam(): Promise<void> {
  await saveTeamState({
    agentIds: {
      coordinator: null,
      researcher: null,
      analyst: null,
      writer: null,
    },
    sharedBlockIds: {
      sources: null,
      terminology: null,
      pitfalls: null,
    },
    completedTasks: 0,
  });
  console.log('[Reset] Team state cleared. New agents will be created on next run.');
}
