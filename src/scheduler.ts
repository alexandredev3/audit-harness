import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./db.ts";
import type { AgentRunner } from "./runner/types.ts";
import type { HarnessConfig, Role, Stage } from "./types.ts";

export class PauseRun extends Error { }
export class FatalRun extends Error { }

export interface RunContext {
  store: Store;
  config: HarnessConfig;
  runners: Record<string, AgentRunner>;
  target: string;
  outDir: string;
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
}

export const READ_TOOLS = ["Read", "Grep", "Glob"];
const MAX_MALFORMED_ATTEMPTS = 2;

export interface TaskSpec<T, S> {
  key: string;
  stage: Stage;
  role: Role;
  agentId: string;
  tools: string[];
  schema: Record<string, unknown>;
  prompt: () => string;
  /** `lastAttempt` lets a reader salvage what it can. */
  read: (output: unknown, lastAttempt: boolean) => { value: T } | { errors: string[] };
  /** Applies the result to the store. Runs in the transaction that marks the task done. */
  commit: (value: T) => S;
  /** Invocations that must stay in the budget after this task launches, for work already owed. */
  reserve?: () => number;
  /** Runs in the transaction that takes the budget and marks the task running. */
  onLaunch?: () => void;
  /** Runs in the transaction that marks the task failed. */
  onFail?: () => void;
}

export type TaskResult<S> =
  | { status: "done"; output: S }
  | { status: "failed"; errors: string[] }
  | { status: "no_budget" };

export async function execTask<T, S>(ctx: RunContext, spec: TaskSpec<T, S>): Promise<TaskResult<S>> {
  const { store, config } = ctx;
  const existing = store.ensureTask(spec.key, spec.agentId, spec.stage);
  if (existing.status === "done") return { status: "done", output: existing.output as S };
  if (existing.status === "failed") return { status: "failed", errors: [existing.error ?? "failed earlier"] };

  const role = config.roles[spec.role];
  const runner = ctx.runners[role.runner];
  if (!runner) throw new FatalRun(`no runner named "${role.runner}" is registered`);

  let feedback: string[] = [];
  let malformed = 0;
  let transient = 0;
  let attempt = existing.attempt;
  let cost = existing.cost_usd ?? 0;

  for (; ;) {
    attempt++;
    const launched = store.tx(() => {
      if (!store.spend(spec.reserve?.() ?? 0)) return false;
      store.updateTask(spec.key, { status: "running", attempt, runner: runner.name, model: role.model });
      spec.onLaunch?.();
      return true;
    });
    if (!launched) {
      if (feedback.length === 0) return { status: "no_budget" };
      // The retry would eat into a reserve, so the rejected answer stands as a failure.
      store.tx(() => {
        store.updateTask(spec.key, { status: "failed", error: `no budget to retry: ${feedback.slice(0, 20).join("; ")}` });
        spec.onFail?.();
      });
      ctx.log(`failed  ${spec.key}: no budget to retry`);
      return { status: "failed", errors: feedback };
    }

    const agentDir = join(ctx.outDir, "agents", spec.agentId);
    mkdirSync(agentDir, { recursive: true });
    const prompt = feedback.length === 0 ? spec.prompt() : spec.prompt() +
      "\n\n# Your previous answer was rejected\n\nFix every problem below and return the complete JSON object again:\n" +
      feedback.slice(0, 30).map((e) => `- ${e}`).join("\n");

    const result = await runner.run({
      agentId: spec.agentId,
      prompt,
      model: role.model,
      targetDir: ctx.target,
      agentDir,
      tools: spec.tools,
      harnessTools: [],
      outputSchema: spec.schema,
      timeoutMs: config.taskTimeoutMs,
      maxTurns: config.maxTurns,
    });
    cost += result.costUsd ?? 0;
    store.updateTask(spec.key, { cost_usd: cost, turns: result.turns ?? null, duration_ms: result.durationMs ?? null });

    let outcome = result.outcome;
    if (outcome.kind === "ok") {
      const read = spec.read(outcome.output, malformed + 1 >= MAX_MALFORMED_ATTEMPTS);
      if ("value" in read) {
        const output = store.tx(() => {
          const stored = spec.commit(read.value);
          store.updateTask(spec.key, { status: "done", output: stored, error: null });
          return stored;
        });
        ctx.log(`done    ${spec.key}`);
        return { status: "done", output };
      }
      outcome = { kind: "malformed", errors: read.errors };
    }

    switch (outcome.kind) {
      case "malformed": {
        malformed++;
        const errors = outcome.errors;
        if (malformed >= MAX_MALFORMED_ATTEMPTS) {
          store.tx(() => {
            store.updateTask(spec.key, { status: "failed", error: errors.slice(0, 20).join("; ") });
            spec.onFail?.();
          });
          ctx.log(`failed  ${spec.key}: ${errors[0]}`);
          return { status: "failed", errors };
        }
        ctx.log(`retry   ${spec.key}: ${errors.length} problem(s), first: ${errors[0]}`);
        feedback = errors;
        break;
      }
      case "transient": {
        store.refund();
        transient++;
        if (transient >= config.transientRetries) {
          store.updateTask(spec.key, { status: "queued", error: outcome.reason });
          throw new PauseRun(`${spec.key} failed ${transient} times: ${outcome.reason}`);
        }
        ctx.log(`backoff ${spec.key}: ${outcome.reason}`);
        await ctx.sleep(config.backoffMs * 2 ** (transient - 1));
        break;
      }
      case "quota":
        store.refund();
        store.updateTask(spec.key, { status: "queued", error: outcome.reason });
        throw new PauseRun(`usage limit reached: ${outcome.reason}`);
      case "fatal":
        store.refund();
        store.updateTask(spec.key, { status: "queued", error: outcome.reason });
        throw new FatalRun(outcome.reason);
    }
  }
}

export async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failed) throw failure;
}
