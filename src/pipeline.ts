import { createHash } from "node:crypto";
import { hunterAllowance, hunterReserve, minimumBudget, PLANNER_CALLS } from "./budget.ts";
import { citedLocationErrors, enforceLocalEvidence, TargetFiles } from "./checks.ts";
import type { FindingRow, LoopState, RunRow, UnitRow } from "./db.ts";
import { writeExports } from "./export.ts";
import {
  addCheck,
  archiveAttempt,
  assignmentOrder,
  buildUnit,
  closeUnit,
  deferred,
  exportLedger,
  type LedgerContext,
  readCriticResult,
  readHunterResult,
} from "./ledger.ts";
import {
  criticPrompt,
  hunterPrompt,
  plannerPrompt,
  type PromptContext,
  RECON_AGENTS,
  type ReconId,
  reconPrompt,
  recordVerifierPrompt,
  SCHEMAS,
  verifierPrompt,
} from "./prompts/assemble.ts";
import type { Catalog } from "./prompts/catalog.ts";
import type { Sandbox } from "./sandbox.ts";
import { execTask, FatalRun, PauseRun, pool, READ_TOOLS, type RunContext } from "./scheduler.ts";
import type { FindingRecord, LedgerUnit, PriorityFacts, Verdict } from "./types.ts";
import { validateFindings, validateLedger } from "./validators.ts";

export interface AuditContext extends RunContext {
  catalog: Catalog;
  sandbox: Sandbox;
}

const MAX_REPORT_CHARS = 20_000;
const MAX_RECORD_VERIFICATION_ROUNDS = 3;
const VERDICTS: Verdict[] = ["confirmed", "needs_validation", "rejected"];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const shortHash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);

/** A harness bug, not an agent failure: the stored ledger no longer satisfies the skill's validator. */
function assertLedgerValid(ctx: AuditContext, when: string): void {
  const errors = validateLedger(exportLedger(ctx.store.units()));
  if (errors.length > 0) {
    throw new Error(`coverage ledger is invalid ${when}; no further work can be assigned:\n${errors.slice(0, 10).join("\n")}`);
  }
}

function promptContext(ctx: AuditContext, run: RunRow): PromptContext {
  return { target: ctx.target, profile: run.profile, catalog: ctx.catalog, sandbox: ctx.sandbox.capabilities() };
}

function ledgerContext(ctx: AuditContext, run: RunRow, files: TargetFiles): LedgerContext {
  return { profile: run.profile, catalog: ctx.catalog, files };
}

export async function runAudit(ctx: AuditContext): Promise<RunRow> {
  const { store } = ctx;
  if (store.run().phase === "done") return store.run();
  recoverInterruptedWork(ctx);
  store.setStatus("in_progress");
  try {
    await runPhases(ctx);
  } catch (error) {
    if (error instanceof PauseRun || error instanceof FatalRun) {
      store.setStatus("paused");
      store.log(error instanceof FatalRun ? "fatal" : "paused", error.message);
      ctx.log(`${error instanceof FatalRun ? "Stopped" : "Paused"}: ${error.message}`);
      return store.run();
    }
    store.setStatus("paused");
    store.log("error", (error as Error).message);
    throw error;
  }
  return store.run();
}

function recoverInterruptedWork(ctx: AuditContext): void {
  const { store } = ctx;
  store.tx(() => {
    store.requeueRunningTasks();
    for (const row of store.units()) {
      if (row.unit.status === "in_progress") store.putUnit({ ...row.unit, status: "planned", agent_id: null });
    }
  });
}

async function runPhases(ctx: AuditContext): Promise<void> {
  const { store } = ctx;
  const files = new TargetFiles(ctx.target);

  if (store.run().phase === "recon") {
    const planned = await reconAndPlan(ctx, files);
    store.setPhase(planned ? "hunt" : "finalize");
  }
  if (store.run().phase === "hunt") {
    await huntLoop(ctx, files);
    store.setPhase("validate");
  }
  if (store.run().phase === "validate") {
    await validateCandidates(ctx, files);
    store.setPhase(store.run().profile === "standard" ? "verify" : "finalize");
  }
  if (store.run().phase === "verify") {
    await verifyRecords(ctx, files);
    store.setPhase("finalize");
  }
  if (store.run().phase === "finalize") {
    finalize(ctx);
    store.setPhase("done");
  }
}

