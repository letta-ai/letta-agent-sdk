import type {
  LettaCodeSession,
  SDKInitMessage,
  SDKResultMessage,
  SendMessage,
} from "../types.js";

export type AdvancedSession = LettaCodeSession & {
  initialize(): Promise<SDKInitMessage>;
  sendAndWaitForResult(message: SendMessage): Promise<SDKResultMessage>;
  updateToolset(toolsetPreference: string): Promise<void>;
};

export function asAdvanced(session: LettaCodeSession): AdvancedSession {
  return session as AdvancedSession;
}
