import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { CanonicalRefs } from "./types.ts";

const require = createRequire(import.meta.url);
const ledger = require("../vendor/skill-validators/validate-coverage-ledger.cjs");
const findings = require("../vendor/skill-validators/validate-findings.cjs");

export const reportSchema: {
  items: { oneOf: { properties: { verdict: { const: string } } }[] };
} = JSON.parse(
  readFileSync(
    new URL("../vendor/skill-validators/report-schema.json", import.meta.url), "utf8"),
);

export function validateLedger(units: unknown[]): string[] {
  return [...ledger.validateDocument(units)];
}

export function validateFindings(records: unknown[]): string[] {
  return [...findings.validateDocument(records, reportSchema)];
}

export function canonicalCoverageId(refs: CanonicalRefs): string {
  return ledger.canonicalCoverageId(refs);
}

export function isSafeRelativePath(value: unknown): value is string {
  return ledger.isSafeRelativePath(value);
}

export function isSafeAgentId(value: unknown): value is string {
  return ledger.isSafeAgentId(value);
}

export function schemaBranch(verdict: string): string {
  const branch = reportSchema.items.oneOf.find((b) => b.properties.verdict.const === verdict);
  if (!branch) throw new Error(`report schema has no branch for verdict ${verdict}`);
  return JSON.stringify(branch, null, 2);
}
