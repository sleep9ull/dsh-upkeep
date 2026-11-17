import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  buildUpgradePrompt,
  deriveVerifyCommands,
  inspectRepository,
  prepareWorkspace,
  verifyWorkspace,
} from '../dist/host/upgrade.js'
import type { CommandResult, ExecRunner } from '../dist/host/exec.js'

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...overrides }
}

function fakeExec(answer: (command: string, args: string[]) => CommandResult): ExecRunner {
  return { run: async (command, args) => answer(command, args) }
}

const match = {
  version: '0.2.2-rc.1',
  item: 'tools',
  description: 'Tools moved.',
  change: 'ctx.tools moved.',
  migration: 'Update the import.',
  matchedSurfaces: [{ kind: 'service' as const, value: 'tools' }],
  score: 2,
}

test('the prompt carries versions, matched changes, rules and commands', () => {
  const prompt = buildUpgradePrompt({
    bundle: '@sleep9ull/plugin',
    repoPath: '/repo',
    workspacePath: '/repo',
    from: '0.2.2-rc.3',
    to: '0.2.3-rc.1',
    matches: [match],
    verifyCommands: ['npm test'],
  })
  assert.match(prompt, /@sleep9ull\/plugin/)
  assert.match(prompt, /0\.2\.2-rc\.3 -> 0\.2\.3-rc\.1/)
  assert.match(prompt, /\[v0\.2\.2-rc\.1\] tools/)
  assert.match(prompt, /npm test/)
  assert.match(prompt, /do not refactor/)
  assert.ok(prompt.length < 12_001)
})

test('verification commands prefer config, then check/test scripts, then build', () => {
  assert.deepEqual(deriveVerifyCommands(['npm run lint'], {}), ['npm run lint'])
  assert.deepEqual(deriveVerifyCommands([], { scripts: { check: 'x', test: 'y' } }), ['npm run check', 'npm test'])
  assert.deepEqual(deriveVerifyCommands([], { scripts: { build: 'z' } }), ['npm run build'])
  assert.deepEqual(deriveVerifyCommands([], {}), ['npm run build'])
})

test('repository inspection reports the root and dirty count', async () => {
  const exec = fakeExec((command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') return result({ stdout: '/repo\n' })
    if (command === 'git' && args[0] === 'status') return result({ stdout: ' M a.ts\n?? b.ts\n' })
    return result({ exitCode: 1 })
  })
  assert.deepEqual(await inspectRepository(exec, '/repo/sub'), { repoRoot: '/repo', dirty: 2 })
  const notRepo = fakeExec(() => result({ exitCode: 128 }))
  assert.equal(await inspectRepository(notRepo, '/tmp'), undefined)
})

test('the checkout is used directly, or a worktree branch is created on request', async () => {
  const direct = await prepareWorkspace({ exec: fakeExec(() => result()), repoRoot: '/repo', worktree: false, worktreeRoot: '', bundle: '@a/p', stamp: 't1' })
  assert.equal(direct.workspacePath, '/repo')
  assert.equal(direct.worktree, false)

  const calls: string[][] = []
  const exec = fakeExec((command, args) => { calls.push([command, ...args]); return result() })
  const prepared = await prepareWorkspace({ exec, repoRoot: '/repo', worktree: true, worktreeRoot: '', bundle: '@sleep9ull/plugin', stamp: 't1' })
  assert.equal(prepared.worktree, true)
  assert.match(prepared.branch ?? '', /^upkeep\/sleep9ull-plugin-t1$/)
  assert.equal(prepared.workspacePath, '/repo/.worktrees/upkeep/t1')
  assert.ok(calls.some(call => call[1] === 'rev-parse' && call[2] === '--git-common-dir'), 'the ignore rule was checked')
  assert.ok(calls.some(call => call[1] === 'worktree' && call[2] === 'add'))

  const failing = fakeExec((command, args) => (args[0] === 'worktree' ? result({ exitCode: 1, stderr: 'boom' }) : result()))
  await assert.rejects(() => prepareWorkspace({ exec: failing, repoRoot: '/repo', worktree: true, worktreeRoot: '', bundle: 'p', stamp: 't2' }), /git worktree add failed/)
})

test('verification records each command and treats a non-zero exit as failure', async () => {
  const exec = fakeExec((command, args) => command === 'sh' && args[1] === 'npm run check'
    ? result({ stdout: 'check ok' })
    : result({ exitCode: 2, stderr: 'test failed' }))
  const results = await verifyWorkspace({ exec, workspacePath: '/repo', commands: ['npm run check', 'npm test'] })
  assert.equal(results.length, 2)
  assert.equal(results[0]?.ok, true)
  assert.equal(results[1]?.ok, false)
  assert.match(results[1]?.output ?? '', /test failed/)
})

test('the in-repo worktree directory is ignored once, through .git/info/exclude', async () => {
  const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { ensureWorktreeIgnored } = await import('../dist/host/upgrade.js')

  const root = mkdtempSync(join(tmpdir(), 'upkeep-exclude-'))
  const gitDir = join(root, '.git')
  mkdirSync(join(gitDir, 'info'), { recursive: true })
  writeFileSync(join(gitDir, 'info', 'exclude'), '# local ignores\n')

  const exec = { run: async () => ({ exitCode: 0, stdout: '.git\n', stderr: '', timedOut: false }) }
  assert.equal(await ensureWorktreeIgnored(exec, root), true)
  const text = readFileSync(join(gitDir, 'info', 'exclude'), 'utf8')
  assert.match(text, /^# local ignores\n\.worktrees\/\n$/)

  // A second run finds the rule and leaves the file alone.
  assert.equal(await ensureWorktreeIgnored(exec, root), false)
  assert.equal(readFileSync(join(gitDir, 'info', 'exclude'), 'utf8'), text)
})
