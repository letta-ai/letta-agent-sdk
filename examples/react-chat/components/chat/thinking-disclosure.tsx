"use client";

import { useEffect, useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "@/styles/chat.module.css";

function ReasoningContent({ content }: { content: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [content]);

  return (
    <div
      aria-live="off"
      className={`${styles.markdown} ${styles.thinkingContent}`}
      ref={viewportRef}
    >
      <Markdown disallowedElements={["img"]} remarkPlugins={[remarkGfm]}>
        {content}
      </Markdown>
    </div>
  );
}

export function ThinkingDisclosure({
  content,
  complete,
}: {
  content: string;
  complete: boolean;
}) {
  return complete ? (
    <details className={styles.thinkingDrawer}>
      <summary>Thinking</summary>
      <ReasoningContent content={content} />
    </details>
  ) : (
    <section aria-label="Thinking" className={styles.thinkingPreview}>
      <header className={styles.thinkingHeader}>Thinking…</header>
      <ReasoningContent content={content} />
    </section>
  );
}
