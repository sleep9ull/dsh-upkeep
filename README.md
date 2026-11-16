# dsh-upkeep

**English** · [简体中文](README.zh.md)

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.3-4b8bbe)
![License](https://img.shields.io/badge/license-MIT-green)

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

`dsh-upkeep` is not on the npm registry yet. Install from a local checkout:

```sh
git clone https://github.com/sleep9ull/dsh-upkeep.git
cd dsh-upkeep
npm install
npm run build
```

Then open **Settings → Plugins → Add plugin** in the DSH web or desktop app, choose the checkout directory, and install. The bundle is linked, so it serves the built `dist/` — rebuild and restart the Host after changing Host code, and refresh the page after changing client code.

With the `dsh` CLI:

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-upkeep
```

Use the profile that runs your Web UI (`web` for an npm install, `desktop` for the desktop app). Updating means pulling the checkout, `npm install && npm run build`, and reloading.

## Usage

| Entry | What it does |
|---|---|
| **Upkeep panel** | A fixed icon in the left sidebar panel list, level with **Plugins** and **Automation tasks**. One sentence at the top answers the maintenance question; below it is a ledger of every monitored plugin — its version and one status column (Healthy / Needs care / Unknown, or the live state for other authors' plugins). The live enabled flag, entry count, install spec and compatibility requirements live in the row tooltip. |
| **Settings → Plugins → Upkeep** | The same view from the plugin manager page, with a shortcut to the full panel. |
| **`upkeep_status` tool** | What the model sees: the same snapshot, plus `check`, `bundles.list` and `report.get` actions for the matched migration items. |
| **Check now** | Refreshes the target DSH version from the registry, evaluates every plugin against the running and target release, scans the guides, and stores one report. |
| **Upgrade** | Appears only on your plugins that need care (never on a healthy row, even when the migration report matched something): confirm, choose worktree or not, and a session opens with the prepared prompt. |
| **Verify / Create PR / Merge** | After the agent's edits: run the verification commands, then open a pull request, and merge only when enabled. |
| **Schedule check** | Creates a recurring compatibility check through DSH's schedule service. |

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

**Upgrade** prepares the workspace (the checkout itself, or a `git worktree` if you ask for isolation), registers it, and opens a session with a prompt that names the exact changes, the files and the verification commands. The agent edits; you stay in control. The preparation notice reports the Host's warnings as well — an uncommitted checkout, a worktree started from HEAD, or a guide fetch that had to fall back.

**Verify** runs the configured commands (default: the package's `check` and `test` scripts, falling back to `build`) in that workspace and records each exit code. **Create PR** commits, pushes and opens the pull request with `gh`; **Merge** only appears when `allowMerge` is enabled, and still asks each time. Failed steps record their error on the run — no silent success.

## Scheduled upkeep

**Schedule check** creates a recurring task (default every 24 hours) through DSH's own schedule service. Each delivery starts a session with a prompt that refreshes the target, runs the check and reports which of your plugins need care and which migration items matched. The task never edits repositories; upgrades remain behind the panel's buttons. Manage or pause it on DSH's **Automation tasks** page.

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
| `verifyCommands` | `[]` | Commands used by Verify; empty derives them from package scripts. |
| `runsToKeep` | `10` | How many upgrade runs to retain. |
| `worktreeRoot` | `""` | Where worktrees are created; empty means beside the repository. |
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
npm run verify       # type-check both halves, build, unit tests, client syntax check
npm run verify:full  # everything above + package metadata + profile check + real registry read
```

`docs/PLAN.md` holds the design and decisions, `docs/EVIDENCE.md` the verified DSH facts this plugin is built on, and `AGENTS.md` the engineering contract. State lives in `$DSH_HOME/upkeep/state.json` (versioned, atomic, bounded; losing it costs a re-check, never behaviour).

## Notes and limitations

- **Verified on DSH `0.2.2-rc.3`**, declared range `>=0.2.2-rc.1 <0.3.0`.
- **The PR path needs the host `gh` CLI signed in**; merging needs `allowMerge` and a fresh confirmation. Nothing is pushed unattended.
- **A linked checkout serves `dist/`.** Build before installing or reloading; Host changes need a Harness restart, client changes only a page refresh.
- **A worktree starts from HEAD.** Uncommitted changes are not copied; the panel warns when the repository is dirty.
- **Remote guide fetching needs network.** Without it, only the installed guides are used and the failure is reported, never hidden.
- **Not published to npm yet.** Installation is from a local checkout as described above.
- **Desktop owns its running profile.** While the app is open, the CLI cannot compose `--profile desktop`; the full-test script reports that step as skipped rather than passing silently.
- **No background push.** DSH does not push to the browser; the panel reads on open and on demand, and scheduled checks appear as sessions.

## License

[MIT](LICENSE)
