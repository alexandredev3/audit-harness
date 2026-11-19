export type Profile = "quick" | "standard";
export type Role = "recon" | "planner" | "hunter" | "critic" | "verifier";
export type Stage = "recon" | "plan" | "hunt" | "critic" | "validate" | "verify";
export type Verdict = "confirmed" | "needs_validation" | "rejected";

export type UnitStatus =
  | "planned"
  | "not_applicable"
  | "out_of_scope"
  | "in_progress"
  | "covered"
  | "candidate"
  | "blocked"
  | "deferred";

export interface Check {
  agent_id: string;
  reviewed_paths: string[];
  invariant: string;
  method: "source" | "local";
  result: string;
  artifact: string | null;
}

export interface CanonicalRefs {
  surface: string;
  boundary: string;
  subsystem: string;
  attack_class: string;
}

export interface Attempt {
  wave: number;
  status: "covered" | "candidate" | "blocked";
  agent_id: string;
  reviewed_paths: string[];
  local_checks: Check[];
  result_fingerprints: string[];
  unresolved: string[];
  reassignment_reason: string;
}

/** A coverage-ledger unit in the exact shape `validate-coverage-ledger.cjs` checks. */
export interface LedgerUnit {
  coverage_id: string;
  canonical_refs: CanonicalRefs;
  surface: string;
  boundary: string;
  subsystem: string;
  attack_class: string;
  starting_paths: string[];
  ordinary_attack_class_block: string | null;
  selected_companion_blocks: string[];
  excluded_blocks: { block: string; reason: string }[];
  prior_status: "none";
  attempts: Attempt[];
  wave: number;
  status: UnitStatus;
  agent_id: string | null;
  reviewed_paths: string[];
  local_checks: Check[];
  result_fingerprints: string[];
  unresolved: string[];
}

export interface PriorityFacts {
  lowest_trust_entry: boolean;
  protects: "credentials" | "cross_tenant_data" | "code_execution" | "release_authority" | "other";
}

export interface TraceEntry {
  kind: "entrypoint" | "propagation" | "sink";
  file: string;
  line: number;
  scope: string;
  description: string;
}

/** Only the fields the harness reads are typed. */
export interface FindingRecord {
  verdict: Verdict;
  fingerprint: string;
  title: string;
  description: string;
  trace: TraceEntry[];
  evidence: { file: string; line: number; description: string }[];
  [field: string]: unknown;
}

export type FindingState = "candidate" | Verdict | "disputed";

export interface RoleConfig {
  runner: string;
  model: string;
}

export interface HarnessConfig {
  roles: Record<Role, RoleConfig>;
  concurrency: number;
  taskTimeoutMs: number;
  maxTurns: number;
  maxWaves: number;
  transientRetries: number;
  backoffMs: number;
  allowSameModelVerifier: boolean;
}
