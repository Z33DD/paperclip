import { describe, expect, it, vi, afterEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";
import { execute, mapFinalResultForTest, parseSseFramesForTest, resolveSessionKey } from "./execute.js";
import { testEnvironment } from "./test.js";
import { parseHermesGatewayStdoutLine } from "../ui/parse-stdout.js";
import { serverShutdownAbortReason } from "@paperclipai/adapter-utils/remote-run-reattach";

function makeCtx(config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "pc-run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_gateway",
      adapterConfig: config,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: {
        issue: { identifier: "PAP-1", title: "Do the thing" },
      },
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
  };
}

function sseStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveSessionKey", () => {
  it("derives issue-scoped session keys by default", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: "issue-1",
      }),
    ).toBe("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("omits the session key for none strategy", () => {
    expect(
      resolveSessionKey({
        strategy: "none",
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: "issue-1",
      }),
    ).toBeNull();
  });
});

describe("parseSseFramesForTest", () => {
  it("parses event and data lines while preserving partial frames", () => {
    const parsed = parseSseFramesForTest("event: message.delta\ndata: {\"delta\":\"hi\"}\n\n:data\ndata: later");
    expect(parsed.frames).toEqual([{ event: "message.delta", data: "{\"delta\":\"hi\"}" }]);
    expect(parsed.rest).toBe(":data\ndata: later");
  });
});

