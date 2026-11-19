import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import type { FindingRecord } from "./types.ts";
import { isSafeRelativePath } from "./validators.ts";

export class TargetFiles {
  private readonly root: string;
  private readonly lineCounts = new Map<string, number | null>();

  constructor(target: string) {
    this.root = realpathSync(target);
  }

  lines(path: string): number | null {
    if (this.lineCounts.has(path)) return this.lineCounts.get(path)!;
    let count: number | null = null;
    if (isSafeRelativePath(path)) {
      try {
        const real = realpathSync(join(this.root, path));
        if ((real === this.root || real.startsWith(this.root + sep)) && statSync(real).isFile()) {
          count = readFileSync(real, "utf8").split("\n").length;
        }
      } catch {
        count = null;
      }
    }
    this.lineCounts.set(path, count);
    return count;
  }

  exists(path: string): boolean {
    if (!isSafeRelativePath(path)) return false;
    try {
      const real = realpathSync(join(this.root, path));
      return real === this.root || real.startsWith(this.root + sep);
    } catch {
      return false;
    }
  }
}

export function missingPaths(paths: string[], files: TargetFiles): string[] {
  return paths.filter((path) => !files.exists(path));
}

export function citedLocationErrors(record: FindingRecord, files: TargetFiles): string[] {
  const errors: string[] = [];
  const check = (list: unknown, label: string) => {
    if (!Array.isArray(list)) return;
    list.forEach((entry, index) => {
      const file = entry?.file;
      const line = entry?.line;
      const count = typeof file === "string" ? files.lines(file) : null;
      if (count === null) {
        errors.push(`${label}[${index}].file: "${file}" is not a file in the target repository`);
      } else if (Number.isInteger(line) && line > count) {
        errors.push(`${label}[${index}].line: ${line} is past the end of ${file} (${count} lines)`);
      }
    });
  };
  check(record.trace, "trace");
  check(record.evidence, "evidence");
  return errors;
}

export const SANDBOX_BLOCKER = "sandbox_unavailable: no harness-run local check backs the observed result";

/**
 * `confirmed` means a bounded local check ran and the harness holds its artifact.
 * A confirmed record without one is rewritten as `needs_validation`, keeping the
 * trace and turning the claimed reproduction into the plan for a later sandboxed run.
 */
export function enforceLocalEvidence(
  record: FindingRecord,
  hasPromotedArtifact: boolean,
): { record: FindingRecord; downgraded: boolean } {
  if (record.verdict !== "confirmed" || hasPromotedArtifact) return { record, downgraded: false };
  const execution = (record.execution ?? {}) as { instructions?: unknown; payloads?: unknown };
  const steps = [
    ...(Array.isArray(execution.instructions) ? execution.instructions : []),
    ...(Array.isArray(execution.payloads) ? execution.payloads.map((p) => `input: ${p}`) : []),
  ].filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  const plan = steps.length > 0
    ? `Run inside the sandbox, with dummy data only: ${steps.join(" | ")}`
    : "Reproduce the claimed result with a bounded local fixture inside the sandbox.";
  return {
    downgraded: true,
    record: {
      verdict: "needs_validation",
      fingerprint: record.fingerprint,
      title: record.title,
      description: record.description,
      claimed_root_cause: String(record.root_cause ?? record.description),
      trace: record.trace,
      evidence: record.evidence,
      blockers: [SANDBOX_BLOCKER],
      validation_plan: { local: plan },
    },
  };
}