// Phase 1: reconnaissance and planning

async function reconAndPlan(ctx: AuditContext, files: TargetFiles): Promise<boolean> {
  const { store } = ctx;
  const run = store.run();
  if (run.budget !== null && run.agents_spent === 0 && run.budget < minimumBudget(run.profile)) {
    store.noteIncomplete("budget_cannot_fund_reconnaissance_and_reserves");
    return false;
  }
  const pctx = promptContext(ctx, run);
  const reports = {} as Record<ReconId, string>;
  const ids = Object.keys(RECON_AGENTS) as ReconId[];

  await pool(ids, run.config.concurrency, async (id) => {
    const agentId = `recon-${id}`;
    const result = await execTask(ctx, {
      key: `recon:${id}`,
      stage: "recon",
      role: "recon",
      agentId,
      tools: READ_TOOLS,
      schema: SCHEMAS.recon,
      prompt: () => reconPrompt(id, agentId, pctx),
      read: (output): { value: string } | { errors: string[] } =>
        isObject(output) && typeof output.report === "string" && output.report.trim() !== ""
          ? { value: output.report.trim() }
          : { errors: ['return {"report": "<markdown>"} with a non-empty report'] },
      commit: (report) => {
        if (report.length > MAX_REPORT_CHARS) {
          store.log("recon_truncated", `${agentId} report cut from ${report.length} to ${MAX_REPORT_CHARS} characters`);
        }
        return { report: report.slice(0, MAX_REPORT_CHARS) };
      },
    });
    if (result.status === "done") reports[id] = result.output.report;
  });
  if (ids.some((id) => reports[id] === undefined)) {
    store.noteIncomplete("reconnaissance_failed");
    return false;
  }

  const lctx = ledgerContext(ctx, run, files);
  const allowance = hunterAllowance({
    remaining: store.remainingBudget() - PLANNER_CALLS,
    profile: run.profile,
    pendingCandidates: 0,
  });
  const result = await execTask(ctx, {
    key: "plan",
    stage: "plan",
    role: "planner",
    agentId: "planner",
    tools: [],
    schema: SCHEMAS.planner,
    prompt: () => plannerPrompt("planner", pctx, reports, allowance === Infinity ? null : allowance),
    read: (output, lastAttempt) => readPlan(output, lctx, lastAttempt),
    commit: (plan) => {
      store.setArchitecture(plan.architecture);
      for (const { unit, priority } of plan.units) store.putUnit(unit, { priority });
      for (const reason of plan.dropped) store.log("planner_unit_dropped", reason);
      return { units: plan.units.length, dropped: plan.dropped.length };
    },
  });
  if (result.status !== "done") {
    store.noteIncomplete(result.status === "no_budget" ? "budget_exhausted_before_planning" : "planner_failed");
    return false;
  }
  assertLedgerValid(ctx, "after seeding");
  ctx.log(`planned ${result.output.units} coverage units`);
  return true;
}

interface Plan {
  architecture: string;
  units: { unit: LedgerUnit; priority: PriorityFacts }[];
  dropped: string[];
}

function readPlan(output: unknown, lctx: LedgerContext, lastAttempt: boolean): { value: Plan } | { errors: string[] } {
  if (!isObject(output) || typeof output.architecture_md !== "string" || output.architecture_md.trim() === "") {
    return { errors: ["architecture_md must be a non-empty string"] };
  }
  if (!Array.isArray(output.units) || output.units.length === 0) {
    return { errors: ["units must list at least one coverage unit"] };
  }
  const errors: string[] = [];
  const byId = new Map<string, { unit: LedgerUnit; priority: PriorityFacts }>();
  output.units.forEach((proposal, index) => {
    const built = buildUnit(proposal, lctx);
    if ("errors" in built) return errors.push(...built.errors.map((e) => `units[${index}]: ${e}`));
    const twin = byId.get(built.unit.coverage_id);
    if (twin) {
      twin.unit.starting_paths = [...new Set([...twin.unit.starting_paths, ...built.unit.starting_paths])];
    } else {
      byId.set(built.unit.coverage_id, built);
    }
  });
  if (errors.length > 0 && !lastAttempt) return { errors };
  const units = [...byId.values()];
  if (units.length === 0) return { errors };
  const ledgerErrors = validateLedger(exportLedger(units.map((u) => ({ ...u, hardening: [], decisions: {} }))));
  if (ledgerErrors.length > 0) return { errors: ledgerErrors };
  return { value: { architecture: output.architecture_md.trim(), units, dropped: errors } };
}

