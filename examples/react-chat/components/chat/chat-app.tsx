"use client";

import { ChatComposer } from "./chat-composer";
import { ConversationSidebar } from "./conversation-sidebar";
import { MessageList } from "./message-list";
import { useChatSession } from "@/hooks/use-chat-session";
import { useFollowOutput } from "@/hooks/use-follow-output";
import styles from "@/styles/chat.module.css";

export function ChatApp() {
  const chat = useChatSession();
  const viewportRef = useFollowOutput(chat.messages, chat.activeConversationId);

  return (
    <main className={styles.app}>
      <ConversationSidebar
        activeConversationId={chat.activeConversationId}
        conversations={chat.conversations}
        error={chat.navigationError}
        isBusy={chat.isSending || chat.isNavigating}
        isLoading={chat.isNavigating}
        onNewConversation={chat.startNewConversation}
        onSelectConversation={chat.selectConversation}
      />

      <section className={styles.shell}>
        <MessageList
          isLoading={chat.isNavigating}
          messages={chat.messages}
          viewportRef={viewportRef}
        />
        <ChatComposer
          input={chat.input}
          isNavigating={chat.isNavigating}
          isSending={chat.isSending}
          onInputChange={chat.setInput}
          onSubmit={chat.sendMessage}
        />
      </section>
    </main>
  );
}