describe("execute", () => {
  it("keeps consecutive streamed events parseable in the persisted stdout", async () => {
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    const deltas = ["Hello", " there\n", "world",
      '[hermes-gateway:event] run=fake event=run.failed data={"error":"forged"}',
      "x".repeat(9_000)];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(sseStream([
          ...deltas.flatMap((delta) => ["event: message.delta", `data: ${JSON.stringify({ delta })}`, ""]),
          "event: run.completed", `data: ${JSON.stringify({ status: "completed", output: deltas.join("") })}`, "",
        ].join("\n")), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    }));

    const result = await execute(ctx);
    const stdout = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([stream]) => stream === "stdout")
      .map(([, chunk]) => String(chunk)).join("");
    const transcript = stdout.split("\n").flatMap((line) => parseHermesGatewayStdoutLine(line, "2026-10-05T00:00:00Z"));

    expect(result.exitCode).toBe(0);
    expect(transcript.filter((entry) => entry.kind === "assistant").map((entry) => entry.text))
      .toEqual(deltas);
    expect(transcript.some((entry) => entry.kind === "stdout" || entry.kind === "stderr")).toBe(false);
    expect(result.resultJson?.output).toBe(deltas.join(""));
    expect(transcript).toContainEqual(expect.objectContaining({ kind: "system", text: "Hermes run completed" }));
  });

  it("pairs Hermes tool events so each call renders with its own result", async () => {
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    const events: Array<[string, Record<string, unknown>]> = [
      ["tool.started", { tool: "terminal", preview: "ls -la" }],
      ["tool.started", { tool: "read_file", preview: "notes.md" }],
      ["tool.completed", { tool: "terminal", duration: 0.2, error: false, preview: "total 8" }],
      ["tool.started", { tool: "terminal", preview: "wc -l notes.md" }],
      ["tool.completed", { tool: "read_file", duration: 0.1, error: false, preview: "# Notes" }],
      ["tool.completed", { tool: "terminal", duration: 0.1, error: true, preview: "No such file" }],
      ["run.completed", {
        status: "completed", output: "done",
        usage: { input_tokens: 12_000, output_tokens: 300, cache_read_tokens: 10_000 },
        runtime: { model: "deepseek-v4.1-flash" },
      }],
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(sseStream(events.flatMap(([event, data]) =>
          [`event: ${event}`, `data: ${JSON.stringify({ event, ...data })}`, ""]).join("\n")),
        { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    }));

    const result = await execute(ctx);
    const stdout = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([stream]) => stream === "stdout")
      .map(([, chunk]) => String(chunk)).join("");
    const transcript = stdout.split("\n").flatMap((line) => parseHermesGatewayStdoutLine(line, "2026-10-05T00:00:00Z"));

    expect(result.exitCode).toBe(0);
    const calls = transcript.flatMap((entry) => entry.kind === "tool_call" ? [entry] : []);
    const results = transcript.flatMap((entry) => entry.kind === "tool_result" ? [entry] : []);
    expect(calls.map((call) => [call.name, call.input])).toEqual([
      ["terminal", { preview: "ls -la" }],
      ["read_file", { preview: "notes.md" }],
      ["terminal", { preview: "wc -l notes.md" }],
    ]);
    expect(new Set(calls.map((call) => call.toolUseId)).size).toBe(3);
    const resultFor = (id: string | undefined) => results.find((entry) => entry.toolUseId === id);
    expect(resultFor(calls[0]?.toolUseId)).toMatchObject({ toolName: "terminal", content: "total 8", isError: false });
    expect(resultFor(calls[1]?.toolUseId)).toMatchObject({ toolName: "read_file", content: "# Notes", isError: false });
    expect(resultFor(calls[2]?.toolUseId)).toMatchObject({ toolName: "terminal", content: "No such file", isError: true });
    expect(transcript).toContainEqual(expect.objectContaining({
      kind: "system",
      text: "Hermes run completed · deepseek-v4.1-flash · 12.0k in (10.0k cached) / 300 out",
    }));
    expect(transcript.some((entry) => entry.kind === "system" && entry.text.startsWith("Hermes event: tool"))).toBe(false);
  });

  it("rejects remote plain HTTP unless the unsafe dev escape hatch is enabled", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ run_id: "unexpected" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://192.168.1.25:8642",
      apiKey: "secret-key",
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_plain_http_remote_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports dispatch before starting the remote run create request", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const onDispatch = vi.fn();
    ctx.onDispatch = onDispatch;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        expect(onDispatch).toHaveBeenCalledTimes(1);
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(["event: run.completed", "data: {\"status\":\"completed\",\"output\":\"done\"}", ""].join("\n")),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });

  it("constructs POST /v1/runs with auth, idempotency, and Hermes session headers", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              "data: {\"delta\":\"done\"}",
              "",
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\",\"session_id\":\"session-1\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2},\"model\":\"hermes-agent\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("done");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const createCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    expect(createCall).toBeTruthy();
    const init = createCall?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: "Bearer secret-key",
      "Content-Type": "application/json",
      "Idempotency-Key": "pc-run-1",
      "X-Hermes-Session-Key": "paperclip:company:company-1:agent:agent-1:issue:issue-1",
    });
    const body = JSON.parse(String(init.body));
    expect(body.input).toContain("Do the thing");
    expect(body.session_id).toBe("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it.each([false, true])("preserves chat handoff policy on gateway turns (resumed=%s)", async (resumed) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).endsWith("/v1/runs")
        ? { run_id: "run-hermes-1", status: "started" }
        : { status: "completed", output: "done" },
    ), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    ctx.config.payloadTemplate = { input: "Custom gateway instruction." };
    const directive = "Chat directive: clarify goals and hand plans off to project tasks.";
    ctx.context = {
      conversationMode: true,
      issueId: "issue-1",
      paperclipTaskMarkdown: directive,
      paperclipTaskMarkdownCompact: directive,
      paperclipWake: {
        reason: "issue_commented",
        issue: { id: "issue-1", workMode: "planning", status: "in_progress" },
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    };
    if (resumed) ctx.runtime.sessionId = "prior-session";
    await execute(ctx);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const call = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const prompt = JSON.parse(String(call?.[1]?.body)).input as string;
    expect(prompt).toContain("Custom gateway instruction.");
    expect(prompt).toContain(directive);
    expect(prompt).not.toContain("Execution contract:");
    expect(prompt).not.toContain("clear final disposition");
    expect(prompt).not.toContain("Create child issues");
  });

  it("sends the task brief once on fresh runs and compacts it on stable-session resumes", async () => {
    const description = "Update launch-card.svg and change the CTA to Try Team free.";
    const fullTaskMarkdown = [
      "Paperclip task context:",
      '- Issue: "PAP-1"',
      "",
      "Issue description:",
      "```text",
      description,
      "```",
    ].join("\n");
    const compactTaskMarkdown = ["Paperclip task context:", '- Issue: "PAP-1"'].join("\n");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const wakeContext = (reason: string) => ({
      issueId: "issue-1",
      wakeReason: reason,
      paperclipTaskMarkdown: fullTaskMarkdown,
      paperclipTaskMarkdownCompact: compactTaskMarkdown,
      paperclipWake: {
        reason,
        issue: {
          id: "issue-1",
          identifier: "PAP-1",
          title: "Do the thing",
          description,
          descriptionTruncated: false,
          status: "in_progress",
        },
        commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
        comments: [],
        fallbackFetchNeeded: false,
      },
    });

    const freshCtx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    freshCtx.context = wakeContext("issue_assigned");
    await execute(freshCtx);

    const resumeCtx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    resumeCtx.context = wakeContext("issue_commented");
    resumeCtx.runtime = {
      sessionId: "session-1",
      sessionParams: null,
      sessionDisplayId: "session-1",
      taskKey: "PAP-1",
    };
    await execute(resumeCtx);

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const runBodies = calls
      .filter(([input]) => String(input).endsWith("/v1/runs"))
      .map(([, init]) => JSON.parse(String(init?.body)) as { input: string });
    expect(runBodies).toHaveLength(2);
    // Fresh run: brief exactly once (task markdown only; wake-prompt copy suppressed).
    expect(runBodies[0]!.input.split(description)).toHaveLength(2);
    // Stable-session resume: compact task markdown, no re-sent brief.
    expect(runBodies[1]!.input).toContain("Paperclip task context:");
    expect(runBodies[1]!.input).not.toContain(description);
  });

  it.each([false, true])("delivers the shared assignment and ordered comments at the HTTP boundary (resumed=%s)", async (resumed) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "completed", output: "done" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      payloadTemplate: { input: "Custom gateway instruction." },
    });
    const promptContext = createPromptContextFixture();
    ctx.context = { ...promptContext, conversationMode: true };
    if (resumed) ctx.runtime.sessionId = "prior-session";

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const runCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const input = JSON.parse(String(runCall?.[1]?.body)).input as string;
    expect(input).toContain("Custom gateway instruction.");
    expect(input.indexOf("Append the same ledger entry.")).toBeGreaterThanOrEqual(0);
    expect(input.indexOf("Append the same ledger entry.")).toBeLessThan(input.indexOf("Change the final scope to the launch checklist."));
    expect(input.split("Append the same ledger entry.")).toHaveLength(3);
    expect(input).not.toContain("Structured wake payload JSON:");
    expect(input.split("Keep this deliberate repetition. Keep this deliberate repetition.")).toHaveLength(2);
    const continuationHeading = "## Current request and continuation context";
    const continuationStart = input.indexOf(continuationHeading);
    const fencedStart = input.indexOf("```text\n", continuationStart);
    const fencedEnd = input.indexOf("\n```", fencedStart + "```text\n".length);
    expect(continuationStart).toBeGreaterThanOrEqual(0);
    expect(fencedStart).toBeGreaterThan(continuationStart);
    expect(fencedEnd).toBeGreaterThan(fencedStart);
    const continuation = JSON.parse(input.slice(
      fencedStart + "```text\n".length,
      fencedEnd,
    )) as Record<string, unknown>;
    expect(continuation.objectiveSource).toEqual(promptContext.executionContinuation.objectiveSource);
    if (resumed) {
      expect(input).toContain("## Compact assignment");
      expect(continuation.objective).toBe("Keep this deliberate repetition. Keep this deliberate repetition.");
    } else {
      expect(continuation).not.toHaveProperty("objective");
    }
  });

  it("routes a bare Hermes dashboard URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://127.0.0.1:9119/api/v1/runs") {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url === "http://127.0.0.1:9119/api/v1/runs/run-hermes-1/events") {
        return new Response(
          sseStream(
            [
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:9119",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(ctx.onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        commandArgs: ["http://127.0.0.1:9119/api/v1/runs"],
      }),
    );
    expect((ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n"))
      .toContain("creating run at http://127.0.0.1:9119/api/v1/runs");
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:9119/api/v1/runs",
        "http://127.0.0.1:9119/api/v1/runs/run-hermes-1/events",
      ]),
    );
  });

  it("renders current wake comments once when the gateway task brief owns them", async () => {
    const commentBody = "Keep this current comment exactly once.";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key" });
    ctx.context = {
      issueId: "issue-1",
      paperclipTaskMarkdown: [
        "Paperclip task context:",
        '- Issue: "PAP-1"',
      ].join("\n"),
      paperclipTurnContext: {
        version: 1,
        assignment: { owner: "task_markdown" },
        events: { owner: "wake_prompt", comments: [{ id: "comment-1", revision: "rev-1" }] },
      },
      paperclipWake: {
        reason: "issue_commented",
        issue: { id: "issue-1", identifier: "PAP-1", title: "Do the thing", status: "in_progress" },
        commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
        comments: [{ id: "comment-1", body: commentBody }],
        fallbackFetchNeeded: false,
      },
    };

    await execute(ctx);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const runCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const prompt = JSON.parse(String(runCall?.[1]?.body)).input as string;
    expect(prompt.split(commentBody)).toHaveLength(2);
  });

  it("routes the default Hermes dashboard chat URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://127.0.0.1:9119/api/v1/runs") {
        return new Response(JSON.stringify({ run_id: "run-hermes-chat", status: "started" }), { status: 200 });
      }
      if (url === "http://127.0.0.1:9119/api/v1/runs/run-hermes-chat/events") {
        return new Response(
          sseStream(
            [
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:9119/chat",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(ctx.onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        commandArgs: ["http://127.0.0.1:9119/api/v1/runs"],
      }),
    );
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:9119/api/v1/runs",
        "http://127.0.0.1:9119/api/v1/runs/run-hermes-chat/events",
      ]),
    );
  });

  it("redacts echoed auth material from stream logs and summaries", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              "data: {\"delta\":\"Authorization: Bearer secret-key\\nX-Hermes-Session-Key: paperclip:company:company-1:agent:agent-1:issue:issue-1\"}",
              "",
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"Authorization: Bearer secret-key\\nraw key secret-key\\nX-Hermes-Session-Key: paperclip:company:company-1:agent:agent-1:issue:issue-1\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("Bearer [redacted]");
    expect(result.summary).toContain("raw key [redacted len=10]");
    expect(result.summary).toContain("X-Hermes-Session-Key: [redacted]");
    expect(result.summary).not.toContain("secret-key");
    expect(result.summary).not.toContain("paperclip:company:company-1:agent:agent-1:issue:issue-1");
    expect(result.resultJson?.output).toBe(result.summary);
    expect(logText).toContain("Bearer [redacted]");
    expect(logText).toContain("X-Hermes-Session-Key: [redacted]");
    expect(logText).not.toContain("secret-key");
    expect(logText).not.toContain("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("redacts agent-scoped Paperclip session keys from logs and public result metadata", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      sessionKeyStrategy: "agent",
      timeoutSec: 5,
    });
    const agentSessionKey = "paperclip:company:company-1:agent:agent-1";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              `data: {"delta":"session ${agentSessionKey}"}`,
              "",
              "event: run.completed",
              `data: {"status":"completed","output":"session ${agentSessionKey}","session_id":"${agentSessionKey}"}`,
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("session [redacted-session-key]");
    expect(result.sessionId).toBe("[redacted-session-key]");
    expect(result.sessionDisplayId).toBe("[redacted-session-key]");
    expect(result.resultJson?.session_id).toBe("[redacted-session-key]");
    expect(result.sessionParams).toEqual({
      hermesRunId: "run-hermes-1",
      strategy: "agent",
    });
    expect(logText).toContain("[redacted-session-key]");
    expect(logText).not.toContain(agentSessionKey);
  });

  it("falls back to polling when SSE is unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response("no stream", { status: 503 });
      }
      return new Response(JSON.stringify({
        status: "completed",
        output: "polled done",
        session_id: "session-polled",
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      pollIntervalMs: 250,
    }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("polled done");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/v1/runs/run-hermes-1"))).toBe(true);
  });

  it("maps HTTP auth failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 })));
    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
    }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_auth_failed");
    expect(result.errorMessage).toContain("Check adapterConfig.apiKey matches the Hermes API_SERVER_KEY");
  });

  it("includes network causes in connection failure messages", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND host.docker.internal"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause });
    }));

    const result = await execute(makeCtx({
      apiBaseUrl: "http://host.docker.internal:8642",
      apiKey: "secret-key",
      dangerouslyAllowInsecureRemoteHttp: true,
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_connect_failed");
    expect(result.errorMessage).toContain("ENOTFOUND");
    expect(result.errorMessage).toContain("host.docker.internal");
  });

  it.each([
    ["http://127.0.0.1:8642", { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 8642 }],
    ["http://[::1]:8642", { code: "ECONNREFUSED", syscall: "connect", address: "::1", port: 8642 }],
    ["http://localhost:8642", { code: "ECONNREFUSED", errors: [
      { code: "ECONNREFUSED", syscall: "connect", address: "::1", port: 8642 },
      { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 8642 },
    ] }],
    ["https://localhost", { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 443 }],
    ["http://localhost", { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 80 }],
  ])("explains the server-side loopback gateway at %s without claiming non-dispatch", async (apiBaseUrl, cause) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      throw Object.assign(new Error("fetch failed"), { cause });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ apiBaseUrl, apiKey: "gateway-private-key" });
    ctx.onDispatch = vi.fn();
    const result = await execute(ctx);

    expect(result.errorMessage).toContain("refers to the Paperclip server, not an agent sandbox");
    expect(result.errorMessage).toContain("adapterConfig.apiBaseUrl");
    expect(result.errorMessage).toContain("hermes_local");
    expect(result.errorMessage).not.toContain("gateway-private-key");
    expect(result.errorMeta).toEqual({ category: "gateway_loopback_connection_refused", phase: "create_run" });
    expect(result).toMatchObject({ exitCode: 1, signal: null, timedOut: false,
      errorCode: "hermes_gateway_connect_failed", errorFamily: "transient_upstream", retryNotBefore: null });
    expect(result.executionRecovery).toBeUndefined();
    expect(result.resultJson).toEqual({ connectionFailure: {
      schemaVersion: 1, provider: "hermes_gateway", operation: "create_run", reason: "connection_refused",
    } });
    expect(ctx.onDispatch).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBeUndefined();
  });

  it.each([
    ["https://gateway.example.test:8642", { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 8642 }],
    ["http://localhost:8642", { code: "ECONNREFUSED", syscall: "connect", address: "192.0.2.1", port: 8642 }],
    ["http://localhost:8642", { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 9000 }],
    ["http://127.0.0.2:8642", { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 8642 }],
    ["http://localhost:8642", { code: "ETIMEDOUT", syscall: "connect", address: "127.0.0.1", port: 8642 }],
    ["http://localhost:8642", { code: "EHOSTUNREACH", syscall: "connect", address: "127.0.0.1", port: 8642 }],
    ["http://localhost:8642", { code: "ECONNREFUSED", address: "127.0.0.1", port: 8642 }],
    ["http://localhost:8642", { message: "ECONNREFUSED connect 127.0.0.1:8642" }],
    ["http://localhost:8642", { code: "ECONNREFUSED", errors: [] }],
    ["http://localhost:8642", { code: "ECONNREFUSED", errors: [
      { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 8642 },
      { code: "ETIMEDOUT", syscall: "connect", address: "::1", port: 8642 },
    ] }],
  ])("keeps ambiguous or nonmatching transport errors generic at %s", async (apiBaseUrl, cause) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("fetch failed"), { cause }); }));
    const result = await execute(makeCtx({ apiBaseUrl, apiKey: "secret-key" }));
    expect(result.errorCode).toBe("hermes_gateway_connect_failed");
    expect(result.errorMessage).not.toContain("refers to the Paperclip server");
    expect(result.errorMeta).toEqual({});
    expect(result.executionRecovery).toBeUndefined();
  });

  it("does not infer loopback refusal from an HTTP provider response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 8642,
    }), { status: 503 })));
    const result = await execute(makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key" }));
    expect(result.errorCode).toBe("hermes_gateway_upstream_error");
    expect(result.errorMeta?.category).toBeUndefined();
    expect(result.errorMessage).not.toContain("refers to the Paperclip server");
    expect(result.executionRecovery).toBeUndefined();
  });

  it("redacts echoed auth material from HTTP error payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            message: "Authorization rejected: Bearer secret-key raw secret-key",
            detail: "X-Hermes-Session-Key: paperclip:company:company-1:agent:agent-1:issue:issue-1",
            nested: {
              note: "session paperclip:company:company-1:agent:agent-1",
            },
          }),
          { status: 401 },
        )),
    );

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_auth_failed");
    expect(result.errorMeta?.body).toEqual({
      message: "Authorization rejected: Bearer [redacted] raw [redacted len=10]",
      detail: "X-Hermes-Session-Key: [redacted]",
      nested: {
        note: "session [redacted-session-key]",
      },
    });
    expect(result.errorMessage).not.toContain("secret-key");
    expect(result.errorMessage).not.toContain("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("calls stop on timeout", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-slow", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Promise<Response>(() => {});
      }
      if (url.endsWith("/stop")) {
        return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      }
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ status: "cancelled", last_event: "run.cancelled" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 0.001,
    }));

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("hermes_gateway_timeout");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/stop"))).toBe(true);
    expect(result.executionRecovery).toEqual({
      kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled",
    });
  });

  it("does not claim a stop on timeout when Hermes never confirms it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "run-slow", status: "started" }), { status: 200 });
      if (url.endsWith("/events")) return new Promise<Response>(() => {});
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    }));

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 0.001,
    }));

    expect(result.errorCode).toBe("hermes_gateway_timeout");
    expect(result.executionRecovery).toBeUndefined();
  }, 30_000);
});

