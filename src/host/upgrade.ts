/**
 * The upgrade loop's Host half: turn a matched report into a bounded task prompt,
 * prepare a workspace (optionally a git worktree), and verify the result without
 * trusting the model. Nothing here edits source files: the agent does that in a
 * Session, so approvals, interruption and the session log apply.
 */

import { basename, join } from 'node:path'

import type { GuideMatch } from './match.js'
import type { ExecRunner } from './exec.js'

/** What the prepared run was built from. */
export interface UpgradePlan {
  bundle: string
  repoPath: string
  workspacePath: string
  worktree: boolean
  branch?: string
  from: string | null
  to: string | null
  matches: GuideMatch[]
  verifyCommands: string[]
}

/** The persisted run record. */
export interface UpgradeRunRecord {
  id: string
  bundle: string
  status: 'prepared' | 'verified' | 'failed'
  createdAt: number
  workspacePath: string
  workspaceId: string
  worktree: boolean
  branch?: string
  prompt: string
  verifyCommands: string[]
  verify?: Array<{ command: string; exitCode: number | null; ok: boolean; output: string }>
}

/** One verification result. */
export interface VerifyResult {
  command: string
  exitCode: number | null
  ok: boolean
  output: string
}

/** Compose the agent-facing task prompt from the mechanical report. */
export function buildUpgradePrompt(input: {
  bundle: string
  repoPath: string
  workspacePath: string
  from: string | null
  to: string | null
  matches: GuideMatch[]
  verifyCommands: string[]
}): string {
  const lines: string[] = []
  lines.push(`Adapt the DeepSeek Harness plugin \`${input.bundle}\` to the target DSH release.`)
  lines.push('')
  lines.push(`- Repository: ${input.repoPath}`)
  lines.push(`- Work in this directory: ${input.workspacePath}`)
  lines.push(`- DSH range: ${input.from ?? 'installed history'} -> ${input.to ?? 'unknown target'}`)
  lines.push('')
  lines.push('Breaking changes that mention surfaces this plugin uses:')
  if (input.matches.length === 0) {
    lines.push('- (none matched mechanically; inspect the plugin manifest and the upgrade guide yourself)')
  }
  for (const match of input.matches.slice(0, 10)) {
    lines.push(`- [v${match.version}] ${match.item}: ${match.description}`)
    if (match.change !== '') lines.push(`  Change: ${match.change.replace(/\s+/g, ' ').slice(0, 600)}`)
    if (match.migration !== '') lines.push(`  Migration: ${match.migration.replace(/\s+/g, ' ').slice(0, 900)}`)
    lines.push(`  Matched surfaces: ${match.matchedSurfaces.map(hit => hit.value).join(', ')}`)
  }
  lines.push('')
  lines.push('Rules:')
  lines.push('- Change only what the listed migrations require; do not refactor or reformat unrelated code.')
  lines.push('- Update the plugin manifest (`engines.dsh` / DSH peers) only when the code now supports the new range.')
  lines.push('- Do not run git push, publish, or modify the installed profile.')
  lines.push('- Finish by running the verification commands below and reporting their outcome.')
  lines.push('')
  lines.push('Verification commands:')
  for (const command of input.verifyCommands) lines.push(`- ${command}`)
  return lines.join('\n').slice(0, 12_000)
}

/** Derive the verification commands: explicit config first, then package scripts. */
export function deriveVerifyCommands(
  configured: string[],
  manifest: Record<string, unknown> | undefined,
): string[] {
  if (configured.length > 0) return configured.slice(0, 6)
  const scripts = manifest !== undefined && typeof manifest.scripts === 'object' && manifest.scripts !== null
    ? manifest.scripts as Record<string, unknown>
    : {}
  const commands: string[] = []
  if (typeof scripts.check === 'string') commands.push('npm run check')
  if (typeof scripts.test === 'string') commands.push('npm test')
  if (commands.length === 0) commands.push('npm run build')
  return commands.slice(0, 4)
}

/** Whether a path is the root of a git work tree, and the dirty file count. */
export async function inspectRepository(exec: ExecRunner, path: string): Promise<{ repoRoot: string; dirty: number } | undefined> {
  const root = await exec.run('git', ['rev-parse', '--show-toplevel'], { cwd: path, timeoutMs: 30_000 })
  if (root.exitCode !== 0) return undefined
  const status = await exec.run('git', ['status', '--porcelain'], { cwd: root.stdout.trim(), timeoutMs: 30_000 })
  const dirty = status.stdout.split('\n').filter(line => line.trim() !== '').length
  return { repoRoot: root.stdout.trim(), dirty }
}

/**
 * Prepare the workspace the agent will edit.
 * @returns the workspace path, and the branch when a worktree was created.
 */
export async function prepareWorkspace(input: {
  exec: ExecRunner
  repoRoot: string
  worktree: boolean
  worktreeRoot: string
  bundle: string
  stamp: string
}): Promise<{ workspacePath: string; worktree: boolean; branch?: string; warnings: string[] }> {
  const warnings: string[] = []
  if (!input.worktree) return { workspacePath: input.repoRoot, worktree: false, warnings }
  const safe = input.bundle.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'plugin'
  const branch = `upkeep/${safe}-${input.stamp}`
  const parent = input.worktreeRoot.trim() === '' ? `${input.repoRoot}-upkeep` : input.worktreeRoot
  const workspacePath = join(parent, `${basename(input.repoRoot)}-${input.stamp}`)
  const added = await input.exec.run('git', ['worktree', 'add', '-b', branch, workspacePath, 'HEAD'], {
    cwd: input.repoRoot,
    timeoutMs: 120_000,
  })
  if (added.exitCode !== 0) {
    throw new Error(`git worktree add failed: ${added.stderr.trim() || added.stdout.trim() || 'unknown error'}`)
  }
  warnings.push('The worktree starts from HEAD; uncommitted changes were not copied.')
  return { workspacePath, worktree: true, branch, warnings }
}

/**
 * Run the verification commands in the prepared workspace.
 * @returns one bounded result per command; a non-zero exit or timeout is a failure.
 */
export async function verifyWorkspace(input: {
  exec: ExecRunner
  workspacePath: string
  commands: string[]
  timeoutMs?: number
}): Promise<VerifyResult[]> {
  const results: VerifyResult[] = []
  for (const command of input.commands) {
    const run = await input.exec.run('sh', ['-c', command], {
      cwd: input.workspacePath,
      timeoutMs: input.timeoutMs ?? 600_000,
    })
    const output = [run.stdout, run.stderr].filter(part => part.trim() !== '').join('\n').slice(-2_000)
    results.push({ command, exitCode: run.exitCode, ok: run.exitCode === 0 && !run.timedOut, output })
  }
  return results
}
