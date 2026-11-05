import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readConfigFromEnv, type PaperclipMcpConfig } from "./config.js";
import { createPaperclipMcpServer } from "./index.js";
import { readRunMeta, RUN_META_KEY } from "./run-meta.js";

const keyless: PaperclipMcpConfig = {
  apiUrl: "http://localhost:3100/api",
  apiKey: null,
  companyId: null,
  agentId: null,
  runId: null,
};

function okResponse() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function sent(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(([url, init]) => {
    const headers = (init as RequestInit).headers as Record<string, string>;
    return { path: new URL(String(url)).pathname, auth: headers.Authorization, runId: headers["X-Paperclip-Run-Id"] ?? null };
  });
}

async function connect(config = keyless) {
  const { server } = createPaperclipMcpServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

const run = (token: string, runId: string) => ({
  [RUN_META_KEY]: { token, runId, agentId: "agent-1", companyId: "company-1" },
});

describe("run identity in tool-call metadata", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    fetchMock = vi.fn().mockImplementation(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
  });

  it("starts without PAPERCLIP_API_KEY", () => {
    expect(readConfigFromEnv({ PAPERCLIP_API_URL: "http://localhost:3100" }).apiKey).toBeNull();
  });

  it("uses the call's run token, run id and agent defaults", async () => {
    const mcp = await connect();
    const result = await mcp.callTool({
      name: "paperclipAddComment",
      arguments: { issueId: "issue-1", body: "hello" },
      _meta: run("jwt-a", "run-a"),
    });
    expect(result.isError).not.toBe(true);
    expect(sent(fetchMock)).toEqual([{ path: "/api/issues/issue-1/comments", auth: "Bearer jwt-a", runId: "run-a" }]);

    await mcp.callTool({ name: "paperclipListAgents", arguments: {}, _meta: run("jwt-a", "run-a") });
    expect(sent(fetchMock)[1]).toMatchObject({ path: "/api/companies/company-1/agents", auth: "Bearer jwt-a" });
    await mcp.close();
  });

  it("keeps the token's run id over a run id the model passed", async () => {
    const mcp = await connect();
    await mcp.callTool({
      name: "paperclipAddComment",
      arguments: { issueId: "issue-1", body: "hello", paperclipRunId: "run-from-model" },
      _meta: run("jwt-a", "run-a"),
    });
    expect(sent(fetchMock)[0].runId).toBe("run-a");
    await mcp.close();
  });

  it("keeps concurrent calls' credentials apart", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("issue-slow")) await new Promise((resolve) => setTimeout(resolve, 10));
      return okResponse();
    });
    const mcp = await connect();
    await Promise.all([
      mcp.callTool({ name: "paperclipAddComment", arguments: { issueId: "issue-slow", body: "1" }, _meta: run("jwt-1", "run-1") }),
      mcp.callTool({ name: "paperclipAddComment", arguments: { issueId: "issue-fast", body: "2" }, _meta: run("jwt-2", "run-2") }),
    ]);
    const byPath = Object.fromEntries(sent(fetchMock).map((call) => [call.path, [call.auth, call.runId]]));
    expect(byPath).toEqual({
      "/api/issues/issue-slow/comments": ["Bearer jwt-1", "run-1"],
      "/api/issues/issue-fast/comments": ["Bearer jwt-2", "run-2"],
    });
    await mcp.close();
  });

  it("refuses a call with no credentials at all, without calling Paperclip", async () => {
    const mcp = await connect();
    const result = await mcp.callTool({ name: "paperclipAddComment", arguments: { issueId: "issue-1", body: "hello" } });
    expect(JSON.stringify(result.content)).toContain("No Paperclip credentials for this call");
    expect(fetchMock).not.toHaveBeenCalled();
    await mcp.close();
  });

  it("still uses PAPERCLIP_API_KEY when the host sends no run", async () => {
    const mcp = await connect({ ...keyless, apiKey: "static-key", companyId: "company-env" });
    await mcp.callTool({ name: "paperclipListAgents", arguments: {} });
    expect(sent(fetchMock)).toEqual([{ path: "/api/companies/company-env/agents", auth: "Bearer static-key", runId: null }]);
    await mcp.close();
  });

  it("reads only well-formed metadata", () => {
    expect(readRunMeta(undefined)).toBeNull();
    expect(readRunMeta({ [RUN_META_KEY]: "jwt" })).toBeNull();
    expect(readRunMeta({ [RUN_META_KEY]: { token: " ", runId: 4 } })).toBeNull();
    expect(readRunMeta({ [RUN_META_KEY]: { token: " jwt ", extra: "x" } })).toEqual({ token: "jwt" });
  });
});
