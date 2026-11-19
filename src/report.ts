import type { Store } from "./db.ts";
import type { SandboxCapabilities } from "./sandbox.ts";
import type { FindingRecord } from "./types.ts";

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "informational"];

type Severity = { overall_severity: string; likelihood: { reason: string }; impact: { reason: string } };
type Execution = { attacker_perspective: string; payloads: string[]; instructions: string[]; observed_result: string };
type Remediation = { strategy: string; code_changes?: { file_name: string; fixed_code: string }[] };
type Plan = { local?: string; deployment?: string };

const cell = (text: unknown) => String(text ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
const severityOf = (r: FindingRecord) => (r.severity as Severity).overall_severity;
const traceLines = (r: FindingRecord) =>
  r.trace.map((t, i) => `${i + 1}. \`${t.file}:${t.line}\` (${t.kind}, ${t.scope}): ${t.description}`).join("\n");
const evidenceLines = (r: FindingRecord) => r.evidence.map((e) => `- \`${e.file}:${e.line}\`: ${e.description}`).join("\n");
const location = (r: FindingRecord) => (r.trace[0] ? `\`${r.trace[0].file}:${r.trace[0].line}\`` : "n/a");

function bySeverity(records: FindingRecord[]): FindingRecord[] {
  return [...records].sort((a, b) => SEVERITY_ORDER.indexOf(severityOf(a)) - SEVERITY_ORDER.indexOf(severityOf(b)));
}

function count<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

export function renderReport(store: Store, sandbox: SandboxCapabilities): string {
  const run = store.run();
  const units = store.units();
  const all = store.findings();
  const confirmed = bySeverity(all.filter((f) => f.state === "confirmed").map((f) => f.record));
  const needs = all.filter((f) => f.state === "needs_validation").map((f) => f.record);
  const rejected = all.filter((f) => f.state === "rejected");
  const unresolved = all.filter((f) => f.state === "candidate" || f.state === "disputed");
  const statuses = count(units.map((u) => u.unit.status));
  const deferredUnits = units.filter((u) => u.unit.status === "deferred");
  const critics = store.tasks().filter((t) => t.stage === "critic" && t.status === "done");
  const lastCritic = critics.at(-1)?.output as { accepted: number } | undefined;
  const out: string[] = [];

  out.push(`# Security audit report: ${run.repo}`, "");
  out.push("## Run", "");
  out.push(`- Run: ${run.run_id}, status ${run.status}${run.incomplete_reason ? ` (${run.incomplete_reason})` : ""}`);
  out.push(`- Profile: ${run.profile}. Scope: whole repository.`);
  out.push(`- Source ref: ${run.source_ref}${run.dirty ? " with uncommitted changes" : ""}`);
  out.push(`- Budget: ${run.budget === null ? "none set" : `${run.agents_spent} of ${run.budget} agent invocations spent`}`);
  out.push("- Execution policy: source review and bounded local execution only. No deployed endpoint or shared service was contacted.");
  out.push(
    sandbox.available
      ? "- Sandbox: available. Confirmed findings carry a harness-run local result."
      : `- Sandbox: unavailable (missing: ${sandbox.missing.join(", ")}). Nothing from the target was executed, so this run cannot confirm any finding. Leads with a complete source trace are listed under needs validation with the local check that would settle them.`,
  );
  out.push("- Prior runs: none used. This run stands alone.");
  if (run.profile === "quick") out.push("- This is a `quick` run: one hunter wave and one critic pass. It is a partial pass, not complete coverage.");
  if (run.status === "incomplete") out.push(`- The run is incomplete: ${run.incomplete_reason}. Coverage and validation below are partial.`);
  if (unresolved.length > 0) {
    out.push("- Candidates without an independent final decision (not findings):");
    for (const f of unresolved) out.push(`  - \`${f.fingerprint}\` (${f.state})`);
  }
  out.push("");

  out.push("## Summary", "");
  out.push(
    `${confirmed.length} confirmed finding(s), ${needs.length} lead(s) needing validation, ${rejected.length} candidate(s) rejected during validation. ` +
    `${statuses.covered ?? 0} of ${units.length} coverage units closed with no candidate.`,
    "",
  );

  out.push("## Confirmed findings", "");
  if (confirmed.length === 0) {
    out.push("None.", "");
  } else {
    out.push("| Severity | Title | Location | Observed result |", "|---|---|---|---|");
    for (const r of confirmed) {
      out.push(`| ${severityOf(r)} | ${cell(r.title)} | ${location(r)} | ${cell((r.execution as Execution).observed_result)} |`);
    }
    out.push("");
    for (const r of confirmed) {
      const severity = r.severity as Severity;
      const execution = r.execution as Execution;
      out.push(`### ${r.title}`, "");
      out.push(`- Fingerprint: \`${r.fingerprint}\``);
      out.push(`- Severity: ${severity.overall_severity}. Likelihood: ${severity.likelihood.reason} Impact: ${severity.impact.reason}`);
      out.push(`- Attacker: ${execution.attacker_perspective}`);
      out.push(`- Root cause: ${r.root_cause}`);
      out.push(`- Observed result: ${execution.observed_result}`);
      out.push(`- Fix: ${(r.remediation as Remediation).strategy}`, "");
      out.push(traceLines(r), "");
    }
  }

  out.push("## Needs validation", "");
  if (needs.length === 0) {
    out.push("None.", "");
  } else {
    out.push("These are source-grounded leads with an exact blocker. They have no severity and are not confirmed vulnerabilities.", "");
    out.push("| Title | Trace starts at | Blocker | Local next step | Owner-observed check |", "|---|---|---|---|---|");
    for (const r of needs) {
      const plan = r.validation_plan as Plan;
      out.push(
        `| ${cell(r.title)} | ${location(r)} | ${cell((r.blockers as string[]).join("; "))} | ${cell(plan.local ?? "n/a")} | ${cell(plan.deployment ?? "n/a")} |`,
      );
    }
    out.push("");
  }

  const hardening = units.flatMap((u) => u.hardening.map((note) => `- ${note} (${u.unit.surface})`));
  out.push("## Hardening notes", "", hardening.length > 0 ? hardening.join("\n") : "None recorded.", "");

  out.push("## Coverage", "");
  out.push(
    `Units: ${units.length} total. ` +
    ["covered", "candidate", "blocked", "deferred", "out_of_scope", "not_applicable"].map((s) => `${s} ${statuses[s] ?? 0}`).join(", ") + ".",
  );
  out.push(
    critics.length === 0
      ? "No coverage critic ran, so this report makes no clean-coverage claim."
      : `Coverage critics run: ${critics.length}. The last one ${lastCritic?.accepted ? `added ${lastCritic.accepted} item(s) of work` : "found no further work"}.`,
  );
  if (deferredUnits.length > 0) {
    out.push("", "Deferred units (not reviewed in this run):");
    for (const u of deferredUnits) out.push(`- ${u.unit.surface} / ${u.unit.boundary} / ${u.unit.attack_class}: ${u.unit.unresolved.join("; ")}`);
  }
  const blocked = units.filter((u) => u.unit.status === "blocked");
  if (blocked.length > 0) {
    out.push("", "Blocked units (partial review):");
    for (const u of blocked) out.push(`- ${u.unit.surface} / ${u.unit.attack_class}: ${u.unit.unresolved.join("; ")}`);
  }
  out.push("");
  return out.join("\n");
}

export function renderFindingsDetail(records: FindingRecord[]): string {
  const detailed = bySeverity(records.filter((r) => r.verdict === "confirmed"))
    .filter((r) => ["critical", "high", "medium"].includes(severityOf(r)));
  const out = ["# Findings detail", ""];
  if (detailed.length === 0) out.push("No confirmed finding of medium severity or higher.", "");
  for (const r of detailed) {
    const execution = r.execution as Execution;
    const remediation = r.remediation as Remediation;
    const conditions = (r.conditions as { kind: string; description: string }[]) ?? [];
    out.push(`## ${r.title}`, "", `Fingerprint: \`${r.fingerprint}\`. Severity: ${severityOf(r)}.`, "", r.description, "");
    out.push("### Trace", "", traceLines(r), "", "### Evidence", "", evidenceLines(r), "");
    out.push("### Local reproduction", "", `Attacker: ${execution.attacker_perspective}`, "");
    out.push(execution.instructions.map((s, i) => `${i + 1}. ${s}`).join("\n"), "");
    out.push("Inputs:", "", execution.payloads.map((p) => "```\n" + p + "\n```").join("\n"), "");
    out.push(`Observed result: ${execution.observed_result}`, "");
    out.push("### Conditions", "", conditions.length > 0 ? conditions.map((c) => `- ${c.kind}: ${c.description}`).join("\n") : "None.", "");
    out.push("### Remediation", "", remediation.strategy, "");
    for (const change of remediation.code_changes ?? []) out.push(`\`${change.file_name}\`:`, "", "```\n" + change.fixed_code + "\n```", "");
  }
  return out.join("\n");
}

export function renderNeedsValidation(records: FindingRecord[]): string {
  const needs = records.filter((r) => r.verdict === "needs_validation");
  const out = ["# Needs validation", "", "Leads without severity. Each one names the fact that would settle it.", ""];
  if (needs.length === 0) out.push("None.", "");
  for (const r of needs) {
    const plan = r.validation_plan as Plan;
    out.push(`## ${r.title}`, "", `Fingerprint: \`${r.fingerprint}\``, "", r.description, "");
    out.push(`Claimed root cause: ${r.claimed_root_cause}`, "");
    out.push("### Trace", "", traceLines(r), "", "### Evidence", "", evidenceLines(r), "");
    out.push("### Blockers", "", (r.blockers as string[]).map((b) => `- ${b}`).join("\n"), "");
    out.push("### How to resolve", "");
    if (plan.local) out.push(`- Local, bounded: ${plan.local}`);
    if (plan.deployment) out.push(`- Owner-observed: ${plan.deployment}`);
    out.push("");
  }
  return out.join("\n");
}
