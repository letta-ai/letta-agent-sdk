import type { ConversationItem } from "@/lib/letta/conversations";
import styles from "@/styles/chat.module.css";

type ConversationSidebarProps = {
  conversations: ConversationItem[];
  activeConversationId?: string;
  isBusy: boolean;
  isLoading: boolean;
  error?: string;
  onNewConversation: () => void;
  onSelectConversation: (conversationId: string) => void;
};

export function ConversationSidebar({
  conversations,
  activeConversationId,
  isBusy,
  isLoading,
  error,
  onNewConversation,
  onSelectConversation,
}: ConversationSidebarProps) {
  return (
    <aside className={styles.sidebar}>
      <button
        className={styles.newConversation}
        disabled={isBusy}
        onClick={onNewConversation}
        type="button"
      >
        <span aria-hidden="true">＋</span>
        New conversation
      </button>

      <nav aria-label="Conversations" className={styles.conversationList}>
        {conversations.map((conversation) => (
          <button
            aria-current={
              conversation.id === activeConversationId ? "page" : undefined
            }
            className={`${styles.conversation} ${
              conversation.id === activeConversationId ? styles.active : ""
            }`}
            disabled={isBusy}
            key={conversation.id}
            onClick={() => onSelectConversation(conversation.id)}
            title={conversation.title}
            type="button"
          >
            {conversation.title}
          </button>
        ))}
      </nav>

      {isLoading && <p className={styles.sidebarStatus}>Loading…</p>}
      {error && <p className={styles.sidebarError}>{error}</p>}
    </aside>
  );
}
