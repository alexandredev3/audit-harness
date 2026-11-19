import { Database } from "bun:sqlite";
import type {
  FindingRecord,
  FindingState,
  HarnessConfig,
  LedgerUnit,
  PriorityFacts,
  Profile,
  Stage,
} from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  target TEXT NOT NULL,
  out_dir TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  dirty INTEGER NOT NULL,
  profile TEXT NOT NULL,
  budget INTEGER,
  agents_spent INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL,
  status TEXT NOT NULL,
  incomplete_reason TEXT,
  phase TEXT NOT NULL,
  loop_state TEXT,
  architecture_md TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  stage TEXT NOT NULL,
  key TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  runner TEXT,
  model TEXT,
  output TEXT,
  error TEXT,
  cost_usd REAL,
  turns INTEGER,
  duration_ms INTEGER,
  finished_at TEXT,
  PRIMARY KEY (run_id, key)
);
CREATE TABLE IF NOT EXISTS units (
  run_id TEXT NOT NULL,
  coverage_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  priority TEXT NOT NULL,
  hardening TEXT NOT NULL DEFAULT '[]',
  decisions TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, coverage_id)
);
CREATE TABLE IF NOT EXISTS findings (
  run_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  record TEXT NOT NULL,
  hunter_task TEXT,
  verifier_task TEXT,
  PRIMARY KEY (run_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
`;

export type RunStatus = "in_progress" | "paused" | "complete" | "incomplete";
export type Phase = "recon" | "hunt" | "validate" | "verify" | "finalize" | "done";
export type TaskStatus = "queued" | "running" | "done" | "failed";

export interface RunRow {
  run_id: string;
  repo: string;
  target: string;
  out_dir: string;
  source_ref: string;
  dirty: boolean;
  profile: Profile;
  budget: number | null;
  agents_spent: number;
  config: HarnessConfig;
  status: RunStatus;
  incomplete_reason: string | null;
  phase: Phase;
  loop_state: LoopState | null;
  architecture_md: string | null;
  created_at: string;
}

export interface LoopState {
  round: number;
  step: "wave" | "post" | "final" | "done";
  /** The last wave launched no hunter because the budget could not fund one. */
  starved?: boolean;
}

export interface TaskRow {
  task_id: string;
  stage: Stage;
  key: string;
  status: TaskStatus;
  attempt: number;
  runner: string | null;
  model: string | null;
  output: unknown;
  error: string | null;
  cost_usd: number | null;
  turns: number | null;
  duration_ms: number | null;
}

export interface UnitRow {
  unit: LedgerUnit;
  priority: PriorityFacts;
  hardening: string[];
  decisions: Record<string, string>;
}

export interface FindingRow {
  fingerprint: string;
  state: FindingState;
  record: FindingRecord;
  hunter_task: string | null;
  verifier_task: string | null;
}

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export class Store {
  private readonly db: Database;
  private depth = 0;

  constructor(path: string, readonly runId: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
  }

  // runs

  createRun(run: Omit<RunRow, "agents_spent" | "status" | "incomplete_reason" | "phase" | "loop_state" | "architecture_md" | "created_at">): void {
    this.db.prepare(
      `INSERT INTO runs (run_id, repo, target, out_dir, source_ref, dirty, profile, budget, config, status, phase, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', 'recon', ?)`,
    ).run(
      run.run_id, run.repo, run.target, run.out_dir, run.source_ref, run.dirty ? 1 : 0,
      run.profile, run.budget, JSON.stringify(run.config), now(),
    );
  }

  run(): RunRow {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(this.runId) as Row | undefined;
    if (!row) throw new Error(`run ${this.runId} not found in database`);
    return {
      ...(row as unknown as RunRow),
      dirty: row.dirty === 1,
      config: JSON.parse(row.config as string),
      loop_state: row.loop_state ? JSON.parse(row.loop_state as string) : null,
    };
  }

  private setRun(column: string, value: string | number | null): void {
    this.db.prepare(`UPDATE runs SET ${column} = ? WHERE run_id = ?`).run(value, this.runId);
  }

  setStatus(status: RunStatus): void {
    this.setRun("status", status);
  }
  noteIncomplete(reason: string): void {
    if (this.run().incomplete_reason === null) this.setRun("incomplete_reason", reason);
    this.log("incomplete", reason);
  }
  setPhase(phase: Phase): void {
    this.setRun("phase", phase);
  }
  setLoopState(state: LoopState): void {
    this.setRun("loop_state", JSON.stringify(state));
  }
  setArchitecture(markdown: string): void {
    this.setRun("architecture_md", markdown);
  }
  setConfig(config: HarnessConfig): void {
    this.setRun("config", JSON.stringify(config));
  }

  /**
   * Takes one agent invocation from the budget. False means the budget cannot fund it
   * while leaving `keep` invocations for work that is already owed.
   */
  spend(keep = 0): boolean {
    return this.tx(() => {
      const { budget, agents_spent } = this.run();
      if (budget !== null && budget - agents_spent - 1 < keep) return false;
      this.setRun("agents_spent", agents_spent + 1);
      return true;
    });
  }
  refund(): void {
    this.tx(() => this.setRun("agents_spent", Math.max(0, this.run().agents_spent - 1)));
  }
  remainingBudget(): number {
    const { budget, agents_spent } = this.run();
    return budget === null ? Infinity : budget - agents_spent;
  }

  // tasks

  private toTask(row: Row): TaskRow {
    return { ...(row as unknown as TaskRow), output: row.output ? JSON.parse(row.output as string) : null };
  }

  task(key: string): TaskRow | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE run_id = ? AND key = ?").get(this.runId, key) as Row | undefined;
    return row ? this.toTask(row) : undefined;
  }

  tasks(): TaskRow[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE run_id = ? ORDER BY rowid").all(this.runId) as Row[])
      .map((row) => this.toTask(row));
  }

  ensureTask(key: string, taskId: string, stage: Stage): TaskRow {
    const repo = this.run().repo;
    this.db.prepare(
      `INSERT OR IGNORE INTO tasks (task_id, run_id, repo, stage, key, status) VALUES (?, ?, ?, ?, ?, 'queued')`,
    ).run(taskId, this.runId, repo, stage, key);
    return this.task(key)!;
  }

  updateTask(key: string, fields: Partial<Omit<TaskRow, "key" | "stage" | "task_id">>): void {
    for (const [column, value] of Object.entries(fields)) {
      const stored = column === "output" ? JSON.stringify(value) : (value as string | number | null);
      this.db.prepare(`UPDATE tasks SET ${column} = ? WHERE run_id = ? AND key = ?`).run(stored, this.runId, key);
    }
    if (fields.status === "done" || fields.status === "failed") {
      this.db.prepare("UPDATE tasks SET finished_at = ? WHERE run_id = ? AND key = ?").run(now(), this.runId, key);
    }
  }

  requeueRunningTasks(): number {
    const result = this.db.prepare("UPDATE tasks SET status = 'queued' WHERE run_id = ? AND status = 'running'").run(this.runId);
    return Number(result.changes);
  }

  // units

  private toUnit(row: Row): UnitRow {
    return {
      unit: JSON.parse(row.data as string),
      priority: JSON.parse(row.priority as string),
      hardening: JSON.parse(row.hardening as string),
      decisions: JSON.parse(row.decisions as string),
    };
  }

  units(): UnitRow[] {
    return (this.db.prepare("SELECT * FROM units WHERE run_id = ? ORDER BY coverage_id").all(this.runId) as Row[])
      .map((row) => this.toUnit(row));
  }

  unit(coverageId: string): UnitRow | undefined {
    const row = this.db.prepare("SELECT * FROM units WHERE run_id = ? AND coverage_id = ?").get(this.runId, coverageId) as Row | undefined;
    return row ? this.toUnit(row) : undefined;
  }

  putUnit(unit: LedgerUnit, extra: Partial<Omit<UnitRow, "unit">> = {}): void {
    const existing = this.unit(unit.coverage_id);
    const priority = extra.priority ?? existing?.priority ?? { lowest_trust_entry: false, protects: "other" };
    const hardening = extra.hardening ?? existing?.hardening ?? [];
    const decisions = extra.decisions ?? existing?.decisions ?? {};
    this.db.prepare(
      `INSERT INTO units (run_id, coverage_id, status, data, priority, hardening, decisions) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, coverage_id) DO UPDATE SET
         status = excluded.status, data = excluded.data, priority = excluded.priority,
         hardening = excluded.hardening, decisions = excluded.decisions`,
    ).run(
      this.runId, unit.coverage_id, unit.status, JSON.stringify(unit),
      JSON.stringify(priority), JSON.stringify(hardening), JSON.stringify(decisions),
    );
  }

  // findings

  private toFinding(row: Row): FindingRow {
    return { ...(row as unknown as FindingRow), record: JSON.parse(row.record as string) };
  }

  findings(): FindingRow[] {
    return (this.db.prepare("SELECT * FROM findings WHERE run_id = ? ORDER BY fingerprint").all(this.runId) as Row[])
      .map((row) => this.toFinding(row));
  }

  finding(fingerprint: string): FindingRow | undefined {
    const row = this.db.prepare("SELECT * FROM findings WHERE run_id = ? AND fingerprint = ?").get(this.runId, fingerprint) as Row | undefined;
    return row ? this.toFinding(row) : undefined;
  }

  putFinding(finding: FindingRow): void {
    this.db.prepare(
      `INSERT INTO findings (run_id, fingerprint, state, record, hunter_task, verifier_task) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, fingerprint) DO UPDATE SET
         state = excluded.state, record = excluded.record,
         hunter_task = excluded.hunter_task, verifier_task = excluded.verifier_task`,
    ).run(
      this.runId, finding.fingerprint, finding.state, JSON.stringify(finding.record),
      finding.hunter_task, finding.verifier_task,
    );
  }

  // events

  log(kind: string, detail: string): void {
    this.db.prepare("INSERT INTO events (run_id, at, kind, detail) VALUES (?, ?, ?, ?)").run(this.runId, now(), kind, detail);
  }

  events(kind?: string): { at: string; kind: string; detail: string }[] {
    const rows = kind
      ? this.db.prepare("SELECT at, kind, detail FROM events WHERE run_id = ? AND kind = ? ORDER BY id").all(this.runId, kind)
      : this.db.prepare("SELECT at, kind, detail FROM events WHERE run_id = ? ORDER BY id").all(this.runId);
    return rows as { at: string; kind: string; detail: string }[];
  }
}
