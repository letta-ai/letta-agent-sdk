import type { Dispatch, FormEvent, SetStateAction } from "react";
import { ThinkingOrb } from "thinking-orbs";
import styles from "@/styles/chat.module.css";

type ChatComposerProps = {
  input: string;
  isSending: boolean;
  isNavigating: boolean;
  onInputChange: Dispatch<SetStateAction<string>>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function ChatComposer({
  input,
  isSending,
  isNavigating,
  onInputChange,
  onSubmit,
}: ChatComposerProps) {
  return (
    <form aria-busy={isSending} className={styles.composer} onSubmit={onSubmit}>
      <input
        aria-label="Message"
        disabled={isSending || isNavigating}
        onChange={(event) => onInputChange(event.target.value)}
        placeholder={isSending ? "Agent is working…" : "Message your agent"}
        value={input}
      />
      <button
        aria-label={isSending ? "Agent is responding" : "Send message"}
        className={isSending ? styles.sendingButton : undefined}
        disabled={isSending || isNavigating || !input.trim()}
      >
        {isSending ? (
          <ThinkingOrb
            aria-hidden="true"
            size={20}
            state="composing"
            theme="dark"
          />
        ) : (
          "↑"
        )}
      </button>
    </form>
  );
}
