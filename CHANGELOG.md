# Changelog

## 0.1.0

First release, and the only version number so far: nothing was published before this, so the whole compatibility loop lands under `0.1.0` rather than being split across invented patch versions. Milestone numbers below are internal planning steps, not release lines.

- **M1** compatibility monitoring: vendored DSH verdict, semver range satisfaction, target DSH version from the npm registry, stored check history, `status`/`check`/`bundles.list`.
- **M2** migration reports: upgrade-guide parsing (installed + GitHub tag), bounded plugin surface scan, mechanical matching, `impact` and `report.get`.
- **M3** targeted upgrades: prompt from matched changes, optional git worktree, workspace registration, `upgrade.prepare`/`upgrade.verify`/`upgrade.runs`.
- **M4** delivery: commit, push, `gh pr create`, `gh pr merge` behind per-step confirmation and `allowMerge`.
- **M5** scheduled checks through `ctx.schedule`, with an explicit unavailable degradation.
- **M6** hardening: one exclusive check/upgrade at a time, capability detection, config and i18n contract tests, and a repeatable full-test script.
