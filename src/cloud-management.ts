import type Letta from "@letta-ai/letta-client";
import { APIError } from "@letta-ai/letta-client/core/error";
import type {
  AgentListParams,
  AgentUpdateParams,
} from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ConversationCreateParams,
  ConversationListParams,
  ConversationUpdateParams,
} from "@letta-ai/letta-client/resources/conversations/conversations";
import type { MessageListParams } from "@letta-ai/letta-client/resources/conversations/messages";
import type { ManagementTransport } from "./management.js";
import type {
  AgentRepository,
  AgentRepositoryPermissions,
  ConversationMessagesResult,
  LettaAgent,
  LettaConversation,
} from "./management-types.js";
import type {
  LettaCodeModelEntry,
  ListModelsResult,
} from "./types.js";

function asAgentRepository(body: unknown, action: string): AgentRepository {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`${action} response did not include a repository.`);
  }
  const repository = body as Record<string, unknown>;
  const permissions = repository.permissions;
  if (
    typeof repository.id !== "string" ||
    typeof repository.name !== "string" ||
    typeof repository.is_primary !== "boolean" ||
    (permissions !== "read" && permissions !== "read_write")
  ) {
    throw new Error(`${action} response included an invalid repository.`);
  }
  return {
    id: repository.id,
    name: repository.name,
    isPrimary: repository.is_primary,
    permissions,
  };
}

function cloudModelEntry(
  raw: Record<string, unknown>,
): LettaCodeModelEntry | null {
  if (typeof raw.handle !== "string" || raw.handle.length === 0) {
    return null;
  }
  const label =
    typeof raw.display_name === "string"
      ? raw.display_name
      : typeof raw.name === "string"
        ? raw.name
        : raw.handle;
  return {
    ...raw,
    id:
      typeof raw.id === "string" && raw.id.length > 0
        ? raw.id
        : raw.handle,
    handle: raw.handle,
    label,
    description:
      typeof raw.description === "string" ? raw.description : "",
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof APIError && error.status === 404;
}

/**
 * The SDK cursor contract is chronological: `before` always means older and
 * `after` always means newer. The Cloud REST API interprets cursors relative
 * to sort order instead, and its default order is newest-first, so descending
 * requests need their cursor keys swapped at this boundary. The app-server
 * transport already receives chronological cursors and must not swap.
 */
function toOrderRelativeCursors(query: MessageListParams): MessageListParams {
  if ((query.order ?? "desc") !== "desc") return query;
  const { before, after, ...rest } = query;
  return {
    ...rest,
    ...(after != null ? { before: after } : {}),
    ...(before != null ? { after: before } : {}),
  };
}

/** Cloud management backed by the canonical generated Letta TypeScript client. */
export class CloudManagementTransport implements ManagementTransport {
  constructor(private readonly client: Letta) {}

  async listAgents(query: AgentListParams): Promise<LettaAgent[]> {
    const page = await this.client.agents.list(query);
    return page.items;
  }

  async retrieveAgent(agentId: string): Promise<LettaAgent> {
    return this.client.agents.retrieve(agentId);
  }

  async updateAgent(
    agentId: string,
    body: AgentUpdateParams,
  ): Promise<LettaAgent> {
    return this.client.agents.update(agentId, body);
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.client.agents.delete(agentId);
  }

  async listAgentRepositories(agentId: string): Promise<AgentRepository[]> {
    const body = await this.client.get<{ repositories: unknown[] }>(
      `/v1/agents/${encodeURIComponent(agentId)}/repositories`,
    );
    if (!Array.isArray(body.repositories)) {
      throw new Error(
        "Cloud list agent repositories response did not include repositories.",
      );
    }
    return body.repositories.map((repository) =>
      asAgentRepository(repository, "Cloud list agent repositories")
    );
  }

  async attachAgentRepository(
    agentId: string,
    repositoryId: string,
    permissions: AgentRepositoryPermissions | undefined,
  ): Promise<AgentRepository> {
    const body = await this.client.post<{
      success: boolean;
      repository: unknown;
    }>(
      `/v1/agents/${encodeURIComponent(agentId)}/repositories`,
      {
        body: {
          repository_id: repositoryId,
          ...(permissions !== undefined ? { permissions } : {}),
        },
      },
    );
    return asAgentRepository(
      body.repository,
      "Cloud attach agent repository",
    );
  }

  async detachAgentRepository(
    agentId: string,
    repositoryId: string,
  ): Promise<void> {
    try {
      await this.client.delete(
        `/v1/agents/${encodeURIComponent(agentId)}/repositories/${encodeURIComponent(repositoryId)}`,
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async recompileAgentSystemPrompt(agentId: string): Promise<void> {
    await this.client.agents.recompile(agentId);
  }

  async recompileConversationSystemPrompt(
    agentId: string,
    conversationId: string,
  ): Promise<void> {
    await this.client.conversations.recompile(conversationId, {
      agent_id: agentId,
    });
  }

  async listModels(): Promise<ListModelsResult> {
    const entries = await this.client.models.list();
    const normalized = entries.flatMap((entry) => {
      const model = cloudModelEntry(
        entry as unknown as Record<string, unknown>,
      );
      return model ? [model] : [];
    });
    return {
      entries: normalized,
      availableHandles: normalized.map((entry) => entry.handle),
    };
  }

  async listConversations(
    query: ConversationListParams,
  ): Promise<LettaConversation[]> {
    return this.client.conversations.list(query);
  }

  async retrieveConversation(
    conversationId: string,
  ): Promise<LettaConversation> {
    return this.client.conversations.retrieve(conversationId);
  }

  async createConversation(
    body: ConversationCreateParams,
  ): Promise<LettaConversation> {
    return this.client.conversations.create(body);
  }

  async updateConversation(
    conversationId: string,
    body: ConversationUpdateParams,
  ): Promise<LettaConversation> {
    return this.client.conversations.update(conversationId, body);
  }

  async listConversationMessages(
    conversationId: string,
    query: MessageListParams,
  ): Promise<ConversationMessagesResult> {
    const page = await this.client.conversations.messages.list(
      conversationId,
      toOrderRelativeCursors(query),
    );
    return { messages: page.items };
  }
}
