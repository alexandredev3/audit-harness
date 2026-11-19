import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./db.ts";
import { exportLedger } from "./ledger.ts";
import { renderFindingsDetail, renderNeedsValidation, renderReport } from "./report.ts";
import type { SandboxCapabilities } from "./sandbox.ts";
import type { FindingRecord } from "./types.ts";
import { validateFindings, validateLedger } from "./validators.ts";

const FINAL_STATES = new Set(["confirmed", "needs_validation", "rejected"]);

export function finalRecords(store: Store): FindingRecord[] {
  return store.findings()
    .filter((f) => FINAL_STATES.has(f.state))
    .map((f) => f.record)
    .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
}

export function writeExports(store: Store, sandbox: SandboxCapabilities): string[] {
  const run = store.run();
  const ledger = exportLedger(store.units());
  const findings = finalRecords(store);
  const write = (name: string, content: string) => writeFileSync(join(run.out_dir, name), content);
  const tasks = store.tasks();

  write("coverage-ledger.json", JSON.stringify(ledger, null, 2) + "\n");
  write("findings.json", JSON.stringify(findings, null, 2) + "\n");
  write("architecture.md", (run.architecture_md ?? "No architecture summary was produced.") + "\n");
  write(
    "run-metadata.json",
    JSON.stringify(
      {
        run_id: run.run_id,
        repo: run.repo,
        target: run.target,
        source_ref: run.source_ref,
        worktree_dirty: run.dirty,
        profile: run.profile,
        scope_paths: [],
        budget: run.budget,
        agents_spent: run.agents_spent,
        execution_policy: "sandboxed-source-and-local-only",
        sandbox,
        prior_runs: [],
        shared_file_owner: "harness",
        roles: run.config.roles,
        estimated_cost_usd: Number(tasks.reduce((sum, t) => sum + (t.cost_usd ?? 0), 0).toFixed(4)),
        run_status: run.status,
        incomplete_reason: run.incomplete_reason,
      },
      null,
      2,
    ) + "\n",
  );

  const errors = [
    ...validateLedger(ledger).map((e) => `coverage-ledger.json ${e}`),
    ...validateFindings(findings).map((e) => `findings.json ${e}`),
  ];
  if (errors.length === 0) {
    write("REPORT.md", renderReport(store, sandbox));
    write("FINDINGS-DETAIL.md", renderFindingsDetail(findings));
    write("NEEDS-VALIDATION.md", renderNeedsValidation(findings));
  }
  return errors;
}
