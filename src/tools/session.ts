import { z } from "zod";
import type { Tool, ToolSchema, ToolResult } from "./tool.js";
import type { Context } from "../context.js";
import type { ToolActionResult } from "../types/types.js";
import { Browserbase } from "@browserbasehq/sdk";
import { randomUUID } from "crypto";
import { createUIResource } from "@mcp-ui/server";
import type { BrowserSession } from "../types/types.js";
import { TextContent } from "@modelcontextprotocol/sdk/types.js";

const EXCEED_QUOTA_MESSAGE = "exceed quota";

// --- Tool: Create Session ---
const CreateSessionInputSchema = z.object({
  // Keep sessionId optional
  sessionId: z
    .string()
    .optional()
    .describe(
      "Optional session ID to use/reuse. If not provided or invalid, a new session is created.",
    ),
  contextId: z
    .string()
    .optional()
    .describe(
      "Optional Browserbase context ID. Pass this in the request when you want the session to run in a specific context.",
    ),
  persist: z
    .boolean()
    .optional()
    .describe(
      "Optional context persistence flag when contextId is provided (defaults to true).",
    ),
});
type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;

const createSessionSchema: ToolSchema<typeof CreateSessionInputSchema> = {
  name: "browserbase_session_create",
  description:
    "Create or reuse a Browserbase browser session and set it as active. You can optionally pass contextId in this request to run the session in a specific Browserbase context. If contextId is omitted, the server generates one and returns it.",
  inputSchema: CreateSessionInputSchema,
};

