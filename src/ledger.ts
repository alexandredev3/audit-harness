import { citedLocationErrors, enforceLocalEvidence, missingPaths, type TargetFiles } from "./checks.ts";
import { type Catalog, companionBlocksFor, isClassRef, isOrdinaryRef } from "./prompts/catalog.ts";
import type {
  Attempt,
  CanonicalRefs,
  Check,
  FindingRecord,
  LedgerUnit,
  PriorityFacts,
  Profile,
} from "./types.ts";
import { canonicalCoverageId, validateFindings } from "./validators.ts";
import type { UnitRow } from "./db.ts";

export const QUICK_SUBSYSTEM_REF = "profile/quick/all-in-scope-subsystems";
const QUICK_SUBSYSTEM_LABEL = "All in-scope subsystems";
const PROTECTS = ["credentials", "cross_tenant_data", "code_execution", "release_authority", "other"];

export interface LedgerContext {
  profile: Profile;
  catalog: Catalog;
  files: TargetFiles;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === "string" && s.trim() !== ""))] : [];
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function buildUnit(
  proposal: unknown,
  ctx: LedgerContext,
): { unit: LedgerUnit; priority: PriorityFacts } | { errors: string[] } {
  if (!isObject(proposal)) return { errors: ["unit must be an object"] };
  const errors: string[] = [];
  const given = isObject(proposal.canonical_refs) ? proposal.canonical_refs : {};

  const classRef = text(given.attack_class) || text(proposal.attack_class);
  if (!isClassRef(ctx.catalog, classRef)) {
    errors.push(`attack_class "${classRef}" is not a class reference from the catalog (expected FILE.md#Class name)`);
  }
  const surface = text(proposal.surface) || text(given.surface);
  const boundary = text(proposal.boundary) || text(given.boundary);
  let subsystem = text(proposal.subsystem) || text(given.subsystem);
  for (const [name, value] of [["surface", surface], ["boundary", boundary], ["subsystem", subsystem]]) {
    if (!value) errors.push(`${name} is missing`);
  }

  const refs: CanonicalRefs = {
    surface: text(given.surface) || surface,
    boundary: text(given.boundary) || boundary,
    subsystem: text(given.subsystem) || subsystem,
    attack_class: classRef,
  };
  if (ctx.profile === "quick") {
    refs.subsystem = QUICK_SUBSYSTEM_REF;
    subsystem = QUICK_SUBSYSTEM_LABEL;
  }

  const startingPaths = strings(proposal.starting_paths);
  if (startingPaths.length === 0) errors.push("starting_paths must name at least one repository-relative path");
  for (const path of missingPaths(startingPaths, ctx.files)) {
    errors.push(`starting path "${path}" does not exist in the target repository`);
  }

  const selected = new Set<string>(isOrdinaryRef(classRef) ? [] : companionBlocksFor(ctx.catalog, classRef));
  for (const ref of strings(proposal.selected_companion_blocks)) {
    if (isOrdinaryRef(ref)) continue;
    if (!ctx.catalog.blocks.has(ref)) {
      errors.push(`selected companion block "${ref}" is not in the catalog`);
    } else if (isClassRef(ctx.catalog, ref)) {
      for (const block of companionBlocksFor(ctx.catalog, ref)) selected.add(block);
    } else {
      selected.add(ref);
    }
  }

  const excluded: { block: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(proposal.excluded_blocks) ? proposal.excluded_blocks : []) {
    const block = isObject(entry) ? text(entry.block) : "";
    const reason = isObject(entry) ? text(entry.reason) : "";
    if (block && reason && !seen.has(block) && !selected.has(block)) {
      seen.add(block);
      excluded.push({ block, reason });
    }
  }

  let coverageId = "";
  try {
    coverageId = canonicalCoverageId(refs);
  } catch {
    if (errors.length === 0) errors.push("surface, boundary, or subsystem is not a valid canonical reference");
  }
  if (errors.length > 0) return { errors };

  const facts = isObject(proposal.priority_facts) ? proposal.priority_facts : {};
  const protects = PROTECTS.includes(text(facts.protects)) ? text(facts.protects) : "other";
  return {
    priority: { lowest_trust_entry: facts.lowest_trust_entry === true, protects: protects as PriorityFacts["protects"] },
    unit: {
      coverage_id: coverageId,
      canonical_refs: refs,
      surface,
      boundary,
      subsystem,
      attack_class: ctx.catalog.blocks.get(classRef)!.name,
      starting_paths: startingPaths,
      ordinary_attack_class_block: isOrdinaryRef(classRef) ? classRef : null,
      selected_companion_blocks: [...selected],
      excluded_blocks: excluded,
      prior_status: "none",
      attempts: [],
      wave: 1,
      status: "planned",
      agent_id: null,
      reviewed_paths: [],
      local_checks: [],
      result_fingerprints: [],
      unresolved: [],
    },
  };
}

