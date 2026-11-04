import { describe, expect, it } from "vitest";
import { parseHermesGatewayStdoutLine } from "./parse-stdout.js";

const TS = "2026-07-08T12:00:00.000Z";

function eventLine(eventName: string, data: unknown): string {
  return `[hermes-gateway:event] run=run-123 event=${eventName} data=${JSON.stringify(data)}`;
}

describe("parseHermesGatewayStdoutLine — reasoning.available payload extraction", () => {
  // This is the assertion that FAILS on the old hardcoded-placeholder code
  // and PASSES once the real reasoning text is extracted from `data`.
  it("uses the real reasoning text from data.text instead of the hardcoded placeholder", () => {
    const result = parseHermesGatewayStdoutLine(
      eventLine("reasoning.available", { text: "Considering three approaches to the cache invalidation bug." }),
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "thinking",
      ts: TS,
      text: "Considering three approaches to the cache invalidation bug.",
    });
    expect(result[0]).not.toHaveProperty("text", "Hermes reasoning available");
  });

  it("uses the real reasoning text from data.summary", () => {
    const result = parseHermesGatewayStdoutLine(
      eventLine("reasoning.available", { summary: "Weighing tradeoffs between two refactor strategies." }),
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "thinking",
      ts: TS,
      text: "Weighing tradeoffs between two refactor strategies.",
    });
  });

  it("recurses one level into a nested data.data record to find the reasoning text", () => {
    const result = parseHermesGatewayStdoutLine(
      eventLine("reasoning.available", { data: { text: "Nested reasoning payload from gateway wrapper." } }),
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "thinking",
      ts: TS,
      text: "Nested reasoning payload from gateway wrapper.",
    });
  });

  it("recurses one level into a nested data.payload record to find the reasoning text", () => {
    const result = parseHermesGatewayStdoutLine(
      eventLine("reasoning.available", { payload: { reasoning: "Nested via payload wrapper instead of data." } }),
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "thinking",
      ts: TS,
      text: "Nested via payload wrapper instead of data.",
    });
  });

  it("falls back to the placeholder when data has no recognizable text field (preserves bare-signal behavior)", () => {
    const result = parseHermesGatewayStdoutLine(
      eventLine("reasoning.available", { unrelatedField: 42 }),
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "thinking", ts: TS, text: "Hermes reasoning available" });
  });

  it("falls back to the placeholder when data is entirely absent/unparseable", () => {
    const result = parseHermesGatewayStdoutLine(
      "[hermes-gateway:event] run=run-123 event=reasoning.available data=not-json",
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "thinking", ts: TS, text: "Hermes reasoning available" });
  });
});

describe("parseHermesGatewayStdoutLine — regression guards for unrelated handlers", () => {
  it("still yields an assistant delta part for message.delta", () => {
    const result = parseHermesGatewayStdoutLine(
      eventLine("message.delta", { delta: "Hello there" }),
      TS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "assistant", ts: TS, text: "Hello there", delta: true });
  });

  it("still yields a stdout part for a plain non-event line", () => {
    const result = parseHermesGatewayStdoutLine("just a plain line of output", TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "stdout", ts: TS, text: "just a plain line of output" });
  });
});

describe("parseHermesGatewayStdoutLine — tool, interim, subagent and completion events", () => {
  it("renders tool.started as a tool call keyed by the adapter's pairing id", () => {
    expect(parseHermesGatewayStdoutLine(
      eventLine("tool.started", { tool: "terminal", preview: "ls -la", seq: 4, paperclip_tool_use_id: "run-123:tool:1" }),
      TS,
    )).toEqual([{ kind: "tool_call", ts: TS, name: "terminal", input: { preview: "ls -la" }, toolUseId: "run-123:tool:1" }]);
  });

  it("renders tool.completed as a tool result with the same id and its error flag", () => {
    expect(parseHermesGatewayStdoutLine(
      eventLine("tool.completed", { tool: "terminal", duration: 0.3, error: true, preview: "Traceback", paperclip_tool_use_id: "run-123:tool:1" }),
      TS,
    )).toEqual([{ kind: "tool_result", ts: TS, toolUseId: "run-123:tool:1", toolName: "terminal", content: "Traceback", isError: true }]);
  });

  it("still renders tool events from logs written before the adapter paired them", () => {
    const [call] = parseHermesGatewayStdoutLine(eventLine("tool.started", { tool: "patch", preview: null, seq: 7 }), TS);
    expect(call).toEqual({ kind: "tool_call", ts: TS, name: "patch", input: {}, toolUseId: "run-123:patch:7" });
    const [result] = parseHermesGatewayStdoutLine(eventLine("tool.completed", { tool: "patch", duration: 1.25, error: false, preview: "" }), TS);
    expect(result).toMatchObject({ kind: "tool_result", toolName: "patch", content: "Finished in 1.3s", isError: false });
  });

  it("drops message.interim when the text was already streamed as deltas", () => {
    expect(parseHermesGatewayStdoutLine(eventLine("message.interim", { text: "Recap", already_streamed: true }), TS)).toEqual([]);
    expect(parseHermesGatewayStdoutLine(eventLine("message.interim", { text: "Checking the list." }), TS))
      .toEqual([{ kind: "assistant", ts: TS, text: "Checking the list.", channel: "progress" }]);
  });

  it("summarizes subagent lifecycle events", () => {
    expect(parseHermesGatewayStdoutLine(eventLine("subagent.start", { goal: "Score 20 leads" }), TS))
      .toEqual([{ kind: "system", ts: TS, text: "Subagent started: Score 20 leads" }]);
    expect(parseHermesGatewayStdoutLine(eventLine("subagent.complete", { status: "completed", summary: "20 scored" }), TS))
      .toEqual([{ kind: "system", ts: TS, text: "Subagent completed: 20 scored" }]);
  });
});
