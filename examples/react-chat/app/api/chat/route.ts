import {
  LettaAgentClient,
  type LettaCodeSession,
} from "@letta-ai/letta-agent-sdk/client";
import type { BrowserEvent } from "@/lib/letta/browser-events";

export const runtime = "nodejs";

function requireEnvironmentVariable(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

function writeEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  event: BrowserEvent,
) {
  controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
}

export async function POST(request: Request) {
  let session: LettaCodeSession | undefined;

  try {
    const body = (await request.json()) as {
      message?: unknown;
      conversationId?: unknown;
    };
    if (typeof body.message !== "string" || !body.message.trim()) {
      return Response.json({ error: "Message is required." }, { status: 400 });
    }
    if (
      typeof body.conversationId !== "string" ||
      !body.conversationId.trim()
    ) {
      return Response.json(
        { error: "Conversation ID is required." },
        { status: 400 },
      );
    }

    // For local mode, import from the package root and use backend: "local".
    const client = new LettaAgentClient({
      backend: "cloud",
      apiKey: requireEnvironmentVariable("LETTA_API_KEY"),
    });

    const conversationId = body.conversationId.trim();
    const conversation = await client.conversations.retrieve(conversationId);
    if (
      conversation.agent_id !==
      requireEnvironmentVariable("LETTA_CHAT_AGENT_ID")
    ) {
      return Response.json(
        { error: "Conversation does not belong to this agent." },
        { status: 403 },
      );
    }

    session = client.resumeSession(conversationId);
    await session.send(body.message.trim());
  } catch (error) {
    session?.close();
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }

  const activeSession = session;
  const encoder = new TextEncoder();
  let streamClosed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let failure: string | undefined;

      try {
        streamMessages: for await (const message of activeSession.stream()) {
          switch (message.type) {
            case "assistant":
              // The browser appends each fragment to the current reply.
              writeEvent(controller, encoder, {
                type: "assistant",
                content: message.content,
              });
              break;

            case "reasoning":
              writeEvent(controller, encoder, {
                type: "reasoning",
                content: message.content,
              });
              break;

            case "tool_call":
              // A tool can emit more than one update with the same call ID.
              writeEvent(controller, encoder, {
                type: "tool_call",
                id: message.toolCallId,
                name: message.toolName,
                input: message.toolInput,
                inputFragment:
                  message.rawArguments ??
                  (typeof message.toolInput.raw === "string"
                    ? message.toolInput.raw
                    : ""),
              });
              break;

            case "tool_result":
              // Report completion, but keep the tool's raw output on the server.
              writeEvent(controller, encoder, {
                type: "tool_result",
                id: message.toolCallId,
                isError: message.isError,
              });
              break;

            case "error":
              failure = message.errorDetail ?? message.message;
              break;

            case "result":
              if (!message.success) {
                failure =
                  failure ??
                  message.errorDetail ??
                  message.errorCode ??
                  "Turn failed.";
              }
              break streamMessages;
          }
        }

        writeEvent(
          controller,
          encoder,
          failure ? { type: "error", message: failure } : { type: "done" },
        );
      } catch (error) {
        if (!streamClosed) {
          writeEvent(controller, encoder, {
            type: "error",
            message: errorMessage(error),
          });
        }
      } finally {
        if (!streamClosed) {
          streamClosed = true;
          activeSession.close();
          controller.close();
        }
      }
    },
    cancel() {
      if (!streamClosed) {
        streamClosed = true;
        activeSession.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "application/x-ndjson; charset=utf-8",
    },
  });
}
