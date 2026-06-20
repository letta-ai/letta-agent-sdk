import { describe, expect, test } from "bun:test";
import type { LettaCodeSession } from "../types.js";

type AssertTrue<T extends true> = T;
type AssertFalse<T extends false> = T;
type HasKey<K extends PropertyKey> = K extends keyof LettaCodeSession ? true : false;

type _HasSend = AssertTrue<HasKey<"send">>;
type _HasStream = AssertTrue<HasKey<"stream">>;
type _HasListMessages = AssertTrue<HasKey<"listMessages">>;
type _HasClose = AssertTrue<HasKey<"close">>;
type _NoInitialize = AssertFalse<HasKey<"initialize">>;
type _NoRunTurn = AssertFalse<HasKey<"runTurn">>;
type _NoRecoverPendingApprovals = AssertFalse<HasKey<"recoverPendingApprovals">>;
type _NoUpdateToolset = AssertFalse<HasKey<"updateToolset">>;
type _NoBootstrapState = AssertFalse<HasKey<"bootstrapState">>;

describe("public LettaCodeSession type", () => {
  test("keeps the canonical public session surface", () => {
    expect(true).toBe(true);
  });
});
