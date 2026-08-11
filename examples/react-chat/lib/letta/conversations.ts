import type { ChatMessage } from "./transcript";

export type ConversationItem = {
  id: string;
  title: string;
};

async function responseJson<T>(response: Response) {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return body;
}

export async function listConversations() {
  const response = await fetch("/api/conversations");
  const body = await responseJson<{ conversations: ConversationItem[] }>(
    response,
  );
  return body.conversations;
}

export async function createConversation(title: string) {
  const response = await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const body = await responseJson<{ conversation: ConversationItem }>(response);
  return body.conversation;
}

export async function bootstrapConversation(conversationId: string) {
  const response = await fetch(
    `/api/conversations?conversationId=${encodeURIComponent(conversationId)}`,
  );
  const body = await responseJson<{
    bootstrap: { conversationId: string; messages: ChatMessage[] };
  }>(response);
  if (body.bootstrap.conversationId !== conversationId) {
    throw new Error("The server returned the wrong conversation.");
  }
  return body.bootstrap.messages;
}

export async function renameConversation(
  conversationId: string,
  title: string,
) {
  const response = await fetch("/api/conversations", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, title }),
  });
  await responseJson(response);
}
