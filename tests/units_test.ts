import { test } from "bun:test";
import assert from "node:assert/strict";
import { hunterAllowance, minimumBudget } from "../src/budget.ts";
import { citedLocationErrors, enforceLocalEvidence, TargetFiles } from "../src/checks.ts";
import { defaultConfig, validateConfig } from "../src/config.ts";
import { assignmentOrder, buildUnit } from "../src/ledger.ts";
import { isMaterialChange } from "../src/pipeline.ts";
import { CLASSES_DIR } from "../src/prompts/assemble.ts";
import { companionBlocksFor, loadCatalog } from "../src/prompts/catalog.ts";
import { buildArgs, classify } from "../src/runner/claude_code.ts";
import { sandboxPromptBlock, UnavailableSandbox } from "../src/sandbox.ts";
import type { FindingRecord } from "../src/types.ts";
import { validateLedger } from "../src/validators.ts";
import { confirmedRecord, makeTarget, needsValidationRecord } from "./helpers.ts";

const catalog = loadCatalog(CLASSES_DIR);
const envelope = (fields: Record<string, unknown>) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", num_turns: 2, total_cost_usd: 0.02, ...fields });
const raw = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: "", timedOut: false });

test("catalog resolves the skill's FILE.md#Name references", () => {
  assert.equal(catalog.files.length, 11);
  assert.ok(catalog.blocks.get("ATTACK-CLASSES.md#Access control")!.text.startsWith("**Access control**"));
  assert.ok(catalog.blocks.has("CLIENT-SIDE.md#`postMessage` origin and source trust"));
  assert.deepEqual(companionBlocksFor(catalog, "AI-AND-LLM.md#Persistent memory poisoning"), [
    "AI-AND-LLM.md#Persistent memory poisoning",
    "AI-AND-LLM.md#Core discipline",
    "AI-AND-LLM.md#Universal moves",
    "AI-AND-LLM.md#Validation rules",
  ]);
  for (const block of catalog.blocks.values()) assert.ok(block.text.length > 40, block.ref);
});

test("buildUnit derives a ledger unit the skill's validator accepts", () => {
  const files = new TargetFiles(makeTarget());
  const proposal = {
    surface: "chat endpoint",
    boundary: "tool dispatcher",
    subsystem: "agent",
    attack_class: "AI-AND-LLM.md#Tool-argument injection into a downstream sink",
    canonical_refs: { surface: "src/router.ts#POST /chat", boundary: "src/authz.ts#dispatch", subsystem: "src" },
    starting_paths: ["src/router.ts"],
  };
  const built = buildUnit(proposal, { profile: "standard", catalog, files });
  assert.ok("unit" in built);
  assert.equal(built.unit.coverage_id, "src%2Frouter.ts%23POST%20%2Fchat::src%2Fauthz.ts%23dispatch::src::AI-AND-LLM.md%23Tool-argument%20injection%20into%20a%20downstream%20sink");
  assert.equal(built.unit.ordinary_attack_class_block, null);
  assert.equal(built.unit.selected_companion_blocks.length, 4); // the class plus its file's three shared sections
  assert.deepEqual(validateLedger([built.unit]), []);

  const invalid = buildUnit({ ...proposal, attack_class: "AI-AND-LLM.md#Nope", canonical_refs: {}, starting_paths: ["../etc/passwd"] }, { profile: "standard", catalog, files });
  assert.ok("errors" in invalid);
  assert.equal(invalid.errors.length, 2);
});

test("assignment order puts lowest-trust entry surfaces first, then ties by coverage ID", () => {
  const row = (id: string, lowest: boolean, protects: "other" | "credentials") =>
    ({ unit: { coverage_id: id }, priority: { lowest_trust_entry: lowest, protects }, hardening: [], decisions: {} }) as never;
  const order = assignmentOrder([row("d", false, "other"), row("c", false, "credentials"), row("b", true, "other"), row("a", true, "other")]);
  assert.deepEqual(order.map((r) => r.unit.coverage_id), ["a", "b", "c", "d"]);
});

