import { expect, test } from "bun:test";
import { createQuery } from "../query.js";
import type { LettaCodeSession, SDKMessage } from "../types.js";

test.each(["complete", "close", "break", "send failure"])(
  "query retains its receipt after %s even when session close clears identity",
  async (ending) => {
    const message: SDKMessage = {
      type: "assistant",
      uuid: "message-1",
      content: "done",
    };
    const session = {
      conversationId: null as string | null,
      agentId: null as string | null,
      async send() {
        this.conversationId = "conv-receipt";
        if (ending === "send failure") throw new Error("send failed");
      },
      async *stream() {
        yield message;
      },
      close() {
        this.conversationId = null;
        this.agentId = null;
      },
    };
    const query = createQuery(async () => session as unknown as LettaCodeSession, {
      prompt: "hello",
      options: { model: "test/model", system: "test" },
    });
    expect(query.conversationId).toBeNull();
    expect(query.agentId).toBeNull();
    expect(Object.getOwnPropertyDescriptor(query, "conversationId")?.get).toBeFunction();
    expect(Object.getOwnPropertyDescriptor(query, "conversationId")?.set).toBeUndefined();
    const messages: SDKMessage[] = [];
    const consume = async () => {
      for await (const event of query) {
        expect(query.conversationId).toBe("conv-receipt");
        messages.push(event);
        if (ending === "close") query.close();
        if (ending === "break") break;
      }
    };
    if (ending === "send failure") {
      await expect(consume()).rejects.toThrow("send failed");
    } else {
      await consume();
      expect(messages).toEqual([message]);
    }
    expect(session.conversationId).toBeNull();
    expect(query.conversationId).toBe("conv-receipt");
    expect(query.agentId).toBeNull();
    query.close();
    expect(query.conversationId).toBe("conv-receipt");
  },
);
