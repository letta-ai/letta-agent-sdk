import { describe, expect, test } from "bun:test";
import type { LettaAgentClient } from "../client.js";
import type { LettaCodeSession } from "../types.js";

type AssertTrue<T extends true> = T;
type AssertFalse<T extends false> = T;
type HasKey<K extends PropertyKey> = K extends keyof LettaCodeSession ? true : false;

type _HasSend = AssertTrue<HasKey<"send">>;
type _HasReady = AssertTrue<HasKey<"ready">>;
type _HasSandbox = AssertTrue<HasKey<"sandbox">>;
type _HasStream = AssertTrue<HasKey<"stream">>;
type _HasAbort = AssertTrue<HasKey<"abort">>;
type _HasSendCommand = AssertTrue<HasKey<"sendCommand">>;
type _HasListMessages = AssertTrue<HasKey<"listMessages">>;
type _HasListModels = AssertTrue<HasKey<"listModels">>;
type _HasUpdateModel = AssertTrue<HasKey<"updateModel">>;
type _HasBootstrapState = AssertTrue<HasKey<"bootstrapState">>;
type _HasRecoverPendingApprovals = AssertTrue<HasKey<"recoverPendingApprovals">>;
type _HasChangeDeviceState = AssertTrue<HasKey<"changeDeviceState">>;
type _HasRemoveQueuedMessage = AssertTrue<HasKey<"removeQueuedMessage">>;
type _HasGetDeviceStatus = AssertTrue<HasKey<"getDeviceStatus">>;
type _HasOnDeviceStatus = AssertTrue<HasKey<"onDeviceStatus">>;
type _HasClose = AssertTrue<HasKey<"close">>;
type _NoInitialize = AssertFalse<HasKey<"initialize">>;
type _NoRunTurn = AssertFalse<HasKey<"runTurn">>;
type _NoUpdateToolset = AssertFalse<HasKey<"updateToolset">>;

type HasClientKey<K extends PropertyKey> =
  K extends keyof LettaAgentClient ? true : false;
type _ClientHasClose = AssertTrue<HasClientKey<"close">>;
type _ClientHasAsyncDispose = AssertTrue<HasClientKey<typeof Symbol.asyncDispose>>;

describe("public LettaCodeSession type", () => {
  test("keeps the canonical public session surface", () => {
    expect(true).toBe(true);
  });
});
