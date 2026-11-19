import { mkdirSync, realpathSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { applyModelOverrides, defaultConfig, validateConfig } from "./config.ts";
import type { Profile } from "./types.ts";
import { Store } from "./db.ts";
import { type AuditContext, runAudit } from "./pipeline.ts";
import { CLASSES_DIR } from "./prompts/assemble.ts";
import { loadCatalog } from "./prompts/catalog.ts";
import { ClaudeCodeRunner } from "./runner/claude_code.ts";
import { UnavailableSandbox } from "./sandbox.ts";

const DB_FILE = "harness.db";

async function git(target: string, ...args: string[]): Promise<string | null> {
  try {
    const child = Bun.spawn(["git", "-C", target, ...args], { stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(child.stdout).text();
    return (await child.exited) === 0 ? stdout.trim() : null;
  } catch {
    return null;
  }
}

function nextRunDir(repo: string): string {
  const home = process.env["HOME"];
  if (!home) throw new Error("HOME is not set; pass --out");
  const base = join(home, "security-audit-harness", repo);
  mkdirSync(base, { recursive: true });
  for (let n = 1;; n++) {
    const dir = join(base, `run-${n}`);
    try {
      mkdirSync(dir);
      return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function soleRunId(dbPath: string): string {
  const db = new Database(dbPath);
  try {
    const rows = db.prepare("SELECT run_id FROM runs").all() as { run_id: string }[];
    const [only, ...others] = rows;
    if (!only || others.length > 0) throw new Error(`${dbPath} holds ${rows.length} runs; expected exactly one`);
    return only.run_id;
  } finally {
    db.close();
  }
}

interface CliOptions {
  target?: string;
  resume?: string;
  profile: Profile;
  budget?: number;
  concurrency?: number;
  model: string[];
  out?: string;
  allowSameModelVerifier?: boolean;
}

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("Expected a positive integer.");
  return n;
}

function buildProgram(): Command {
  return new Command()
    .name("bun run audit")
    .usage("--target <repo> [options]\n       bun run audit --resume <run-directory> [options]")
    .addOption(new Option("--target <repo>", "Repository to audit").conflicts("resume"))
    .option("--resume <run-directory>", "Continue a paused or interrupted run")
    .addOption(
      new Option("--profile <profile>", "quick: one hunter wave and one critic. standard: waves until a clean critic pass")
        .choices(["quick", "standard"])
        .default("standard"),
    )
    .option("--budget <n>", "Cap on agent invocations across all phases (default: no cap)", positiveInt)
    .option("--concurrency <n>", "Agents running at once (default: 4)", positiveInt)
    .addOption(
      new Option("--model <role>=<model>", "Override a role's model (recon, planner, hunter, critic, verifier). Repeatable")
        .argParser((value: string, previous: string[]) => [...previous, value])
        .default([], "none"),
    )
    .option("--out <dir>", "Run directory (default: ~/security-audit-harness/<repo>/run-<N>)")
    .option("--allow-same-model-verifier", "Permit hunter and verifier to share a model")
    .allowExcessArguments(false)
    .exitOverride();
}

export async function main(argv: string[]): Promise<number> {
  const program = buildProgram();
  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    // Commander has already printed help or the usage error.
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    throw error;
  }
  const values = program.opts<CliOptions>();
  if (!values.target && !values.resume) {
    program.outputHelp({ error: true });
    return 2;
  }

  let store: Store;
  if (values.resume) {
    const outDir = resolve(values.resume);
    store = new Store(join(outDir, DB_FILE), soleRunId(join(outDir, DB_FILE)));
  } else {
    const target = realpathSync(resolve(values.target!));
    const { profile } = values;
    const budget = values.budget ?? null;

    const repo = basename(target);
    const outDir = values.out ? resolve(values.out) : nextRunDir(repo);
    if (outDir === target || outDir.startsWith(target + sep)) {
      throw new Error("the run directory must be outside the target repository");
    }
    mkdirSync(outDir, { recursive: true });
    const head = await git(target, "rev-parse", "HEAD");
    const status = await git(target, "status", "--porcelain");
    const runId = basename(outDir);
    store = new Store(join(outDir, DB_FILE), runId);
    store.createRun({
      run_id: runId,
      repo,
      target,
      out_dir: outDir,
      source_ref: head ?? "not a git repository",
      dirty: status === null ? false : status !== "",
      profile,
      budget,
      config: defaultConfig(),
    });
  }

  const run = store.run();
  const config = run.config;
  if (values.concurrency !== undefined) config.concurrency = values.concurrency;
  if (values.allowSameModelVerifier) config.allowSameModelVerifier = true;
  applyModelOverrides(config, values.model);
  const problems = validateConfig(config);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`config: ${problem}`);
    return 2;
  }
  store.setConfig(config);

  const ctx: AuditContext = {
    store,
    config,
    runners: { "claude-code": new ClaudeCodeRunner() },
    target: run.target,
    outDir: run.out_dir,
    catalog: loadCatalog(CLASSES_DIR),
    sandbox: new UnavailableSandbox(),
    log: (message) => console.log(message),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };

  console.log(`${values.resume ? "Resuming" : "Starting"} ${run.run_id} (${run.profile}) on ${run.target}`);
  console.log(`Run directory: ${run.out_dir}`);
  const result = await runAudit(ctx);
  store.close();

  if (result.status === "paused") {
    console.log(`\nRun paused after ${result.agents_spent} agent invocation(s). Nothing is lost.`);
    console.log(`Resume with: bun run audit --resume ${result.out_dir}`);
    return 3;
  }
  console.log(`\nRun ${result.status}${result.incomplete_reason ? ` (${result.incomplete_reason})` : ""}.`);
  console.log(`Report: ${join(result.out_dir, "REPORT.md")}`);
  return result.status === "complete" ? 0 : 1;
}
