import type { AgentRunner, AgentRunResult, AgentTask, Outcome } from "./types.ts";

const QUOTA = /usage limit|limit reached|out of (extra )?usage|billing|credit balance|quota|account_on_hold/i;
const RATE = /rate.?limit|overloaded|too many requests|server_error|timed? ?out|network|ECONN|socket hang up/i;
const AUTH = /authenticat|not logged in|\/login|invalid api key|oauth|unauthorized|model_not_found|invalid_request/i;
const BAD_INVOCATION = /unknown option|not a valid JSON Schema|invalid (value|argument)/i;

export interface RawRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function parseStrictJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function classifyErrorText(text: string, status: unknown): Outcome {
  if (status === 401 || status === 403 || AUTH.test(text)) return { kind: "fatal", reason: text };
  if (QUOTA.test(text)) return { kind: "quota", reason: text };
  if (status === 429 || (typeof status === "number" && status >= 500) || RATE.test(text)) {
    return { kind: "transient", reason: text };
  }
  return { kind: "transient", reason: text || "unknown error" };
}

/**
 * Exit code 0 is not success on its own: an API error can arrive as the result text
 * of a normal exit, and a run that ends without structured output simply omits the field.
 */
export function classify(raw: RawRun): AgentRunResult {
  if (raw.timedOut) return { outcome: { kind: "transient", reason: "task timed out" } };

  let envelope: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(raw.stdout);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) envelope = parsed;
  } catch {
    // handled below
  }
  if (!envelope) {
    const text = (raw.stderr || raw.stdout).trim().slice(0, 500);
    if (BAD_INVOCATION.test(text)) return { outcome: { kind: "fatal", reason: text } };
    return { outcome: classifyErrorText(text || `exit code ${raw.exitCode} with no output`, null) };
  }

  const meta = {
    costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : undefined,
    turns: typeof envelope.num_turns === "number" ? envelope.num_turns : undefined,
    durationMs: typeof envelope.duration_ms === "number" ? envelope.duration_ms : undefined,
  };
  const resultText = typeof envelope.result === "string" ? envelope.result : "";

  if (envelope.is_error === true || envelope.subtype !== "success") {
    if (envelope.subtype === "error_max_turns") {
      return { outcome: { kind: "malformed", errors: ["agent hit the turn limit before answering"] }, ...meta };
    }
    if (envelope.subtype === "error_max_structured_output_retries") {
      return { outcome: { kind: "malformed", errors: ["agent could not produce JSON matching the output schema"] }, ...meta };
    }
    const text = (resultText || String(envelope.subtype ?? "")).slice(0, 500);
    return { outcome: classifyErrorText(text, envelope.api_error_status), ...meta };
  }

  if (envelope.structured_output !== undefined && envelope.structured_output !== null) {
    return { outcome: { kind: "ok", output: envelope.structured_output }, ...meta };
  }
  const fromText = parseStrictJson(resultText);
  if (fromText !== undefined) return { outcome: { kind: "ok", output: fromText }, ...meta };

  // A short non-JSON answer that names a limit is an error delivered as a success.
  if (resultText.length < 400 && QUOTA.test(resultText)) {
    return { outcome: { kind: "quota", reason: resultText }, ...meta };
  }
  if (resultText.length < 400 && RATE.test(resultText)) {
    return { outcome: { kind: "transient", reason: resultText }, ...meta };
  }
  return {
    outcome: { kind: "malformed", errors: ["no structured output; the answer was prose or empty"] },
    ...meta,
  };
}

export function buildArgs(task: AgentTask): string[] {
  if (task.harnessTools.length > 0) {
    throw new Error("harness-served tools need the sandbox MCP server, which is not built yet");
  }
  return [
    "-p",
    "--safe-mode", // no CLAUDE.md, skills, plugins, hooks, MCP, or memory; login still works
    "--setting-sources", "user", // never read the target's settings files or .mcp.json
    "--strict-mcp-config",
    "--tools", task.tools.join(","),
    "--disallowedTools", "mcp__*",
    "--permission-mode", "dontAsk", // anything that would prompt is denied
    "--output-format", "json",
    "--json-schema", JSON.stringify(task.outputSchema),
    "--model", task.model,
    "--max-turns", String(task.maxTurns),
    "--no-session-persistence",
    "--add-dir", task.targetDir,
  ];
}

function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "USER", "LANG", "TMPDIR"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

export class ClaudeCodeRunner implements AgentRunner {
  readonly name = "claude-code";
  constructor(private readonly binary = "claude") { }

  async run(task: AgentTask): Promise<AgentRunResult> {
    let child;
    try {
      child = Bun.spawn([this.binary, ...buildArgs(task)], {
        cwd: task.agentDir,
        env: minimalEnv(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      return { outcome: { kind: "fatal", reason: `cannot start ${this.binary}: ${(error as Error).message}` } };
    }

    // The prompt goes over stdin: it can be far longer than an argument should be.
    child.stdin.write(task.prompt);
    await child.stdin.end();

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGINT"); // lets the CLI end the turn
      killTimer = setTimeout(() => child.kill("SIGTERM"), 10_000);
    }, task.timeoutMs);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);

    return classify({ exitCode, stdout, stderr, timedOut });
  }
}
