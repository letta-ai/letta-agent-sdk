/**
 * File Store Helper
 * 
 * Utilities for reading/writing shared files between agents.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Output directory for research artifacts
const OUTPUT_DIR = join(__dirname, '..', 'output');

/**
 * Ensure output directory exists
 */
async function ensureOutputDir(): Promise<void> {
  if (!existsSync(OUTPUT_DIR)) {
    await mkdir(OUTPUT_DIR, { recursive: true });
  }
}

/**
 * Read content from a file in the output directory
 */
export async function readOutput(filename: string): Promise<string> {
  const filepath = join(OUTPUT_DIR, filename);
  return await readFile(filepath, 'utf-8');
}

/**
 * Check if a file exists in the output directory
 */
export function outputExists(filename: string): boolean {
  return existsSync(join(OUTPUT_DIR, filename));
}

/**
 * Get the full path for an output file
 */
export function getOutputPath(filename: string): string {
  return join(OUTPUT_DIR, filename);
}

/**
 * Standard filenames for workflow artifacts
 */
export const ARTIFACTS = {
  findings: (taskId: string) => `${taskId}-findings.md`,
  analysis: (taskId: string) => `${taskId}-analysis.md`,
  report: (taskId: string) => `${taskId}-report.md`,
  teamState: 'team-state.json',
};

/**
 * Load team state from disk (or return default)
 */
export async function loadTeamState(): Promise<{
  agentIds: Record<'researcher' | 'analyst' | 'writer', string | null>;
  completedTasks: number;
}> {
  const filepath = join(OUTPUT_DIR, ARTIFACTS.teamState);
  let stored: Record<string, unknown> = {};

  if (existsSync(filepath)) {
    const content = await readFile(filepath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (parsed !== null && typeof parsed === 'object') {
      stored = parsed as Record<string, unknown>;
    }
  }

  const storedAgentIds = stored.agentIds !== null && typeof stored.agentIds === 'object'
    ? stored.agentIds as Record<string, unknown>
    : {};

  return {
    agentIds: {
      researcher: typeof storedAgentIds.researcher === 'string' ? storedAgentIds.researcher : null,
      analyst: typeof storedAgentIds.analyst === 'string' ? storedAgentIds.analyst : null,
      writer: typeof storedAgentIds.writer === 'string' ? storedAgentIds.writer : null,
    },
    completedTasks: typeof stored.completedTasks === 'number' ? stored.completedTasks : 0,
  };
}

/**
 * Save team state to disk
 */
export async function saveTeamState(state: {
  agentIds: Record<'researcher' | 'analyst' | 'writer', string | null>;
  completedTasks: number;
}): Promise<void> {
  await ensureOutputDir();
  const filepath = join(OUTPUT_DIR, ARTIFACTS.teamState);
  await writeFile(filepath, JSON.stringify(state, null, 2), 'utf-8');
}
