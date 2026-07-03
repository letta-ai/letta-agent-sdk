import { describe, expect, test } from "bun:test";
import { mapPermissionMode } from "../remote-client-session-core.js";

describe("mapPermissionMode", () => {
  test("maps unset and default modes to app-server standard mode", () => {
    expect(mapPermissionMode(undefined)).toBe("standard");
    expect(mapPermissionMode("default")).toBe("standard");
  });

  test("maps explicit SDK modes to app-server device modes", () => {
    expect(mapPermissionMode("standard")).toBe("standard");
    expect(mapPermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(mapPermissionMode("plan")).toBe("memory");
    expect(mapPermissionMode("bypassPermissions")).toBe("unrestricted");
  });
});
