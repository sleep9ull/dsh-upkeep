import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { compareVersions, highestVersion, isNewer, parseVersion } from '../dist/host/versions.js'

test('parseVersion accepts release, prerelease and build metadata', () => {
  assert.deepEqual(parseVersion('0.2.2-rc.3'), {
    major: 0,
    minor: 2,
    patch: 2,
    prerelease: ['rc', '3'],
    build: '',
  })
  assert.equal(parseVersion('v1.10.0')?.minor, 10)
  assert.equal(parseVersion('1.0.0+build.7')?.build, 'build.7')
  assert.equal(parseVersion('not-a-version'), undefined)
  assert.equal(parseVersion('1.2'), undefined)
})

test('prerelease versions sort before their release', () => {
  assert.equal(compareVersions('0.2.2-rc.2', '0.2.2-rc.3'), -1)
  assert.equal(compareVersions('0.2.2-rc.3', '0.2.2'), -1)
  assert.equal(compareVersions('0.2.2', '0.2.2-rc.3'), 1)
})

test('numeric prerelease identifiers sort below alphanumeric ones', () => {
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1)
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1)
  assert.equal(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1)
})

test('build metadata does not affect precedence', () => {
  assert.equal(compareVersions('1.0.0+build.1', '1.0.0+build.2'), 0)
})

test('isNewer ignores unparseable candidates', () => {
  assert.equal(isNewer('0.2.2', '0.2.2-rc.3'), true)
  assert.equal(isNewer('garbage', '0.2.2-rc.3'), false)
})

test('highestVersion picks the highest parseable entry', () => {
  assert.equal(highestVersion(['0.2.2-rc.1', '0.2.1', '0.2.2-rc.3', 'nope', '0.2.2-alpha.2']), '0.2.2-rc.3')
  assert.equal(highestVersion(['nope']), undefined)
  assert.equal(highestVersion([]), undefined)
})

import { satisfiesRange } from '../dist/host/versions.js'

test('range satisfaction follows the DSH cases (includePrerelease)', () => {
  // The running DSH and the published prereleases both participate.
  assert.equal(satisfiesRange('0.2.2-rc.3', '>=0.2.2-rc.1 <0.3.0'), true)
  assert.equal(satisfiesRange('0.2.2-rc.3', '>=0.2.2-rc.1 <0.2.2-rc.3'), false)
  // A prerelease sorts before its release, so <0.2.2 still admits rc.3.
  assert.equal(satisfiesRange('0.2.2-rc.3', '>=0.2.2-rc.1 <0.2.2'), true)
  assert.equal(satisfiesRange('0.2.2-rc.3', '^0.2.2-rc.1'), true)
  assert.equal(satisfiesRange('0.2.2', '^0.2.2-rc.1'), true)
  assert.equal(satisfiesRange('0.3.0', '^0.2.2-rc.1'), false)
})

test('caret, tilde, x-ranges, partials, hyphens and unions', () => {
  assert.equal(satisfiesRange('1.9.0', '^1.2.3'), true)
  assert.equal(satisfiesRange('2.0.0', '^1.2.3'), false)
  assert.equal(satisfiesRange('0.2.9', '^0.2.3'), true)
  assert.equal(satisfiesRange('0.3.0', '^0.2.3'), false)
  assert.equal(satisfiesRange('0.0.3', '^0.0.3'), true)
  assert.equal(satisfiesRange('0.0.4', '^0.0.3'), false)
  assert.equal(satisfiesRange('1.2.9', '~1.2.3'), true)
  assert.equal(satisfiesRange('1.3.0', '~1.2.3'), false)
  assert.equal(satisfiesRange('1.5.0', '1.x'), true)
  assert.equal(satisfiesRange('2.0.0', '1.x'), false)
  assert.equal(satisfiesRange('1.2.7', '1.2'), true)
  assert.equal(satisfiesRange('1.3.0', '1.2'), false)
  assert.equal(satisfiesRange('1.5.0', '1.2.3 - 1.9.0'), true)
  assert.equal(satisfiesRange('1.9.1', '1.2.3 - 1.9.0'), false)
  assert.equal(satisfiesRange('3.0.0', '^1.0.0 || ^3.0.0'), true)
})

test('an empty or invalid range is unmet', () => {
  assert.equal(satisfiesRange('1.0.0', ''), false)
  assert.equal(satisfiesRange('1.0.0', 'not-a-range'), false)
  assert.equal(satisfiesRange('garbage', '>=1.0.0'), false)
})
