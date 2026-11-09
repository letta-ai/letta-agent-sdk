import type { AppServerExternalToolCallHandler } from "@letta-ai/letta-code/app-server-client";
import type { AnyAgentTool } from "./types.js";

/** The `external_tools` groups that advertise client tools to the runtime. */
export function externalToolGroups(tools: AnyAgentTool[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      tools: tools.map((tool) => ({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters as Record<string, unknown>,
      })),
    },
  ];
}

/** Run a runtime's external tool call against the client tools by name. */
export function createExternalToolCallHandler(
  externalTools: Map<string, AnyAgentTool>,
): AppServerExternalToolCallHandler {
  return async (request) => {
    const tool = externalTools.get(request.tool_name);
    if (!tool) {
      throw new Error(`Unknown external tool: ${request.tool_name}`);
    }
    const result = await tool.execute(request.tool_call_id, request.input);
    return {
      content: result.content.map((part) => ({
        type: part.type,
        ...(part.text !== undefined ? { text: part.text } : {}),
        ...(part.data !== undefined ? { data: part.data } : {}),
        ...(part.mimeType !== undefined ? { mimeType: part.mimeType } : {}),
      })),
      ...(result.isError === true ? { is_error: true } : {}),
    };
  };
}
