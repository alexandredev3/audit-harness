The parent synthesizes `<output-dir>/architecture.md`, with a hard cap of about 1,000 words. Include:

1. Product, principals, normal authority, and protected resources.
2. The comparable-software baseline from Agent 1a, when one is source-grounded: what security trade-offs the comparable accepts. Use it to calibrate effort and severity, never to dismiss a demonstrated finding; if the comparable shares a defect pattern that has mattered in practice, that strengthens the finding. Omit this line when no meaningful comparable exists.
3. Tech stack, source-visible deployment paths, and offline build/test limits.
4. Entry surfaces and the important source-to-sink or lifecycle paths.
5. Trust boundaries and the strongest source-visible control on each.
6. Repository-relative starting paths.
7. Prior coverage gaps, changed-source and blocked revalidation targets, and same-source confirmed exclusions.
8. A short companion-selection summary derived from [ATTACK-CLASSES.md](ATTACK-CLASSES.md): selected files and the source-visible boundaries that require them.

Keep the assignment-level ordinary block, selected companion blocks, and excluded blocks with reasons in each ledger unit, not in `architecture.md`. This keeps the architecture cap valid for large runs and makes the exact hunter prompt map machine-checkable.

Do not select a companion file merely because the language or dependency name appears. Select it because reconnaissance found the trust-sensitive boundary described by its `When to use this file` section. Do not exclude a visible boundary just because another agent will review a related class.
