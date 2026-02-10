import { describe, expect, test, mock } from "bun:test";
import { Session } from "./session.js";

describe("Session", () => {
  describe("handleCanUseTool with bypassPermissions", () => {
    test("auto-approves tools when permissionMode is bypassPermissions", async () => {
      // Create a session with bypassPermissions
      const session = new Session({
        permissionMode: "bypassPermissions",
      });

      // Access the private method for testing
      // @ts-expect-error - accessing private method for testing
      const handleCanUseTool = session.handleCanUseTool.bind(session);

      // Mock the transport.write to capture the response
      let capturedResponse: unknown;
      // @ts-expect-error - accessing private property for testing
      session.transport.write = async (msg: unknown) => {
        capturedResponse = msg;
      };

      // Simulate a control_request for tool approval
      await handleCanUseTool("test-request-id", {
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_call_id: "test-tool-call-id",
        input: { command: "ls" },
        permission_suggestions: [],
        blocked_path: null,
      });

      // Verify the response auto-approves
      expect(capturedResponse).toEqual({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "test-request-id",
          response: {
            behavior: "allow",
            updatedInput: null,
            updatedPermissions: [],
          },
        },
      });
    });

    test("denies tools by default when no callback and not bypassPermissions", async () => {
      // Create a session with default permission mode
      const session = new Session({
        permissionMode: "default",
      });

      // @ts-expect-error - accessing private method for testing
      const handleCanUseTool = session.handleCanUseTool.bind(session);

      let capturedResponse: unknown;
      // @ts-expect-error - accessing private property for testing
      session.transport.write = async (msg: unknown) => {
        capturedResponse = msg;
      };

      await handleCanUseTool("test-request-id", {
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_call_id: "test-tool-call-id",
        input: { command: "ls" },
        permission_suggestions: [],
        blocked_path: null,
      });

      // Verify the response denies (no callback registered)
      expect(capturedResponse).toEqual({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "test-request-id",
          response: {
            behavior: "deny",
            message: "No canUseTool callback registered",
            interrupt: false,
          },
        },
      });
    });

    test("uses canUseTool callback when provided and not bypassPermissions", async () => {
      const session = new Session({
        permissionMode: "default",
        canUseTool: async (toolName, input) => {
          if (toolName === "Bash") {
            return { behavior: "allow" };
          }
          return { behavior: "deny", message: "Tool not allowed" };
        },
      });

      // @ts-expect-error - accessing private method for testing
      const handleCanUseTool = session.handleCanUseTool.bind(session);

      let capturedResponse: unknown;
      // @ts-expect-error - accessing private property for testing
      session.transport.write = async (msg: unknown) => {
        capturedResponse = msg;
      };

      await handleCanUseTool("test-request-id", {
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_call_id: "test-tool-call-id",
        input: { command: "ls" },
        permission_suggestions: [],
        blocked_path: null,
      });

      // Verify callback was used and allowed
      expect(capturedResponse).toMatchObject({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "test-request-id",
          response: {
            behavior: "allow",
          },
        },
      });
    });
  });
});
