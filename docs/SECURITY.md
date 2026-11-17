# What dsh-upkeep can do to your machine

Upkeep reads your installed plugins and, when you ask it to, prepares an upgrade of
one repository you own. That crosses several trust boundaries, so this page states
exactly what it touches. It is written for the version in this checkout.

## Network

| When | What | Credentials |
|---|---|---|
| Check | Reads npm packument metadata for `@deepseek-ai/dsh` from `registry.npmjs.org`, falling back to `registry.npmmirror.com` | None |
| Check | Fetches upgrade-guide files from `raw.githubusercontent.com` / the GitHub contents API when the target release is newer than the installation | None |
| Delivery | Runs your local `gh` CLI, which uses whatever login it already has | Your `gh` session |

Nothing else leaves the machine. There is no telemetry, no analytics endpoint, and
no upload of repository contents.

## Local files it writes

| Path | Why | Removed when |
|---|---|---|
| `$DSH_HOME/upkeep/state.json` | Check history, target-version cache, upgrade runs | You delete the file (it is derived data; losing it costs one re-check) |
| `<your repo>/.worktrees/upkeep/<run>` | A `git worktree` for an upgrade, when you choose the isolated mode | When you merge the run, or when `worktreesToKeep` evicts it |
| `<your repo>/.git/info/exclude` | One line, `.worktrees/`, so the worktree does not show as untracked | You remove the line, or set `ignoreWorktrees: false` before any upgrade |
| The profile's `node_modules` | **Never written.** The installed copy is read-only input | — |

## Commands it runs

All commands are spawned with an argv array and a deadline; none go through a shell
except the verification commands you configure.

| Command | When |
|---|---|
| `git rev-parse`, `git status`, `git worktree add/remove/list`, `git add -A`, `git commit`, `git push`, `git branch -D` | Preparing an upgrade and delivering it |
| `gh pr create`, `gh pr merge`, `gh auth status`, `gh --version` | Creating and merging a pull request |
| `sh -c "<command>"` for each entry in `verifyCommands` | Verifying an upgrade |

`verifyCommands` is configuration you own, so it can run anything you can. Prefer
the defaults (the repository's own `check` / `test` scripts).

## Repository edits

Upkeep itself never edits your source. It creates a workspace (a checkout or a
`git worktree`) and starts a **session** whose prompt tells the agent to change only
what the DSH version requires. You watch that session, you press Verify, and you
press Create PR — nothing is committed or pushed without those actions.

`delivery.merge` is off unless you enable `allowMerge`, and every merge still asks
for confirmation.

## Scheduled tasks

A scheduled task stores a short launcher; the policy it follows comes from the
installed plugin version. Create or remove them in DSH's Automation tasks page, or
let Upkeep create them from the panel.

## Uninstall

1. Remove the scheduled tasks you created (DSH's Automation tasks page).
2. Remove the plugin from the profile (the Plugins page, or `dsh plugin --profile <name> remove @sleep9ull/dsh-upkeep`).
3. Optionally delete `$DSH_HOME/upkeep/` and any `<repo>/.worktrees/upkeep/` directories.
4. Optionally delete the `.worktrees/` line Upkeep added to `<repo>/.git/info/exclude`.

Nothing else is left behind: the plugin keeps no daemon, no service, and no data
outside the two locations above.