// Phase 2: hunting waves and coverage critics

async function huntLoop(ctx: AuditContext, files: TargetFiles): Promise<void> {
  const { store } = ctx;
  const run = store.run();
  let state: LoopState = run.loop_state ?? { round: 1, step: "wave" };
  const save = (next: LoopState) => {
    state = next;
    store.setLoopState(next);
  };
  const plannedCount = () => store.units().filter((r) => r.unit.status === "planned").length;
  const deferPlanned = (reason: string) =>
    store.tx(() => {
      for (const row of store.units()) {
        if (row.unit.status === "planned") store.putUnit(deferred(row.unit, reason));
      }
    });
  const nextRound = () => {
    if (state.round >= run.config.maxWaves) {
      deferPlanned("max_waves_reached");
      return save({ round: state.round, step: "done" });
    }
    save({ round: state.round + 1, step: "wave" });
  };

  while (state.step !== "done") {
    if (state.step === "wave") {
      const starved = await huntWave(ctx, files);
      assertLedgerValid(ctx, `after hunter wave ${state.round}`);
      save({ round: state.round, step: "post", starved });
    } else if (state.step === "post") {
      const accepted = await runCritic(ctx, files, `critic:post:${state.round}`, false);
      if (run.profile === "quick" || state.starved || accepted === null) {
        deferPlanned(
          accepted === null
            ? "critic_budget_exhausted"
            : state.starved
              ? "budget_cannot_reserve_critics_and_validation"
              : "quick_profile_final_critic",
        );
        save({ round: state.round, step: "done" });
      } else if (accepted === 0 && plannedCount() === 0) {
        save({ round: state.round, step: "final" });
      } else {
        nextRound();
      }
    } else {
      const accepted = await runCritic(ctx, files, `critic:final:${state.round}`, true);
      if (accepted === null) {
        deferPlanned("critic_budget_exhausted");
        save({ round: state.round, step: "done" });
      } else if (accepted === 0 && plannedCount() === 0) {
        save({ round: state.round, step: "done" });
      } else {
        nextRound();
      }
    }
  }
}

/** Returns true if the budget could fund no hunter. */
async function huntWave(ctx: AuditContext, files: TargetFiles): Promise<boolean> {
  const { store } = ctx;
  const run = store.run();
  const planned = assignmentOrder(store.units().filter((r) => r.unit.status === "planned"));
  if (planned.length === 0) return false;

  const allowance = hunterAllowance({
    remaining: store.remainingBudget(),
    profile: run.profile,
    pendingCandidates: store.findings().filter((f) => f.state === "candidate").length,
  });
  const assigned = planned.slice(0, allowance);
  store.tx(() => {
    for (const row of planned.slice(assigned.length)) {
      store.putUnit(deferred(row.unit, "budget_cannot_reserve_critics_and_validation"));
    }
  });
  ctx.log(`wave: ${assigned.length} hunter(s), ${planned.length - assigned.length} unit(s) deferred by budget`);

  await pool(assigned, run.config.concurrency, (row) => huntUnit(ctx, files, row.unit));

  // A hunter the budget refused at launch leaves its unit planned; `quick` has no later wave to take it.
  if (run.profile === "quick") {
    store.tx(() => {
      for (const row of store.units()) {
        if (row.unit.status === "planned") store.putUnit(deferred(row.unit, "budget_cannot_reserve_critics_and_validation"));
      }
    });
  }
  return assigned.length === 0;
}

