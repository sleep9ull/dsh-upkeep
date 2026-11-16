import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { normalizeConfig } from '../dist/host/dispatch.js'

test('config defaults are safe', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.targetChannel, 'auto')
  assert.equal(config.targetVersion, '')
  assert.equal(config.feedTtlMinutes, 60)
  assert.equal(config.checkOnStartup, true)
  assert.equal(config.checksToKeep, 20)
  assert.equal(config.analyzeOnCheck, true)
  assert.deepEqual(config.verifyCommands, [])
  assert.equal(config.runsToKeep, 10)
  assert.equal(config.defaultBaseBranch, 'main')
  assert.equal(config.allowMerge, false)
  assert.equal(config.scheduleCwd, '')
  assert.equal(config.scheduleIntervalHours, 24)
  assert.equal(config.concurrency, 2)
  assert.deepEqual(config.ownerHandles, [])
  assert.deepEqual(config.ownerEmails, [])
  assert.equal(config.autoDetectOwner, true)
})

test('config bounds, lists and commands are normalized', () => {
  const config = normalizeConfig({
    targetChannel: '  ',
    concurrency: 99,
    feedTtlMinutes: 0,
    checksToKeep: 999,
    runsToKeep: 0,
    scheduleIntervalHours: 9_999,
    allowMerge: true,
    verifyCommands: 'npm test\n  npm run check  ',
    ownerHandles: ' @Sleep9ull, other ',
    ownerEmails: ' A@B.Com ',
    autoDetectOwner: false,
  })
  assert.equal(config.targetChannel, 'auto')
  assert.equal(config.concurrency, 8)
  assert.equal(config.feedTtlMinutes, 1)
  assert.equal(config.checksToKeep, 100)
  assert.equal(config.runsToKeep, 1)
  assert.equal(config.scheduleIntervalHours, 720)
  assert.equal(config.allowMerge, true)
  assert.deepEqual(config.verifyCommands, ['npm test', 'npm run check'])
  assert.deepEqual(config.ownerHandles, ['sleep9ull', 'other'])
  assert.deepEqual(config.ownerEmails, ['a@b.com'])
  assert.equal(config.autoDetectOwner, false)
  assert.equal(normalizeConfig({ scheduleCwd: ' /work ' }).scheduleCwd, '/work')
})
