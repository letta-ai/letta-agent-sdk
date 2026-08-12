import type { LettaCodeSession, SDKInitMessage } from "../types.js";

export type AdvancedSession = LettaCodeSession & {
  initialize(): Promise<SDKInitMessage>;
  updateToolset(toolsetPreference: string): Promise<void>;
};

export function asAdvanced(session: LettaCodeSession): AdvancedSession {
  return session as AdvancedSession;
}
