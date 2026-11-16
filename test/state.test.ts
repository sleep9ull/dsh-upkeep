import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { appendCheck, emptyState, lastCheckView, readState, statePath, writeState } from '../dist/host/state.js'
import type { StoredCheck } from '../dist/host/state.js'

function check(id: string, at: number): StoredCheck {
  return { id, at, runtimeVersion: '0.2.2-rc.3', targetVersion: '0.2.3-rc.1', total: 1, needsCare: 0, reports: [] }
}

test('state round-trips atomically and tolerates missing or broken files', () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-state-'))
  assert.deepEqual(readState(home), emptyState())
  const state = { ...emptyState(), feed: { fetchedAt: 1, targetVersion: '0.2.3-rc.1', channel: 'next' } }
  assert.equal(writeState(home, state), true)
  assert.deepEqual(readState(home), state)
  writeFileSync(statePath(home), '{ broken')
  assert.deepEqual(readState(home), emptyState())
})

test('checks are bounded and the newest is summarized first', () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-state-'))
  let state = emptyState()
  for (let index = 0; index < 5; index += 1) state = appendCheck(state, check('c' + index, index), 3)
  assert.deepEqual(readState(home).checks, [])
  assert.deepEqual(state.checks.map(entry => entry.id), ['c4', 'c3', 'c2'])
  assert.equal(lastCheckView(state)?.at, 4)
  assert.equal(lastCheckView(emptyState()), undefined)
})
