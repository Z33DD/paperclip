import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperclipApiClient } from "./client.js";
import { createPaperclipMcpServer } from "./index.js";

const config = (runId: string | null) => ({
  apiUrl: "http://localhost:3100/api",
  apiKey: "token-123",
  companyId: "11111111-1111-1111-1111-111111111111",
  agentId: "22222222-2222-2222-2222-222222222222",
  runId,
});

function okResponse() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function sentRunIds(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>)
    .map((headers) => headers["X-Paperclip-Run-Id"] ?? null);
}

describe("per-call run id", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    fetchMock = vi.fn().mockImplementation(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
  });

  it("sends the call's run id on writes when the server has none", async () => {
    const client = new PaperclipApiClient(config(null));
    await client.withRunId("run-a", () => client.requestJson("PATCH", "/issues/x", { body: {} }));
    expect(sentRunIds(fetchMock)).toEqual(["run-a"]);
  });

  it("prefers the call's run id over PAPERCLIP_RUN_ID", async () => {
    const client = new PaperclipApiClient(config("run-env"));
    await client.withRunId("run-call", () => client.requestJson("POST", "/issues/x/comments", { body: {} }));
    await client.requestJson("POST", "/issues/x/comments", { body: {} });
    expect(sentRunIds(fetchMock)).toEqual(["run-call", "run-env"]);
  });

  it("keeps concurrent calls' run ids apart", async () => {
    const client = new PaperclipApiClient(config(null));
    await Promise.all([
      client.withRunId("run-1", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await client.requestJson("PATCH", "/issues/one", { body: {} });
      }),
      client.withRunId("run-2", () => client.requestJson("PATCH", "/issues/two", { body: {} })),
    ]);
    const byPath = Object.fromEntries(
      fetchMock.mock.calls.map(([url, init]) => [
        new URL(String(url)).pathname,
        ((init as RequestInit).headers as Record<string, string>)["X-Paperclip-Run-Id"],
      ]),
    );
    expect(byPath).toEqual({ "/api/issues/one": "run-1", "/api/issues/two": "run-2" });
  });

  it("ignores a blank run id and does not send one on reads", async () => {
    const client = new PaperclipApiClient(config(null));
    await client.withRunId("  ", () => client.requestJson("PATCH", "/issues/x", { body: {} }));
    await client.withRunId("run-a", () => client.requestJson("GET", "/issues/x"));
    expect(sentRunIds(fetchMock)).toEqual([null, null]);
  });

  it("accepts paperclipRunId on every registered tool and forwards it", async () => {
    const { server } = createPaperclipMcpServer(config(null));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

    const { tools } = await mcp.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {})).toContain("paperclipRunId");
    }

    const result = await mcp.callTool({
      name: "paperclipAddComment",
      arguments: { issueId: "issue-1", body: "hello", paperclipRunId: "run-tool" },
    });
    expect(result.isError).not.toBe(true);
    expect(sentRunIds(fetchMock)).toEqual(["run-tool"]);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String((init as RequestInit).body))).not.toHaveProperty("paperclipRunId");
    await mcp.close();
  });
});
