"use client";

import { useCallback, useEffect, useRef } from "react";
import type { ChatMessage } from "@/lib/letta/transcript";

export function useFollowOutput(
  messages: ChatMessage[],
  conversationId?: string,
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const shouldFollow = useRef(true);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const updateFollowMode = () => {
      const distanceFromBottom =
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
      shouldFollow.current = distanceFromBottom <= 120;
    };

    updateFollowMode();
    viewport.addEventListener("scroll", updateFollowMode, { passive: true });
    return () => viewport.removeEventListener("scroll", updateFollowMode);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && shouldFollow.current) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [messages]);

  const followLatest = useCallback(() => {
    shouldFollow.current = true;
    requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
  }, []);

  useEffect(() => {
    followLatest();
  }, [conversationId, followLatest]);

  return viewportRef;
}
