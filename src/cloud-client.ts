import Letta from "@letta-ai/letta-client";
import type { LettaCodeCloudClientOptions } from "./types.js";

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

export function getCloudApiKey(
  options: LettaCodeCloudClientOptions,
): string | undefined {
  return options.apiKey ?? bearerToken(options.headers) ?? defaultApiKey();
}

export function normalizeCloudApiBaseUrl(url: string | undefined): string {
  const parsed = new URL(url ?? DEFAULT_CLOUD_API_BASE_URL);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

/** Build the canonical Letta API client shared by one Agent SDK client. */
export function createCloudClient(
  options: LettaCodeCloudClientOptions,
): Letta {
  return new Letta({
    apiKey: getCloudApiKey(options) ?? null,
    baseURL: normalizeCloudApiBaseUrl(options.apiBaseUrl),
    defaultHeaders: options.headers,
    fetch: options.fetch,
  });
}