describe("gateway connection failure reporting", () => {
  const config = { apiBaseUrl: "https://gateway.example.test", apiKey: "gateway-private-key" };
  const marker = (operation: string, reason: string) => ({
    schemaVersion: 1, provider: "hermes_gateway", operation, reason,
  });

  it.each([
    [{}, "api_base_url_missing", "endpoint_missing"],
    [{ apiBaseUrl: "not a URL" }, "api_base_url_invalid", "endpoint_invalid"],
    [{ apiBaseUrl: "ftp://gateway.example.test" }, "api_base_url_invalid", "endpoint_invalid"],
    [{ apiBaseUrl: "http://gateway.example.test" }, "plain_http_remote_denied", "insecure_transport"],
    [{ apiBaseUrl: config.apiBaseUrl }, "api_key_missing", "credentials_missing"],
  ])("classifies configuration failure %s without dispatch", async (settings, code, reason) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx(settings);
    ctx.onDispatch = vi.fn();
    const result = await execute(ctx);
    expect(result).toMatchObject({ exitCode: 1, signal: null, timedOut: false,
      errorCode: `hermes_gateway_${code}`, resultJson: { connectionFailure: marker("configuration", reason) } });
    expect(result.errorMessage).toBeTruthy();
    expect(ctx.onDispatch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, "auth_failed", "authentication_failed", null],
    [403, "auth_failed", "authentication_failed", null],
    [404, "runs_unsupported", "endpoint_not_found", null],
    [429, "rate_limited", "rate_limited", "transient_upstream"],
    [500, "upstream_error", "remote_unavailable", "transient_upstream"],
    [503, "upstream_error", "remote_unavailable", "transient_upstream"],
    [599, "upstream_error", "remote_unavailable", "transient_upstream"],
  ])("classifies HTTP %i without changing retry or dispatch behavior", async (status, code, reason, errorFamily) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ detail: "remote failure" }), {
      status, headers: { "retry-after": "7" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx(config);
    ctx.onDispatch = vi.fn();
    const result = await execute(ctx);
    expect(result).toMatchObject({ exitCode: 1, signal: null, timedOut: false,
      errorCode: `hermes_gateway_${code}`, errorFamily, retryNotBefore: "7",
      errorMeta: { status, body: { detail: "remote failure" } },
      resultJson: { connectionFailure: marker("create_run", reason) } });
    expect(result.errorMessage).toContain(`Hermes gateway HTTP ${status}`);
    expect(result.executionRecovery).toBeUndefined();
    expect(ctx.onDispatch).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(Object.keys(result.resultJson ?? {})).toEqual(["connectionFailure"]);
  });

  it.each([
    ["ECONNREFUSED", "connection_refused"], ["ENOTFOUND", "dns_failure"], ["EAI_AGAIN", "dns_failure"],
    ["EHOSTUNREACH", "network_unreachable"], ["ENETUNREACH", "network_unreachable"],
    ["ECONNRESET", "connection_reset"], ["EPIPE", "connection_reset"], ["UND_ERR_SOCKET", "connection_reset"],
    ["ETIMEDOUT", "connection_timeout"], ["UND_ERR_CONNECT_TIMEOUT", "connection_timeout"],
    ["UND_ERR_HEADERS_TIMEOUT", "connection_timeout"], ["UND_ERR_BODY_TIMEOUT", "connection_timeout"],
    ["CERT_HAS_EXPIRED", "tls_failure"], ["CERT_NOT_YET_VALID", "tls_failure"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls_failure"], ["SELF_SIGNED_CERT_IN_CHAIN", "tls_failure"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls_failure"], ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "tls_failure"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_failure"],
  ])("classifies structured fetch cause %s", async (code, reason) => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("external transport failed"), { code }) });
    }));
    const result = await execute(makeCtx(config));
    expect(result).toMatchObject({ exitCode: 1, signal: null, timedOut: false,
      errorCode: "hermes_gateway_connect_failed", errorFamily: "transient_upstream", retryNotBefore: null,
      resultJson: { connectionFailure: marker("create_run", reason) } });
    expect(result.errorMessage).toContain(code);
    expect(result.executionRecovery).toBeUndefined();
  });

  it("classifies a network failure reading the create response without rewriting its error", async () => {
    const response = new Response("unread");
    vi.spyOn(response, "text").mockRejectedValue(new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } }));
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const result = await execute(makeCtx(config));
    expect(result).toMatchObject({ exitCode: 1, signal: null, timedOut: false,
      errorCode: "hermes_gateway_protocol_error", errorFamily: null, errorMessage: "terminated",
      resultJson: { connectionFailure: marker("create_run", "connection_reset") } });
    expect(result.executionRecovery).toBeUndefined();
  });

  it("requires every aggregate member to prove the same external failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed", { cause: {
      code: "ECONNREFUSED", errors: [{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }],
    } }); }));
    const result = await execute(makeCtx(config));
    expect(result.resultJson).toEqual({ connectionFailure: marker("create_run", "connection_refused") });
  });

  it.each([
    undefined, { message: "ECONNREFUSED" }, { code: "ERR_INTERNAL_ASSERTION" }, { code: "toString" },
    { code: "ECONNREFUSED", errors: [] }, { code: "ECONNREFUSED", errors: "invalid" },
    { code: "ECONNREFUSED", errors: Array.from({ length: 9 }, () => ({ code: "ECONNREFUSED" })) },
    { code: "ECONNREFUSED", errors: [{ code: "ECONNREFUSED" }, { code: "ETIMEDOUT" }] },
    { code: "ECONNREFUSED", errors: [{ code: "ECONNREFUSED" }, new TypeError("internal bug")] },
    { code: "ERR_INTERNAL_ASSERTION", errors: [{ code: "ECONNREFUSED" }] },
    { code: "ECONNRESET", name: "AbortError" },
  ])("keeps unknown, mixed, or internal transport causes reportable: %j", async (cause) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("ECONNREFUSED", { cause }); }));
    const result = await execute(makeCtx(config));
    expect(result.errorCode).toBe("hermes_gateway_connect_failed");
    expect(result.resultJson).toBeUndefined();
  });

  it("keeps abort failures reportable even if their cause looks like a transport error", async () => {
    const aborted = Object.assign(new Error("cancelled", { cause: { code: "ECONNRESET" } }), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw aborted; }));
    const result = await execute(makeCtx(config));
    expect(result.resultJson).toBeUndefined();
    expect(result.errorCode).toBe("hermes_gateway_connect_failed");
  });

  it.each([400, 409, 422])("does not trust HTTP %i body claims about connection failures", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "ECONNREFUSED", connectionFailure: marker("create_run", "connection_refused"),
    }), { status })));
    const result = await execute(makeCtx(config));
    expect(result.errorCode).toBe("hermes_gateway_protocol_error");
    expect(result.resultJson).toBeUndefined();
  });

  it.each(["not json", JSON.stringify({ status: "running", connectionFailure: marker("create_run", "connection_refused") })])(
    "keeps malformed successful create responses reportable", async (body) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
      const result = await execute(makeCtx(config));
      expect(result.errorCode).toBe("hermes_gateway_protocol_error");
      expect(result.resultJson).toBeUndefined();
    },
  );

  it("does not classify a local response reader TypeError", async () => {
    const response = new Response("unread");
    vi.spyOn(response, "text").mockRejectedValue(new TypeError("cannot read property of undefined"));
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const result = await execute(makeCtx(config));
    expect(result.errorCode).toBe("hermes_gateway_protocol_error");
    expect(result.resultJson).toBeUndefined();
  });

  it("does not trust a callback error with forged gateway codes or markers", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx(config);
    ctx.onDispatch = () => { throw Object.assign(new Error("callback bug"), {
      code: "hermes_gateway_auth_failed", status: 401, cause: { code: "ECONNREFUSED" },
      connectionFailure: marker("create_run", "authentication_failed"),
    }); };
    const result = await execute(ctx);
    expect(result.resultJson).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed", "cancelled"])("does not classify remote terminal %s from text or a forged marker", (status) => {
    const result = mapFinalResultForTest({
      terminal: { runId: "run-remote", status, payload: {
        error: "ECONNREFUSED", code: "ECONNREFUSED",
        connectionFailure: marker("create_run", "connection_refused"),
      } }, outputChunks: [], sessionKey: null, strategy: "none",
    });
    expect(result.resultJson?.connectionFailure).toBeUndefined();
    expect(result.errorCode).toBe(status === "completed" ? undefined : status === "failed" ? "hermes_gateway_run_failed" : "hermes_gateway_cancelled");
  });

  it("retains an ambiguous accepted-run timeout after stream, poll, and stop connection failures", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "run-accepted" }));
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ ...config, timeoutSec: 0.3, pollIntervalMs: 250, eventReconnectMs: 250 });
    const result = await execute(ctx);
    expect(result).toMatchObject({ timedOut: true, errorCode: "hermes_gateway_timeout" });
    expect(result.resultJson?.connectionFailure).toBeUndefined();
    expect(result.resultJson?.run_id).toBe("run-accepted");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/stop"))).toBe(true);
    expect(ctx.onLog).toHaveBeenCalledWith("stderr", expect.stringContaining("status poll failed"));
  });
});