/** The skill's assignment order, as far as v1 has the inputs for it. The coverage-ID tiebreak keeps runs deterministic. */
export function assignmentOrder(rows: UnitRow[]): UnitRow[] {
  const rank = (row: UnitRow) => (row.priority.lowest_trust_entry ? 0 : 2) + (row.priority.protects === "other" ? 1 : 0);
  return [...rows].sort((a, b) =>
    rank(a) - rank(b) || (a.unit.coverage_id < b.unit.coverage_id ? -1 : a.unit.coverage_id > b.unit.coverage_id ? 1 : 0)
  );
}

export function deferred(unit: LedgerUnit, reason: string): LedgerUnit {
  return {
    ...unit,
    status: "deferred",
    agent_id: null,
    reviewed_paths: [],
    local_checks: [],
    result_fingerprints: [],
    unresolved: [reason],
  };
}

export function archiveAttempt(unit: LedgerUnit, reason: string): LedgerUnit {
  if (unit.status !== "covered" && unit.status !== "candidate" && unit.status !== "blocked") {
    throw new Error(`cannot archive a unit in status ${unit.status}`);
  }
  const attempt: Attempt = {
    wave: unit.wave,
    status: unit.status,
    agent_id: unit.agent_id!,
    reviewed_paths: unit.reviewed_paths,
    local_checks: unit.local_checks,
    result_fingerprints: unit.result_fingerprints,
    unresolved: unit.unresolved,
    reassignment_reason: reason,
  };
  return {
    ...unit,
    attempts: [...unit.attempts, attempt],
    wave: unit.wave + 1,
    status: "planned",
    agent_id: null,
    reviewed_paths: [],
    local_checks: [],
    result_fingerprints: [],
    unresolved: [],
  };
}

export interface HunterOutcome {
  disposition: "covered" | "candidate" | "blocked";
  checks: Check[];
  reviewedPaths: string[];
  unresolved: string[];
  candidates: FindingRecord[];
  hardening: string[];
  uncovered: unknown[];
  downgraded: string[];
}

