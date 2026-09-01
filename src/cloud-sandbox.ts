/** A GitHub repository cloned into an SDK-managed Cloud sandbox. */
export interface GitHubRepositoryRef {
  owner: string;
  repo: string;
  /** Exact commit to check out after cloning. Omit to use the default branch tip. */
  commit?: string;
}

export interface LettaCodeCloudSandboxOptions {
  /**
   * TTL to request when refreshing an SDK-managed sandbox. Defaults to 5
   * minutes, matching the Cloud API default. Valid range: 1-60.
   */
  ttlMinutes?: number;
  /** Timeout waiting for a newly created sandbox environment to come online. */
  readyTimeoutMs?: number;
  /** Poll interval while waiting for a newly created sandbox environment. */
  readyPollIntervalMs?: number;
  /** Interval for proactive TTL refreshes while the session is open. */
  refreshIntervalMs?: number;
  /**
   * GitHub repositories to clone into `/root/workspace` when creating the
   * managed sandbox. Up to 10 repositories may be provided. Private
   * repositories require access through the organization's GitHub integration.
   */
  githubRepositories?: GitHubRepositoryRef[];
  /**
   * Best-effort terminate the SDK-managed sandbox on session close. Defaults to
   * false so other sessions for the same conversation and reconnecting clients
   * can continue using it. Set true to restore eager cleanup when this session
   * exclusively owns the sandbox.
   */
  terminateOnClose?: boolean;
}

const MIN_TTL_MINUTES = 1;
const MAX_TTL_MINUTES = 60;
const MAX_GITHUB_REPOSITORIES = 10;
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9-]+$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/;
const GITHUB_COMMIT_PATTERN = /^[0-9a-fA-F]{40}$/;

function validatePositiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new Error(`Invalid ${name}. Expected a positive integer.`);
  }
}

export function validateCloudSandboxOptions(
  options: LettaCodeCloudSandboxOptions | undefined,
  name: string,
): void {
  if (options === undefined) return;
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error(`Invalid ${name}. Expected an object.`);
  }
  if (
    options.ttlMinutes !== undefined &&
    (!Number.isInteger(options.ttlMinutes) ||
      options.ttlMinutes < MIN_TTL_MINUTES ||
      options.ttlMinutes > MAX_TTL_MINUTES)
  ) {
    throw new Error(
      `Invalid ${name}.ttlMinutes. Expected an integer between ${MIN_TTL_MINUTES} and ${MAX_TTL_MINUTES}.`,
    );
  }
  validatePositiveInteger(options.readyTimeoutMs, `${name}.readyTimeoutMs`);
  validatePositiveInteger(
    options.readyPollIntervalMs,
    `${name}.readyPollIntervalMs`,
  );
  validatePositiveInteger(options.refreshIntervalMs, `${name}.refreshIntervalMs`);

  if (options.githubRepositories !== undefined) {
    if (!Array.isArray(options.githubRepositories)) {
      throw new Error(
        `Invalid ${name}.githubRepositories. Expected an array.`,
      );
    }
    if (options.githubRepositories.length > MAX_GITHUB_REPOSITORIES) {
      throw new Error(
        `Invalid ${name}.githubRepositories. Expected at most ${MAX_GITHUB_REPOSITORIES} repositories.`,
      );
    }
    for (const [index, repository] of options.githubRepositories.entries()) {
      if (
        repository === null ||
        typeof repository !== "object" ||
        Array.isArray(repository)
      ) {
        throw new Error(
          `Invalid ${name}.githubRepositories[${index}]. Expected an object.`,
        );
      }
      if (
        typeof repository.owner !== "string" ||
        !GITHUB_OWNER_PATTERN.test(repository.owner)
      ) {
        throw new Error(
          `Invalid ${name}.githubRepositories[${index}].owner.`,
        );
      }
      if (
        typeof repository.repo !== "string" ||
        !GITHUB_REPOSITORY_PATTERN.test(repository.repo)
      ) {
        throw new Error(
          `Invalid ${name}.githubRepositories[${index}].repo.`,
        );
      }
      if (
        repository.commit !== undefined &&
        (typeof repository.commit !== "string" ||
          !GITHUB_COMMIT_PATTERN.test(repository.commit))
      ) {
        throw new Error(
          `Invalid ${name}.githubRepositories[${index}].commit. Expected a full Git commit SHA.`,
        );
      }
    }
  }

  if (
    options.terminateOnClose !== undefined &&
    typeof options.terminateOnClose !== "boolean"
  ) {
    throw new Error(`Invalid ${name}.terminateOnClose. Expected a boolean.`);
  }
}
