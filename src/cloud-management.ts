import type {
  ManagementQuery,
  ManagementTransport,
} from "./management.js";
import type {
  AgentRepository,
  ConversationMessagesResult,
  LettaAgent,
  LettaConversation,
  AgentRepositoryPermissions,
} from "./management-types.js";
import type {
  LettaCodeCloudClientOptions,
  LettaCodeModelEntry,
  ListModelsResult,
} from "./types.js";

const DEFAULT_CLOUD_API_BASE_URL = "https://api.letta.com";

function defaultApiKey(): string | undefined {
  const env = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  return env?.LETTA_API_KEY ?? env?.LETTA_CLOUD_API_KEY;
}

function bearerToken(
  headers: Record<string, string> | undefined,
): string | undefined {
  const authorization = headers?.Authorization ?? headers?.authorization;
  return authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
}

function apiBaseUrl(value: string | undefined): string {
  const url = new URL(value ?? DEFAULT_CLOUD_API_BASE_URL);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function requestHeaders(
  options: LettaCodeCloudClientOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers ?? {}),
  };
  const apiKey =
    options.apiKey ?? bearerToken(options.headers) ?? defaultApiKey();
  if (apiKey && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function appendQuery(url: URL, query: ManagementQuery): void {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function responseErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const message = record.message ?? record.error ?? record.detail;
    const reasonText = record.reason_text;
    const pieces = [message, reasonText].filter(
      (value): value is string =>
        typeof value === "string" && value.length > 0,
    );
    if (pieces.length > 0) return pieces.join(": ");
  }
  return fallback;
}

function cloudRequestError(
  response: Response,
  body: unknown,
  action: string,
  url: URL,
  options: LettaCodeCloudClientOptions,
): Error {
  const parts = [
    `${action} failed`,
    responseErrorMessage(body, `HTTP ${response.status}`),
    `URL: ${url.toString()}`,
  ];
  if (response.status === 401 || response.status === 403) {
    const hasApiKey = Boolean(
      options.apiKey ??
        bearerToken(options.headers) ??
        defaultApiKey(),
    );
    parts.push(
      hasApiKey
        ? "Authentication failed — the API key may be invalid or lack permissions for this resource."
        : "No API key found. Set LETTA_API_KEY (or pass apiKey in client options).",
    );
  }
  return new Error(parts.join(" — "));
}

function asObject<T>(body: unknown, action: string): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`${action} response did not include an object.`);
  }
  return body as T;
}

function asArray<T>(body: unknown, action: string): T[] {
  if (!Array.isArray(body)) {
    throw new Error(`${action} response did not include an array.`);
  }
  return body as T[];
}

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

export class CloudManagementTransport implements ManagementTransport {
  constructor(private readonly options: LettaCodeCloudClientOptions) {}

  listAgents(query: ManagementQuery): Promise<LettaAgent[]> {
    return this.getArray("/v1/agents/", query, "Cloud list agents");
  }

  retrieveAgent(agentId: string): Promise<LettaAgent> {
    return this.getObject(
      `/v1/agents/${encodeURIComponent(agentId)}`,
      {},
      "Cloud retrieve agent",
    );
  }

  updateAgent(
    agentId: string,
    body: Record<string, unknown>,
  ): Promise<LettaAgent> {
    return this.requestObject(
      `/v1/agents/${encodeURIComponent(agentId)}`,
      "PATCH",
      body,
      "Cloud update agent",
    );
  }

  async deleteAgent(agentId: string): Promise<void> {
    // No trailing slash: the production api.letta.com router 404s
    // trailing-slash non-GET agent routes (see `POST /v1/agents` in
    // cloud-session.ts — GET tolerates the slash; DELETE does not).
    await this.requestUrl(
      this.url(`/v1/agents/${encodeURIComponent(agentId)}`),
      "DELETE",
      undefined,
      "Cloud delete agent",
    );
  }

