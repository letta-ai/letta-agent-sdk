import { LettaAgentClientBase } from "./client-base.js";
import type {
  LettaCodeCloudClientOptions,
  LettaCodeRemoteClientOptions,
} from "./types.js";

export type PortableLettaAgentClientOptions =
  | LettaCodeRemoteClientOptions
  | LettaCodeCloudClientOptions;

/**
 * Portable Letta Agent SDK client for browsers and React Native.
 *
 * This entry point intentionally excludes local process execution. Use the
 * package root from Node.js when `backend: "local"` is required.
 */
export class LettaAgentClient extends LettaAgentClientBase {
  constructor(options: PortableLettaAgentClientOptions) {
    super(options);
    if (this.backend === "local") {
      throw this.localBackendUnavailableError();
    }
  }
}

export { CloudManagedSandboxExpiredError } from "./cloud-session.js";
export { ConversationForkHydrationError } from "./management-errors.js";
export { RepositoriesClient } from "./repositories.js";
export type * from "./sandbox-files.js";
export type {
  Computer,
  ComputerMetadata,
  ComputerSelector,
  ComputersClient,
  ListComputersOptions,
  ListComputersResult,
  ResolvedComputer,
} from "./computers.js";
export type * from "./management-types.js";
export { extractStreamTextDelta } from "./stream-events.js";
export { createTranscriptAccumulator } from "./transcript-accumulator.js";
export type {
  TranscriptAccumulator,
  TranscriptHistoryPage,
  TranscriptRebaseOptions,
  TranscriptRow,
  TranscriptRowIdentity,
  TranscriptRowKind,
  TranscriptTextKind,
  TranscriptTextRow,
  TranscriptToolCallRow,
  TranscriptToolCallStatus,
  TranscriptToolResult,
} from "./transcript-accumulator.js";
export { createReactNativeWebSocketConstructor } from "./websocket.js";
export type * from "./types.js";
export type * from "./query-types.js";
