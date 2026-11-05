import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PaperclipApiClient } from "./client.js";
import { readConfigFromEnv, type PaperclipMcpConfig } from "./config.js";
import { readRunMeta } from "./run-meta.js";
import { createToolDefinitions } from "./tools.js";

// Every tool also takes the caller's run id, for servers that outlive one heartbeat (an agent
// runtime that keeps one MCP process per agent). Paperclip requires it on an agent's writes.
const PAPERCLIP_RUN_ID_ARG = z
  .string()
  .optional()
  .describe(
    "Your current Paperclip run id (the Run ID in your wake prompt). Needed on writes only when this server was started without PAPERCLIP_RUN_ID and your runtime does not send your run to Paperclip itself.",
  );

export function createPaperclipMcpServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "paperclip",
    version: "0.1.0",
  });

  const client = new PaperclipApiClient(config);
  const tools = createToolDefinitions(client);
  for (const tool of tools) {
    const shape = { ...tool.schema.shape, paperclipRunId: PAPERCLIP_RUN_ID_ARG };
    server.tool(tool.name, tool.description, shape, ({ paperclipRunId, ...input }, extra) =>
      client.withCallContext(readRunMeta(extra?._meta) ?? {}, () =>
        client.withRunId(paperclipRunId, () => tool.execute(input)),
      ),
    );
  }

  return {
    server,
    tools,
    client,
  };
}

export async function runServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const { server } = createPaperclipMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
