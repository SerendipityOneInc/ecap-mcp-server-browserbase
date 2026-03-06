import { z } from "zod";
import type { Tool, ToolSchema, ToolResult } from "./tool.js";
import type { Context } from "../context.js";
import type { ToolActionResult } from "../types/types.js";

/**
 * Stagehand Get URL
 *
 * This tool is used to get the current URL of the browser page.
 */

const GetUrlInputSchema = z.object({
  sessionId: z.string().min(1).describe("Required MCP session ID to use."),
});

type GetUrlInput = z.infer<typeof GetUrlInputSchema>;

const getUrlSchema: ToolSchema<typeof GetUrlInputSchema> = {
  name: "browserbase_stagehand_get_url",
  description: "Return the current page URL (full URL with query/fragment).",
  inputSchema: GetUrlInputSchema,
};

async function handleGetUrl(
  context: Context,
  params: GetUrlInput,
): Promise<ToolResult> {
  const action = async (): Promise<ToolActionResult> => {
    try {
      const stagehand = await context.getStagehand(params.sessionId);

      const page = stagehand.context.pages()[0];

      if (!page) {
        throw new Error("No active page available");
      }

      const currentUrl = page.url();

      return {
        content: [
          {
            type: "text",
            text: currentUrl,
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get current URL: ${errorMsg}`);
    }
  };

  return {
    action,
    waitForNetwork: false,
  };
}

const getUrlTool: Tool<typeof GetUrlInputSchema> = {
  capability: "core",
  schema: getUrlSchema,
  handle: handleGetUrl,
};

export default getUrlTool;
