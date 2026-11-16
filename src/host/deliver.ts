/**
 * Delivery: turn a verified upgrade run into a commit, a pushed branch and a
 * pull request — every step gated by the caller's explicit confirmation.
 *
 * `ctx.forge` cannot create a pull request (it only tracks and merges existing
 * ones) and the forge rows are not mounted by default, so creation goes through
 * the host `gh` CLI. The Host half keeps every command bounded and never shells
 * out through a string.
 */

import type { ExecRunner } from './exec.js'

/** What the delivery panel needs to know before it offers a button. */
export interface DeliveryPreview {
  workspacePath: string
  branch: string | null
  base: string
  dirty: number
  ahead: number
  diffStat: string
  gh: { available: boolean; authed: boolean; remote: string | null }
  warnings: string[]
}

/** One commit attempt. */
export interface CommitOutcome {
  committed: boolean
  sha?: string
  output: string
}

/** Run one git command. */
async function git(exec: ExecRunner, cwd: string, args: string[], timeoutMs = 60_000) {
  return await exec.run('git', args, { cwd, timeoutMs })
}

/** Read the branch/working-tree/gh facts behind the delivery buttons. */
export async function readDeliveryPreview(exec: ExecRunner, workspacePath: string, base: string): Promise<DeliveryPreview> {
  const warnings: string[] = []
  const branchResult = await git(exec, workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null
  if (branch === null) warnings.push('The workspace is not on a git branch.')

  const status = await git(exec, workspacePath, ['status', '--porcelain'])
  const dirty = status.stdout.split('\n').filter(line => line.trim() !== '').length

  let ahead = 0
  const aheadResult = await git(exec, workspacePath, ['rev-list', '--count', `${base}..HEAD`])
  if (aheadResult.exitCode === 0) ahead = Number(aheadResult.stdout.trim()) || 0
  else warnings.push(`The base branch "${base}" is not available locally.`)

  let diffStat = ''
  const diff = await git(exec, workspacePath, ['diff', '--stat', `${base}...HEAD`])
  if (diff.exitCode === 0) diffStat = diff.stdout.trim()
  if (diffStat === '' && ahead > 0) {
    const single = await git(exec, workspacePath, ['show', '--stat', '--oneline', 'HEAD'])
    if (single.exitCode === 0) diffStat = single.stdout.trim()
  }

  const ghVersion = await exec.run('gh', ['--version'], { cwd: workspacePath, timeoutMs: 15_000 })
  const ghAvailable = ghVersion.exitCode === 0
  const ghAuth = ghAvailable ? await exec.run('gh', ['auth', 'status'], { cwd: workspacePath, timeoutMs: 20_000 }) : undefined
  const remoteResult = await git(exec, workspacePath, ['remote', 'get-url', 'origin'])
  const remote = remoteResult.exitCode === 0 ? remoteResult.stdout.trim() : null
  if (ghAvailable && ghAuth !== undefined && ghAuth.exitCode !== 0) warnings.push('The gh CLI is installed but not signed in.')

  return { workspacePath, branch, base, dirty, ahead, diffStat, gh: { available: ghAvailable, authed: ghAuth?.exitCode === 0, remote }, warnings }
}

/** Stage every change and commit it; a clean tree is not an error. */
export async function commitWorkspace(exec: ExecRunner, workspacePath: string, message: string): Promise<CommitOutcome> {
  const add = await git(exec, workspacePath, ['add', '-A'])
  if (add.exitCode !== 0) return { committed: false, output: (add.stderr || add.stdout).trim() }
  const commit = await git(exec, workspacePath, ['commit', '-m', message])
  if (commit.exitCode !== 0) {
    const output = (commit.stdout + '\n' + commit.stderr).trim()
    if (/nothing to commit|no changes added/i.test(output)) return { committed: false, output }
    return { committed: false, output }
  }
  const sha = await git(exec, workspacePath, ['rev-parse', '--short', 'HEAD'])
  return { committed: true, ...(sha.exitCode === 0 ? { sha: sha.stdout.trim() } : {}), output: (commit.stdout || commit.stderr).trim() }
}

/** Push the branch to origin (setting upstream when needed). */
export async function pushBranch(exec: ExecRunner, workspacePath: string, branch: string): Promise<{ ok: boolean; output: string }> {
  const push = await git(exec, workspacePath, ['push', '-u', 'origin', branch], 120_000)
  return { ok: push.exitCode === 0, output: (push.stdout + '\n' + push.stderr).trim() }
}

/** Extract a pull-request URL from gh output. */
export function pullRequestUrl(output: string): string | undefined {
  return /https?:\/\/\S+\/pull\/\d+/.exec(output)?.[0]
}

/** Create a pull request with gh; an existing one is reported by its URL. */
export async function createPullRequest(
  exec: ExecRunner,
  workspacePath: string,
  request: { base: string; branch: string; title: string; body: string },
): Promise<{ ok: boolean; url?: string; output: string }> {
  const created = await exec.run('gh', [
    'pr', 'create',
    '--base', request.base,
    '--head', request.branch,
    '--title', request.title,
    '--body', request.body,
  ], { cwd: workspacePath, timeoutMs: 120_000 })
  const output = (created.stdout + '\n' + created.stderr).trim()
  const url = pullRequestUrl(output)
  if (created.exitCode === 0 && url !== undefined) return { ok: true, url, output }
  if (/already exists/i.test(output)) {
    const view = await exec.run('gh', ['pr', 'view', '--json', 'url', '--jq', '.url'], { cwd: workspacePath, timeoutMs: 60_000 })
    const existing = pullRequestUrl(view.stdout)
    if (view.exitCode === 0 && existing !== undefined) return { ok: true, url: existing, output }
  }
  return { ok: false, output }
}

/** Merge an existing pull request; the caller has already confirmed and allowed it. */
export async function mergePullRequest(
  exec: ExecRunner,
  workspacePath: string,
  request: { ref: string; method: 'merge' | 'squash' },
): Promise<{ ok: boolean; output: string }> {
  const merged = await exec.run('gh', ['pr', 'merge', request.ref, request.method === 'squash' ? '--squash' : '--merge'], {
    cwd: workspacePath,
    timeoutMs: 180_000,
  })
  return { ok: merged.exitCode === 0, output: (merged.stdout + '\n' + merged.stderr).trim() }
}

/** Remove a clean worktree; a dirty one is left in place and reported. */
export async function removeWorktree(exec: ExecRunner, repoRoot: string, path: string): Promise<{ ok: boolean; output: string }> {
  const removed = await git(exec, repoRoot, ['worktree', 'remove', path], 60_000)
  return { ok: removed.exitCode === 0, output: (removed.stdout + '\n' + removed.stderr).trim() }
}

/** Compose the commit message and pull-request text for one run. */
export function buildDeliveryText(input: {
  bundle: string
  from: string | null
  to: string | null
  matched: number
}): { commitMessage: string; prTitle: string; prBody: string } {
  const range = `${input.from ?? 'current DSH'} -> ${input.to ?? 'target DSH'}`
  const commitMessage = `chore(${input.bundle}): adapt to DSH ${input.to ?? 'target'}\n\nUpkeep matched ${input.matched} migration-guide item(s) for ${range}.`
  const prTitle = `chore(${input.bundle}): adapt to DSH ${input.to ?? 'target'}`
  const prBody = [
    `Adapts \`${input.bundle}\` to DeepSeek Harness ${input.to ?? 'target'} (range ${range}).`,
    '',
    `Matched migration-guide items: ${input.matched}.`,
    '',
    'Prepared and verified by dsh-upkeep. Review the diff before merging.',
  ].join('\n')
  return { commitMessage, prTitle, prBody }
}
