import type {
  CreateRepositoryFileParams,
  CreateRepositoryParams,
  DeleteRepositoryFileParams,
  DeleteRepositoryFileResult,
  GetRepositoryVersionParams,
  LettaCodeCloudClientOptions,
  ListRepositoriesParams,
  ListRepositoriesResult,
  ListRepositoryFilesParams,
  ListRepositoryFilesResult,
  ListRepositoryVersionsParams,
  Repository,
  RepositoryFile,
  RepositoryFileMutationResult,
  RepositoryVersion,
  UpdateRepositoryFileParams,
} from "./types.js";

const DEFAULT_CLOUD_API_BASE_URL = "https://api.letta.com";

type FetchLike = typeof fetch;

function getDefaultApiKey(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  return env?.LETTA_API_KEY ?? env?.LETTA_CLOUD_API_KEY;
}

function bearerTokenFromHeaders(headers: Record<string, string> | undefined): string | undefined {
  const authorization = headers?.Authorization ?? headers?.authorization;
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1];
}

function getCloudApiKey(options: LettaCodeCloudClientOptions): string | undefined {
  return options.apiKey ?? bearerTokenFromHeaders(options.headers) ?? getDefaultApiKey();
}

function getFetch(fetchOverride?: FetchLike): FetchLike {
  const resolved = fetchOverride ?? globalThis.fetch;
  if (!resolved) throw new Error("No fetch implementation available for cloud backend.");
  return resolved.bind(globalThis) as FetchLike;
}

function normalizeCloudApiBaseUrl(url: string | undefined): string {
  const parsed = new URL(url ?? DEFAULT_CLOUD_API_BASE_URL);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function cloudHeaders(options: LettaCodeCloudClientOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers ?? {}),
  };
  const apiKey = getCloudApiKey(options);
  if (apiKey && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
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
    const pieces = [message, reasonText]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (pieces.length > 0) return pieces.join(": ");
  }
  return fallback;
}

