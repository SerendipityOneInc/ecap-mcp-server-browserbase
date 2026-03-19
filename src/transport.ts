import http from "node:http";
import assert from "node:assert";
import crypto from "node:crypto";

import { ServerList } from "./server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "../config.d.ts";
import type { RequestContextStore } from "./server.js";

const DEFAULT_ACCOUNT_ME_URL =
  "https://account.favie.yesy.online/user/me?business=ecap";

export async function startStdioTransport(
  serverList: ServerList,
  config?: Config,
) {
  // Check if we're using the default model without an API key
  if (config) {
    const modelName = config.modelName || "gemini-2.0-flash";
    const hasModelApiKey =
      config.modelApiKey ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY;

    if (modelName.includes("gemini") && !hasModelApiKey) {
      console.error(
        `Need to set GEMINI_API_KEY or GOOGLE_API_KEY in your environment variables`,
      );
    }
  }

  const server = await serverList.create();
  await server.connect(new StdioServerTransport());
}

function getAuthorizationHeader(req: http.IncomingMessage): string | undefined {
  const rawAuthHeader = req.headers.authorization;
  return Array.isArray(rawAuthHeader) ? rawAuthHeader[0] : rawAuthHeader;
}

function getBearerToken(req: http.IncomingMessage): string | null {
  const authHeader = getAuthorizationHeader(req);
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

function respondWithJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: Record<string, string>,
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function authorizeRequest(
  req: http.IncomingMessage,
  config?: Config,
): Promise<{ ok: true } | { ok: false; statusCode: number; message: string }> {
  const authHeader = getAuthorizationHeader(req);
  const token = getBearerToken(req);

  if (!authHeader || !token) {
    return {
      ok: false,
      statusCode: 401,
      message: "Authorization header with Bearer token is required",
    };
  }

  const accountMeUrl =
    config?.accountMeUrl ??
    process.env.ACCOUNT_ME_URL ??
    DEFAULT_ACCOUNT_ME_URL;

  try {
    const response = await fetch(accountMeUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    await response.text();
    const isAuthorized = response.status === 200;

    if (!isAuthorized) {
      return {
        ok: false,
        statusCode: 401,
        message: "Invalid auth token",
      };
    }

    return { ok: true };
  } catch {
    return {
      ok: false,
      statusCode: 502,
      message: "Failed to validate auth token",
    };
  }
}

async function handleStreamable(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  serverList: ServerList,
  sessions: Map<
    string,
    {
      transport: StreamableHTTPServerTransport;
      requestContext: RequestContextStore;
    }
  >,
) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      res.statusCode = 404;
      res.end("Session not found");
      return;
    }
    session.requestContext.requestHeaders = req.headers;
    return await session.transport.handleRequest(req, res);
  }

  if (req.method === "POST") {
    const sessionId = crypto.randomUUID();
    const requestContext: RequestContextStore = {
      requestHeaders: req.headers,
    };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
    });
    sessions.set(sessionId, { transport, requestContext });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const server = await serverList.create({ requestContext });
    await server.connect(transport);
    return await transport.handleRequest(req, res);
  }

  res.statusCode = 400;
  res.end("Invalid request");
}

export function startHttpTransport(
  port: number,
  hostname: string | undefined,
  serverList: ServerList,
  config?: Config,
) {
  // In-memory Map of SHTTP sessions
  const streamableSessions = new Map<
    string,
    {
      transport: StreamableHTTPServerTransport;
      requestContext: RequestContextStore;
    }
  >();
  const httpServer = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.statusCode = 400;
        res.end("Bad request: missing URL");
        return;
      }

      const url = new URL(`http://localhost${req.url}`);
      if (!url.pathname.startsWith("/mcp")) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const authResult = await authorizeRequest(req, config);
      if (!authResult.ok) {
        respondWithJson(res, authResult.statusCode, {
          detail: authResult.message,
        });
        return;
      }

      await handleStreamable(req, res, serverList, streamableSessions);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown server error";
      process.stderr.write(`[HTTP] Request handling failed: ${errorMessage}\n`);
      if (!res.headersSent) {
        respondWithJson(res, 500, { detail: "Internal server error" });
      } else {
        res.end();
      }
    }
  });
  httpServer.listen(port, hostname, () => {
    const address = httpServer.address();
    assert(address, "Could not bind server socket");
    let url: string;
    if (typeof address === "string") {
      url = address;
    } else {
      const resolvedPort = address.port;
      let resolvedHost =
        address.family === "IPv4" ? address.address : `[${address.address}]`;
      if (resolvedHost === "0.0.0.0" || resolvedHost === "[::]")
        resolvedHost = "localhost";
      url = `http://${resolvedHost}:${resolvedPort}`;
    }
    const message = [
      `Listening on ${url}`,
      "Put this in your client config:",
      JSON.stringify(
        {
          mcpServers: {
            browserbase: {
              type: "http",
              url: `${url}/mcp`,
            },
          },
        },
        undefined,
        2,
      ),
      "If your client supports streamable HTTP, you can use the /mcp endpoint instead.",
    ].join("\n");
    console.log(message);
  });
}
