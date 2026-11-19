export interface AgentTask {
  agentId: string;
  prompt: string;
  model: string;
  targetDir: string;
  agentDir: string;
  tools: string[];
  harnessTools: string[];
  outputSchema: Record<string, unknown>;
  timeoutMs: number;
  maxTurns: number;
}

export type Outcome =
  | { kind: "ok"; output: unknown }
  | { kind: "malformed"; errors: string[] }
  | { kind: "transient"; reason: string }
  | { kind: "quota"; reason: string }
  | { kind: "fatal"; reason: string };

export interface AgentRunResult {
  outcome: Outcome;
  costUsd?: number;
  turns?: number;
  durationMs?: number;
}

export interface AgentRunner {
  readonly name: string;
  run(task: AgentTask): Promise<AgentRunResult>;
}