/** Ownership fields come from the harness, never from the model. */
export function readHunterResult(
  output: unknown,
  unit: LedgerUnit,
  agentId: string,
  ctx: LedgerContext,
): { value: HunterOutcome } | { errors: string[] } {
  if (!isObject(output)) return { errors: ["result must be one JSON object"] };
  const errors: string[] = [];
  const units = Array.isArray(output.units) ? output.units.filter(isObject) : [];
  const result = units.find((u) => u.coverage_id === unit.coverage_id);
  if (units.length !== 1 || !result) {
    return { errors: [`units must contain exactly one entry, for coverage_id ${unit.coverage_id}`] };
  }
  const disposition = text(result.disposition);
  if (disposition !== "covered" && disposition !== "candidate" && disposition !== "blocked") {
    return { errors: [`disposition must be covered, candidate, or blocked; got "${disposition}"`] };
  }

  const checks: Check[] = [];
  const rawChecks = Array.isArray(result.checks) ? result.checks : [];
  if (rawChecks.length === 0) errors.push("checks must list at least one check you performed");
  rawChecks.forEach((raw, index) => {
    if (!isObject(raw)) return errors.push(`checks[${index}] must be an object`);
    const paths = strings(raw.reviewed_paths);
    if (paths.length === 0) errors.push(`checks[${index}].reviewed_paths must not be empty`);
    for (const path of missingPaths(paths, ctx.files)) {
      errors.push(`checks[${index}].reviewed_paths: "${path}" does not exist in the target repository`);
    }
    if (raw.method === "local") {
      errors.push(`checks[${index}].method: no sandbox ran in this run, so a check cannot be "local"; report it as "source"`);
    }
    if (!text(raw.invariant)) errors.push(`checks[${index}].invariant is missing`);
    if (!text(raw.result)) errors.push(`checks[${index}].result is missing`);
    checks.push({
      agent_id: agentId,
      reviewed_paths: paths,
      invariant: text(raw.invariant),
      method: "source",
      result: text(raw.result),
      artifact: null,
    });
  });

  const unresolved = strings(result.unresolved);
  const fingerprints = strings(result.candidate_fingerprints);
  const rawCandidates = Array.isArray(output.candidates) ? output.candidates : [];
  if (disposition === "covered" && (unresolved.length > 0 || rawCandidates.length > 0)) {
    errors.push("a covered unit has no unresolved fact and no candidate");
  }
  if (disposition === "blocked" && unresolved.length === 0) {
    errors.push("a blocked unit must state the unresolved fact");
  }
  if (disposition === "blocked" && rawCandidates.length > 0) {
    errors.push("a blocked unit carries no candidate; use disposition candidate");
  }
  if (disposition === "candidate" && rawCandidates.length === 0) {
    errors.push("a candidate unit must include its candidates");
  }

  const candidates: FindingRecord[] = [];
  const downgraded: string[] = [];
  rawCandidates.forEach((raw, index) => {
    if (!isObject(raw)) return errors.push(`candidates[${index}] must be an object`);
    const { proposed_verdict: named, verdict, ...rest } = raw;
    // Hunters copy the schema's `verdict` key often enough that refusing it wastes a call.
    const proposed_verdict = named ?? verdict;
    if (proposed_verdict !== "confirmed" && proposed_verdict !== "needs_validation") {
      return errors.push(`candidates[${index}].proposed_verdict must be confirmed or needs_validation`);
    }
    const proposed = { ...rest, verdict: proposed_verdict } as FindingRecord;
    const shape = validateFindings([proposed]);
    if (shape.length > 0) {
      return errors.push(...shape.slice(0, 10).map((e) => `candidates[${index}] ${e}`));
    }
    errors.push(...citedLocationErrors(proposed, ctx.files).map((e) => `candidates[${index}].${e}`));
    const enforced = enforceLocalEvidence(proposed, false);
    if (enforced.downgraded) downgraded.push(proposed.fingerprint);
    candidates.push(enforced.record);
  });
  const candidatePrints = candidates.map((c) => c.fingerprint);
  if (new Set(candidatePrints).size !== candidatePrints.length) errors.push("candidates repeat a fingerprint");
  for (const print of fingerprints) {
    if (!candidatePrints.includes(print)) errors.push(`candidate_fingerprints lists "${print}" with no matching candidate`);
  }

  if (errors.length > 0) return { errors };
  return {
    value: {
      disposition,
      checks,
      reviewedPaths: [...new Set(checks.flatMap((c) => c.reviewed_paths))],
      unresolved,
      candidates,
      hardening: strings(output.hardening),
      uncovered: Array.isArray(output.uncovered) ? output.uncovered : [],
      downgraded,
    },
  };
}

export function closeUnit(unit: LedgerUnit, agentId: string, outcome: HunterOutcome): LedgerUnit {
  return {
    ...unit,
    status: outcome.disposition,
    agent_id: agentId,
    reviewed_paths: outcome.reviewedPaths,
    local_checks: outcome.checks,
    result_fingerprints: outcome.disposition === "candidate" ? outcome.candidates.map((c) => c.fingerprint) : [],
    unresolved: outcome.disposition === "covered" ? [] : outcome.unresolved,
  };
}

export function addCheck(unit: LedgerUnit, check: Check): LedgerUnit {
  const local_checks = [...unit.local_checks, check];
  return { ...unit, local_checks, reviewed_paths: [...new Set(local_checks.flatMap((c) => c.reviewed_paths))] };
}

export interface CriticOutcome {
  missingUnits: unknown[];
  reassignIds: string[];
  stop: boolean;
}

export function readCriticResult(output: unknown): { value: CriticOutcome } | { errors: string[] } {
  if (!isObject(output)) return { errors: ["result must be one JSON object"] };
  if (!Array.isArray(output.missing_units) || !Array.isArray(output.reassign_ids)) {
    return { errors: ["missing_units and reassign_ids must both be arrays"] };
  }
  return {
    value: {
      missingUnits: output.missing_units,
      reassignIds: strings(output.reassign_ids),
      stop: output.stop === true,
    },
  };
}

/** The ledger as the skill's validator expects it: bare units sorted by coverage ID. */
export function exportLedger(rows: UnitRow[]): LedgerUnit[] {
  return rows.map((row) => row.unit).sort((a, b) => (a.coverage_id < b.coverage_id ? -1 : a.coverage_id > b.coverage_id ? 1 : 0));
}
