/**
 * Letta-hosted repository API types, used by RepositoriesClient and
 * AgentRepositoriesClient. Kept beside their implementation
 * (repositories.ts) and re-exported from types.ts.
 */

export interface Repository {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRepositoryParams {
  name: string;
}

export interface ListRepositoriesParams {
  limit?: number;
  offset?: number;
}

export interface ListRepositoriesResult {
  repositories: Repository[];
  hasNextPage: boolean;
}

export interface RepositoryResource {
  type: "repository";
  repositoryId: string;
  /**
   * Whether to trigger a system-prompt recompile after attaching (and after
   * detaching on cleanup) so the session's conversation does not retain
   * stale repository projections. Defaults to `true`.
   */
  recompile?: boolean;
}

export interface RepositoryFileEntry {
  path: string;
  type: "file" | "directory";
}

export interface ListRepositoryFilesParams {
  pathPrefix?: string;
  depth?: number;
  ref?: string;
}

export interface ListRepositoryFilesResult {
  files: RepositoryFileEntry[];
  ref: string;
}

export interface CreateRepositoryFileParams {
  path: string;
  content: string;
}

export interface RepositoryFile {
  path: string;
  content: string;
  contentSha256: string;
  ref?: string;
}

export interface UpdateRepositoryFileParams {
  path: string;
  content?: string;
  newPath?: string;
  precondition?: {
    contentSha256: string;
  };
}

export interface RepositoryFileMutationResult {
  path: string;
  contentSha256: string;
  commitSha: string;
}

export interface DeleteRepositoryFileParams {
  path: string;
}

export interface DeleteRepositoryFileResult {
  success: boolean;
  commitSha: string;
}

export interface RepositoryVersion {
  sha: string;
  message: string;
  timestamp: string;
  author_name: string | null;
}

export interface ListRepositoryVersionsParams {
  path?: string;
  limit?: number;
}

export interface GetRepositoryVersionParams {
  path: string;
}
