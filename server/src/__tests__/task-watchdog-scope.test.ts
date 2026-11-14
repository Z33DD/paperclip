import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  issueIsInTaskWatchdogSubtree,
  resolveTaskWatchdogMutationScope,
  TASK_WATCHDOG_ORIGIN_KIND,
  taskWatchdogScopeAllowsIssueMutation,
} from "../services/task-watchdog-scope.js";

type Row = Record<string, unknown>;

const COMPANY = "company-1";
const OTHER_COMPANY = "company-2";
const AGENT = "agent-1";
const RUN = "run-1";
const WATCHED = "issue-watched";
const WATCHDOG_ISSUE = "issue-watchdog";

/**
 * O serviço só usa `db.select(...).from(...).where(...).then(rows => ...)`, então cada consulta é
 * uma linha da fila. Isso deixa cada teste dizer exatamente quantas leituras espera.
 */
function fakeDb(results: Row[][]): Db {
  const queue = [...results];
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          then: (fn: (rows: Row[]) => unknown) => Promise.resolve(fn(queue.shift() ?? [])),
        }),
      }),
    }),
  } as unknown as Db;
}

function untouchedDb(): Db {
  return {
    select: () => {
      throw new Error("o banco não deveria ser consultado neste caso");
    },
  } as unknown as Db;
}

function runRow(overrides: Row = {}): Row {
  return {
    id: RUN,
    companyId: COMPANY,
    agentId: AGENT,
    contextSnapshot: { taskWatchdog: { watchedIssueId: WATCHED } },
    ...overrides,
  };
}

function watchdogRow(overrides: Row = {}): Row {
  return {
    id: "wd-1",
    companyId: COMPANY,
    issueId: WATCHED,
    watchdogAgentId: AGENT,
    watchdogIssueId: WATCHDOG_ISSUE,
    status: "active",
    ...overrides,
  };
}

const agentActor = { type: "agent", agentId: AGENT, runId: RUN, companyId: COMPANY };

function issueRow(id: string, parentId: string | null = null, originKind: string | null = null): Row {
  return { id, companyId: COMPANY, parentId, originKind };
}

describe("resolveTaskWatchdogMutationScope", () => {
  it("ignores a non-agent actor without touching the database", async () => {
    await expect(
      resolveTaskWatchdogMutationScope(untouchedDb(), { type: "user", agentId: AGENT, runId: RUN }),
    ).resolves.toEqual({ kind: "none" });
  });

  it("ignores an agent actor that is not tied to a run", async () => {
    await expect(
      resolveTaskWatchdogMutationScope(untouchedDb(), { type: "agent", agentId: AGENT, runId: null }),
    ).resolves.toEqual({ kind: "none" });
    await expect(
      resolveTaskWatchdogMutationScope(untouchedDb(), { type: "agent", agentId: null, runId: RUN }),
    ).resolves.toEqual({ kind: "none" });
  });

  it("ignores a run that no longer exists", async () => {
    await expect(resolveTaskWatchdogMutationScope(fakeDb([[]]), agentActor)).resolves.toEqual({
      kind: "none",
    });
  });

  it("ignores an ordinary run that carries no watchdog context", async () => {
    const db = fakeDb([[runRow({ contextSnapshot: { issueId: WATCHED } })]]);
    await expect(resolveTaskWatchdogMutationScope(db, agentActor)).resolves.toEqual({ kind: "none" });
  });

  it("accepts the legacy boolean flag with the watched issue at the top level", async () => {
    const db = fakeDb([
      [runRow({ contextSnapshot: { taskWatchdog: true, watchedIssueId: WATCHED } })],
      [],
    ]);
    await expect(resolveTaskWatchdogMutationScope(db, agentActor)).resolves.toEqual({
      kind: "invalid",
      detail: "Task-watchdog run context is not backed by an active persisted watchdog.",
    });
  });

  it("refuses a watchdog context that belongs to another agent", async () => {
    const db = fakeDb([[runRow({ agentId: "agent-2" })]]);
    await expect(resolveTaskWatchdogMutationScope(db, agentActor)).resolves.toEqual({
      kind: "invalid",
      detail: "Task-watchdog run context does not belong to this agent.",
    });
  });

  it("refuses a run from another company than the actor's", async () => {
    const db = fakeDb([[runRow({ companyId: OTHER_COMPANY })]]);
    await expect(resolveTaskWatchdogMutationScope(db, agentActor)).resolves.toEqual({
      kind: "invalid",
      detail: "Task-watchdog run context does not belong to this agent.",
    });
  });

  it("refuses a watchdog context with no persisted watched issue", async () => {
    const db = fakeDb([[runRow({ contextSnapshot: { taskWatchdog: { stopFingerprint: "fp" } } })]]);
    await expect(resolveTaskWatchdogMutationScope(db, agentActor)).resolves.toEqual({
      kind: "invalid",
      detail: "Task-watchdog run context is missing a persisted watched issue id.",
    });
  });

  it("returns the persisted scope when an active watchdog backs the run", async () => {
    const db = fakeDb([[runRow()], [watchdogRow()]]);
    await expect(resolveTaskWatchdogMutationScope(db, agentActor)).resolves.toEqual({
      kind: "watchdog",
      watchdogId: "wd-1",
      companyId: COMPANY,
      watchedIssueId: WATCHED,
      watchdogIssueId: WATCHDOG_ISSUE,
      stopFingerprint: null,
    });
  });

  it("keeps the stop fingerprint and a missing watchdog issue as null", async () => {
    const db = fakeDb([
      [runRow({ contextSnapshot: { taskWatchdog: { watchedIssueId: WATCHED, stopFingerprint: "fp-9" } } })],
      [watchdogRow({ watchdogIssueId: null })],
    ]);
    await expect(resolveTaskWatchdogMutationScope(db, agentActor)).resolves.toEqual({
      kind: "watchdog",
      watchdogId: "wd-1",
      companyId: COMPANY,
      watchedIssueId: WATCHED,
      watchdogIssueId: null,
      stopFingerprint: "fp-9",
    });
  });
});

