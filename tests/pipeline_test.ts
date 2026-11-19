import { readFileSync } from "node:fs";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SANDBOX_BLOCKER } from "../src/checks.ts";
import { runAudit } from "../src/pipeline.ts";
import { validateFindings, validateLedger } from "../src/validators.ts";
import {
  cleanCritic,
  confirmedRecord,
  coverageIdFrom,
  defaultHandler,
  FINGERPRINT,
  type Handler,
  hunterCandidate,
  hunterCovered,
  makeHarness,
  needsValidationRecord,
  planOutput,
  readJson,
} from "./helpers.ts";

test("quick run goes from recon to a validated report", async () => {
  const h = makeHarness({ handler: defaultHandler });
  const run = await runAudit(h.ctx);

  assert.equal(run.status, "complete");
  assert.equal(run.agents_spent, 4 + 1 + 2 + 1 + 1); // recon, planner, hunters, critic, verifier
  assert.equal(h.runner.count("recheck"), 0); // quick merges validation and record verification

  const findings = readJson(h.outDir, "findings.json");
  assert.deepEqual(findings.map((f: { verdict: string }) => f.verdict), ["needs_validation"]);
  assert.deepEqual(validateFindings(findings), []);

  const ledger = readJson(h.outDir, "coverage-ledger.json");
  assert.deepEqual(validateLedger(ledger), []);
  assert.deepEqual(ledger.map((u: { status: string }) => u.status).sort(), ["candidate", "covered"]);
  // quick coarsens the subsystem dimension to one fixed identity
  assert.ok(ledger.every((u: { coverage_id: string }) => u.coverage_id.includes("profile%2Fquick%2Fall-in-scope-subsystems")));
  // the verifier's check sits beside the hunter's, each under its own agent ID
  const candidateUnit = ledger.find((u: { status: string }) => u.status === "candidate");
  assert.equal(new Set(candidateUnit.local_checks.map((c: { agent_id: string }) => c.agent_id)).size, 2);

  const report = readFileSync(join(h.outDir, "REPORT.md"), "utf8");
  assert.match(report, /Sandbox: unavailable/);
  assert.match(report, /Missing owner check on user update/);
  assert.equal(readJson(h.outDir, "run-metadata.json").run_status, "complete");
  h.store.close();
});

test("each agent sees its own role's text and the locked-down tool list", async () => {
  const h = makeHarness({ handler: defaultHandler });
  await runAudit(h.ctx);

  const hunter = h.runner.calls.find((c) => c.agentId.startsWith("hunt-") && coverageIdFrom(c.prompt).includes("Access%20control"))!;
  assert.match(hunter.prompt, /\*\*Access control\*\*/); // the selected class block, verbatim
  assert.doesNotMatch(hunter.prompt, /\*\*Cryptography and secrets\*\*/); // a class it was not assigned
  assert.match(hunter.prompt, /Defensive vulnerability-finding method/);
  assert.match(hunter.prompt, /Sandbox status: UNAVAILABLE/);
  assert.doesNotMatch(hunter.prompt, /Parent consolidation|Coverage-critic waves/); // parent-only text
  assert.match(hunter.prompt, /belong to other hunters/);
  assert.deepEqual(hunter.tools, ["Read", "Grep", "Glob"]);
  assert.equal(hunter.targetDir, h.target);
  assert.ok(!hunter.agentDir.startsWith(h.target));

  const planner = h.runner.calls.find((c) => c.agentId === "planner")!;
  assert.deepEqual(planner.tools, []);
  const verifier = h.runner.calls.find((c) => c.agentId.startsWith("verify-"))!;
  assert.match(verifier.prompt, /You did not write this candidate/);
  assert.notEqual(verifier.model, hunter.model);
  h.store.close();
});

test("a confirmed verdict with no harness-run local check is downgraded", async () => {
  const handler: Handler = (task, role, index) => {
    if (role === "hunter" && coverageIdFrom(task.prompt).includes("Access%20control")) {
      return hunterCandidate(coverageIdFrom(task.prompt), { proposed_verdict: "confirmed", ...confirmedRecord() });
    }
    if (role === "verifier") return { decision: "confirmed", record: { verdict: "confirmed", ...confirmedRecord() } };
    return defaultHandler(task, role, index);
  };
  const h = makeHarness({ handler });
  const run = await runAudit(h.ctx);

  assert.equal(run.status, "complete");
  const [finding] = readJson(h.outDir, "findings.json");
  assert.equal(finding.verdict, "needs_validation");
  assert.deepEqual(finding.blockers, [SANDBOX_BLOCKER]);
  assert.equal(finding.severity, undefined);
  assert.match(finding.validation_plan.local, /Send the request as tenant B/);
  assert.equal(h.store.events("downgraded").length, 2); // once for the hunter, once for the verifier
  h.store.close();
});

