import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  buildDeliveryText,
  commitWorkspace,
  createPullRequest,
  mergePullRequest,
  pullRequestUrl,
  readDeliveryPreview,
} from '../dist/host/deliver.js'
import type { CommandResult, ExecRunner } from '../dist/host/exec.js'

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...overrides }
}

function fakeExec(answer: (command: string, args: string[]) => CommandResult): ExecRunner {
  return { run: async (command, args) => answer(command, args) }
}

test('delivery preview reads branch, dirt, ahead, diff and gh state', async () => {
  const exec = fakeExec((command, args) => {
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return result({ stdout: 'upkeep/x\n' })
    if (command === 'git' && args[0] === 'status') return result({ stdout: ' M a.ts\n' })
    if (command === 'git' && args[0] === 'rev-list') return result({ stdout: '2\n' })
    if (command === 'git' && args[0] === 'diff') return result({ stdout: '1 file changed' })
    if (command === 'git' && args[0] === 'remote') return result({ stdout: 'git@github.com:o/r.git\n' })
    if (command === 'gh' && args[0] === '--version') return result({ stdout: 'gh 2.x' })
    if (command === 'gh' && args[0] === 'auth') return result()
    return result({ exitCode: 1 })
  })
  const preview = await readDeliveryPreview(exec, '/repo', 'main')
  assert.equal(preview.branch, 'upkeep/x')
  assert.equal(preview.dirty, 1)
  assert.equal(preview.ahead, 2)
  assert.equal(preview.diffStat, '1 file changed')
  assert.deepEqual(preview.gh, { available: true, authed: true, remote: 'git@github.com:o/r.git' })
})

test('a clean tree is not a commit, and a real commit reports its sha', async () => {
  const clean = fakeExec((command, args) => {
    if (command === 'git' && args[0] === 'commit') return result({ exitCode: 1, stdout: 'nothing to commit, working tree clean' })
    return result()
  })
  assert.deepEqual(await commitWorkspace(clean, '/repo', 'msg'), { committed: false, output: 'nothing to commit, working tree clean' })

  const committed = fakeExec((command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') return result({ stdout: 'abc1234\n' })
    return result()
  })
  const outcome = await commitWorkspace(committed, '/repo', 'msg')
  assert.equal(outcome.committed, true)
  assert.equal(outcome.sha, 'abc1234')
})

test('pull request creation extracts the URL and reuses an existing PR', async () => {
  assert.equal(pullRequestUrl('https://github.com/o/r/pull/9'), 'https://github.com/o/r/pull/9')
  const created = fakeExec(() => result({ stdout: 'https://github.com/o/r/pull/9\n' }))
  const made = await createPullRequest(created, '/repo', { base: 'main', branch: 'b', title: 't', body: 'b' })
  assert.deepEqual(made, { ok: true, url: 'https://github.com/o/r/pull/9', output: 'https://github.com/o/r/pull/9' })

  const existing = fakeExec((command, args) => {
    if (args[0] === 'pr' && args[1] === 'create') return result({ exitCode: 1, stderr: 'a pull request already exists for o:r' })
    if (args[0] === 'pr' && args[1] === 'view') return result({ stdout: 'https://github.com/o/r/pull/5\n' })
    return result({ exitCode: 1 })
  })
  const found = await createPullRequest(existing, '/repo', { base: 'main', branch: 'b', title: 't', body: 'b' })
  assert.equal(found.ok, true)
  assert.equal(found.url, 'https://github.com/o/r/pull/5')
})

test('merge uses the requested strategy and reports failure', async () => {
  const calls: string[][] = []
  const exec = fakeExec((command, args) => { calls.push([command, ...args]); return result() })
  const merged = await mergePullRequest(exec, '/repo', { ref: 'https://github.com/o/r/pull/9', method: 'squash' })
  assert.equal(merged.ok, true)
  assert.deepEqual(calls[0], ['gh', 'pr', 'merge', 'https://github.com/o/r/pull/9', '--squash'])
  const failing = fakeExec(() => result({ exitCode: 1, stderr: 'conflict' }))
  assert.equal((await mergePullRequest(failing, '/repo', { ref: 'x', method: 'merge' })).ok, false)
})

test('the delivery proposal names the plugin and the version range', () => {
  const proposal = buildDeliveryText({ bundle: '@sleep9ull/plugin', from: '0.2.2-rc.3', to: '0.2.3-rc.1', matched: 3 })
  assert.match(proposal.commitMessage, /chore\(@sleep9ull\/plugin\): adapt to DSH 0\.2\.3-rc\.1/)
  assert.match(proposal.prTitle, /adapt to DSH 0\.2\.3-rc\.1/)
  assert.match(proposal.prBody, /Matched migration-guide items: 3/)
})
