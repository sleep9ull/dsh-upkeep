# dsh-upkeep

**English** · [简体中文](README.zh.md)

![Version](https://img.shields.io/badge/version-0.1.2-blue)
[![npm](https://img.shields.io/npm/v/@sleep9ull/dsh-upkeep?label=npm)](https://www.npmjs.com/package/@sleep9ull/dsh-upkeep)
![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.3-4b8bbe)
![License](https://img.shields.io/badge/license-MIT-green)

> **Status: `0.1.2`, early release.** The package is published as **`@sleep9ull/dsh-upkeep`**:
> `dsh plugin --profile <name> add @sleep9ull/dsh-upkeep`.
> Verified end to end on **DSH `0.2.2-rc.3` on macOS**, in English and Chinese:
> monitoring, upgrade preparation and its session, verification, the pull-request
> step, and scheduled checks.

**The compatibility concierge for [DeepSeek Harness](https://www.deepseek.com/harness/) plugins.**

> DSH moves fast. A plugin that no longer declares a compatible version is not "a bit wrong" — DSH refuses to load it, the row ends up silently disabled, and the only trace is one line on stderr. Finding out *why*, then fixing it, is manual work every single release.
>
> `dsh-upkeep` closes that loop: it watches the plugins you maintain, tells you what broke before your users do, and turns a break into a targeted upgrade, verification, and a pull request you approve.

`dsh-upkeep` is a DeepSeek Harness plugin for plugin authors. It knows which installed plugins are *yours*, whether they still work on the DSH you run today and the one you are about to upgrade to, and what to change when they do not.

## Features

- **Compatibility monitoring** — knows the running DSH and the next DSH (read from the npm registry, channel-aware), and evaluates every plugin you own against both. A new release that will break your plugin is visible before you install it, not after.
- **Migration reports** — reads DSH's own upgrade guides, scans what each plugin actually uses (packages, services, events, tools, commands, slots, patch rows, config keys), and lists only the breaking changes that mention those surfaces — with the original Change and Migration text and the evidence behind every match.
- **One-click targeted upgrade** — prepares a bounded task from the matched changes, optionally in a fresh git worktree, and opens a session with that prompt. The agent edits; you watch, steer and interrupt. A **Verify** button then runs the plugin's own check/test commands in that workspace and reports each result.
- **Human-confirmed delivery** — commits, pushes and opens the pull request (or merges, when you allow it) only after explicit confirmation, with each step's failure recorded instead of hidden. PRs are the default; merging is an explicit opt-in.
- **Scheduled upkeep** — creates a recurring DSH task that refreshes the target version, runs the check and reports what needs care. It never edits repositories on its own.
- **Ownership, not guesswork** — "mine / other / unknown" is decided from evidence (package scope, author, repository, local checkout, git remote) matched against your machine's identity — configuration, `~/.gitconfig` and the signed-in `gh` account. Official `@deepseek-ai/*` packages are excluded and reported, never silently mixed in.

Everything the panel does is also available to the agent through the `upkeep_status` tool, and every result can be traced back to evidence: a manifest, a live row state, or a migration-guide item.

## Install / update

**Recommended: install from the app.** Open **Settings → Plugins → Add plugin**, enter

```
@sleep9ull/dsh-upkeep
```

and install. The plugin ships a Host half and a Web half, so the panel appears in the sidebar right after installation; reload the page if it does not.

The same thing from the CLI, into the profile that runs your UI (`web` for an npm install, `desktop` for the desktop app):

```sh
dsh plugin --profile desktop add @sleep9ull/dsh-upkeep
```

Updating is the same command again, or **Plugins → Update** in the app.

### Installing from a checkout (development)

```sh
git clone https://github.com/sleep9ull/dsh-upkeep.git
cd dsh-upkeep
npm install
npm run build
```

Then **Settings → Plugins → Add plugin** with the checkout directory, or `dsh plugin --profile <profile> add /absolute/path/to/dsh-upkeep`. The bundle is linked, so it serves the built `dist/`: rebuild and restart the Host after Host changes, refresh the page after client changes.

## Usage

| Entry | What it does |
|---|---|
| **Upkeep panel** | A fixed icon in the left sidebar panel list, level with **Plugins** and **Automation tasks**. One sentence at the top answers the maintenance question; below it is a ledger of every monitored plugin — its version, one status column (Healthy / Needs care / Unknown, or the live state for other authors' plugins), and, for your own plugins, a Scheduled column that either offers **Create** or shows how often that plugin is already checked, plus an Actions column holding the **Upgrade** button so the status column stays a status. The live enabled flag, entry count, install spec and compatibility requirements live in the row tooltip. The sidebar entry gains a parenthetical count whenever something needs care — `Upkeep (2 need care)` — and stays bare while everything is healthy. |
| **Settings → Plugins → Upkeep** | The same view from the plugin manager page, with a shortcut to the full panel. |
| **`upkeep_status` tool** | What the model sees: the same snapshot, plus `check`, `bundles.list` and `report.get` actions for the matched migration items. |
| **Refresh** | The one button: re-reads the plugins, evaluates them against the running and target release, re-matches the migration guides, and stores one report. A cached target younger than `feedTtlMinutes` is reused, so a click does not always mean a registry round trip; the agent tool can pass `force` when it really wants a fresh answer. |
| **Upgrade** | Appears only on your plugins that need care (never on a healthy row, even when the migration report matched something): a small dialog confirms it and carries the "edit in a separate git worktree" choice, then a session opens with the prepared prompt. |
| **Verify / Create PR / Merge** | After the agent's edits: run the verification commands, then open a pull request, and merge only when enabled. |
| **Scheduled** (per row) | A **Create** button on a row with no recurring check opens a small dialog with a time picker seeded with 08:00 local (adjustable, saved with your IANA zone) and creates a daily check for that single plugin; once it exists the cell reads as a time of day plus a cadence — `8:00am everyday`, `9:30am every 6 hours` — with the task name and next run in its tooltip. One plugin per click. |

## How compatibility is decided

DSH has exactly one official verdict, and Upkeep reproduces it rather than inventing one:

1. **Declared layer** — a plugin's own `engines.dsh` range decides alone; without it, every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer must match. Prereleases participate, and `workspace:^|~|*` means the running version. A mismatch is an exact-version exemption in the profile's `compatibility.json`, or it does not count as compatible.
2. **Runtime layer** — the live fiber phase of each plugin row, which catches plugins that satisfy the range but fail to import or start.
3. **Projection layer** — the same declared check against the next DSH. This is the part DSH itself cannot do before you upgrade.

An unreadable manifest or an unavailable service is reported as **unknown with its reason**, never as compatible. The target version comes from the npm registry with the desktop channel mapped to its dist-tag and the highest published semver as fallback; the lagging `latest` tag is never trusted alone, and a cached answer is marked stale.

## Migration reports

A check reads DSH's shipped upgrade guides for the releases between the running and target DSH; when the target is newer than the installation, the missing guides are fetched from the release tag. It then scans each of your plugins for the surfaces it really uses and matches guide text on identifier boundaries, with the package/service/event/tool/slot evidence attached to every hit.

The panel shows the count on the row tooltip; `report.get` returns the matched items with their `Change` and `Migration` sections. When nothing matches mechanically, Upkeep says so instead of pretending the plugin is clean.

## Upgrades and delivery

**Upgrade** prepares the workspace (the checkout itself, or a `git worktree` if you ask for isolation) and starts a session whose prompt fences the work: change code **only** where the DSH version change forces it, and never fix anything else it happens to notice. The agent edits; you stay in control. The preparation notice reports the Host's warnings as well — an uncommitted checkout, a worktree started from HEAD, or a guide fetch that had to fall back.

**Verify** runs the configured commands (default: the package's `check` and `test` scripts, falling back to `build`) in that workspace and records each exit code. **Create PR** commits, pushes and opens the pull request with `gh`; **Merge** only appears when `allowMerge` is enabled, and still asks each time. Failed steps record their error on the run — no silent success.

## Scheduled upkeep

Each plugin can watch itself: press **Create** in its Scheduled cell to make a recurring task (default every 24 hours, `scheduleIntervalHours`) through DSH's own schedule service, delivering a prompt that checks that one plugin. The cell then reads as a time of day plus how often (`8:00am everyday`), and its tooltip carries the task name and the next run. Pausing a task on the Automation tasks page brings **Create** back. Each delivery starts a session with a **launcher** prompt that only tells the agent to call `upkeep_status` with `action: "check"` and then follow the `brief` block of its result. The policy — what to report, how to grade out-of-scope findings, what is forbidden — ships with the installed plugin, so upgrading dsh-upkeep changes what an existing task does without touching your task. A task whose prompt you rewrote yourself is left alone. Stored launchers are brought forward at Host startup and at the head of every check, so an upgrade reaches existing tasks even if the panel is never opened. The task never edits repositories; upgrades remain behind the panel's buttons. Manage or pause it on DSH's **Automation tasks** page.

## Configuration

The Loader row accepts the following configuration (defaults shown):

| Field | Default | Meaning |
|---|---|---|
| `targetChannel` | `auto` | Release channel compared against; `auto` follows the desktop app's update channel. |
| `targetVersion` | `""` | Exact target version; empty asks the registry. |
| `feedTtlMinutes` | `60` | How long a cached registry answer stays fresh. |
| `checkOnStartup` | `true` | Whether a check runs shortly after the Host starts. |
| `checksToKeep` | `20` | How many check reports to retain. |
| `analyzeOnCheck` | `true` | Whether a check also matches the migration guides. |
| `concurrency` | `2` | How many plugins one check inspects at a time (1–8). |
| `verifyCommands` | `[]` | Commands used by Verify, run with `sh -c` in the workspace (they carry your shell rights); empty derives them from package scripts. |
| `runsToKeep` | `10` | How many upgrade runs to retain. |
| `ignoreWorktrees` | `true` | Add `.worktrees/` to this clone's `.git/info/exclude`; turn it off to leave the clone untouched (the panel then warns). |
| `worktreesToKeep` | `5` | How many upgrade worktrees to keep per repository; older ones and their `upkeep/*` branches are removed when a new one is prepared. `0` keeps all. |
| `worktreeRoot` | `""` | Where worktrees are created; empty means `<repo>/.worktrees/upkeep/<run>` inside the checkout, whose path is added to the clone's `.git/info/exclude`. |
| `defaultBaseBranch` | `main` | Branch previews compare against and PRs target. |
| `allowMerge` | `false` | Whether Merge is offered at all; every merge still asks. |
| `ownerHandles` | `""` | Account handles that identify you; empty auto-detects. |
| `ownerEmails` | `""` | Author emails that identify you. |
| `autoDetectOwner` | `true` | Use `~/.gitconfig` and the `gh` login as identity. |
| `scheduleCwd` | `""` | Project directory for a scheduled check's session; empty uses `$DSH_HOME`. |
| `scheduleIntervalHours` | `24` | Default interval for a created check (1–720). |

## Development

```sh
npm install
npm run verify       # repository checkout
npm run verify:pack  # the tarball npm would publish, installed into a throwaway profile
npm run verify       # type-check both halves, build, every test, and a headless render of the panel
npm run verify:full  # everything above + package metadata + profile check + real registry read
```

`docs/PLAN.md` holds the design and decisions, `docs/EVIDENCE.md` the verified DSH facts this plugin is built on, and `AGENTS.md` the engineering contract. State lives in `$DSH_HOME/upkeep/state.json` (versioned, atomic, bounded; losing it costs a re-check, never behaviour).

## What it touches on your machine

Upkeep reads your installed plugins, and on request prepares an upgrade of one repository you own. It talks to the npm registry and GitHub for metadata, writes `$DSH_HOME/upkeep/state.json`, creates `<repo>/.worktrees/upkeep/<run>` for isolated upgrades, and runs `git`/`gh` plus your configured verification commands. It never edits your source and never commits or pushes without your confirmation. The full list, including how to uninstall cleanly, is in [docs/SECURITY.md](docs/SECURITY.md); releasing is documented in [docs/RELEASE.md](docs/RELEASE.md).

Host warnings are translated too: the panel sends its language with every request, so a Chinese panel reads Chinese warnings instead of English ones.

## Notes and limitations

- **macOS first.** Developed and verified there; the Host half is plain Node and should behave the same on Linux, but Windows is not supported (`verifyCommands` run through `sh -c`).
- **DSH internals move.** The plugin reads DSH's own services (schedules, workspaces, plugins) and pins `engines.dsh` to the release it was tested against. A DSH upgrade is a dogfooding event: re-run `npm run verify`, then walk the install checklist.
- **Two languages.** The panel and Host warnings speak English and Chinese; other DSH languages fall back to English.
- **Your own plugins only.** Official `@deepseek-ai/*` packages are excluded by design, and other authors' plugins are diagnosed, never upgraded.
- **The upgrade itself is an agent in a session.** The prompt fences it to DSH-compatibility changes and forbids fixing anything else, but watching the session and reading the diff before Verify → Create PR remains your job.



- **Verified on DSH `0.2.2-rc.3`**, and the declared range says exactly that: `>=0.2.2-rc.3 <0.3.0`. Earlier prereleases are not claimed — they were never tested, and the internal surfaces this plugin reads do change between them.
- **The PR path needs the host `gh` CLI signed in**; merging needs `allowMerge` and a fresh confirmation. Nothing is pushed unattended.
- **A linked checkout serves `dist/`.** Build before installing or reloading; Host changes need a Harness restart, client changes only a page refresh.
- **A worktree starts from HEAD.** Uncommitted changes are not copied; the panel warns when the repository is dirty. Merging a run retires its worktree and branch.
- **`git clean -xdf` deletes the worktrees.** They live inside the checkout under `.worktrees/`, which is only *ignored*, not protected.
- **Build tools should skip `.worktrees`.** Watchers that ignore `.gitignore` (some bundlers, `tsc --watch`) will otherwise scan the nested checkout; add it to their exclude list.
- **Remote guide fetching needs network.** Without it, only the installed guides are used and the failure is reported, never hidden.
- **Not published to npm yet.** Installation is from a local checkout as described above.
- **Desktop owns its running profile.** While the app is open, the CLI cannot compose `--profile desktop`; the full-test script reports that step as skipped rather than passing silently.
- **No background push.** DSH does not push to the browser; the panel reads on open and on demand, and scheduled checks appear as sessions.

## License

[MIT](LICENSE)
