import type {
  BootstrapStateOptions,
  BootstrapStateResult,
  LettaCodeSession,
  RecoverPendingApprovalsOptions,
  RecoverPendingApprovalsResult,
  SDKInitMessage,
  SDKResultMessage,
  SendMessage,
} from "../types.js";

export type AdvancedSession = LettaCodeSession & {
  initialize(): Promise<SDKInitMessage>;
  runTurn(message: SendMessage): Promise<SDKResultMessage>;
  recoverPendingApprovals(
    options?: RecoverPendingApprovalsOptions,
  ): Promise<RecoverPendingApprovalsResult>;
  updateToolset(toolsetPreference: string): Promise<void>;
  bootstrapState(options?: BootstrapStateOptions): Promise<BootstrapStateResult>;
};

export function asAdvanced(session: LettaCodeSession): AdvancedSession {
  return session as AdvancedSession;
}