test("cited locations must exist inside the target", () => {
  const files = new TargetFiles(makeTarget());
  const record = { ...needsValidationRecord(), verdict: "needs_validation" } as unknown as FindingRecord;
  assert.deepEqual(citedLocationErrors(record, files), []);
  record.trace[0] = { ...record.trace[0]!, line: 999 };
  record.evidence[0] = { ...record.evidence[0]!, file: "src/ghost.ts" };
  const errors = citedLocationErrors(record, files);
  assert.match(errors[0]!, /999 is past the end of src\/router\.ts \(40 lines\)/);
  assert.match(errors[1]!, /src\/ghost\.ts" is not a file/);
});

test("enforceLocalEvidence keeps a confirmed record only when an artifact backs it", () => {
  const record = { ...confirmedRecord(), verdict: "confirmed" } as unknown as FindingRecord;
  assert.equal(enforceLocalEvidence(record, true).record.verdict, "confirmed");
  const { record: lowered, downgraded } = enforceLocalEvidence(record, false);
  assert.ok(downgraded);
  assert.equal(lowered.verdict, "needs_validation");
  assert.equal(lowered.claimed_root_cause, record.root_cause);
});

test("budget arithmetic reserves critics and validation before hunters", () => {
  assert.equal(minimumBudget("quick"), 7);
  assert.equal(minimumBudget("standard"), 8);
  assert.equal(hunterAllowance({ remaining: Infinity, profile: "quick", pendingCandidates: 0 }), Infinity);
  assert.equal(hunterAllowance({ remaining: 3, profile: "quick", pendingCandidates: 0 }), 1); // 1 critic, 1 verifier, 1 hunter
  assert.equal(hunterAllowance({ remaining: 12, profile: "standard", pendingCandidates: 0 }), 7); // 2 critics, 30% of 10 for validation
  assert.equal(hunterAllowance({ remaining: 12, profile: "standard", pendingCandidates: 4 }), 2); // 4 candidates need 8 verifier calls
  assert.equal(hunterAllowance({ remaining: 2, profile: "standard", pendingCandidates: 0 }), 0);
});

test("config refuses a verifier on the hunter's model unless told otherwise", () => {
  const config = defaultConfig();
  assert.deepEqual(validateConfig(config), []);
  config.roles.verifier.model = config.roles.hunter.model;
  assert.equal(validateConfig(config).length, 1);
  config.allowSameModelVerifier = true;
  assert.deepEqual(validateConfig(config), []);
});

test("classify does not trust exit code 0", () => {
  assert.deepEqual(classify(raw(envelope({ structured_output: { a: 1 } }))).outcome, { kind: "ok", output: { a: 1 } });
  assert.equal(classify(raw(envelope({ result: '{"a": 1}' }))).outcome.kind, "ok");
  assert.equal(classify(raw(envelope({ result: "I'm sorry, I can't help with that." }))).outcome.kind, "malformed");
  assert.equal(classify(raw(envelope({ result: "Claude usage limit reached. Your limit will reset at 5pm." }))).outcome.kind, "quota");
  assert.equal(classify(raw(envelope({ is_error: true, result: "API Error: 529 overloaded", api_error_status: 529 }))).outcome.kind, "transient");
  assert.equal(classify(raw(envelope({ is_error: true, result: "Invalid API key · Please run /login", api_error_status: 401 }))).outcome.kind, "fatal");
  assert.equal(classify(raw(envelope({ subtype: "error_max_turns", is_error: true }))).outcome.kind, "malformed");
  assert.equal(classify(raw(envelope({ subtype: "error_max_structured_output_retries", is_error: true }))).outcome.kind, "malformed");
  assert.equal(classify(raw("", 1)).outcome.kind, "transient");
  assert.equal(classify({ exitCode: 1, stdout: "", stderr: "error: unknown option '--nope'", timedOut: false }).outcome.kind, "fatal");
  assert.equal(classify({ ...raw(envelope({ structured_output: {} })), timedOut: true }).outcome.kind, "transient");
  assert.equal(classify(raw(envelope({ structured_output: {} }))).costUsd, 0.02);
});

test("the runner invocation keeps the target's and the user's configuration out", () => {
  const task = {
    agentId: "hunt-w1-x", prompt: "p", model: "sonnet", targetDir: "/t", agentDir: "/a",
    tools: ["Read", "Grep", "Glob"], harnessTools: [] as string[], outputSchema: { type: "object" }, timeoutMs: 1, maxTurns: 5,
  };
  const args = buildArgs(task);
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  for (const flag of ["--safe-mode", "--strict-mcp-config", "--no-session-persistence"]) assert.ok(args.includes(flag), flag);
  assert.equal(value("--setting-sources"), "user");
  assert.equal(value("--tools"), "Read,Grep,Glob");
  assert.equal(value("--disallowedTools"), "mcp__*");
  assert.equal(value("--permission-mode"), "dontAsk");
  assert.equal(value("--add-dir"), "/t");
  assert.ok(!args.includes("p")); // the prompt travels over stdin
  assert.throws(() => buildArgs({ ...task, harnessTools: ["sandbox_run"] }));
});

test("agents are told the truth about the sandbox", () => {
  const block = sandboxPromptBlock(new UnavailableSandbox().capabilities());
  assert.match(block, /UNAVAILABLE \(missing: os_sandbox, artifact_promotion\)/);
  assert.match(block, /Never propose or return `confirmed`/);
});

test("only changes of substance count as a material replacement", () => {
  const before = { ...needsValidationRecord(), verdict: "needs_validation" } as unknown as FindingRecord;
  assert.equal(isMaterialChange(before, { ...before, title: "Reworded title" }), false);
  assert.equal(isMaterialChange(before, { ...before, claimed_root_cause: "A different cause." }), true);
  assert.equal(isMaterialChange(before, { ...before, trace: [{ ...before.trace[0]!, line: 13 }, before.trace[1]!] }), true);
});
