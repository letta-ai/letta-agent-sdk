import type Letta from "@letta-ai/letta-client";

/** One file to upload into an SDK-managed Cloud sandbox. */
export interface SandboxFileUpload {
  /** Filename reported to the sandbox upload API. */
  name: string;
  /** Portable file contents. The Blob type supplies the MIME type. */
  data: Blob;
}

/** Metadata returned after a file is uploaded into a managed sandbox. */
export interface SandboxUploadedFile {
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface SandboxFileUploadResult {
  files: SandboxUploadedFile[];
}

/** File transfer client for an SDK-managed Cloud sandbox. */
export interface SandboxFilesClient {
  /** Upload files under `/root/downloads` in this SDK-managed Cloud sandbox. */
  uploadFiles(files: readonly SandboxFileUpload[]): Promise<SandboxFileUploadResult>;
  /** Download one file under `/root/downloads` from this SDK-managed Cloud sandbox. */
  downloadFile(path: string): Promise<Uint8Array>;
}

function isUploadedFile(value: unknown): value is SandboxUploadedFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  return (
    typeof file.path === "string" &&
    typeof file.name === "string" &&
    typeof file.mimeType === "string" &&
    typeof file.size === "number" &&
    Number.isSafeInteger(file.size) &&
    file.size >= 0
  );
}

function parseUploadResult(value: unknown): SandboxFileUploadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cloud sandbox file upload returned an invalid response.");
  }
  const files = (value as Record<string, unknown>).files;
  if (!Array.isArray(files) || !files.every(isUploadedFile)) {
    throw new Error("Cloud sandbox file upload returned invalid file metadata.");
  }
  return { files };
}

function uploadForm(files: readonly SandboxFileUpload[]): FormData {
  if (files.length === 0) {
    throw new Error("Cloud sandbox file upload requires at least one file.");
  }
  const form = new FormData();
  for (const [index, file] of files.entries()) {
    if (!file || typeof file.name !== "string" || file.name.trim() === "") {
      throw new Error(`Invalid Cloud sandbox upload file at index ${index}.`);
    }
    form.append("file", file.data, file.name);
  }
  return form;
}

export async function uploadSandboxFiles(
  apiClient: Letta,
  sandboxId: string,
  files: readonly SandboxFileUpload[],
): Promise<SandboxFileUploadResult> {
  const response = await apiClient.post<unknown>(
    `/v1/sandboxes/${encodeURIComponent(sandboxId)}/files`,
    { body: uploadForm(files) },
  );
  return parseUploadResult(response);
}

export async function downloadSandboxFile(
  apiClient: Letta,
  sandboxId: string,
  path: string,
): Promise<Uint8Array> {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("Cloud sandbox file download requires a non-empty path.");
  }
  const response = await apiClient.get<Response>(
    `/v1/sandboxes/${encodeURIComponent(sandboxId)}/files`,
    {
      query: { path },
      __binaryResponse: true,
    },
  );
  return new Uint8Array(await response.arrayBuffer());
}
