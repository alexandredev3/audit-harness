import type { HarnessConfig, Role } from "./types.ts";

export const ROLES: Role[] = ["recon", "planner", "hunter", "critic", "verifier"];

export function defaultConfig(): HarnessConfig {
  return {
    roles: {
      recon: { runner: "claude-code", model: "sonnet" },
      planner: { runner: "claude-code", model: "opus" },
      hunter: { runner: "claude-code", model: "sonnet" },
      critic: { runner: "claude-code", model: "opus" },
      verifier: { runner: "claude-code", model: "opus" },
    },
    concurrency: 4,
    taskTimeoutMs: 20 * 60 * 1000,
    maxTurns: 80,
    maxWaves: 4,
    transientRetries: 3,
    backoffMs: 15_000,
    allowSameModelVerifier: false,
  };
}

/** A finding must be judged by different weights than the ones that produced it. */
export function validateConfig(config: HarnessConfig): string[] {
  const errors: string[] = [];
  const { hunter, verifier } = config.roles;
  if (
    !config.allowSameModelVerifier &&
    hunter.runner === verifier.runner && hunter.model === verifier.model
  ) {
    errors.push(
      `hunter and verifier both use ${hunter.runner}/${hunter.model}; ` +
      "pick different models or pass --allow-same-model-verifier",
    );
  }
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
    errors.push("concurrency must be a positive integer");
  }
  return errors;
}

export function applyModelOverrides(config: HarnessConfig, overrides: string[]): void {
  for (const entry of overrides) {
    const [role, model] = entry.split("=");
    if (!ROLES.includes(role as Role) || !model) {
      throw new Error(`--model expects role=model with role in ${ROLES.join(", ")}; got "${entry}"`);
    }
    config.roles[role as Role].model = model;
  }
}
