import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { STATE_VERSION, appendCheck, emptyState, lastCheckView, readState, statePath, writeState } from '../dist/host/state.js'
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

test('an older payload is migrated instead of discarded, a newer one is not clobbered', () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-migrate-'))
  mkdirSync(join(home, 'upkeep'), { recursive: true })
  const file = join(home, 'upkeep', 'state.json')

  // Pre-versioning shape: same fields, no `version`.
  writeFileSync(file, JSON.stringify({ checks: [], runs: [], updatedAt: '2026-01-01T00:00:00.000Z' }))
  const migrated = readState(home)
  assert.equal(migrated.version, STATE_VERSION, 'the payload is brought forward')

  // Written by a newer build: start empty rather than downgrade the file.
  writeFileSync(file, JSON.stringify({ version: STATE_VERSION + 1, checks: [], runs: [] }))
  const future = readState(home)
  assert.equal(future.version, STATE_VERSION)
  assert.deepEqual(future.runs, [], 'a newer layout is not interpreted as ours')
})
