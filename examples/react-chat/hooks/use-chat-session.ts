"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  applyBrowserEvent,
  readBrowserEvents,
  type BrowserEvent,
} from "@/lib/letta/browser-events";
import {
  bootstrapConversation,
  createConversation,
  listConversations,
  renameConversation,
  type ConversationItem,
} from "@/lib/letta/conversations";
import type { ChatMessage } from "@/lib/letta/transcript";

type ConversationBootstrap = {
  conversations: ConversationItem[];
  activeConversationId?: string;
  messages: ChatMessage[];
};

let bootstrapPromise: Promise<ConversationBootstrap> | undefined;

async function runConversationBootstrap(): Promise<ConversationBootstrap> {
  const conversations = await listConversations();
  const storedId = window.sessionStorage.getItem("letta-conversation-id");
  const active = conversations.find(
    (conversation) => conversation.id === storedId,
  );
  const messages = active ? await bootstrapConversation(active.id) : [];

  if (active) {
    window.sessionStorage.setItem("letta-conversation-id", active.id);
  } else {
    window.sessionStorage.removeItem("letta-conversation-id");
  }
  return {
    conversations,
    activeConversationId: active?.id,
    messages,
  };
}

function bootstrapConversations() {
  // React Strict Mode can run an Effect twice in development. Both runs share
  // one list and bootstrap request through this module-level Promise.
  if (!bootstrapPromise) {
    const pending = runConversationBootstrap();
    bootstrapPromise = pending;
    const clearPending = () => {
      if (bootstrapPromise === pending) bootstrapPromise = undefined;
    };
    pending.then(clearPending, clearPending);
  }
  return bootstrapPromise;
}

function conversationTitle(text: string) {
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

export function useChatSession() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string>();
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isNavigating, setIsNavigating] = useState(true);
  const [navigationError, setNavigationError] = useState<string>();

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const result = await bootstrapConversations();
        if (cancelled) return;
        setConversations(result.conversations);
        setActiveConversationId(result.activeConversationId);
        setMessages(result.messages);
      } catch (error) {
        if (!cancelled) {
          setNavigationError(
            error instanceof Error ? error.message : "Could not load chats.",
          );
        }
      } finally {
        if (!cancelled) setIsNavigating(false);
      }
    }

    void start();
    return () => {
      cancelled = true;
    };
  }, []);

  function applyEvent(messageId: string, event: BrowserEvent) {
    setMessages((current) =>
      current.map((message) =>
        message.id === messageId ? applyBrowserEvent(message, event) : message,
      ),
    );
  }

  async function selectConversation(conversationId: string) {
    if (isSending || isNavigating || conversationId === activeConversationId) {
      return;
    }

    setIsNavigating(true);
    setNavigationError(undefined);
    try {
      const restoredMessages = await bootstrapConversation(conversationId);
      window.sessionStorage.setItem("letta-conversation-id", conversationId);
      setActiveConversationId(conversationId);
      setMessages(restoredMessages);
    } catch (error) {
      setNavigationError(
        error instanceof Error ? error.message : "Could not load that chat.",
      );
    } finally {
      setIsNavigating(false);
    }
  }

  function startNewConversation() {
    if (isSending || isNavigating) return;
    setNavigationError(undefined);
    window.sessionStorage.removeItem("letta-conversation-id");
    setActiveConversationId(undefined);
    setMessages([]);
    setInput("");
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isSending || isNavigating) return;

    const assistantId = crypto.randomUUID();
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", content: text }],
        complete: true,
      },
      {
        id: assistantId,
        role: "assistant",
        parts: [],
        complete: false,
      },
    ]);
    setInput("");
    setIsSending(true);

    try {
      let conversationId = activeConversationId;
      if (!conversationId) {
        const conversation = await createConversation(text);
        conversationId = conversation.id;
        window.sessionStorage.setItem("letta-conversation-id", conversation.id);
        setConversations((current) => [conversation, ...current]);
        setActiveConversationId(conversation.id);
      } else {
        const current = conversations.find(
          (conversation) => conversation.id === conversationId,
        );
        if (current?.title === "New conversation") {
          const title = conversationTitle(text);
          setConversations((items) =>
            items.map((item) =>
              item.id === conversationId ? { ...item, title } : item,
            ),
          );
          void renameConversation(conversationId, title).catch(() => undefined);
        }
      }

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, conversationId }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? `Request failed: ${response.status}`);
      }

      for await (const streamEvent of readBrowserEvents(response)) {
        applyEvent(assistantId, streamEvent);
      }
    } catch (error) {
      applyEvent(assistantId, {
        type: "error",
        message: error instanceof Error ? error.message : "Request failed.",
      });
    } finally {
      setIsSending(false);
    }
  }

  return {
    messages,
    conversations,
    activeConversationId,
    input,
    setInput,
    isSending,
    isNavigating,
    navigationError,
    selectConversation,
    startNewConversation,
    sendMessage,
  };
}
