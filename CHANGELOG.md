# Changelog

### Beyond M6 — still `0.1.0`

Everything below shipped before the first publish, so it belongs to the same version rather than a bump.

- **The upgrade is fenced.** The session may change only what the DSH version forces; anything else it notices is reported as P0/P1/P2 findings (problem only, no fix, no estimate) and the code is left alone.
- **Scheduled tasks store a launcher.** The prompt only tells the agent to call `upkeep_status`; the policy travels in the result's `brief`, so upgrading dsh-upkeep changes what an existing task does without touching it. Old launchers are brought forward at startup and on `schedule.refresh`, and a prompt you rewrote is never overwritten.
- **Tasks are created in your language.** The prompt marker carries the scope and language, so switching languages cannot orphan a task; titles are display text.
- **Worktrees live inside the checkout** at `<repo>/.worktrees/upkeep/<run>`, bounded by `worktreesToKeep`, ignored through `.git/info/exclude` (opt out with `ignoreWorktrees`), and retired with their branch when a run is merged.
- **Prepare starts the run itself** through a one-shot task deleted `upgradeTaskCleanupSeconds` later, instead of leaving an unsent draft.
- **Delivery is bounded:** a commit stages only the files the preview listed; a preparation that cannot register its workspace removes the worktree it created.
- **The panel gained** an Actions column, a per-row Stop for scheduled checks (`schedule.remove`), daily-cadence display, and localized Host warnings.
- **Release plumbing:** `npm run verify:pack` proves the tarball installs and composes, `docs/SECURITY.md` documents the machine footprint, `docs/RELEASE.md` the release steps, and CI runs the suite on node 22 and 24.

## 0.1.0

First release, and the only version number so far: nothing was published before this, so the whole compatibility loop lands under `0.1.0` rather than being split across invented patch versions. Milestone numbers below are internal planning steps, not release lines.

- **M1** compatibility monitoring: vendored DSH verdict, semver range satisfaction, target DSH version from the npm registry, stored check history, `status`/`check`/`bundles.list`.
- **M2** migration reports: upgrade-guide parsing (installed + GitHub tag), bounded plugin surface scan, mechanical matching, `impact` and `report.get`.
- **M3** targeted upgrades: prompt from matched changes, optional git worktree, workspace registration, `upgrade.prepare`/`upgrade.verify`/`upgrade.runs`.
- **M4** delivery: commit, push, `gh pr create`, `gh pr merge` behind per-step confirmation and `allowMerge`.
- **M5** scheduled checks through `ctx.schedule`, with an explicit unavailable degradation.
- **M6** hardening: one exclusive check/upgrade at a time, capability detection, config and i18n contract tests, and a repeatable full-test script.
