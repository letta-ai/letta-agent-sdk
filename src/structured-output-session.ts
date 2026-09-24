import type { SDKMessage, SDKResultMessage, OutputFormat, SendMessage } from "./types.js";
import type { RuntimeSessionMode, RemoteClientRuntimeController } from "./remote-session-protocol.js";
import { sessionOutputFormat } from "./remote-session-protocol.js";
import { createStructuredOutputTool, type StructuredOutputParseResult } from "./structured-output.js";

export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
export const STRUCTURED_OUTPUT_PROMPT = "Return the final result by calling StructuredOutput exactly once with the requested fields. Do not write the result as prose.";

export function registerStructuredOutputTool(
  mode: RuntimeSessionMode,
  onResult: (result: StructuredOutputParseResult, toolCallId: string) => void,
): void {
  const format = sessionOutputFormat(mode);
  if (!format) return;
  if (mode.options.tools?.some((tool) => tool.name === STRUCTURED_OUTPUT_TOOL)) {
    throw new Error("StructuredOutput is reserved when outputFormat is set.");
  }
  mode.options = {
    ...mode.options,
    tools: [...(mode.options.tools ?? []), createStructuredOutputTool(format, onResult)],
    allowedTools: mode.options.allowedTools === undefined ? undefined
      : [...new Set([...mode.options.allowedTools, STRUCTURED_OUTPUT_TOOL])],
  };
}

export async function resolveStructuredMode(
  controller: RemoteClientRuntimeController,
  model: string,
): Promise<"native" | "portable"> {
  const catalog = await controller.listModels();
  const entry = catalog.entries.find((candidate) => candidate.handle === model || candidate.id === model);
  // Unknown capabilities fail safe to the portable tool path.
  return (entry as typeof entry & { supportsStructuredOutputs?: boolean } | undefined)
    ?.supportsStructuredOutputs === true ? "native" : "portable";
}


/** Retry invalid or missing structured results in the same conversation. */
export async function* streamStructuredTurns(config: {
  nextMessage(): Promise<SDKMessage | null>;
  send(message: SendMessage): Promise<void>;
  abort(): Promise<void>;
  format: OutputFormat;
  mode(): "native" | "portable" | null;
  accepted(): { valid: boolean; value: unknown; detail: string; toolCallId?: string | null };
}): AsyncGenerator<SDKMessage> {
  const maxRetries = config.format.maxRetries ?? 2;
  let retries = 0;
  let stopping = false;
  while (true) {
    const msg = await config.nextMessage();
    if (!msg) break;
    const mode = config.mode();
    const accepted = config.accepted();
    if (mode === "portable" && accepted.valid && msg.type === "tool_result" &&
      msg.toolCallId === accepted.toolCallId && !stopping) {
      stopping = true;
      // External SDK tools have no terminal rule; stop after their successful return.
      void config.abort().catch(() => undefined);
    }
    if (msg.type !== "result") {
      yield msg;
      continue;
    }
    if (mode === "portable" && accepted.valid) {
      yield { ...msg, success: true, structuredOutput: accepted.value,
        error: undefined, errorCode: undefined, errorDetail: undefined, recoverable: undefined };
      break;
    }
    if (mode === "native" && msg.success) {
      yield msg;
      break;
    }
    if ((mode === "native" && msg.errorCode !== "structured_output_error") ||
      (mode === "portable" && !msg.success && msg.errorCode !== "interrupted")) {
      yield msg;
      break;
    }
    const detail = mode === "portable" ? accepted.detail : (msg.errorDetail ?? "Invalid JSON Schema response.");
    if (retries++ >= maxRetries) {
      const failure: SDKResultMessage = { ...msg, success: false, structuredOutput: undefined,
        error: "structured_output_error", errorCode: "structured_output_error",
        errorDetail: `Structured output failed after ${retries} turns: ${detail}`,
        recoverable: false };
      yield failure;
      break;
    }
    stopping = false;
    await config.send(mode === "portable"
      ? `Your previous result was missing or invalid: ${detail}. Call StructuredOutput with a result matching the schema. Do not respond in prose.`
      : `Your previous response was invalid: ${detail}. Return only JSON matching the requested schema.`);
  }
}
