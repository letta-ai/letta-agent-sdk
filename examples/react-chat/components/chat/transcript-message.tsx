import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "@/lib/letta/transcript";
import { ThinkingDisclosure } from "./thinking-disclosure";
import { ToolDisclosure } from "./tool-disclosure";
import styles from "@/styles/chat.module.css";

export function TranscriptMessage({ message }: { message: ChatMessage }) {
  return (
    <article className={`${styles.message} ${styles[message.role]}`}>
      {message.parts.map((part, index) => {
        if (part.type === "reasoning") {
          return (
            <ThinkingDisclosure
              complete={part.complete}
              content={part.content}
              key={`reasoning-${index}`}
            />
          );
        }
        if (part.type === "tools") {
          return <ToolDisclosure key={`tools-${index}`} tools={part.tools} />;
        }
        return message.role === "assistant" ? (
          <div className={styles.markdown} key={`text-${index}`}>
            <Markdown disallowedElements={["img"]} remarkPlugins={[remarkGfm]}>
              {part.content}
            </Markdown>
          </div>
        ) : (
          <p key={`text-${index}`}>{part.content}</p>
        );
      })}
      {message.error && <p className={styles.error}>Error: {message.error}</p>}
    </article>
  );
}
