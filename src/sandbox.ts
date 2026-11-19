export interface SandboxLimits {
  wallClockMs: number;
  memoryMb: number;
  cpus: number;
  maxOutputBytes: number;
}

export interface SandboxCapabilities {
  available: boolean;
  /** Controls the platform cannot enforce; non-empty means no execution. */
  missing: string[];
}

export interface SandboxRunRequest {
  agentId: string;
  command: string[];
  /** Fixtures to write under the agent's scratch directory before the run. */
  files?: Record<string, string>;
  /** Scratch-relative files the harness may promote to artifacts afterwards. */
  expectArtifacts?: string[];
  limits?: Partial<SandboxLimits>;
}

export interface SandboxRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Output-relative artifact paths (`agents/<id>/artifacts/...`) promoted by the harness. */
  promoted: string[];
}

export interface Sandbox {
  capabilities(): SandboxCapabilities;
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
}

export class SandboxUnavailable extends Error {
  constructor() {
    super("no OS-enforced sandbox is available in this build");
  }
}

export class UnavailableSandbox implements Sandbox {
  capabilities(): SandboxCapabilities {
    return { available: false, missing: ["os_sandbox", "artifact_promotion"] };
  }
  run(): Promise<SandboxRunResult> {
    return Promise.reject(new SandboxUnavailable());
  }
}

export function sandboxPromptBlock(caps: SandboxCapabilities): string {
  if (caps.available) {
    return [
      "Sandbox status: AVAILABLE through the `sandbox_run` tool.",
      "Every target-controlled command must go through that tool. The harness applies the",
      "limits and promotes the artifacts you predeclare; you never write retained files.",
    ].join("\n");
  }
  return [
    `Sandbox status: UNAVAILABLE (missing: ${caps.missing.join(", ")}).`,
    "No target-controlled execution is possible in this run, so no local observed result",
    "can exist. Wherever the text below asks for a bounded local check, do not attempt",
    "one and do not describe one as if it ran. Never propose or return `confirmed`.",
    "A lead with a complete source trace is `needs_validation`: add a blocker that starts",
    "with `sandbox_unavailable:` and write the exact bounded check to run later in",
    '`validation_plan.local`. Every check you report uses "method": "source" and',
    '"artifact": null.',
  ].join("\n");
}
