/**
 * Research Team Types
 * 
 * Shared type definitions for the multi-agent research system.
 */

// ═══════════════════════════════════════════════════════════════
// CORE TYPES
// ═══════════════════════════════════════════════════════════════

export type Depth = 'quick' | 'standard' | 'comprehensive';

// ═══════════════════════════════════════════════════════════════
// DEPTH CONFIGURATION
// ═══════════════════════════════════════════════════════════════

export interface DepthConfig {
  sourcesCount: number;
  reportSections: string[];
  estimatedMinutes: number;
}

export const DEPTH_CONFIGS: Record<Depth, DepthConfig> = {
  quick: {
    sourcesCount: 3,
    reportSections: ['summary', 'key_findings', 'sources'],
    estimatedMinutes: 5,
  },
  standard: {
    sourcesCount: 6,
    reportSections: ['summary', 'background', 'key_findings', 'analysis', 'sources'],
    estimatedMinutes: 15,
  },
  comprehensive: {
    sourcesCount: 10,
    reportSections: ['executive_summary', 'background', 'methodology', 'findings', 'analysis', 'implications', 'future_directions', 'sources'],
    estimatedMinutes: 30,
  },
};

// ═══════════════════════════════════════════════════════════════
// FEEDBACK TYPES
// ═══════════════════════════════════════════════════════════════

export interface UserFeedback {
  taskId: string;
  rating: number; // 1-5 stars
  comment?: string;
  timestamp: Date;
}

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

export function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}
