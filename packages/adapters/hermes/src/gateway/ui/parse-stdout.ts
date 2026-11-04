import type { TranscriptEntry } from "@paperclipai/adapter-utils";

/**
 * Strip ANSI escape sequences (CSI, OSC) from terminal text.
 * Same pattern used in claude-local adapter quota.ts.
 */
function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Pull the reasoning text out of a `reasoning.available` event payload.
 * The exact field name is defined by the external Hermes gateway, so this
 * checks the plausible field names (mirroring the fallback chain used by
 * extractOutput() in gateway/server/execute.ts) and recurses one level into
 * nested `data` / `payload` records.
 */
function extractDirectReasoningText(data: Record<string, unknown>): string {
  return (
    asString(data.reasoning).trim() ||
    asString(data.reasoning_text).trim() ||
    asString(data.thinking).trim() ||
    asString(data.text).trim() ||
    asString(data.summary).trim() ||
    asString(data.content).trim()
  );
}

function extractReasoningText(data: Record<string, unknown> | null): string {
  if (!data) return "";
  const direct = extractDirectReasoningText(data);
  if (direct) return stripAnsi(direct);
  const nested = asRecord(data.data) ?? asRecord(data.payload);
  const nestedDirect = nested ? extractDirectReasoningText(nested) : "";
  return nestedDirect ? stripAnsi(nestedDirect) : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Field the gateway adapter stamps on paired tool.started / tool.completed events. */
const TOOL_USE_ID_FIELD = "paperclip_tool_use_id";

function toolUseId(runId: string, toolName: string, data: Record<string, unknown> | null): string {
  return (
    asString(data?.[TOOL_USE_ID_FIELD]) ||
    asString(data?.tool_call_id) ||
    asString(data?.toolCallId) ||
    // Logs written before the adapter paired tool events: one id per event,
    // so each call still renders, just without its result attached.
    `${runId}:${toolName}:${typeof data?.seq === "number" ? data.seq : "?"}`
  );
}

function toolName(data: Record<string, unknown> | null): string {
  return asString(data?.tool) || asString(data?.name) || "tool";
}

function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 100_000 ? 0 : 1)}k` : String(count);
}

function completedSummary(data: Record<string, unknown> | null): string {
  const parts = ["Hermes run completed"];
  const runtime = asRecord(data?.runtime);
  const model = asString(runtime?.model) || asString(data?.model);
  if (model) parts.push(model);
  const usage = asRecord(data?.usage);
  const input = asNumber(usage?.input_tokens);
  const output = asNumber(usage?.output_tokens);
  if (input > 0 || output > 0) {
    const cached = asNumber(usage?.cache_read_tokens);
    parts.push(`${formatTokens(input)} in${cached > 0 ? ` (${formatTokens(cached)} cached)` : ""} / ${formatTokens(output)} out`);
  }
  return parts.join(" · ");
}

function subagentText(eventName: string, data: Record<string, unknown> | null): string {
  const goal = asString(data?.goal).trim();
  if (eventName === "subagent.start") return goal ? `Subagent started: ${goal}` : "Subagent started";
  const status = asString(data?.status).trim();
  const summary = asString(data?.summary).trim();
  return [`Subagent ${status || "finished"}`, summary || goal].filter(Boolean).join(": ");
}

export function parseHermesGatewayStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const cleaned = stripAnsi(line);
  const trimmed = cleaned.trim();
  if (!trimmed) return [];

  const eventMatch = trimmed.match(/^\[hermes-gateway:event\]\s+run=([^\s]+)\s+event=([^\s]+)\s+data=(.*)$/s);
  if (eventMatch) {
    const runId = eventMatch[1];
    const eventName = eventMatch[2];
    const data = asRecord(safeJsonParse(eventMatch[3]));
    if (eventName === "message.delta") {
      const delta = asString(data?.delta) || asString(data?.text_delta);
      return delta ? [{ kind: "assistant", ts, text: stripAnsi(delta), delta: true }] : [];
    }
    if (eventName === "run.failed" || eventName === "run.error") {
      const message = asString(data?.error) || asString(data?.message) || "Hermes run failed";
      return [{ kind: "stderr", ts, text: message }];
    }
    if (eventName === "reasoning.available") {
      const reasoning = extractReasoningText(data);
      return [{ kind: "thinking", ts, text: reasoning || "Hermes reasoning available" }];
    }
    if (eventName === "tool.started") {
      const name = toolName(data);
      const preview = asString(data?.preview);
      return [{
        kind: "tool_call",
        ts,
        name,
        input: preview ? { preview: stripAnsi(preview) } : {},
        toolUseId: toolUseId(runId, name, data),
      }];
    }
    if (eventName === "tool.completed" || eventName === "tool.failed") {
      const name = toolName(data);
      const duration = asNumber(data?.duration);
      const preview = stripAnsi(asString(data?.preview) || asString(data?.error));
      return [{
        kind: "tool_result",
        ts,
        toolUseId: toolUseId(runId, name, data),
        toolName: name,
        content: preview || (duration > 0 ? `Finished in ${duration.toFixed(1)}s` : "Finished"),
        isError: eventName === "tool.failed" || data?.error === true,
      }];
    }
    if (eventName === "message.interim") {
      // Interim text is a recap of what message.delta already streamed.
      if (data?.already_streamed === true) return [];
      const text = asString(data?.text);
      return text ? [{ kind: "assistant", ts, text: stripAnsi(text), channel: "progress" }] : [];
    }
    if (eventName === "run.completed") {
      return [{ kind: "system", ts, text: completedSummary(data) }];
    }
    if (eventName === "subagent.start" || eventName === "subagent.complete") {
      return [{ kind: "system", ts, text: subagentText(eventName, data) }];
    }
    return [{ kind: "system", ts, text: `Hermes event: ${eventName}` }];
  }

  if (trimmed.startsWith("[hermes-gateway]")) {
    return [{ kind: "system", ts, text: trimmed.replace(/^\[hermes-gateway\]\s*/, "") }];
  }

  return [{ kind: "stdout", ts, text: cleaned }];
}
