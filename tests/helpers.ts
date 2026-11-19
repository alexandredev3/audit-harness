import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { Store } from "../src/db.ts";
import type { AuditContext } from "../src/pipeline.ts";
import { CLASSES_DIR } from "../src/prompts/assemble.ts";
import { loadCatalog } from "../src/prompts/catalog.ts";
import type { AgentRunner, AgentRunResult, AgentTask, Outcome } from "../src/runner/types.ts";
import { UnavailableSandbox } from "../src/sandbox.ts";
import type { HarnessConfig, Profile } from "../src/types.ts";

export type Role = "recon" | "planner" | "hunter" | "critic" | "verifier" | "recheck";

export function roleOf(agentId: string): Role {
  if (agentId.startsWith("recon-")) return "recon";
  if (agentId === "planner") return "planner";
  if (agentId.startsWith("hunt-")) return "hunter";
  if (agentId.startsWith("critic-")) return "critic";
  if (agentId.startsWith("verify-")) return "verifier";
  if (agentId.startsWith("recheck-")) return "recheck";
  throw new Error(`unknown agent ${agentId}`);
}

export type Handler = (task: AgentTask, role: Role, callIndex: number) => unknown | { outcome: Outcome };

export class FakeRunner implements AgentRunner {
  readonly name = "claude-code";
  readonly calls: AgentTask[] = [];
  constructor(public handler: Handler) {}

  run(task: AgentTask): Promise<AgentRunResult> {
    this.calls.push(task);
    const role = roleOf(task.agentId);
    const index = this.calls.filter((c) => roleOf(c.agentId) === role).length - 1;
    const result = this.handler(task, role, index);
    if (result && typeof result === "object" && "outcome" in result) {
      return Promise.resolve({ outcome: (result as { outcome: Outcome }).outcome });
    }
    return Promise.resolve({ outcome: { kind: "ok", output: result }, costUsd: 0.01, turns: 3, durationMs: 10 });
  }

  count(role: Role): number {
    return this.calls.filter((c) => roleOf(c.agentId) === role).length;
  }
}

export function makeTarget(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-target-"));
  mkdirSync(join(dir, "src"));
  const lines = (n: number, label: string) => Array.from({ length: n }, (_, i) => `// ${label} line ${i + 1}`).join("\n");
  writeFileSync(join(dir, "src", "router.ts"), lines(40, "router"));
  writeFileSync(join(dir, "src", "authz.ts"), lines(20, "authz"));
  writeFileSync(join(dir, "src", "users.ts"), lines(30, "users"));
  return dir;
}

export interface Harness {
  ctx: AuditContext;
  store: Store;
  runner: FakeRunner;
  outDir: string;
  target: string;
  logs: string[];
}

export function makeHarness(options: {
  handler: Handler;
  profile?: Profile;
  budget?: number | null;
  config?: Partial<HarnessConfig>;
}): Harness {
  const target = realpathSync(makeTarget());
  const outDir = mkdtempSync(join(tmpdir(), "harness-run-"));
  const config = { ...defaultConfig(), backoffMs: 0, ...options.config };
  const store = new Store(join(outDir, "harness.db"), "run-1");
  store.createRun({
    run_id: "run-1",
    repo: "fixture",
    target,
    out_dir: outDir,
    source_ref: "test",
    dirty: false,
    profile: options.profile ?? "quick",
    budget: options.budget ?? null,
    config,
  });
  const runner = new FakeRunner(options.handler);
  const logs: string[] = [];
  const ctx: AuditContext = {
    store,
    config,
    runners: { "claude-code": runner },
    target,
    outDir,
    catalog: loadCatalog(CLASSES_DIR),
    sandbox: new UnavailableSandbox(),
    log: (message) => logs.push(message),
    sleep: () => Promise.resolve(),
  };
  return { ctx, store, runner, outDir, target, logs };
}

// Canned agent outputs

export const FINGERPRINT = "users/update-missing-owner-check";

export const planOutput = (extraUnits: unknown[] = []) => ({
  architecture_md: "A small API. Tenants update their own users through POST /users/:id.",
  units: [
    {
      surface: "POST /users/:id",
      boundary: "requireOwner",
      subsystem: "api",
      attack_class: "ATTACK-CLASSES.md#Access control",
      canonical_refs: { surface: "src/router.ts#POST /users/:id", boundary: "src/authz.ts#requireOwner", subsystem: "src" },
      starting_paths: ["src/router.ts", "src/authz.ts"],
      selected_companion_blocks: [],
      excluded_blocks: [{ block: "AI-AND-LLM.md#Persistent memory poisoning", reason: "no model call in source" }],
      priority_facts: { lowest_trust_entry: true, protects: "cross_tenant_data" },
    },
    {
      surface: "POST /users/:id",
      boundary: "requireOwner",
      subsystem: "api",
      attack_class: "ATTACK-CLASSES.md#Injection",
      canonical_refs: { surface: "src/router.ts#POST /users/:id", boundary: "src/authz.ts#requireOwner", subsystem: "src" },
      starting_paths: ["src/users.ts"],
      priority_facts: { lowest_trust_entry: false, protects: "other" },
    },
    ...extraUnits,
  ],
});

