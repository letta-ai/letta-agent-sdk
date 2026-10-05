import type Letta from "@letta-ai/letta-client";
import { DecisionsClient } from "./decisions.js";

/** Experimental Cloud APIs. No stability or compatibility guarantee. */
export class AlphaClient {
  private decisionsClient: DecisionsClient | null = null;

  constructor(
    private readonly client: Letta,
    private readonly assertOpen: () => void,
  ) {}

  /** Classify supplied evidence without creating an agent or sandbox. */
  get decisions(): DecisionsClient {
    this.assertOpen();
    this.decisionsClient ??= new DecisionsClient(this.client, this.assertOpen);
    return this.decisionsClient;
  }
}
