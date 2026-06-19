import { Session } from "./session.js";
import type {
  CreateAgentOptions,
  CreateSessionOptions,
  LettaCodeBackend,
  LettaCodeClientOptions,
  LettaCodeClientSessionOptions,
  LettaCodeEnvironment,
  SDKResultMessage,
  SendMessage,
} from "./types.js";
import {
  validateCreateAgentOptions,
  validateCreateSessionOptions,
} from "./validation.js";

const VALID_BACKENDS = new Set<LettaCodeBackend>([
  "local",
  "remote",
  "cloud",
]);

function isLettaCodeBackend(value: string): value is LettaCodeBackend {
  return VALID_BACKENDS.has(value as LettaCodeBackend);
}

function getOptionsEnvironment(
  options: LettaCodeClientOptions,
): LettaCodeEnvironment | undefined {
  if ("environment" in options) {
    return options.environment;
  }
  return undefined;
}

function stripEnvironment(
  options: LettaCodeClientSessionOptions,
): CreateSessionOptions {
  const sessionOptions = { ...options };
  delete sessionOptions.environment;
  return sessionOptions;
}

function hasCreateAgentEnvironment(options: CreateAgentOptions): boolean {
  return "environment" in (options as Record<string, unknown>);
}

/**
 * Top-level Letta Code SDK client.
 *
 * `backend` selects how the SDK reaches or runs the Letta Code harness.
 * The only implemented backend today is `local`, which spawns the bundled
 * Letta Code CLI subprocess and speaks the existing stdio JSON protocol.
 * `remote` and `cloud` are typed placeholders for the upcoming app-server /
 * constellation-backed transports.
 */
export class LettaCodeClient {
  readonly backend: LettaCodeBackend;
  readonly environment: LettaCodeEnvironment | undefined;

  constructor(options: LettaCodeClientOptions = {}) {
    const backend = options.backend ?? "local";
    if (!isLettaCodeBackend(backend)) {
      throw new Error(
        `Invalid Letta Code backend '${String(backend)}'. Valid values: local, remote, cloud.`,
      );
    }

    this.backend = backend;
    this.environment = getOptionsEnvironment(options);

    if (this.backend === "local" && this.environment !== undefined) {
      throw new Error(
        "LettaCodeClient environment is only valid for remote/cloud backends.",
      );
    }
  }

  /**
   * Create a new Letta Code agent with a default conversation.
   *
   * Environment/device selection is intentionally not part of the agent payload;
   * it belongs to the client/session execution context.
   */
  async createAgent(options: CreateAgentOptions = {}): Promise<string> {
    this.assertLocalBackend("createAgent");
    if (hasCreateAgentEnvironment(options)) {
      throw new Error(
        "createAgent() does not accept environment. Set a client default or pass environment to resumeSession()/createSession().",
      );
    }

    validateCreateAgentOptions(options);
    const session = new Session({ ...options, createOnly: true });
    const initMsg = await session.initialize();
    session.close();
    return initMsg.agentId;
  }

  /**
   * Create a new conversation/session.
   *
   * Without an agent id, this uses the default/LRU agent, matching the legacy
   * top-level createSession() helper.
   */
  createSession(
    agentIdOrOptions?: string | LettaCodeClientSessionOptions,
    options: LettaCodeClientSessionOptions = {},
  ): Session {
    const agentId =
      typeof agentIdOrOptions === "string" ? agentIdOrOptions : undefined;
    const resolvedOptions =
      typeof agentIdOrOptions === "string" ? options : (agentIdOrOptions ?? {});

    this.assertSessionBackend("createSession", resolvedOptions);
    const sessionOptions = stripEnvironment(resolvedOptions);
    validateCreateSessionOptions(sessionOptions);

    if (agentId) {
      return new Session({ ...sessionOptions, agentId, newConversation: true });
    }
    return new Session({ ...sessionOptions, newConversation: true });
  }

  /**
   * Resume an existing agent default conversation or a specific conversation.
   *
   * `options.environment` overrides the client's default execution target for
   * remote/cloud backends once those transports are implemented.
   */
  resumeSession(
    id: string,
    options: LettaCodeClientSessionOptions = {},
  ): Session {
    this.assertSessionBackend("resumeSession", options);
    const sessionOptions = stripEnvironment(options);
    validateCreateSessionOptions(sessionOptions);

    if (id.startsWith("conv-")) {
      return new Session({ ...sessionOptions, conversationId: id });
    }
    return new Session({
      ...sessionOptions,
      agentId: id,
      defaultConversation: true,
    });
  }

  /** One-shot prompt convenience helper using a new conversation. */
  async prompt(
    message: SendMessage,
    agentId?: string,
    options: LettaCodeClientSessionOptions = {},
  ): Promise<SDKResultMessage> {
    const session = agentId
      ? this.createSession(agentId, options)
      : this.createSession(options);

    try {
      return await session.runTurn(message);
    } finally {
      session.close();
    }
  }

  private assertLocalBackend(action: string): void {
    if (this.backend === "local") {
      return;
    }

    throw new Error(
      `LettaCodeClient backend '${this.backend}' is not implemented yet. ${action} currently supports backend 'local' only.`,
    );
  }

  private assertSessionBackend(
    action: string,
    options: LettaCodeClientSessionOptions,
  ): void {
    const effectiveEnvironment = options.environment ?? this.environment;
    if (this.backend === "local") {
      if (effectiveEnvironment !== undefined) {
        throw new Error(
          `${action}() environment overrides are only valid for remote/cloud backends.`,
        );
      }
      return;
    }

    throw new Error(
      `LettaCodeClient backend '${this.backend}' is not implemented yet. ${action} currently supports backend 'local' only.`,
    );
  }
}