async function huntUnit(ctx: AuditContext, files: TargetFiles, unit: LedgerUnit): Promise<void> {
  const { store } = ctx;
  const run = store.run();
  const lctx = ledgerContext(ctx, run, files);
  const agentId = `hunt-w${unit.wave}-${shortHash(unit.coverage_id)}`;
  const peers = store.units().map((r) => r.unit).filter((u) => u.coverage_id !== unit.coverage_id && u.status !== "deferred");

  await execTask(ctx, {
    key: `hunt:${unit.coverage_id}:w${unit.wave}`,
    stage: "hunt",
    role: "hunter",
    agentId,
    tools: READ_TOOLS,
    schema: SCHEMAS.hunter,
    prompt: () => hunterPrompt(agentId, promptContext(ctx, run), run.architecture_md ?? "", unit, peers),
    read: (output) => readHunterResult(output, unit, agentId, lctx),
    // Applies to retries too: a hunter's second attempt never spends a critic's or verifier's call.
    reserve: () => hunterReserve(run.profile, store.findings().filter((f) => f.state === "candidate").length),
    onLaunch: () => store.putUnit({ ...unit, status: "in_progress", agent_id: agentId }),
    // A unit whose hunter returned nothing usable is a recorded gap, never silent coverage.
    onFail: () => store.putUnit(deferred(unit, "hunter_result_unusable")),
    commit: (outcome) => {
      for (const candidate of outcome.candidates) {
        const known = store.finding(candidate.fingerprint);
        // One root cause is one candidate: keep the stronger trace when two hunters reach it.
        if (!known || (known.state === "candidate" && candidate.trace.length > known.record.trace.length)) {
          store.putFinding({
            fingerprint: candidate.fingerprint,
            state: "candidate",
            record: candidate,
            hunter_task: agentId,
            verifier_task: null,
          });
        }
      }
      for (const print of outcome.downgraded) {
        store.log("downgraded", `${agentId} proposed confirmed for ${print} without a harness-run local check`);
      }
      store.putUnit(closeUnit(unit, agentId, outcome), { hardening: outcome.hardening });
      addProposedUnits(ctx, lctx, outcome.uncovered, `hunter ${agentId}`, "quick_profile_single_wave");
      return { disposition: outcome.disposition, candidates: outcome.candidates.length };
    },
  });
}

function addProposedUnits(ctx: AuditContext, lctx: LedgerContext, proposals: unknown[], source: string, quickReason: string): number {
  const { store } = ctx;
  let added = 0;
  for (const proposal of proposals) {
    const built = buildUnit(proposal, lctx);
    if ("errors" in built) {
      store.log("proposed_unit_rejected", `${source}: ${built.errors.join("; ")}`);
      continue;
    }
    const semantic = (u: LedgerUnit) => JSON.stringify([u.surface, u.boundary, u.subsystem, u.attack_class]);
    const clash = store.units().some((r) => r.unit.coverage_id === built.unit.coverage_id || semantic(r.unit) === semantic(built.unit));
    if (clash) continue;
    store.putUnit(lctx.profile === "quick" ? deferred(built.unit, quickReason) : built.unit, { priority: built.priority });
    added++;
  }
  return added;
}

/** Returns how much work it added, or null if the budget could not fund it. */
async function runCritic(ctx: AuditContext, files: TargetFiles, key: string, final: boolean): Promise<number | null> {
  const { store } = ctx;
  const run = store.run();
  const lctx = ledgerContext(ctx, run, files);
  const agentId = key.replaceAll(":", "-");
  const result = await execTask(ctx, {
    key,
    stage: "critic",
    role: "critic",
    agentId,
    tools: READ_TOOLS,
    schema: SCHEMAS.critic,
    prompt: () =>
      criticPrompt(
        agentId,
        promptContext(ctx, run),
        run.architecture_md ?? "",
        exportLedger(store.units()),
        store.findings().map((f) => ({ fingerprint: f.fingerprint, state: f.state, title: f.record.title })),
        final,
      ),
    read: readCriticResult,
    commit: (critic) => {
      let accepted = addProposedUnits(ctx, lctx, critic.missingUnits, `critic ${agentId}`, "quick_profile_final_critic");
      for (const id of critic.reassignIds) {
        const row = store.unit(id);
        const status = row?.unit.status;
        if (!row || (status !== "covered" && status !== "candidate" && status !== "blocked")) {
          store.log("reassign_ignored", `${agentId}: ${id} is not a closed unit in this ledger`);
          continue;
        }
        const reopened = archiveAttempt(row.unit, `Coverage critic ${agentId} reported that this unit did not close.`);
        store.putUnit(run.profile === "quick" ? deferred(reopened, "quick_profile_final_critic") : reopened);
        accepted++;
      }
      return { accepted, stop: critic.stop };
    },
  });
  if (result.status === "no_budget") {
    store.noteIncomplete("critic_budget_exhausted");
    return null;
  }
  if (result.status === "failed") {
    store.noteIncomplete("coverage_critic_failed");
    return null;
  }
  assertLedgerValid(ctx, `after ${key}`);
  return result.output.accepted;
}