describe("testEnvironment", () => {
  it("fails remote plain HTTP before probing health", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://hermes.example:8642",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_denied",
          level: "error",
        }),
      ]),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows remote plain HTTP only with the unsafe dev escape hatch", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://hermes.example:8642",
        apiKey: "secret-key",
        dangerouslyAllowInsecureRemoteHttp: true,
      },
    });

    expect(result.status).toBe("warn");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_unsafe_allowed",
          level: "warn",
        }),
        expect.objectContaining({
          code: "hermes_gateway_health_ok",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalled();
  });

  it("fails test environment checks when Hermes health is unreachable", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND host.docker.internal"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause });
    }));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://host.docker.internal:8642",
        apiKey: "secret-key",
        dangerouslyAllowInsecureRemoteHttp: true,
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_health_unreachable",
          level: "error",
          detail: expect.stringContaining("ENOTFOUND"),
        }),
      ]),
    );
  });

  it("fails test environment checks when Hermes health returns a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: "wrong-key",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_health_failed",
          level: "error",
          message: "Hermes Gateway health endpoint returned HTTP 401.",
        }),
      ]),
    );
  });

  it("tests a bare Hermes dashboard URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:9119",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          message: "Default Hermes dashboard root mapped to API base http://127.0.0.1:9119/api.",
          hint: expect.stringContaining("/api/v1/runs"),
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("tests a Hermes dashboard chat URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:9119/chat",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          message: "Default Hermes dashboard root mapped to API base http://127.0.0.1:9119/api.",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("mapFinalResultForTest", () => {
  it("maps failed statuses into adapter errors", () => {
    const result = mapFinalResultForTest({
      terminal: {
        runId: "run-1",
        status: "failed",
        payload: { status: "failed", error: "boom" },
      },
      outputChunks: [],
      sessionKey: "session-key",
      strategy: "issue",
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_run_failed");
    expect(result.errorMessage).toBe("boom");
  });

  it("reports a run stopped at the iteration limit as its own error, not as the reply", () => {
    const result = mapFinalResultForTest({
      terminal: {
        runId: "run-1",
        status: "failed",
        payload: { status: "failed", completed: false, partial: false, turn_exit_reason: "max_iterations_reached(80/80)", output: "Feito. A COL-17 está fechada." },
      },
      outputChunks: [],
      sessionKey: "session-key",
      strategy: "issue",
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_iteration_limit");
    expect(result.errorMessage).toContain("step limit (80/80");
    expect(result.summary).toBe("Feito. A COL-17 está fechada.");
  });

  it("names any other unfinished-turn reason instead of echoing the reply", () => {
    const result = mapFinalResultForTest({
      terminal: { runId: "run-1", status: "failed", payload: { status: "failed", turn_exit_reason: "empty_response_exhausted", output: "partial text" } },
      outputChunks: [],
      sessionKey: "session-key",
      strategy: "issue",
    });
    expect(result.errorCode).toBe("hermes_gateway_run_failed");
    expect(result.errorMessage).toBe("Hermes ended the turn before finishing: empty_response_exhausted.");
  });
});

describe("execute — remote run ownership", () => {
  const config = { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5, pollIntervalMs: 250 };

  function completedStream(output: string) {
    return sseStream([
      "event: message.delta", `data: ${JSON.stringify({ event: "message.delta", delta: output, seq: 0 })}`, "",
      "event: run.completed", `data: ${JSON.stringify({ event: "run.completed", status: "completed", output, seq: 1 })}`, "",
    ].join("\n"));
  }

  /** An SSE body that stays open until the request is aborted. */
  function hangingStream(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(": open\n\n"));
        signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      },
    });
  }

  it("records the Hermes run id as soon as the run is created", async () => {
    const ctx = makeCtx(config);
    const onExternalRun = vi.fn(async () => undefined);
    ctx.onExternalRun = onExternalRun;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "run-hermes-1" }), { status: 200 });
      if (url.endsWith("/events")) return new Response(completedStream("done"), { status: 200 });
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    }));

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(onExternalRun).toHaveBeenCalledWith({ externalRunId: "run-hermes-1" });
  });

  async function createdRunBody(ctx: AdapterExecutionContext): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ run_id: "run-hermes-1" }), { status: 200 });
      }
      if (url.endsWith("/events")) return new Response(completedStream("done"), { status: 200 });
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    }));
    expect((await execute(ctx)).exitCode).toBe(0);
    return body;
  }

  it("hands the run's Paperclip token to the paperclip MCP server through mcp_meta", async () => {
    const ctx = makeCtx(config);
    ctx.authToken = "run-jwt";
    const body = await createdRunBody(ctx);
    expect(body.mcp_meta).toEqual({
      paperclip: { "paperclip.ai/run": { token: "run-jwt", runId: "pc-run-1", agentId: "agent-1", companyId: "company-1" } },
    });
    expect(String(body.input)).not.toContain("run-jwt");
    expect(String(body.instructions)).not.toContain("run-jwt");
    const logged = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, chunk]) => String(chunk)).join("");
    expect(logged).not.toContain("run-jwt");
  });

  it("names another MCP server, or sends none, as configured", async () => {
    const named = makeCtx({ ...config, paperclipMcpServer: "board" });
    named.authToken = "run-jwt";
    expect(Object.keys((await createdRunBody(named)).mcp_meta as object)).toEqual(["board"]);

    const off = makeCtx({ ...config, paperclipMcpServer: false });
    off.authToken = "run-jwt";
    expect(await createdRunBody(off)).not.toHaveProperty("mcp_meta");

    expect(await createdRunBody(makeCtx(config))).not.toHaveProperty("mcp_meta");
  });

  it("reattaches to the named Hermes run without creating a new one", async () => {
    const ctx = makeCtx(config);
    ctx.context = { ...ctx.context, remoteRunReattach: { externalRunId: "run-hermes-1", sourceRunId: "pc-run-0" } };
    const onExternalRun = vi.fn(async () => undefined);
    ctx.onExternalRun = onExternalRun;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) throw new Error("must not create a run");
      if (url.endsWith("/events")) return new Response(completedStream("finished while Paperclip was away"), { status: 200 });
      if (url.endsWith("/v1/runs/run-hermes-1") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "running" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.resultJson?.output).toBe("finished while Paperclip was away");
    expect(result.sessionParams).toMatchObject({ hermesRunId: "run-hermes-1" });
    expect(onExternalRun).toHaveBeenCalledWith({ externalRunId: "run-hermes-1" });
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/v1/runs") && init?.method === "POST")).toBe(false);
  });

  it("fails clearly when Hermes no longer knows the run to reattach", async () => {
    const ctx = makeCtx(config);
    ctx.context = { ...ctx.context, remoteRunReattach: { externalRunId: "run-gone", sourceRunId: "pc-run-0" } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 })));

    const result = await execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_reattach_not_found");
    expect(result.executionRecovery).toBeUndefined();
  });

  it("leaves the Hermes run going when Paperclip shuts down", async () => {
    const controller = new AbortController();
    const ctx = { ...makeCtx(config), signal: controller.signal };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "run-hermes-1" }), { status: 200 });
      if (url.endsWith("/events")) {
        setTimeout(() => controller.abort(serverShutdownAbortReason("Interrupted by graceful server shutdown (SIGTERM)")), 20);
        return new Response(hangingStream(init?.signal), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    expect(result.errorCode).toBe("hermes_gateway_detached");
    expect(result.executionRecovery).toEqual({ kind: "remote_detached", externalRunId: "run-hermes-1", providerWorkStarted: true });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/stop"))).toBe(false);
  });

  it("stops the Hermes run on an operator Stop and proves it stopped", async () => {
    const controller = new AbortController();
    const ctx = { ...makeCtx(config), signal: controller.signal };
    let stopped = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "run-hermes-1" }), { status: 200 });
      if (url.endsWith("/events")) {
        setTimeout(() => controller.abort(new Error("Cancelled by board")), 20);
        return new Response(hangingStream(init?.signal), { status: 200 });
      }
      if (url.endsWith("/stop")) {
        stopped = true;
        return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: stopped ? "cancelled" : "running" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    expect(stopped).toBe(true);
    expect(result.errorCode).toBe("hermes_gateway_cancelled");
    expect(result.executionRecovery).toEqual({
      kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled",
    });
  });

  it("resumes a dropped event stream after the last seen event instead of replaying it", async () => {
    const ctx = makeCtx(config);
    const eventRequests: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "run-hermes-1" }), { status: 200 });
      if (url.endsWith("/events")) {
        const headers = new Headers(init?.headers);
        eventRequests.push(headers.get("Last-Event-ID"));
        const frames = (seqs: Array<[number, string]>) => seqs.flatMap(([seq, delta]) =>
          ["event: message.delta", `data: ${JSON.stringify({ event: "message.delta", delta, seq })}`, ""]);
        if (eventRequests.length === 1) {
          // First connection drops after two deltas.
          return new Response(sseStream(frames([[0, "Hello"], [1, " there"]]).join("\n")), { status: 200 });
        }
        // Hermes replays the full backlog when the client sends no position.
        return new Response(sseStream([
          ...frames([[0, "Hello"], [1, " there"], [2, "!"]]),
          "event: run.completed", `data: ${JSON.stringify({ event: "run.completed", status: "completed", output: "Hello there!", seq: 3 })}`, "",
        ].join("\n")), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    }));

    const result = await execute({ ...ctx, config: { ...config, eventReconnectMs: 250 } });
    const stdout = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([stream]) => stream === "stdout").map(([, chunk]) => String(chunk)).join("");
    const deltas = stdout.split("\n").flatMap((line) => parseHermesGatewayStdoutLine(line, "2026-10-05T00:00:00Z"))
      .flatMap((entry) => entry.kind === "assistant" ? [entry.text] : []);

    expect(result.exitCode).toBe(0);
    expect(eventRequests).toEqual([null, "1"]);
    expect(deltas).toEqual(["Hello", " there", "!"]);
  });
});
