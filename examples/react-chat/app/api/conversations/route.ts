import { LettaAgentClient } from "@letta-ai/letta-agent-sdk/client";
import { projectTranscript } from "@/lib/letta/transcript";

export const runtime = "nodejs";

function requireEnvironmentVariable(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function getClient() {
  return new LettaAgentClient({
    backend: "cloud",
    apiKey: requireEnvironmentVariable("LETTA_API_KEY"),
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

async function belongsToAgent(
  client: LettaAgentClient,
  conversationId: string,
) {
  const conversation = await client.conversations.retrieve(conversationId);
  return (
    conversation.agent_id === requireEnvironmentVariable("LETTA_CHAT_AGENT_ID")
  );
}

function conversationItem(conversation: {
  id: string;
  summary?: string | null;
}) {
  return {
    id: conversation.id,
    title: conversation.summary?.trim() || "New conversation",
  };
}

export async function GET(request: Request) {
  try {
    const client = getClient();
    const conversationId = new URL(request.url).searchParams.get(
      "conversationId",
    );

    if (conversationId) {
      if (!(await belongsToAgent(client, conversationId))) {
        return Response.json(
          { error: "Conversation does not belong to this agent." },
          { status: 403 },
        );
      }
      const session = client.resumeSession(conversationId);
      try {
        const state = await session.bootstrapState({
          order: "desc",
          limit: 100,
        });
        if (
          state.agentId !== requireEnvironmentVariable("LETTA_CHAT_AGENT_ID")
        ) {
          return Response.json(
            { error: "Conversation does not belong to this agent." },
            { status: 403 },
          );
        }

        return Response.json({
          bootstrap: {
            conversationId: state.conversationId,
            messages: projectTranscript([...state.messages].reverse()),
            nextBefore: state.nextBefore,
            hasMore: state.hasMore,
          },
        });
      } finally {
        session.close();
      }
    }

    const conversations = await client.conversations.list({
      agentId: requireEnvironmentVariable("LETTA_CHAT_AGENT_ID"),
      archiveStatus: "unarchived",
      order: "desc",
      orderBy: "lastMessageAt",
      limit: 20,
    });
    return Response.json({
      conversations: conversations
        .filter((conversation) => conversation.last_message_at)
        .map(conversationItem),
    });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      title?: unknown;
    };
    if (typeof body.title !== "string" || !body.title.trim()) {
      return Response.json(
        { error: "Conversation title is required." },
        { status: 400 },
      );
    }

    const conversation = await getClient().conversations.create({
      agentId: requireEnvironmentVariable("LETTA_CHAT_AGENT_ID"),
      summary: body.title.trim().slice(0, 60),
    });
    return Response.json({ conversation: conversationItem(conversation) });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as {
      conversationId?: unknown;
      title?: unknown;
    };
    if (
      typeof body.conversationId !== "string" ||
      typeof body.title !== "string" ||
      !body.title.trim()
    ) {
      return Response.json(
        { error: "Conversation ID and title are required." },
        { status: 400 },
      );
    }

    const client = getClient();
    if (!(await belongsToAgent(client, body.conversationId))) {
      return Response.json(
        { error: "Conversation does not belong to this agent." },
        { status: 403 },
      );
    }
    const conversation = await client.conversations.update(
      body.conversationId,
      {
        summary: body.title.trim().slice(0, 60),
      },
    );
    return Response.json({ conversation: conversationItem(conversation) });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }
}
