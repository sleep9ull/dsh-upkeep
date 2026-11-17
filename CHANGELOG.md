# Changelog

## 0.1.1

Patch release for the first trials: one scan bug, and both halves of its symptom.

- **A local tarball install is scanned from the installed copy.** A `file:` dependency can point at the `.tgz` it was installed from (`"dsh-wardrobe": "file:../dsh-wardrobe-0.1.0.tgz"`), and DSH reports that spec as `source: file:/abs/dsh-wardrobe-0.1.0.tgz` with no hint that the path is a file. The resolver used it as the package root, so the declared bundle patch "could not be read", the surface scan found zero files, and that plugin's migration report matched nothing — an empty answer that read like "nothing to do". The local target now has to be a directory; a tarball falls back to the installed copy and is no longer counted as local-checkout evidence.
- **Scan warnings name the plugin and speak the reader's language.** `The bundle patch ./cordis.patch.yml could not be read.` became `读不到 @isdou/dsh-wardrobe (./cordis.patch.yml) 声明的 bundle patch，本次扫描无法得知它声明的 row 与配置。`, with the English form alongside. A source directory that cannot be resolved, or one with no readable file, now reports the scan as unknown instead of leaving a clean-looking empty inventory.

No configuration or wire-format changes; nothing in this release is breaking.

## 0.1.0

First release, and the only version number so far: nothing was published before this, so the whole compatibility loop lands under `0.1.0` rather than being split across invented patch versions. Milestone numbers below are internal planning steps, not release lines.

- **M1** compatibility monitoring: vendored DSH verdict, semver range satisfaction, target DSH version from the npm registry, stored check history, `status`/`check`/`bundles.list`.
- **M2** migration reports: upgrade-guide parsing (installed + GitHub tag), bounded plugin surface scan, mechanical matching, `impact` and `report.get`.
- **M3** targeted upgrades: prompt from matched changes, optional git worktree, workspace registration, `upgrade.prepare`/`upgrade.verify`/`upgrade.runs`.
- **M4** delivery: commit, push, `gh pr create`, `gh pr merge` behind per-step confirmation and `allowMerge`.
- **M5** scheduled checks through `ctx.schedule`, with an explicit unavailable degradation.
- **M6** hardening: one exclusive check/upgrade at a time, capability detection, config and i18n contract tests, and a repeatable full-test script.

### Beyond M6

Everything here shipped in `0.1.0` before the first publish, so it belongs to that version rather than a later bump.

- **The upgrade is fenced.** The session may change only what the DSH version forces; anything else it notices is reported as P0/P1/P2 findings (problem only, no fix, no estimate) and the code is left alone.
- **Scheduled tasks store a launcher.** The prompt only tells the agent to call `upkeep_status`; the policy travels in the result's `brief`, so upgrading dsh-upkeep changes what an existing task does without touching it. Old launchers are brought forward at startup and on `schedule.refresh`, and a prompt you rewrote is never overwritten.
- **Tasks are created in your language.** The prompt marker carries the scope and language, so switching languages cannot orphan a task; titles are display text.
- **Worktrees live inside the checkout** at `<repo>/.worktrees/upkeep/<run>`, bounded by `worktreesToKeep`, ignored through `.git/info/exclude` (opt out with `ignoreWorktrees`), and retired with their branch when a run is merged.
- **Prepare starts the run itself** through a one-shot task deleted `upgradeTaskCleanupSeconds` later, instead of leaving an unsent draft.
- **Delivery is bounded:** a commit stages only the files the preview listed; a preparation that cannot register its workspace removes the worktree it created.
- **The panel gained** an Actions column, a per-row Stop for scheduled checks (`schedule.remove`), daily-cadence display, and localized Host warnings.
- **Release plumbing:** `npm run verify:pack` proves the tarball installs and composes, `docs/SECURITY.md` documents the machine footprint, `docs/RELEASE.md` the release steps, and CI runs the suite on node 22 and 24.
