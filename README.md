# dsh-upkeep

**English** · [简体中文](README.zh.md)

![Status](https://img.shields.io/badge/status-M0%20complete-blue)
![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.3-4b8bbe)
![License](https://img.shields.io/badge/license-MIT-green)

**The compatibility concierge for [DeepSeek Harness](https://www.deepseek.com/harness/) plugins.**

> DSH moves fast. A plugin that no longer declares a compatible version is not "a bit wrong" — DSH refuses to load it, the row ends up silently disabled, and the only trace is one line on stderr. Finding out *why*, then fixing it, is manual work every single release.
>
> `dsh-upkeep` closes that loop: it watches the plugins you maintain, tells you what broke before your users do, and turns a break into a targeted upgrade with verification and a pull request.

`dsh-upkeep` is a DSH plugin for plugin authors. It owns three things:

- **Compatibility monitoring** — keeps a watch list of your plugins and reports, per plugin, whether it satisfies the running DSH and the next DSH you are about to run.
- **One-click targeted upgrade** — matches the breaking changes that actually touch your plugin against DSH's migration guides, has a coding agent apply them in a dedicated session (optionally a git worktree), verifies the result, and opens a PR for you to review.
- **Scheduled upkeep** — creates a recurring compatibility check so a new DSH release is noticed without opening the app.

Two doors, one implementation: everything the panel can do is available to the agent as a tool, and everything the agent can do is visible in the panel.

## Status

| Capability | State |
|---|---|
| Fixed **Upkeep** panel in the sidebar (level with Plugins), plus a tab in **Settings → Plugins**, status snapshot, ownership and care verdicts, `upkeep_status` tool | **Shipped (M0)** |
| Compat watch list, declared/runtime/projected compatibility, history | In progress (M1) |
| Migration-guide matching and a per-plugin breakage report | Planned (M2) |
| One-click upgrade in a session or worktree, layered verification | Planned (M3) |
| Human-confirmed PR / merge delivery | Planned (M4) |
| Recurring checks through DSH's schedule service | Planned (M5) |
| Release hardening, cross-version matrix, npm publish | Planned (M6) |

The scope, decisions and acceptance criteria live in [docs/PLAN.md](docs/PLAN.md). This README describes only what is shipped today and what is explicitly planned.

## Install / update

### From the Plugins page

`dsh-upkeep` is not on the npm registry yet. Install it from a local checkout:

```sh
git clone https://github.com/sleep9ull/dsh-upkeep.git
cd dsh-upkeep
npm install
npm run build
```

Then open **Settings → Plugins → Add plugin** in the DSH web or desktop app, choose the checkout directory, and install. The bundle is linked, so it serves the built `dist/` — rebuild and restart the Host after changing Host code, and refresh the page after changing client code.

### With the `dsh` CLI

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-upkeep
```

Use the profile that runs your Web UI (`web` for an npm install, `desktop` for the desktop app). Restart the profile or let HMR reload it.

### Update

Pull the checkout, run `npm install && npm run build`, and reload. A future release will be installable from the registry by name.

## Usage

| Entry | What it does |
|---|---|
| **Upkeep panel** | A fixed icon in the left sidebar panel list, level with **Plugins** and **Automation tasks**. Click it to open the full page: the running DSH version, the current profile, the plugin-entry count, and every installed bundle with its version, state, owner and care verdict. **Refresh** re-reads it. |
| **Upkeep tab** | **Settings → Plugins → Upkeep** shows the same view for when you are already managing plugins; its header button jumps to the full panel. |
| **`upkeep_status` tool** | The agent reads the same snapshot in-session. Pass `action: "bundles.list"` for just the bundle list. Read-only: no installs, no edits, no network. |

### Upkeep panel

The panel answers one question first: **what is this installation actually running, and which plugins did it load?**

- The header shows the page title and gives you one button, **Refresh**.
- The summary block shows the running DSH version, the profile name, the number of live plugin entries, and how many bundles are installed.
- The bundle list is split into two visual groups: **My plugins** first (matched against your local identity), then **Other plugins** (other authors or unknown ownership). Each group has its own heading, count and empty state.
- The bundle table lists each bundle with its version, state (`enabled`, `disabled`, `load error`), **owner** (`Mine` / `Other author` / `Unknown`) and **care** (`Needs care` / `Healthy` / `Unknown`). Hovering a verdict shows the evidence behind it.
- Ownership is inferred, never assumed: the package scope, `author`, `repository`, and the git remote of a local checkout are matched against your identity — `ownerHandles` / `ownerEmails` in the plugin configuration, plus the `~/.gitconfig` name/email and the signed-in `gh` account. A plugin with no recognizable signal stays **Unknown**. The identity is whatever machine you run it on: another developer's installation resolves theirs, so the same plugin serves every author.
- The care verdict is computed only for **Mine**: a declared incompatibility with the running DSH, or a plugin row that failed to load, marks the plugin **Needs care**; otherwise it is **Healthy** (with declared-range evaluation arriving in M1).
- Official `@deepseek-ai/*` packages are part of DSH and never appear in the monitored list; the summary reports how many bundles and plugin entries were excluded, so nothing looks missing.
- Warnings appear inline when a fact could not be read, for example when the plugin-manager service is not mounted. An unreadable value is reported as unknown with its reason, never guessed.

### `upkeep_status` tool

The tool is the model-facing door to the same dispatcher the panel calls. Example: ask the agent *"which of my plugins failed to load?"* and it reads the same snapshot you see in the panel.

## How compatibility is decided (planned, M1)

DSH has exactly one official verdict, and Upkeep will copy it rather than invent one:

1. **Declared layer** — a plugin's own `engines.dsh` range decides alone; without it, every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer must match. Prereleases participate, and `workspace:^|~|*` means the running version. A mismatch is an exact-version exemption in the profile's `compatibility.json`, or it does not count as compatible.
2. **Runtime layer** — the entry's live fiber phase and diagnostic, which catch plugins that satisfy the range but fail to import or start.
3. **Historical layer** — Upkeep's own record of when a plugin stopped matching, which DSH does not keep.

Because the verdict is computed from your plugins' manifests and the running version, Upkeep can also answer the more useful question early: **will this plugin still load on the next DSH?** That projection is what turns a release-day surprise into a task you can schedule.

## One-click upgrade (planned, M3–M4)

The upgrade is deliberately boring and reviewable:

1. **Match** — scan the plugin's manifest, bundle patch, imports, services, events, tools, slots and persisted data, then select the migration-guide items that actually mention those surfaces.
2. **Plan** — hand the matched `Change` / `Migration` text to a coding agent as a bounded task, with the files, the acceptance command and the stop conditions.
3. **Edit** — the agent works in a dedicated DSH session rooted at your repository, or in a fresh git worktree when you ask for isolation. You can watch, steer and interrupt.
4. **Verify** — layered checks: manifest re-evaluation, the repository's own check/test commands, a composed-profile admission check, and optionally a headless boot of a throwaway profile.
5. **Deliver** — you review the diff and the verification report, then Upkeep opens a PR (default) or merges, on your confirmation. Nothing is pushed or merged unattended.

## Scheduled upkeep (planned, M5)

Upkeep will create a DSH scheduled task on your behalf — daily, weekly, or cron — that runs the check and reports back. When a monitored plugin drops out of compatibility, the task can either notify you or start the upgrade flow, with delivery still behind your confirmation.

## Configuration

The Loader row accepts the following configuration (defaults shown):

| Field | Default | Meaning |
|---|---|---|
| `targetChannel` | `auto` | Which DSH release channel the monitor compares against. `auto` follows the desktop app's update channel. |
| `checkOnStartup` | `true` | Whether a compatibility check runs when the Host starts. |
| `concurrency` | `2` | How many watched plugins one check may inspect at a time (clamped to 1–8). |
| `worktreeRoot` | `""` | Directory under which upgrade worktrees are created; empty means beside the repository. |
| `ownerHandles` | `""` | Comma-separated account handles that identify you (npm scope / GitHub login). Empty means auto-detect. |
| `ownerEmails` | `""` | Comma-separated author emails that identify you, matched against a plugin's `author`. |
| `autoDetectOwner` | `true` | Whether the `~/.gitconfig` name/email and the signed-in `gh` account may be used as identity. |

## Development

```sh
npm install
npm run verify   # type-check both halves, build, run the unit tests, syntax-check the client script
```

| Command | Purpose |
|---|---|
| `npm run build` | Compile the Host half and the client script into `dist/`. |
| `npm run check` | Type-check without emitting. |
| `npm test` | Build, compile the tests, run them against `dist/`, then `node --check dist/client.js`. |
| `npm run verify` | `check` + `test`. |

Before installing into a running profile, rebuild: a linked install serves `dist/`. `docs/PLAN.md` holds the architecture and milestones; `docs/EVIDENCE.md` holds the verified DSH facts this plugin is built on; `AGENTS.md` holds the engineering contract for contributors and agents.

## Notes and limitations

- **M0 is read-only.** It reads versions, profile state and bundle state. It installs nothing, edits nothing and makes no network requests.
- **Compatibility verdicts are not implemented yet.** The Upkeep panel reports the load error DSH already recorded; deriving declared/runtime/projected compatibility arrives with M1.
- **The client half is a separate load.** After changing `src/client.ts`, refresh the page; after changing Host code, restart the Harness so the module generation is replaced.
- **A linked checkout serves `dist/`.** Run `npm run build` before installing or reloading, otherwise the new code will not appear.
- **Ownership is inference, not an account system.** It reads package metadata and the git remote of local checkouts; when those do not identify you, the plugin stays `Unknown` and you can set `ownerHandles` explicitly. No repository is contacted to verify authorship.
- **No push from the Host.** DSH does not push to the browser. The panel reads on open and on demand, which is a deliberate design choice, not a missing refresh.
- **Version support.** Verified on DSH `0.2.2-rc.3`; the declared range is `>=0.2.2-rc.1 <0.3.0`. DSH is in a release-candidate cycle, so the range is a promise about the surface this plugin uses, not a claim about every build.

## Like it?

If `dsh-upkeep` saves you a release-day scramble, a ⭐ on [GitHub](https://github.com/sleep9ull/dsh-upkeep) is welcome — issues and PRs too.

## License

[MIT](LICENSE)