// Built fresh on every call: test files share one process, and a test may edit its copy.
const trace = () => [
  { kind: "entrypoint", file: "src/router.ts", line: 12, scope: "POST /users/:id", description: "Route accepts the user id from the path." },
  { kind: "sink", file: "src/users.ts", line: 21, scope: "updateUser", description: "Record is written without an owner check." },
];
const evidence = () => [{ file: "src/authz.ts", line: 5, description: "requireOwner is applied to GET only." }];

export const needsValidationRecord = (fingerprint = FINGERPRINT) => ({
  fingerprint,
  title: "Missing owner check on user update",
  description: "POST /users/:id reaches updateUser without checking that the caller owns the record.",
  claimed_root_cause: "requireOwner is not applied to the POST route.",
  trace: trace(),
  evidence: evidence(),
  blockers: ["sandbox_unavailable: cannot run the dummy-tenant integration test"],
  validation_plan: { local: "As tenant B, update a tenant A user with a dummy record and expect 403." },
});

export const confirmedRecord = (fingerprint = FINGERPRINT) => ({
  fingerprint,
  title: "Missing owner check on user update",
  description: "POST /users/:id reaches updateUser without checking that the caller owns the record.",
  root_cause: "requireOwner is not applied to the POST route.",
  intended_behavior: "Only the owning tenant may update a user.",
  trace: trace(),
  evidence: evidence(),
  conditions: [{ kind: "authentication_level", description: "Any authenticated tenant." }],
  execution: {
    attacker_perspective: "Authenticated tenant B",
    payloads: ['POST /users/a-1 {"name":"x"}'],
    instructions: ["Start the fixture server.", "Send the request as tenant B."],
    observed_result: "200 OK and the tenant A record changed.",
  },
  remediation: { strategy: "Apply requireOwner to the POST route." },
  severity: {
    likelihood: { score: "high", reason: "Any tenant can send it." },
    impact: { score: "high", reason: "Cross-tenant write." },
    overall_severity: "high",
  },
  confidence: { score: "high", reason: "Reproduced locally." },
});

export function coverageIdFrom(prompt: string): string {
  const match = /"coverage_id": "([^"]+)"/.exec(prompt);
  if (!match?.[1]) throw new Error("hunter prompt carries no coverage_id");
  return match[1];
}

export const hunterCovered = (coverageId: string, path = "src/users.ts") => ({
  units: [{
    coverage_id: coverageId,
    disposition: "covered",
    reviewed_paths: [path],
    checks: [{ agent_id: "x", reviewed_paths: [path], invariant: "Input is parameterized before the query.", method: "source", result: "No string-built query on this path.", artifact: null }],
    candidate_fingerprints: [],
    unresolved: [],
  }],
  candidates: [],
  hardening: ["Add a regression test for the update path."],
  uncovered: [],
});

export const hunterCandidate = (coverageId: string, candidate: Record<string, unknown>) => ({
  units: [{
    coverage_id: coverageId,
    disposition: "candidate",
    reviewed_paths: ["src/router.ts", "src/authz.ts"],
    checks: [{ agent_id: "x", reviewed_paths: ["src/router.ts", "src/authz.ts"], invariant: "Every mutating route applies requireOwner.", method: "source", result: "POST /users/:id does not.", artifact: null }],
    candidate_fingerprints: [candidate.fingerprint],
    unresolved: [],
  }],
  candidates: [candidate],
  hardening: [],
  uncovered: [],
});

export const cleanCritic = { missing_units: [], reassign_ids: [], resolved_prior_leads: [], stop: true };

export const defaultHandler: Handler = (task, role) => {
  switch (role) {
    case "recon":
      return { report: "1. A small API. See src/router.ts:1 and src/authz.ts:1." };
    case "planner":
      return planOutput();
    case "hunter": {
      const id = coverageIdFrom(task.prompt);
      return id.includes("Access%20control")
        ? hunterCandidate(id, { proposed_verdict: "needs_validation", ...needsValidationRecord() })
        : hunterCovered(id);
    }
    case "critic":
      return cleanCritic;
    case "verifier":
      return { decision: "needs_validation", record: { verdict: "needs_validation", ...needsValidationRecord() } };
    case "recheck":
      return { decision: "verified", fingerprint: FINGERPRINT };
  }
};

export const readJson = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
