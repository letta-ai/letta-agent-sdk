import type { RefObject } from "react";
import type { ChatMessage } from "@/lib/letta/transcript";
import { TranscriptMessage } from "./transcript-message";
import styles from "@/styles/chat.module.css";

type MessageListProps = {
  messages: ChatMessage[];
  isLoading: boolean;
  viewportRef: RefObject<HTMLDivElement | null>;
};

export function MessageList({
  messages,
  isLoading,
  viewportRef,
}: MessageListProps) {
  return (
    <div className={styles.thread} aria-live="polite" ref={viewportRef}>
      {messages.length === 0 && !isLoading && (
        <div className={styles.empty}>
          <h1>How can I help?</h1>
        </div>
      )}
      {messages.map((message) => (
        <TranscriptMessage key={message.id} message={message} />
      ))}
    </div>
  );
}
