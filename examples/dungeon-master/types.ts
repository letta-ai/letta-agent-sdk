/** State that the CLI needs to resume the same agent and campaign. */
export interface GameState {
  dmAgentId: string | null;
  activeCampaign: string | null;
  pendingCampaign: string | null;
}

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
