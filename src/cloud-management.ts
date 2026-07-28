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
import type {
  ManagementQuery,
  ManagementTransport,
} from "./management.js";
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

/** Cloud management backed by the canonical generated Letta TypeScript client. */
export class CloudManagementTransport implements ManagementTransport {
  constructor(private readonly client: Letta) {}

  async listAgents(query: ManagementQuery): Promise<LettaAgent[]> {
    const page = await this.client.agents.list(query as AgentListParams);
    return page.items as unknown as LettaAgent[];
  }

  async retrieveAgent(agentId: string): Promise<LettaAgent> {
    return await this.client.agents.retrieve(agentId) as unknown as LettaAgent;
  }

  async updateAgent(
    agentId: string,
    body: Record<string, unknown>,
  ): Promise<LettaAgent> {
    return await this.client.agents.update(
      agentId,
      body as AgentUpdateParams,
    ) as unknown as LettaAgent;
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
    query: ManagementQuery,
  ): Promise<LettaConversation[]> {
    return await this.client.conversations.list(
      query as ConversationListParams,
    ) as LettaConversation[];
  }

  async retrieveConversation(
    conversationId: string,
  ): Promise<LettaConversation> {
    return await this.client.conversations.retrieve(
      conversationId,
    ) as LettaConversation;
  }

  async createConversation(
    body: Record<string, unknown>,
  ): Promise<LettaConversation> {
    return await this.client.conversations.create(
      body as unknown as ConversationCreateParams,
    ) as LettaConversation;
  }

  async updateConversation(
    conversationId: string,
    body: Record<string, unknown>,
  ): Promise<LettaConversation> {
    return await this.client.conversations.update(
      conversationId,
      body as ConversationUpdateParams,
    ) as LettaConversation;
  }

  async listConversationMessages(
    conversationId: string,
    query: ManagementQuery,
  ): Promise<ConversationMessagesResult> {
    const page = await this.client.conversations.messages.list(
      conversationId,
      query as MessageListParams,
    );
    return { messages: page.items as unknown as Record<string, unknown>[] };
  }
}
