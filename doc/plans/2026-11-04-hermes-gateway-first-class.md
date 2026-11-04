# Hermes Gateway as a first-class adapter

Date: 2026-11-04. Branch: `feat/hermes-gateway-first-class` (fork Z33DD/paperclip).

## Why

A company that runs every agent through `hermes_gateway` (Hermes API server, `/v1/runs` +
SSE) hits the same walls on day one:

1. **The issue page shows nothing useful while an agent works.** Tool calls and results
   arrive as `tool.started` / `tool.completed` events, which the transcript parser
   rendered as anonymous `Hermes event: tool.started` system lines. A run with 70 tool
   calls looks frozen. Releases up to 2026.1023.0 also wrote each delta without a newline,
   which glued the next event line onto it, so the page showed only the first word of
   the reply (upstream fixed that one in #15201).
2. **You can't pick it in the UI.** `hermes_gateway` is `hideFromVisualSelection`, and the
   onboarding wizard only offers `claude_local` / `codex_local`. Gateway agents have to be
   created through the API with a board token.
3. **A Paperclip restart kills live runs.** The run keeps going on the Hermes side, but
   Paperclip marks it `process_lost` because only Paperclip Runner runs can reattach. Then
   recovery re-wakes the agent and starts a duplicate.
4. **Agents can't write to Paperclip without extra wiring.** Writes need the run id. The
   stock MCP server reads it once at startup, which is wrong for a long-lived gateway
   (see paperclipai/paperclip#16636), so operators patch it per call.

## Phase 1: transcript (this change)

- `gateway/server/execute.ts`: Hermes tool events have no call id, so the adapter pairs
  `tool.started` with the next `tool.completed`/`tool.failed` of the same tool (FIFO, which
  matches Hermes' sequential executor) and stamps both with `paperclip_tool_use_id`. If
  Hermes ever sends `tool_call_id`, that id wins.
- `gateway/ui/parse-stdout.ts`:
  - `tool.started` → `tool_call` (preview as input)
  - `tool.completed` / `tool.failed` → `tool_result` (preview, error flag)
  - `message.interim` dropped when `already_streamed`
  - `run.completed` → one line with model and token usage
  - `subagent.start` / `subagent.complete` → readable lines
  - Logs written before pairing still render, with one id per event.

## Phase 2: create and configure in the UI

- Show `hermes_gateway` in the new-agent picker, under the Hermes card ("Local CLI" or
  "Gateway URL").
- Onboarding wizard: a "Connect a Hermes gateway" source: base URL, API key (stored as a
  secret), profile path (`/p/<profile>`), plus a connection test (`testEnvironment`
  already exists).
- `KNOWN_DEFAULTS` capability entries for both Hermes adapters, so the first render
  doesn't fall back to all-false.

## Phase 3: survive Paperclip restarts

- Persist `hermesRunId` as soon as the run is created. The session codec already carries it.
- On boot recovery, for `hermes_gateway` runs that are still `running`, ask
  `GET /v1/runs/{id}`. If the run is still live, reattach to `/v1/runs/{id}/events`. The
  Hermes backlog keeps 1,000 events, so replay from the last logged `seq`. If it's terminal,
  settle it with the real result. Never mark it `process_lost` while Hermes says it's
  running.
- Add `hermes_gateway` to the continuation/retry sets where a remote run can be proven alive.

## Phase 4: Paperclip tools without operator wiring

- Send the run id and a run-scoped key with each run (the request body's `metadata`, or a
  header the Hermes Paperclip toolset reads), so Hermes' Paperclip MCP calls carry them
  per call. Coordinate with #16636 instead of duplicating it.

## Out of scope

- Cost in USD: Hermes reports tokens, not money. Paperclip keeps token usage. Pricing stays
  with the provider routing.