// Handle function for CreateSession using SessionManager
async function handleCreateSession(
  context: Context,
  params: CreateSessionInput,
): Promise<ToolResult> {
  const action = async (): Promise<ToolActionResult> => {
    try {
      const sessionManager = context.getSessionManager();
      const config = context.config; // Get config from context
      const providedSessionId =
        typeof params.sessionId === "string" && params.sessionId.length > 0
          ? params.sessionId
          : undefined;
      let targetSessionId: string;
      const bb = new Browserbase({
        apiKey: config.browserbaseApiKey,
      });

      if (!providedSessionId) {
        await billForCreateSession(context);
      }

      const effectiveContextId =
        params.contextId ||
        (
          await bb.contexts.create({
            projectId: config.browserbaseProjectId,
          })
        ).id;

      // Session ID Strategy: Use raw sessionId for both internal tracking and Browserbase operations
      // Default session uses generated ID with timestamp/UUID, user sessions use provided ID as-is
      if (providedSessionId) {
        targetSessionId = providedSessionId;
        process.stderr.write(
          `[tool.createSession] Attempting to create/assign session with specified ID: ${targetSessionId}\n`,
        );
      } else {
        targetSessionId = sessionManager.getDefaultSessionId();
      }

      const defaultSessionId = sessionManager.getDefaultSessionId();
      if (targetSessionId === defaultSessionId) {
        // Avoid mutating/reusing the default session when context is passed/generated per request.
        targetSessionId = `browserbase_session_${Date.now()}_${randomUUID()}`;
      }
      const session: BrowserSession =
        await sessionManager.createNewBrowserSession(
          targetSessionId, // Internal session ID for tracking
          config,
          {
            resumeSessionId: providedSessionId, // Browserbase session ID to resume
            contextId: effectiveContextId,
            contextPersist: params.persist,
          },
        );

      if (
        !session ||
        !session.page ||
        !session.sessionId ||
        !session.stagehand
      ) {
        throw new Error(
          `SessionManager failed to return a valid session object with actualSessionId for ID: ${targetSessionId}`,
        );
      }

      // Note: No need to set context.currentSessionId - SessionManager handles this
      // and context.currentSessionId is a getter that delegates to SessionManager
      const browserbaseSessionId = session.stagehand.browserbaseSessionId;
      if (!browserbaseSessionId) {
        throw new Error(
          "Browserbase session ID not found in Stagehand instance",
        );
      }
      const debugUrl = (await bb.sessions.debug(browserbaseSessionId))
        .debuggerFullscreenUrl;
      const returnedContextId = session.contextId ?? effectiveContextId;

      return {
        content: [
          {
            type: "text",
            text: `MCP Session ID: ${targetSessionId}`,
          },
          {
            type: "text",
            text: `Browserbase Live Session View URL: https://www.browserbase.com/sessions/${browserbaseSessionId}`,
          },
          {
            type: "text",
            text: `Browserbase Live Debugger URL: ${debugUrl}`,
          },
          {
            type: "text",
            text: `Browserbase Context ID: ${returnedContextId}`,
          },
          createUIResource({
            uri: "ui://analytics-dashboard/main",
            content: { type: "externalUrl", iframeUrl: debugUrl },
            encoding: "text",
          }) as unknown as TextContent,
        ],
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[tool.createSession] Action failed: ${errorMessage}\n`,
      );
      if (errorMessage === EXCEED_QUOTA_MESSAGE) {
        throw new Error(EXCEED_QUOTA_MESSAGE);
      }
      // Re-throw to be caught by Context.run's error handling for actions
      throw new Error(`Failed to create Browserbase session: ${errorMessage}`);
    }
  };

  // Return the ToolResult structure expected by Context.run
  return {
    action: action,
    waitForNetwork: false,
  };
}

// Define tool using handle
const createSessionTool: Tool<typeof CreateSessionInputSchema> = {
  capability: "core", // Add capability
  schema: createSessionSchema,
  handle: handleCreateSession,
};

async function billForCreateSession(context: Context): Promise<void> {
  const authorization = context.getBearerAuthorization();
  if (!authorization) {
    throw new Error("Missing Authorization bearer token");
  }
  const billingServiceUrl =
    context.config.billingServiceUrl ??
    "https://ecap-proxy-service.panda-api.zooclaw.ai/";
  const billingUrl = new URL("/browser/billing", billingServiceUrl).toString();

  const litellmApiBase = getRequiredRequestHeader(context, [
    "litellm_api_base",
    "litellm-api-base",
    "x-litellm-api-base",
  ]);
  const litellmApiKey = getRequiredRequestHeader(context, [
    "litellm_api_key",
    "litellm-api-key",
    "x-litellm-api-key",
  ]);

  try {
    const response = await fetch(billingUrl, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        litellm_api_base: litellmApiBase,
        litellm_api_key: litellmApiKey,
        billing_params: {
          timestamp: Date.now(),
          properties: {
            model: "browserbase",
            total_tokens: 30,
            prompt_tokens: 30,
            completion_tokens: 30,
            response_cost: 0.05,
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(EXCEED_QUOTA_MESSAGE);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === EXCEED_QUOTA_MESSAGE
    ) {
      throw error;
    }

    process.stderr.write(
      `[tool.createSession] Billing request failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    throw new Error(EXCEED_QUOTA_MESSAGE);
  }
}

function getRequiredRequestHeader(
  context: Context,
  headerNames: string[],
): string {
  for (const headerName of headerNames) {
    const value = context.getRequestHeader(headerName);
    if (value) return value;
  }

  throw new Error(`Missing required header: ${headerNames[0]}`);
}

// --- Tool: Close Session ---
const CloseSessionInputSchema = z.object({
  sessionId: z.string().min(1).describe("Required MCP session ID to close."),
});
type CloseSessionInput = z.infer<typeof CloseSessionInputSchema>;

const closeSessionSchema: ToolSchema<typeof CloseSessionInputSchema> = {
  name: "browserbase_session_close",
  description: "Close the specified Browserbase session by MCP session ID.",
  inputSchema: CloseSessionInputSchema,
};

async function handleCloseSession(
  context: Context,
  params: CloseSessionInput,
): Promise<ToolResult> {
  const action = async (): Promise<ToolActionResult> => {
    const targetSessionId = params.sessionId;
    const wasActiveSession = context.currentSessionId === targetSessionId;
    let cleanupSuccessful = false;
    let cleanupErrorMessage = "";

    // Step 1: Get session info before cleanup
    let browserbaseSessionId: string | undefined;
    const sessionManager = context.getSessionManager();

    try {
      const session = sessionManager.getManagedSession(targetSessionId);

      if (session && session.stagehand) {
        // Store the actual Browserbase session ID for the replay URL
        browserbaseSessionId = session.sessionId;

        // cleanupSession handles both closing Stagehand and cleanup (idempotent)
        await sessionManager.cleanupSession(targetSessionId);
        cleanupSuccessful = true;
      } else {
        process.stderr.write(
          `[tool.closeSession] No session found for ID: ${targetSessionId}\n`,
        );
      }
    } catch (error: unknown) {
      cleanupErrorMessage =
        error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[tool.closeSession] Error cleaning up session (ID was ${targetSessionId}): ${cleanupErrorMessage}\n`,
      );
    }

    // Step 2: Determine the result message
    if (cleanupErrorMessage && !cleanupSuccessful) {
      throw new Error(
        `Failed to cleanup session '${targetSessionId}'. Error: ${cleanupErrorMessage}`,
      );
    }

    if (cleanupSuccessful) {
      let successMessage = `Browserbase session ('${targetSessionId}') closed successfully.`;
      if (wasActiveSession) {
        successMessage += " Active session reset to default.";
      }
      if (browserbaseSessionId) {
        successMessage += ` View replay at https://www.browserbase.com/sessions/${browserbaseSessionId}`;
      }
      return { content: [{ type: "text", text: successMessage }] };
    }

    // No session was found
    return {
      content: [
        {
          type: "text",
          text: `No active session found for session ID '${targetSessionId}'.`,
        },
      ],
    };
  };

  return {
    action: action,
    waitForNetwork: false,
  };
}

const closeSessionTool: Tool<typeof CloseSessionInputSchema> = {
  capability: "core",
  schema: closeSessionSchema,
  handle: handleCloseSession,
};

export default [createSessionTool, closeSessionTool];
