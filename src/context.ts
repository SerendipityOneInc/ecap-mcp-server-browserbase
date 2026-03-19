import type { Stagehand } from "@browserbasehq/stagehand";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Config } from "../config.d.ts";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { listResources, readResource } from "./mcp/resources.js";
import { SessionManager } from "./sessionManager.js";
import type { MCPTool } from "./types/types.js";
import type http from "node:http";
import type { RequestContextStore } from "./server.js";

/**
 * MCP Server Context
 *
 * Central controller that connects the MCP server infrastructure with browser automation capabilities,
 * managing server instances, browser sessions, tool execution, and resource access.
 */

export class Context {
  public readonly config: Config;
  private server: Server;
  private sessionManager: SessionManager;
  private requestContext?: RequestContextStore;

  // currentSessionId is a getter that delegates to SessionManager to ensure synchronization
  // This prevents desync between Context and SessionManager session tracking
  public get currentSessionId(): string {
    return this.sessionManager.getActiveSessionId();
  }

  constructor(
    server: Server,
    config: Config,
    requestContext?: RequestContextStore,
  ) {
    this.server = server;
    this.config = config;
    this.sessionManager = new SessionManager();
    this.requestContext = requestContext;
  }

  public getServer(): Server {
    return this.server;
  }

  public getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  public getRequestHeader(name: string): string | undefined {
    const requestHeaders = normalizeHeaders(this.requestContext?.requestHeaders);
    return requestHeaders[name.toLowerCase()];
  }

  public getBearerAuthorization(): string | undefined {
    const authorization = this.getRequestHeader("authorization");
    if (!authorization) return undefined;

    const [scheme, token] = authorization.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) return undefined;
    return authorization;
  }

  /**
   * Gets the Stagehand instance for the current session from SessionManager
   */
  public async getStagehand(
    sessionId: string = this.currentSessionId,
  ): Promise<Stagehand> {
    const session = await this.sessionManager.getSession(
      sessionId,
      this.config,
    );
    if (!session) {
      throw new Error(`No session found for ID: ${sessionId}`);
    }
    return session.stagehand;
  }

  async run(tool: MCPTool, args: unknown): Promise<CallToolResult> {
    try {
      console.error(
        `Executing tool: ${tool.schema.name} with args: ${JSON.stringify(args)}`,
      );

      // Check if this tool has a handle method (new tool system)
      if ("handle" in tool && typeof tool.handle === "function") {
        const toolResult = await tool.handle(this, args);

        if (toolResult?.action) {
          const actionResult = await toolResult.action();
          const content = actionResult?.content || [];

          return {
            content: Array.isArray(content)
              ? content
              : [{ type: "text", text: "Action completed successfully." }],
            isError: false,
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: `${tool.schema.name} completed successfully.`,
              },
            ],
            isError: false,
          };
        }
      } else {
        // Fallback for any legacy tools without handle method
        throw new Error(
          `Tool ${tool.schema.name} does not have a handle method`,
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        `Tool ${tool.schema?.name || "unknown"} failed: ${errorMessage}`,
      );
      return {
        content: [{ type: "text", text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  }

  /**
   * List resources
   * Documentation: https://modelcontextprotocol.io/docs/concepts/resources
   */
  listResources() {
    return listResources();
  }

  /**
   * Read a resource by URI
   * Documentation: https://modelcontextprotocol.io/docs/concepts/resources
   */
  readResource(uri: string) {
    return readResource(uri);
  }
}

function normalizeHeaders(
  headers?: http.IncomingHttpHeaders,
): Record<string, string> {
  if (!headers) return {};

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key.toLowerCase()] = value;
      continue;
    }

    if (Array.isArray(value) && value.length > 0) {
      normalized[key.toLowerCase()] = value[0];
    }
  }

  return normalized;
}
