/**
 * Focus Group Types
 * 
 * This demo simulates a political focus group where:
 * - A candidate presents positions to voters
 * - Voters (with distinct personas) respond with their reactions
 * - An analyst observes and provides insights
 */

// Voter persona definition - describes who the voter is
export interface VoterPersona {
  name: string;
  age: number;
  location: string;
  party: 'Democrat' | 'Republican' | 'Independent';
  leaningStrength: 'strong' | 'moderate' | 'weak';
  topIssues: string[];      // What they care about most
  background: string;       // Brief description
}

// State persisted to disk
export interface FocusGroupState {
  candidateAgentId: string | null;
  voterAgentIds: Record<string, string>;  // persona name -> agent ID
  analystAgentId: string | null;
  sessionCount: number;
}

// A single exchange in the focus group
export interface FocusGroupRound {
  position: string;           // What the candidate presented
  voterResponses: {
    voterName: string;
    reaction: string;
  }[];
  followUpQuestion?: string;  // Candidate's follow-up
  followUpResponses?: {
    voterName: string;
    reaction: string;
  }[];
  analysis?: string;          // Analyst's summary
}

// Configuration
export const CONFIG = {
  model: 'haiku',  // Fast and cheap for demos
};