test("a usage limit pauses the run and resume finishes it without repeating work", async () => {
  let limited = true;
  const handler: Handler = (task, role, index) => {
    if (role === "hunter" && limited) return { outcome: { kind: "quota", reason: "usage limit reached" } };
    return defaultHandler(task, role, index);
  };
  const h = makeHarness({ handler, config: { concurrency: 1 } });

  const paused = await runAudit(h.ctx);
  assert.equal(paused.status, "paused");
  assert.equal(paused.agents_spent, 5); // the refused hunter call is refunded
  assert.equal(h.runner.count("recon"), 4);

  limited = false;
  const resumed = await runAudit(h.ctx);
  assert.equal(resumed.status, "complete");
  assert.equal(h.runner.count("recon"), 4); // not run again
  assert.equal(h.runner.count("planner"), 1);
  assert.equal(resumed.agents_spent, 9);
  assert.deepEqual(validateLedger(readJson(h.outDir, "coverage-ledger.json")), []);
  h.store.close();
});

test("a result citing a missing file is retried once with the errors attached", async () => {
  const handler: Handler = (task, role, index) => {
    if (role === "hunter" && coverageIdFrom(task.prompt).includes("Injection")) {
      const id = coverageIdFrom(task.prompt);
      return task.prompt.includes("previous answer was rejected") ? hunterCovered(id) : hunterCovered(id, "src/nope.ts");
    }
    return defaultHandler(task, role, index);
  };
  const h = makeHarness({ handler });
  const run = await runAudit(h.ctx);

  assert.equal(run.status, "complete");
  assert.equal(h.runner.count("hunter"), 3);
  assert.equal(run.agents_spent, 10); // a malformed attempt counts against the budget
  const retry = h.runner.calls.filter((c) => c.agentId.startsWith("hunt-")).at(-1)!;
  assert.match(retry.prompt, /src\/nope\.ts" does not exist in the target repository/);
  h.store.close();
});

test("a hunter that never returns usable output leaves its unit deferred, not covered", async () => {
  const handler: Handler = (task, role, index) => {
    if (role === "hunter" && coverageIdFrom(task.prompt).includes("Injection")) return { apology: "I could not complete this." };
    return defaultHandler(task, role, index);
  };
  const h = makeHarness({ handler });
  await runAudit(h.ctx);

  const ledger = readJson(h.outDir, "coverage-ledger.json");
  const unit = ledger.find((u: { attack_class: string }) => u.attack_class === "Injection");
  assert.equal(unit.status, "deferred");
  assert.deepEqual(unit.unresolved, ["hunter_result_unusable"]);
  assert.deepEqual(validateLedger(ledger), []);
  h.store.close();
});

test("a budget too small for recon and reserves launches no agent", async () => {
  const h = makeHarness({ handler: defaultHandler, budget: 6 });
  const run = await runAudit(h.ctx);

  assert.equal(run.status, "incomplete");
  assert.equal(run.incomplete_reason, "budget_cannot_fund_reconnaissance_and_reserves");
  assert.equal(h.runner.calls.length, 0);
  assert.match(readFileSync(join(h.outDir, "REPORT.md"), "utf8"), /incomplete/);
  h.store.close();
});

test("a tight budget defers units in priority order and is never exceeded", async () => {
  const h = makeHarness({ handler: defaultHandler, budget: 8 });
  const run = await runAudit(h.ctx);

  assert.ok(run.agents_spent <= 8);
  assert.equal(h.runner.count("hunter"), 1);
  assert.equal(h.runner.count("critic"), 1); // reserved before hunting
  assert.equal(h.runner.count("verifier"), 1);
  const ledger = readJson(h.outDir, "coverage-ledger.json");
  const byClass = Object.fromEntries(ledger.map((u: { attack_class: string; status: string }) => [u.attack_class, u.status]));
  assert.equal(byClass["Access control"], "candidate"); // lowest-trust entry goes first
  assert.equal(byClass["Injection"], "deferred");
  assert.match(readFileSync(join(h.outDir, "REPORT.md"), "utf8"), /budget_cannot_reserve_critics_and_validation/);
  h.store.close();
});

test("a hunter retry never spends the critic's or the verifier's reserved call", async () => {
  const handler: Handler = (task, role, index) => {
    if (role === "hunter" && coverageIdFrom(task.prompt).includes("Injection")) return { apology: "not JSON you can use" };
    return defaultHandler(task, role, index);
  };
  const h = makeHarness({ handler, budget: 9 });
  const run = await runAudit(h.ctx);

  assert.equal(h.runner.count("hunter"), 2); // the unusable answer was not retried
  assert.equal(h.runner.count("critic"), 1);
  assert.equal(h.runner.count("verifier"), 1);
  assert.equal(run.status, "complete"); // every candidate still got its independent decision
  assert.equal(run.agents_spent, 9);
  h.store.close();
});

test("repeated transient failures pause the run instead of logging an empty success", async () => {
  const handler: Handler = (task, role, index) =>
    role === "planner" ? { outcome: { kind: "transient", reason: "overloaded" } } : defaultHandler(task, role, index);
  const h = makeHarness({ handler });
  const run = await runAudit(h.ctx);

  assert.equal(run.status, "paused");
  assert.equal(h.runner.count("planner"), 3);
  assert.equal(run.agents_spent, 4); // transient attempts are refunded
  assert.equal(h.store.units().length, 0);
  h.store.close();
});

test("standard run loops on critic work, then verifies records with fresh agents", async () => {
  const handler: Handler = (task, role, index) => {
    if (role === "critic" && task.agentId === "critic-post-1") {
      return {
        ...cleanCritic,
        stop: false,
        missing_units: [{
          surface: "GET /users/:id",
          boundary: "requireOwner",
          subsystem: "api",
          attack_class: "ATTACK-CLASSES.md#Access control",
          starting_paths: ["src/router.ts"],
          reason: "the read path was never assigned",
        }],
        reassign_ids: [JSON.parse(/```json\n(\[[\s\S]*?\n\])\n```/.exec(task.prompt)![1]!).find((u: { status: string }) => u.status === "covered").coverage_id],
      };
    }
    if (role === "hunter" && coverageIdFrom(task.prompt).includes("GET%20")) return hunterCovered(coverageIdFrom(task.prompt), "src/router.ts");
    return defaultHandler(task, role, index);
  };
  const h = makeHarness({ handler, profile: "standard" });
  const run = await runAudit(h.ctx);

  assert.equal(run.status, "complete");
  assert.equal(h.runner.count("hunter"), 4); // 2 in wave 1, then the new unit and the reassigned one
  assert.deepEqual(
    h.runner.calls.filter((c) => c.agentId.startsWith("critic-")).map((c) => c.agentId),
    ["critic-post-1", "critic-post-2", "critic-final-2"],
  );
  assert.equal(h.runner.count("verifier"), 1);
  assert.equal(h.runner.count("recheck"), 1);

  const ledger = readJson(h.outDir, "coverage-ledger.json");
  assert.deepEqual(validateLedger(ledger), []);
  assert.equal(ledger.length, 3);
  const reassigned = ledger.find((u: { wave: number }) => u.wave === 2);
  assert.equal(reassigned.attempts.length, 1);
  assert.notEqual(reassigned.attempts[0].agent_id, reassigned.agent_id); // a fresh owner each attempt
  h.store.close();
});

test("a material replacement in record verification needs another fresh verifier", async () => {
  const rejected = {
    verdict: "rejected",
    fingerprint: FINGERPRINT,
    title: "Missing owner check on user update",
    description: "The claim does not hold.",
    claimed_root_cause: "requireOwner is not applied to the POST route.",
    trace: needsValidationRecord().trace,
    evidence: needsValidationRecord().evidence,
    reason: "A router-level middleware applies requireOwner to every mutating route.",
  };
  const handler: Handler = (task, role, index) => {
    if (role === "recheck") {
      return index === 0 ? { decision: "replace", reason: "a visible control prevents it", record: rejected } : { decision: "verified", fingerprint: FINGERPRINT };
    }
    return defaultHandler(task, role, index);
  };
  const h = makeHarness({ handler, profile: "standard" });
  const run = await runAudit(h.ctx);

  assert.equal(run.status, "complete");
  assert.equal(h.runner.count("recheck"), 2);
  const second = h.runner.calls.filter((c) => c.agentId.startsWith("recheck-"))[1]!;
  assert.match(second.prompt, /router-level middleware/); // the second verifier judged the replacement
  assert.deepEqual(readJson(h.outDir, "findings.json").map((f: { verdict: string }) => f.verdict), ["rejected"]);
  h.store.close();
});

test("the planner is told what was wrong and invalid units never reach the ledger", async () => {
  const bad = { surface: "x", boundary: "y", subsystem: "z", attack_class: "ATTACK-CLASSES.md#Made up", starting_paths: ["src/ghost.ts"] };
  const handler: Handler = (task, role, index) => {
    if (role === "planner") return planOutput([bad]);
    return defaultHandler(task, role, index);
  };
  const h = makeHarness({ handler });
  const run = await runAudit(h.ctx);

  assert.equal(run.status, "complete");
  assert.equal(h.runner.count("planner"), 2);
  assert.match(h.runner.calls.filter((c) => c.agentId === "planner")[1]!.prompt, /is not a class reference from the catalog/);
  assert.equal(h.store.units().length, 2); // the invalid unit was dropped on the last attempt
  assert.equal(h.store.events("planner_unit_dropped").length, 2);
  h.store.close();
});