// Phase 3: candidate validation

function readFinalRecord(raw: unknown, fingerprint: string, files: TargetFiles): { record: FindingRecord; downgraded: boolean } | { errors: string[] } {
  if (!isObject(raw)) return { errors: ["record must be an object"] };
  const record = raw as FindingRecord;
  if (record.fingerprint !== fingerprint) return { errors: [`record.fingerprint must stay "${fingerprint}"`] };
  const shape = validateFindings([record]);
  if (shape.length > 0) return { errors: shape.slice(0, 15) };
  const cited = citedLocationErrors(record, files);
  if (cited.length > 0) return { errors: cited };
  return enforceLocalEvidence(record, false);
}

function linkedUnits(ctx: AuditContext, fingerprint: string): UnitRow[] {
  return ctx.store.units().filter((r) => r.unit.result_fingerprints.includes(fingerprint));
}

function recordDecision(ctx: AuditContext, fingerprint: string, verdict: string): void {
  for (const row of linkedUnits(ctx, fingerprint)) {
    ctx.store.putUnit(row.unit, { decisions: { ...row.decisions, [fingerprint]: verdict } });
  }
}

async function validateCandidates(ctx: AuditContext, files: TargetFiles): Promise<void> {
  const { store } = ctx;
  const run = store.run();
  const candidates = store.findings().filter((f) => f.state === "candidate");

  await pool(candidates, run.config.concurrency, async (finding) => {
    const print = finding.fingerprint;
    const agentId = `verify-${shortHash(print)}`;
    const result = await execTask(ctx, {
      key: `validate:${print}`,
      stage: "validate",
      role: "verifier",
      agentId,
      tools: READ_TOOLS,
      schema: SCHEMAS.verifier,
      prompt: () => verifierPrompt(agentId, promptContext(ctx, run), run.architecture_md ?? "", finding.record, linkedUnits(ctx, print).map((r) => r.unit)),
      read: (output) => {
        if (!isObject(output) || !VERDICTS.includes(output.decision as Verdict)) {
          return { errors: ["decision must be confirmed, needs_validation, or rejected"] };
        }
        const record = isObject(output.record) ? { verdict: output.decision, ...output.record } : output.record;
        if (isObject(record) && record.verdict !== output.decision) return { errors: ["record.verdict must equal decision"] };
        const final = readFinalRecord(record, print, files);
        return "errors" in final ? final : { value: final };
      },
      commit: ({ record, downgraded }) => {
        if (downgraded) store.log("downgraded", `${agentId} returned confirmed for ${print} without a harness-run local check`);
        store.putFinding({ ...finding, state: record.verdict, record, verifier_task: agentId });
        const reviewed = [...new Set([...record.trace, ...record.evidence].map((e) => e.file))];
        for (const row of linkedUnits(ctx, print)) {
          const unit = addCheck(row.unit, {
            agent_id: agentId,
            reviewed_paths: reviewed,
            invariant: `Independent validation of candidate ${print}`,
            method: "source",
            result: `Verifier decision: ${record.verdict}`,
            artifact: null,
          });
          store.putUnit(unit, { decisions: { ...row.decisions, [print]: record.verdict } });
        }
        return { decision: record.verdict };
      },
    });
    if (result.status === "no_budget") store.noteIncomplete("validation_budget_exhausted");
    if (result.status === "failed") store.noteIncomplete("candidate_validation_failed");
  });
  assertLedgerValid(ctx, "after candidate validation");
}

