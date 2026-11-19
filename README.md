# audit-harness

A security audit harness in TypeScript on Bun. It runs the prompts from Cloudflare's `security-audit` skill as a pipeline of isolated agents, following [Build your own vulnerability harness](https://blog.cloudflare.com/build-your-own-vulnerability-harness). The skill expects a parent agent to coordinate everything from memory. Here that parent is code backed by SQLite, so a run survives a crash, stays inside a budget, and resumes after a usage limit.

## Status

The pipeline works for one repository: reconnaissance, planning, hunting waves with coverage critics, candidate validation, record verification, and reports.

The sandbox is not built yet. Agents can only read source, so no run can produce a `confirmed` finding. The skill defines `confirmed` as backed by a local execution result, and the harness enforces that in code: a `confirmed` verdict with no harness-run check behind it is rewritten as `needs_validation`, with the claimed reproduction kept as the plan for a later sandboxed run. `src/sandbox.ts` holds the interface the sandbox will implement.

Also not built: prior-run carry-over, the `deep` profile, cross-repo tracing, and root-cause deduplication beyond matching fingerprints.

## Usage

```sh
bun run audit --target ~/code/my-service
bun run audit --target ~/code/my-service --profile quick --budget 40
bun run audit --resume ~/security-audit-harness/my-service/run-3
```

| Option | Meaning |
|---|---|
| `--profile quick\|standard` | `quick` runs one hunter wave and one critic. `standard` (default) repeats waves until a clean critic pass, then re-verifies every record with a fresh agent. |
| `--budget <n>` | Cap on agent invocations across all phases. Critics and validation are reserved before hunters are assigned. |
| `--concurrency <n>` | Agents running at once. Default 4. |
| `--model <role>=<model>` | Override a role's model. Roles: `recon`, `planner`, `hunter`, `critic`, `verifier`. |
| `--out <dir>` | Run directory. Default `~/security-audit-harness/<repo>/run-<N>`. It must be outside the target. |

A run directory holds `harness.db` (the source of truth), plus exports written at the end: `REPORT.md`, `FINDINGS-DETAIL.md`, `NEEDS-VALIDATION.md`, `findings.json`, `coverage-ledger.json`, `architecture.md`, and `run-metadata.json`. Both JSON files must pass the skill's validators before any report is written.

Exit codes: 0 complete, 1 incomplete, 2 bad arguments, 3 paused (resume with the printed command).

## How agents run

Each agent is a `claude -p` subprocess using your own Claude Code login, so a subscription works. The harness never handles credentials. Other providers can be added by implementing `AgentRunner` in `src/runner/types.ts`.

Every agent starts with `--safe-mode`, `--setting-sources user`, `--strict-mcp-config`, and `--tools "Read,Grep,Glob"`, in an empty working directory with a cleared environment. Without those flags a headless run executes hooks from the target's `.claude/settings.json`, connects the servers in its `.mcp.json`, and loads your own plugins, skills, and MCP tools into every agent. `bun run check:lockdown` tests this against a fixture repo that plants a hook and an MCP server. It makes one real model call, so it is not part of the test suite.

The hunter and the verifier must use different models. The harness refuses to start otherwise unless you pass `--allow-same-model-verifier`.

## Layout

```
src/pipeline.ts          the phases, in order
src/scheduler.ts         one task: budget, retries, outcome handling, atomic commit
src/ledger.ts            coverage units, canonical IDs, hunter and critic result checks
src/checks.ts            cited-path checks and the local-evidence rule
src/prompts/             prompt assembly and the attack-class catalog
src/runner/              AgentRunner interface and the Claude Code implementation
src/sandbox.ts           Sandbox interface (no implementation yet)
prompts/                 the skill's prompt text, split by role
prompts/hunt/classes/    attack-class files, unmodified, referenced as FILE.md#Class name
vendor/skill-validators/ the skill's two validators and their tests, unmodified
docs/skill/              the original skill documents, kept as the spec for the code
```

## Tests

Run `bun install` once first.

```sh
bun run test               # pipeline and unit tests, no model calls
bun run test:validators    # the skill's own validator tests
bun run check:lockdown     # one real call; run after upgrading Claude Code
bun run typecheck
```
