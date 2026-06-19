/**
 * Local protocol type surface consumed by the SDK.
 *
 * @letta-ai/letta-code@0.27.11 publishes these declarations under an internal
 * dist path while its package.json points the public `./protocol` export at a
 * missing file. Keep the SDK's public types self-contained so CI and consumers
 * do not depend on that broken subpath export.
 */

export interface MessageEnvelope {
  type: string;
  session_id?: string;
  uuid?: string;
  timestamp?: string;
  event_seq?: number;
  agent_id?: string;
  conversation_id?: string;
  [key: string]: unknown;
}

/**
 * System prompt preset configuration used by the CLI protocol.
 */
export interface SystemPromptPresetConfig {
  type: "preset";
  preset: string;
  append?: string;
}

/**
 * Custom memory block definition accepted when creating agents.
 */
export interface CreateBlock {
  label: string;
  value: string;
  base_template_id?: string | null;
  deployment_id?: string | null;
  description?: string | null;
  entity_id?: string | null;
  hidden?: boolean | null;
  is_template?: boolean;
  limit?: number;
  metadata?: Record<string, unknown> | null;
  preserve_on_migration?: boolean | null;
  project_id?: string | null;
  read_only?: boolean;
  tags?: string[] | null;
  template_id?: string | null;
  template_name?: string | null;
}

export interface SystemInitMessage extends MessageEnvelope {
  type: "system";
  subtype: "init";
  agent_id: string;
  conversation_id: string;
  model: string;
  tools: string[];
  cwd: string;
  mcp_servers: Array<{
    name: string;
    status: string;
  }>;
  permission_mode: string;
  slash_commands: string[];
  memfs_enabled?: boolean;
  skill_sources?: Array<"bundled" | "global" | "agent" | "project">;
  system_info_reminder_enabled?: boolean;
  reflection_trigger?: "off" | "step-count" | "compaction-event";
  reflection_behavior?: "reminder" | "auto-launch";
  reflection_step_count?: number;
}

export interface MessageWire extends MessageEnvelope {
  type: "message";
  message_type?: string;
  run_id?: string;
}

export interface StreamEvent extends MessageEnvelope {
  type: "stream_event";
  event: unknown;
}

export type ResultSubtype = "success" | "interrupted" | "error" | string;

export interface ResultMessage extends MessageEnvelope {
  type: "result";
  subtype: ResultSubtype;
  agent_id?: string;
  conversation_id: string;
  duration_ms: number;
  duration_api_ms?: number;
  num_turns?: number;
  result?: string | null;
  run_ids?: string[];
  usage?: unknown;
  stop_reason?: string;
}

export interface ErrorMessage extends MessageEnvelope {
  type: "error";
  message: string;
  stop_reason: string;
  run_id?: string;
  api_error?: Record<string, unknown>;
}

export interface CanUseToolControlRequest {
  subtype: "can_use_tool";
  tool_name: string;
  input: Record<string, unknown>;
  tool_call_id: string;
  permission_suggestions?: unknown[];
  blocked_path?: string | null;
  diffs?: unknown[];
}

export interface RegisterExternalToolsRequest {
  subtype: "register_external_tools";
  tools: Array<{
    name: string;
    label?: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
}

export interface BootstrapSessionStateRequest {
  subtype: "bootstrap_session_state";
  limit?: number;
  order?: "asc" | "desc";
}

export interface RecoverPendingApprovalsControlRequest {
  subtype: "recover_pending_approvals";
  agent_id?: string;
  conversation_id?: string;
}

export interface ListMessagesControlRequest {
  subtype: "list_messages";
  conversation_id?: string;
  agent_id?: string;
  before?: string;
  after?: string;
  order?: "asc" | "desc";
  limit?: number;
}

export interface InterruptControlRequest {
  subtype: "interrupt";
}

export interface InitializeControlRequest {
  subtype: "initialize";
}

export interface ExecuteExternalToolControlRequest {
  subtype: "execute_external_tool";
  tool_call_id: string;
  tool_name: string;
  input: Record<string, unknown>;
}

export type ControlRequestBody =
  | InitializeControlRequest
  | InterruptControlRequest
  | RegisterExternalToolsRequest
  | BootstrapSessionStateRequest
  | RecoverPendingApprovalsControlRequest
  | ListMessagesControlRequest
  | CanUseToolControlRequest
  | ExecuteExternalToolControlRequest
  | (Record<string, unknown> & { subtype: string });

export interface ControlRequest extends MessageEnvelope {
  type: "control_request";
  request_id: string;
  request: ControlRequestBody;
}

export interface CanUseToolResponseAllow {
  behavior: "allow";
  message?: string;
  updatedInput?: Record<string, unknown> | null;
  updatedPermissions?: unknown[];
}

export interface CanUseToolResponseDeny {
  behavior: "deny";
  message: string;
  interrupt?: boolean;
}

export type CanUseToolResponse = CanUseToolResponseAllow | CanUseToolResponseDeny;

export interface ExternalToolResultContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ExternalToolResultResponse {
  subtype: "external_tool_result";
  request_id: string;
  tool_call_id: string;
  content: ExternalToolResultContent[];
  is_error: boolean;
}

export type ControlResponseBody =
  | {
      subtype: "success";
      request_id: string;
      response?: CanUseToolResponse | Record<string, unknown>;
    }
  | {
      subtype: "error";
      request_id: string;
      error: string;
    }
  | ExternalToolResultResponse;

export interface ControlResponse extends MessageEnvelope {
  type: "control_response";
  response: ControlResponseBody;
}

export interface RetryMessage extends MessageEnvelope {
  type: "retry";
  reason: string;
  attempt: number;
  max_attempts: number;
  delay_ms: number;
  run_id?: string;
}

export type WireMessage =
  | SystemInitMessage
  | MessageWire
  | StreamEvent
  | ResultMessage
  | ErrorMessage
  | RetryMessage
  | ControlRequest
  | ControlResponse
  | (MessageEnvelope & { type: string });
