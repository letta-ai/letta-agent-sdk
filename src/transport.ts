/**
 * SubprocessTransport
 *
 * Spawns the Letta Code CLI and communicates via stdin/stdout JSON streams.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { InternalSessionOptions, WireMessage } from "./types.js";

// All logging gated behind DEBUG_SDK env var
function sdkLog(tag: string, ...args: unknown[]) {
  if (process.env.DEBUG_SDK) console.error(`[SDK-Transport] [${tag}]`, ...args);
}

export class SubprocessTransport {
  private process: ChildProcess | null = null;
  private stdout: Interface | null = null;
  private messageQueue: WireMessage[] = [];
  private messageResolvers: Array<(msg: WireMessage | null) => void> = [];
  private closed = false;
  private agentId?: string;
  private wireMessageCount = 0;
  private lastMessageAt = 0;

  constructor(
    private options: InternalSessionOptions = {}
  ) {}

  /**
   * Start the CLI subprocess
   */
  async connect(): Promise<void> {
    const args = this.buildArgs();

    // Find the CLI - use the installed letta-code package
    const cliPath = await this.findCli();
    sdkLog("connect", `CLI: ${cliPath}`);
    sdkLog("connect", `args: ${args.join(" ")}`);
    sdkLog("connect", `cwd: ${this.options.cwd || process.cwd()}`);
    sdkLog("connect", `permissionMode: ${this.options.permissionMode || "default"}`);

    this.process = spawn("node", [cliPath, ...args], {
      cwd: this.options.cwd || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const pid = this.process.pid;
    sdkLog("connect", `CLI process spawned, pid=${pid}`);

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error("Failed to create subprocess pipes");
    }

    // Set up stdout reading
    this.stdout = createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });

    this.stdout.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as WireMessage;
        this.handleMessage(msg);
      } catch {
        // Non-JSON line from CLI stdout - could be important debug info
        sdkLog("stdout", `[non-JSON] ${line.slice(0, 500)}`);
      }
    });

    // Log stderr for debugging (CLI errors, auth failures, etc.)
    if (this.process.stderr) {
      this.process.stderr.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          console.error("[letta-code-sdk] CLI stderr:", msg);
        }
      });
    }

    // Handle process exit
    //
    // BUG FIX: When the CLI subprocess exits while read() has a pending
    // resolver waiting for the next message, that resolver would never fire.
    // The messages() async generator would be stuck in `await this.read()`
    // forever, causing session.stream() to hang, which deadlocks the
    // caller's processing mutex. Resolving pending readers with null on
    // process exit lets messages() break out of its loop cleanly.
    this.process.on("close", (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(`[letta-code-sdk] CLI process exited with code ${code}`);
      }
      sdkLog("close", `CLI process exited: pid=${pid} code=${code} signal=${signal} wireMessages=${this.wireMessageCount} msSinceLastMsg=${this.lastMessageAt ? Date.now() - this.lastMessageAt : 0} pendingResolvers=${this.messageResolvers.length} queueLen=${this.messageQueue.length}`);
      this.closed = true;
      // Flush pending readers so they don't hang forever (see comment above)
      for (const resolve of this.messageResolvers) {
        resolve(null);
      }
      this.messageResolvers = [];
    });

    this.process.on("error", (err) => {
      console.error("[letta-code-sdk] CLI process error:", err);
      this.closed = true;
    });
  }

  /**
   * Send a message to the CLI via stdin
   */
  async write(data: object): Promise<void> {
    if (!this.process?.stdin || this.closed) {
      const err = new Error(`Transport not connected (closed=${this.closed}, pid=${this.process?.pid}, stdin=${!!this.process?.stdin})`);
      sdkLog("write", err.message);
      throw err;
    }
    const payload = data as Record<string, unknown>;
    sdkLog("write", `type=${payload.type} subtype=${(payload.request as Record<string, unknown>)?.subtype || (payload.response as Record<string, unknown>)?.subtype || "N/A"}`);
    this.process.stdin.write(JSON.stringify(data) + "\n");
  }

  /**
   * Read the next message from the CLI
   */
  async read(): Promise<WireMessage | null> {
    // Return queued message if available
    if (this.messageQueue.length > 0) {
      return this.messageQueue.shift()!;
    }

    // If closed, no more messages
    if (this.closed) {
      sdkLog("read", `returning null (closed), total wireMessages=${this.wireMessageCount}`);
      return null;
    }

    // Wait for next message
    sdkLog("read", `waiting for next message (resolvers=${this.messageResolvers.length + 1}, queue=${this.messageQueue.length})`);
    return new Promise((resolve) => {
      this.messageResolvers.push(resolve);
    });
  }

  /**
   * Async iterator for messages
   */
  async *messages(): AsyncGenerator<WireMessage> {
    while (true) {
      const msg = await this.read();
      if (msg === null) {
        sdkLog("messages", `iterator ending (closed=${this.closed}, wireMessages=${this.wireMessageCount})`);
        break;
      }
      yield msg;
    }
  }

  /**
   * Close the transport
   */
  close(): void {
    sdkLog("close", `explicit close called (wireMessages=${this.wireMessageCount}, pendingResolvers=${this.messageResolvers.length}, pid=${this.process?.pid})`);
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
    this.closed = true;

    // Resolve any pending readers with null
    for (const resolve of this.messageResolvers) {
      resolve(null);
    }
    this.messageResolvers = [];
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private handleMessage(msg: WireMessage): void {
    this.wireMessageCount++;
    this.lastMessageAt = Date.now();

    // Compact log of every wire message for traceability
    const wirePayload = msg as unknown as Record<string, unknown>;
    const msgType = wirePayload.message_type || wirePayload.subtype || "";
    sdkLog("wire", `#${this.wireMessageCount} type=${msg.type} ${msgType ? `msg_type=${msgType}` : ""} resolvers=${this.messageResolvers.length} queue=${this.messageQueue.length}`);

    // Always log critical message types (result, errors, approval)
    if (msg.type === "result") {
      const result = wirePayload as unknown as { subtype?: string; result?: string; duration_ms?: number; stop_reason?: string };
      sdkLog("wire", `RESULT: subtype=${result.subtype} stop_reason=${result.stop_reason || "N/A"} duration=${result.duration_ms}ms resultLen=${result.result?.length || 0}`);
    }

    // Track agent_id from init message
    if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
      this.agentId = (msg as unknown as { agent_id: string }).agent_id;
      sdkLog("wire", `INIT: agent_id=${this.agentId}`);
    }

    // Log control requests (approval flow)
    if (msg.type === "control_request") {
      const req = wirePayload as unknown as { request_id?: string; request?: { subtype?: string; tool_name?: string } };
      sdkLog("wire", `CONTROL_REQUEST: id=${req.request_id} subtype=${req.request?.subtype} tool=${req.request?.tool_name || "N/A"}`);
    }

    // If someone is waiting for a message, give it to them
    if (this.messageResolvers.length > 0) {
      const resolve = this.messageResolvers.shift()!;
      resolve(msg);
    } else {
      // Otherwise queue it
      this.messageQueue.push(msg);
    }
  }

  private buildArgs(): string[] {
    const args: string[] = [
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
    ];

    // Note: All validation happens in validateInternalSessionOptions() called from Session constructor

    // Conversation and agent handling
    if (this.options.conversationId) {
      // Resume specific conversation (derives agent automatically)
      args.push("--conversation", this.options.conversationId);
    } else if (this.options.agentId) {
      // Resume existing agent
      args.push("--agent", this.options.agentId);
      if (this.options.newConversation) {
        // Create new conversation on this agent
        args.push("--new");
      } else if (this.options.defaultConversation) {
        // Use agent's default conversation explicitly
        args.push("--default");
      }
    } else if (this.options.createOnly) {
      // createAgent() - explicitly create new agent
      args.push("--new-agent");
    } else if (this.options.newConversation) {
      // createSession() without agentId - LRU agent + new conversation
      args.push("--new");
    }
    // else: no agent flags = default behavior (LRU agent, default conversation)

    // Model
    if (this.options.model) {
      args.push("-m", this.options.model);
    }

    // Embedding model
    if (this.options.embedding) {
      args.push("--embedding", this.options.embedding);
    }

    // System prompt configuration
    if (this.options.systemPrompt !== undefined) {
      if (typeof this.options.systemPrompt === "string") {
        // Check if it's a valid preset name or custom string
        const validPresets = [
          "default",
          "letta-claude",
          "letta-codex",
          "letta-gemini",
          "claude",
          "codex",
          "gemini",
        ];
        if (validPresets.includes(this.options.systemPrompt)) {
          // Preset name → --system
          args.push("--system", this.options.systemPrompt);
        } else {
          // Custom string → --system-custom
          args.push("--system-custom", this.options.systemPrompt);
        }
      } else {
        // Preset object → --system (+ optional --system-append)
        args.push("--system", this.options.systemPrompt.preset);
        if (this.options.systemPrompt.append) {
          args.push("--system-append", this.options.systemPrompt.append);
        }
      }
    }

    // Memory blocks (only for new agents)
    if (this.options.memory !== undefined && !this.options.agentId) {
      if (this.options.memory.length === 0) {
        // Empty array → no memory blocks (just core)
        args.push("--init-blocks", "");
      } else {
        // Separate preset names from custom/reference blocks
        const presetNames: string[] = [];
        const memoryBlocksJson: Array<
          | { label: string; value: string }
          | { blockId: string }
        > = [];

        for (const item of this.options.memory) {
          if (typeof item === "string") {
            // Preset name
            presetNames.push(item);
          } else if ("blockId" in item) {
            // Block reference - pass to --memory-blocks
            memoryBlocksJson.push(item as { blockId: string });
          } else {
            // CreateBlock
            memoryBlocksJson.push(item as { label: string; value: string });
          }
        }

        // NOTE: When custom blocks are provided via --memory-blocks, they define the complete
        // memory configuration. Preset blocks (--init-blocks) cannot be mixed with custom blocks.
        if (memoryBlocksJson.length > 0) {
          // Use custom blocks only
          args.push("--memory-blocks", JSON.stringify(memoryBlocksJson));
          if (presetNames.length > 0) {
            console.warn(
              "[letta-code-sdk] Using custom memory blocks. " +
              `Preset blocks are ignored when custom blocks are provided: ${presetNames.join(", ")}`
            );
          }
        } else if (presetNames.length > 0) {
          // Use presets only
          args.push("--init-blocks", presetNames.join(","));
        }
      }
    }

    // Convenience props for block values (only for new agents)
    if (!this.options.agentId) {
      if (this.options.persona !== undefined) {
        args.push("--block-value", `persona=${this.options.persona}`);
      }
      if (this.options.human !== undefined) {
        args.push("--block-value", `human=${this.options.human}`);
      }
    }

    // Permission mode
    if (this.options.permissionMode === "bypassPermissions") {
      // Keep using alias for backwards compatibility
      args.push("--yolo");
    } else if (
      this.options.permissionMode &&
      this.options.permissionMode !== "default"
    ) {
      args.push("--permission-mode", this.options.permissionMode);
    }

    // Allowed tools
    if (this.options.allowedTools) {
      args.push("--allowedTools", this.options.allowedTools.join(","));
    }
    if (this.options.disallowedTools) {
      args.push("--disallowedTools", this.options.disallowedTools.join(","));
    }

    return args;
  }

  private async findCli(): Promise<string> {
    // Try multiple resolution strategies
    const { existsSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    // Strategy 1: Check LETTA_CLI_PATH env var
    if (process.env.LETTA_CLI_PATH && existsSync(process.env.LETTA_CLI_PATH)) {
      return process.env.LETTA_CLI_PATH;
    }

    // Strategy 2: Try to resolve from node_modules
    // Note: resolve the package main export (not /letta.js subpath) because
    // the package.json "exports" field doesn't expose the subpath directly.
    try {
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const resolved = require.resolve("@letta-ai/letta-code");
      if (existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // Continue to next strategy
    }

    // Strategy 3: Check relative to this file (for local file: deps)
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const localPaths = [
      join(__dirname, "../../@letta-ai/letta-code/letta.js"),
      join(__dirname, "../../../letta-code-prod/letta.js"),
      join(__dirname, "../../../letta-code/letta.js"),
    ];

    for (const p of localPaths) {
      if (existsSync(p)) {
        return p;
      }
    }

    throw new Error(
      "Letta Code CLI not found. Set LETTA_CLI_PATH or install @letta-ai/letta-code."
    );
  }
}
