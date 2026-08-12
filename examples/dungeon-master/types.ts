/**
 * Dungeon Master Types
 */

export interface GameState {
  dmAgentId: string | null;
  activeCampaign: string | null;
  campaigns: string[];
}

export interface DMConfig {
  model: string;
}

export const DEFAULT_CONFIG: DMConfig = {
  model: 'haiku',
};

export const PATHS = {
  stateFile: 'state.json',
  rulebook: 'rulebook.md',
  campaignsDir: 'campaigns',
} as const;

export const CAMPAIGN_FILES = {
  world: 'world.md',
  player: 'player.md',
  npcs: 'npcs.md',
  quests: 'quests.md',
  sessionLog: 'session-log.md',
  consequences: 'consequences.md',
} as const;