// Phase 5: independent record verification (standard profile)

/** A change that needs its own fresh verifier before it can become the final record. */
export function isMaterialChange(before: FindingRecord, after: FindingRecord): boolean {
  const core = (r: FindingRecord) =>
    JSON.stringify([
      r.verdict,
      r.root_cause ?? r.claimed_root_cause,
      r.trace.map((t) => [t.kind, t.file, t.line]),
      r.severity ?? null,
      r.execution ?? null,
    ]);
  return core(before) !== core(after);
}

type Recheck = { kind: "verified" } | { kind: "applied" } | { kind: "replace"; record: FindingRecord };

async function verifyRecords(ctx: AuditContext, files: TargetFiles): Promise<void> {
  const { store } = ctx;
  const run = store.run();
  const records = store.findings().filter((f) => f.state === "confirmed" || f.state === "needs_validation");
  await pool(records, run.config.concurrency, (finding) => verifyRecord(ctx, files, finding));
}

async function verifyRecord(ctx: AuditContext, files: TargetFiles, finding: FindingRow): Promise<void> {
  const { store } = ctx;
  const run = store.run();
  const print = finding.fingerprint;
  let current = finding.record;
  let pending = false; // `current` is a material replacement no fresh verifier has accepted yet

  const apply = (record: FindingRecord) => {
    store.putFinding({ ...store.finding(print)!, state: record.verdict, record });
    recordDecision(ctx, print, record.verdict);
  };

  for (let round = 1; round <= MAX_RECORD_VERIFICATION_ROUNDS; round++) {
    const agentId = `recheck-${shortHash(print)}-${round}`;
    const subject = current;
    const wasPending = pending;
    const result = await execTask<Recheck, Recheck>(ctx, {
      key: `verify:${print}:${round}`,
      stage: "verify",
      role: "verifier",
      agentId,
      tools: READ_TOOLS,
      schema: SCHEMAS.recordVerifier,
      prompt: () => recordVerifierPrompt(agentId, promptContext(ctx, run), run.architecture_md ?? "", subject),
      read: (output) => {
        if (isObject(output) && output.decision === "verified") return { value: { kind: "verified" } };
        if (!isObject(output) || output.decision !== "replace") return { errors: ["decision must be verified or replace"] };
        const final = readFinalRecord(output.record, print, files);
        if ("errors" in final) return final;
        if (final.downgraded) store.log("downgraded", `${agentId} proposed confirmed for ${print} without a harness-run local check`);
        return { value: { kind: "replace", record: final.record } };
      },
      commit: (recheck) => {
        if (recheck.kind === "verified") {
          if (wasPending) apply(subject);
          return recheck;
        }
        if (recheck.kind === "replace" && !isMaterialChange(subject, recheck.record)) {
          apply(recheck.record);
          return { kind: "applied" };
        }
        return recheck;
      },
    });

    if (result.status !== "done") {
      store.noteIncomplete(result.status === "no_budget" ? "record_verification_budget_exhausted" : "record_verification_failed");
      break;
    }
    if (result.output.kind !== "replace") return;
    current = result.output.record;
    pending = true;
  }

  if (pending) {
    // A disputed record leaves findings.json; its unit keeps the fingerprint as an unresolved candidate.
    store.putFinding({ ...store.finding(print)!, state: "disputed" });
    recordDecision(ctx, print, "disputed");
    store.noteIncomplete("record_verification_unresolved");
  }
}

// Phase 4 and 6: exports and report

function finalize(ctx: AuditContext): void {
  const { store } = ctx;
  store.tx(() => {
    for (const row of store.units()) {
      if (row.unit.status === "planned" || row.unit.status === "in_progress") {
        store.putUnit(deferred({ ...row.unit, agent_id: null }, "run_ended_before_assignment"));
      }
    }
  });
  store.setStatus(store.run().incomplete_reason === null ? "complete" : "incomplete");
  const errors = writeExports(store, ctx.sandbox.capabilities());
  if (errors.length > 0) {
    throw new Error(`exports failed the skill's validators:\n${errors.slice(0, 20).join("\n")}`);
  }
}