describe("issueIsInTaskWatchdogSubtree", () => {
  it("accepts the watched issue itself", async () => {
    await expect(
      issueIsInTaskWatchdogSubtree(fakeDb([[issueRow(WATCHED)]]), COMPANY, WATCHED, WATCHED),
    ).resolves.toBe(true);
  });

  it("walks up through the parents", async () => {
    const db = fakeDb([[issueRow("child", WATCHED)], [issueRow(WATCHED)]]);
    await expect(issueIsInTaskWatchdogSubtree(db, COMPANY, "child", WATCHED)).resolves.toBe(true);
  });

  it("rejects an issue outside the watched subtree", async () => {
    const db = fakeDb([[issueRow("unrelated", null)]]);
    await expect(issueIsInTaskWatchdogSubtree(db, COMPANY, "unrelated", WATCHED)).resolves.toBe(false);
  });

  it("rejects a chain that crosses a watchdog-created issue", async () => {
    const db = fakeDb([[issueRow("child", WATCHED)], [issueRow(WATCHED, null, TASK_WATCHDOG_ORIGIN_KIND)]]);
    await expect(issueIsInTaskWatchdogSubtree(db, COMPANY, "child", WATCHED)).resolves.toBe(false);
  });

  it("stops on a cycle instead of looping forever", async () => {
    const db = fakeDb([[issueRow("a", "b")], [issueRow("b", "a")]]);
    await expect(issueIsInTaskWatchdogSubtree(db, COMPANY, "a", WATCHED)).resolves.toBe(false);
  });

  it("gives up after the ancestry depth limit", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => issueRow(`issue-${index}`, `issue-${index + 1}`));
    await expect(
      issueIsInTaskWatchdogSubtree(fakeDb(rows.map((row) => [row])), COMPANY, "issue-0", WATCHED),
    ).resolves.toBe(false);
  });

  it("rejects an issue the company query cannot see", async () => {
    await expect(issueIsInTaskWatchdogSubtree(fakeDb([[]]), OTHER_COMPANY, "x", WATCHED)).resolves.toBe(false);
  });
});

describe("taskWatchdogScopeAllowsIssueMutation", () => {
  const watchdogScope = {
    kind: "watchdog" as const,
    watchdogId: "wd-1",
    companyId: COMPANY,
    watchedIssueId: WATCHED,
    watchdogIssueId: WATCHDOG_ISSUE,
    stopFingerprint: null,
  };
  const target = (id: string, companyId: string = COMPANY) => ({ id, companyId });

  it("leaves scopes that are not watchdogs untouched", async () => {
    await expect(
      taskWatchdogScopeAllowsIssueMutation(untouchedDb(), { kind: "none" }, target("any")),
    ).resolves.toEqual({ kind: "none" });
    const invalid = { kind: "invalid" as const, detail: "x" };
    await expect(taskWatchdogScopeAllowsIssueMutation(untouchedDb(), invalid, target("any"))).resolves.toBe(
      invalid,
    );
  });

  it("refuses an issue from another company", async () => {
    await expect(
      taskWatchdogScopeAllowsIssueMutation(untouchedDb(), watchdogScope, target("any", OTHER_COMPANY)),
    ).resolves.toEqual({
      kind: "invalid",
      detail: "Task-watchdog mutation target is outside the watchdog company.",
    });
  });

  it("allows the watchdog's own issue without a query", async () => {
    await expect(
      taskWatchdogScopeAllowsIssueMutation(untouchedDb(), watchdogScope, target(WATCHDOG_ISSUE)),
    ).resolves.toBe(watchdogScope);
  });

  it("checks the subtree when the watchdog issue is not allowed", async () => {
    const db = fakeDb([[issueRow(WATCHDOG_ISSUE, WATCHED)], [issueRow(WATCHED)]]);
    await expect(
      taskWatchdogScopeAllowsIssueMutation(db, watchdogScope, target(WATCHDOG_ISSUE), {
        allowWatchdogIssue: false,
      }),
    ).resolves.toBe(watchdogScope);
  });

  it("allows an issue inside the watched subtree", async () => {
    const db = fakeDb([[issueRow("child", WATCHED)], [issueRow(WATCHED)]]);
    await expect(
      taskWatchdogScopeAllowsIssueMutation(db, watchdogScope, target("child")),
    ).resolves.toBe(watchdogScope);
  });

  it("refuses an issue outside the watched subtree", async () => {
    const db = fakeDb([[issueRow("unrelated", null)]]);
    await expect(taskWatchdogScopeAllowsIssueMutation(db, watchdogScope, target("unrelated"))).resolves.toEqual({
      kind: "invalid",
      detail: "Task-watchdog runs can only mutate the watched issue subtree.",
    });
  });
});