function assertOkResponse(response: Response, body: unknown, action: string): void {
  if (!response.ok) {
    throw new Error(responseErrorMessage(body, `${action} failed with HTTP ${response.status}`));
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Cloud repositories response missing ${name}.`);
  return value;
}

function toRepository(body: unknown): Repository {
  if (!body || typeof body !== "object") {
    throw new Error("Cloud repositories response did not include a repository.");
  }
  const record = body as Record<string, unknown>;
  return {
    id: requireString(record.id, "id"),
    name: requireString(record.name, "name"),
    createdAt: requireString(record.created_at, "created_at"),
    updatedAt: requireString(record.updated_at, "updated_at"),
  };
}

function toFileMutation(body: unknown): RepositoryFileMutationResult {
  if (!body || typeof body !== "object") {
    throw new Error("Cloud repositories file response did not include file details.");
  }
  const record = body as Record<string, unknown>;
  return {
    path: requireString(record.path, "path"),
    contentSha256: requireString(record.content_sha256, "content_sha256"),
    commitSha: requireString(record.commit_sha, "commit_sha"),
  };
}

function addOptionalSearchParam(url: URL, key: string, value: string | number | undefined): void {
  if (value !== undefined) url.searchParams.set(key, String(value));
}

export class RepositoriesClient {
  constructor(private readonly options: LettaCodeCloudClientOptions) {}

  async create(params: CreateRepositoryParams): Promise<Repository> {
    return toRepository(await this.request("/v1/repositories", "POST", { name: params.name }, "Cloud create repository"));
  }

  async list(params: ListRepositoriesParams = {}): Promise<ListRepositoriesResult> {
    const url = this.url("/v1/repositories");
    addOptionalSearchParam(url, "limit", params.limit);
    addOptionalSearchParam(url, "offset", params.offset);
    const body = await this.requestUrl(url, "GET", undefined, "Cloud list repositories");
    if (!body || typeof body !== "object") {
      throw new Error("Cloud list repositories response did not include repositories.");
    }
    const record = body as Record<string, unknown>;
    const repositories = Array.isArray(record.repositories)
      ? record.repositories.map(toRepository)
      : [];
    return {
      repositories,
      hasNextPage: record.has_next_page === true,
    };
  }

  async get(repositoryId: string): Promise<Repository> {
    return toRepository(await this.request(`/v1/repositories/${encodeURIComponent(repositoryId)}`, "GET", undefined, "Cloud get repository"));
  }

  /**
   * Delete a repository. The server soft-deletes it (marks the repository
   * deleted rather than removing its data). Resolves on success; throws if the
   * repository does not exist or is not visible to the caller's organization.
   */
  async delete(repositoryId: string): Promise<void> {
    await this.request(
      `/v1/repositories/${encodeURIComponent(repositoryId)}`,
      "DELETE",
      undefined,
      "Cloud delete repository",
    );
  }

  readonly files = {
    list: async (
      repositoryId: string,
      params: ListRepositoryFilesParams = {},
    ): Promise<ListRepositoryFilesResult> => {
      const url = this.url(`/v1/repositories/${encodeURIComponent(repositoryId)}/files`);
      addOptionalSearchParam(url, "path_prefix", params.pathPrefix);
      addOptionalSearchParam(url, "depth", params.depth);
      addOptionalSearchParam(url, "ref", params.ref);
      const body = await this.requestUrl(url, "GET", undefined, "Cloud list repository files");
      if (!body || typeof body !== "object") {
        throw new Error("Cloud list repository files response did not include files.");
      }
      const record = body as Record<string, unknown>;
      const files = Array.isArray(record.files)
        ? record.files.map((entry) => {
          if (!entry || typeof entry !== "object") {
            throw new Error("Cloud list repository files response included an invalid file entry.");
          }
          const file = entry as Record<string, unknown>;
          const type = file.type;
          if (type !== "file" && type !== "directory") {
            throw new Error("Cloud list repository files response included an invalid file type.");
          }
          return { path: requireString(file.path, "path"), type: type as "file" | "directory" };
        })
        : [];
      return { files, ref: requireString(record.ref, "ref") };
    },

    create: async (
      repositoryId: string,
      params: CreateRepositoryFileParams,
    ): Promise<RepositoryFileMutationResult> => toFileMutation(await this.request(
      `/v1/repositories/${encodeURIComponent(repositoryId)}/files`,
      "POST",
      { path: params.path, content: params.content },
      "Cloud create repository file",
    )),

    read: async (repositoryId: string, params: { path: string; ref?: string }): Promise<RepositoryFile> => {
      const url = this.url(`/v1/repositories/${encodeURIComponent(repositoryId)}/files/content`);
      url.searchParams.set("path", params.path);
      addOptionalSearchParam(url, "ref", params.ref);
      const body = await this.requestUrl(url, "GET", undefined, "Cloud read repository file");
      if (!body || typeof body !== "object") {
        throw new Error("Cloud read repository file response did not include file content.");
      }
      const record = body as Record<string, unknown>;
      return {
        path: requireString(record.path, "path"),
        content: requireString(record.content, "content"),
        contentSha256: requireString(record.content_sha256, "content_sha256"),
        ref: optionalString(record.ref),
      };
    },

    update: async (
      repositoryId: string,
      params: UpdateRepositoryFileParams,
    ): Promise<RepositoryFileMutationResult> => toFileMutation(await this.request(
      `/v1/repositories/${encodeURIComponent(repositoryId)}/files`,
      "PATCH",
      {
        path: params.path,
        ...(params.content !== undefined ? { content: params.content } : {}),
        ...(params.newPath !== undefined ? { new_path: params.newPath } : {}),
        ...(params.precondition !== undefined
          ? { precondition: { content_sha256: params.precondition.contentSha256 } }
          : {}),
      },
      "Cloud update repository file",
    )),

    delete: async (
      repositoryId: string,
      params: DeleteRepositoryFileParams,
    ): Promise<DeleteRepositoryFileResult> => {
      const body = await this.request(
        `/v1/repositories/${encodeURIComponent(repositoryId)}/files`,
        "DELETE",
        { path: params.path },
        "Cloud delete repository file",
      );
      if (!body || typeof body !== "object") {
        throw new Error("Cloud delete repository file response did not include delete details.");
      }
      const record = body as Record<string, unknown>;
      return { success: record.success === true, commitSha: requireString(record.commit_sha, "commit_sha") };
    },
  };

  readonly versions = {
    list: async (
      repositoryId: string,
      params: ListRepositoryVersionsParams = {},
    ): Promise<RepositoryVersion[]> => {
      const url = this.url(`/v1/repositories/${encodeURIComponent(repositoryId)}/versions`);
      addOptionalSearchParam(url, "path", params.path);
      addOptionalSearchParam(url, "limit", params.limit);
      const body = await this.requestUrl(url, "GET", undefined, "Cloud list repository versions");
      if (Array.isArray(body)) return body as RepositoryVersion[];
      if (body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).versions)) {
        return (body as { versions: RepositoryVersion[] }).versions;
      }
      return [];
    },

    get: async (
      repositoryId: string,
      sha: string,
      params: GetRepositoryVersionParams,
    ): Promise<RepositoryFile> => {
      const url = this.url(`/v1/repositories/${encodeURIComponent(repositoryId)}/versions/${encodeURIComponent(sha)}`);
      url.searchParams.set("path", params.path);
      const body = await this.requestUrl(url, "GET", undefined, "Cloud get repository version");
      if (!body || typeof body !== "object") {
        throw new Error("Cloud get repository version response did not include file content.");
      }
      const record = body as Record<string, unknown>;
      return {
        path: requireString(record.path, "path"),
        content: requireString(record.content, "content"),
        contentSha256: requireString(record.content_sha256, "content_sha256"),
        ref: requireString(record.sha, "sha"),
      };
    },
  };

  private url(path: string): URL {
    return new URL(`${normalizeCloudApiBaseUrl(this.options.apiBaseUrl)}${path}`);
  }

  private async request(
    path: string,
    method: string,
    body: unknown,
    action: string,
  ): Promise<unknown> {
    return this.requestUrl(this.url(path), method, body, action);
  }

  private async requestUrl(
    url: URL,
    method: string,
    body: unknown,
    action: string,
  ): Promise<unknown> {
    const response = await getFetch(this.options.fetch)(url, {
      method,
      headers: cloudHeaders(this.options),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = await parseJsonResponse(response);
    assertOkResponse(response, parsed, action);
    return parsed;
  }
}