  async listAgentRepositories(agentId: string): Promise<AgentRepository[]> {
    const body = await this.getObject<Record<string, unknown>>(
      `/v1/agents/${encodeURIComponent(agentId)}/repositories`,
      {},
      "Cloud list agent repositories",
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
    const body = await this.requestObject<Record<string, unknown>>(
      `/v1/agents/${encodeURIComponent(agentId)}/repositories`,
      "POST",
      {
        repository_id: repositoryId,
        ...(permissions !== undefined ? { permissions } : {}),
      },
      "Cloud attach agent repository",
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
    await this.requestUrl(
      this.url(
        `/v1/agents/${encodeURIComponent(agentId)}/repositories/${encodeURIComponent(repositoryId)}`,
      ),
      "DELETE",
      undefined,
      "Cloud detach agent repository",
      [404],
    );
  }

  async recompileAgentSystemPrompt(agentId: string): Promise<void> {
    await this.requestUrl(
      this.url(`/v1/agents/${encodeURIComponent(agentId)}/recompile`),
      "POST",
      {},
      "Cloud recompile system prompt",
    );
  }

  async recompileConversationSystemPrompt(
    agentId: string,
    conversationId: string,
  ): Promise<void> {
    await this.requestUrl(
      this.url(
        `/v1/conversations/${encodeURIComponent(conversationId)}/recompile`,
      ),
      "POST",
      { agent_id: agentId },
      "Cloud recompile system prompt",
    );
  }

  async listModels(): Promise<ListModelsResult> {
    // No trailing slash for consistency with the non-GET routes above (the
    // production router only tolerates trailing slashes on GET).
    const entries = await this.getArray<Record<string, unknown>>(
      "/v1/models",
      {},
      "Cloud list models",
    );
    const normalized = entries.flatMap((entry) => {
      const model = cloudModelEntry(entry);
      return model ? [model] : [];
    });
    return {
      entries: normalized,
      // Cloud's authenticated endpoint already returns the models available to
      // this user, so its catalog is also the authoritative availability set.
      availableHandles: normalized.map((entry) => entry.handle),
    };
  }

  listConversations(
    query: ManagementQuery,
  ): Promise<LettaConversation[]> {
    return this.getArray(
      "/v1/conversations/",
      query,
      "Cloud list conversations",
    );
  }

  retrieveConversation(
    conversationId: string,
  ): Promise<LettaConversation> {
    return this.getObject(
      `/v1/conversations/${encodeURIComponent(conversationId)}`,
      {},
      "Cloud retrieve conversation",
    );
  }

  createConversation(
    body: Record<string, unknown>,
  ): Promise<LettaConversation> {
    const { agent_id: agentId, ...requestBody } = body;
    if (typeof agentId !== "string" || agentId.length === 0) {
      throw new Error("createConversation() requires a non-empty agentId.");
    }
    const url = this.url("/v1/conversations/");
    url.searchParams.set("agent_id", agentId);
    return this.requestUrlObject(
      url,
      "POST",
      requestBody,
      "Cloud create conversation",
    );
  }

  updateConversation(
    conversationId: string,
    body: Record<string, unknown>,
  ): Promise<LettaConversation> {
    return this.requestObject(
      `/v1/conversations/${encodeURIComponent(conversationId)}`,
      "PATCH",
      body,
      "Cloud update conversation",
    );
  }

  async listConversationMessages(
    conversationId: string,
    query: ManagementQuery,
  ): Promise<ConversationMessagesResult> {
    const messages = await this.getArray<Record<string, unknown>>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      query,
      "Cloud list conversation messages",
    );
    return { messages };
  }

  private async getArray<T>(
    path: string,
    query: ManagementQuery,
    action: string,
  ): Promise<T[]> {
    const body = await this.get(path, query, action);
    return asArray<T>(body, action);
  }

  private async getObject<T>(
    path: string,
    query: ManagementQuery,
    action: string,
  ): Promise<T> {
    const body = await this.get(path, query, action);
    return asObject<T>(body, action);
  }

  private get(
    path: string,
    query: ManagementQuery,
    action: string,
  ): Promise<unknown> {
    const url = this.url(path);
    appendQuery(url, query);
    return this.requestUrl(url, "GET", undefined, action);
  }

  private requestObject<T>(
    path: string,
    method: string,
    body: Record<string, unknown>,
    action: string,
  ): Promise<T> {
    return this.requestUrlObject(
      this.url(path),
      method,
      body,
      action,
    );
  }

  private async requestUrlObject<T>(
    url: URL,
    method: string,
    body: Record<string, unknown>,
    action: string,
  ): Promise<T> {
    return asObject<T>(
      await this.requestUrl(url, method, body, action),
      action,
    );
  }

  private async requestUrl(
    url: URL,
    method: string,
    body: Record<string, unknown> | undefined,
    action: string,
    allowedStatuses: readonly number[] = [],
  ): Promise<unknown> {
    const fetchImpl = (this.options.fetch ?? globalThis.fetch)?.bind(
      globalThis,
    );
    if (!fetchImpl) {
      throw new Error("No fetch implementation available for cloud backend.");
    }
    const response = await fetchImpl(url, {
      method,
      headers: requestHeaders(this.options),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const responseBody = await parseResponse(response);
    if (!response.ok && !allowedStatuses.includes(response.status)) {
      throw cloudRequestError(
        response,
        responseBody,
        action,
        url,
        this.options,
      );
    }
    return responseBody;
  }

  private url(path: string): URL {
    return new URL(`${apiBaseUrl(this.options.apiBaseUrl)}${path}`);
  }
}
