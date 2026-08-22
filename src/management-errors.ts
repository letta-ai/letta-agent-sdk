/**
 * The App Server created a fork but the SDK could not retrieve its full state.
 * `conversationId` remains available so the caller can inspect or archive it.
 */
export class ConversationForkHydrationError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string, cause: unknown) {
    super(
      `Conversation ${conversationId} was forked, but its state could not be retrieved.`,
      { cause },
    );
    this.name = "ConversationForkHydrationError";
    this.conversationId = conversationId;
  }
}
