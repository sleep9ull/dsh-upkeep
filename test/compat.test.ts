import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { CompatibilityError, describeRequirements, evaluatePluginCompatibility } from '../dist/host/compat.js'

const RUNTIME = '0.2.2-rc.3'

test('an own engines.dsh range decides alone', () => {
  assert.equal(evaluatePluginCompatibility({ name: 'p', version: '1.0.0', engines: { dsh: '>=0.2.2-rc.1 <0.3.0' } }, RUNTIME), undefined)
  const issue = evaluatePluginCompatibility({ name: 'p', version: '1.0.0', engines: { dsh: '>=0.2.0 <0.2.2-rc.1' } }, RUNTIME)
  assert.deepEqual(issue, {
    name: 'p',
    version: '1.0.0',
    runtimeVersion: RUNTIME,
    requirements: { 'engines.dsh': '>=0.2.0 <0.2.2-rc.1' },
    exempted: false,
  })
  // engines.dsh wins: the rejecting peer is ignored.
  assert.equal(evaluatePluginCompatibility({
    name: 'p',
    version: '1.0.0',
    engines: { dsh: '^0.2.2-rc.1' },
    peerDependencies: { '@deepseek-ai/dsh': '^9.0.0' },
  }, RUNTIME), undefined)
})

test('without engines.dsh every DSH peer must match', () => {
  const ok = evaluatePluginCompatibility({
    name: 'p',
    version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh': '>=0.2.2-rc.1 <0.3.0', '@deepseek-ai/dsh-session': 'workspace:^' },
  }, RUNTIME)
  assert.equal(ok, undefined)
  const issue = evaluatePluginCompatibility({
    name: 'p',
    version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh': '>=0.2.2-rc.1 <0.3.0', '@deepseek-ai/dsh-session': '^0.1.0' },
  }, RUNTIME)
  assert.deepEqual(issue?.requirements, { '@deepseek-ai/dsh-session': '^0.1.0' })
  assert.equal(describeRequirements(issue?.requirements ?? {}), '@deepseek-ai/dsh-session ^0.1.0')
})

test('an exact version exemption only applies to its exact runtime', () => {
  const manifest = { name: 'p', version: '1.0.0', engines: { dsh: '<0.2.0' } }
  const exemptions = { 'p@1.0.0': [RUNTIME] }
  assert.equal(evaluatePluginCompatibility(manifest, RUNTIME, exemptions)?.exempted, true)
  assert.equal(evaluatePluginCompatibility(manifest, '0.2.3-rc.1', exemptions)?.exempted, false)
})

test('malformed requirement fields are reported as compatibility errors', () => {
  assert.throws(() => evaluatePluginCompatibility({ name: 'p', version: '1.0.0', engines: { dsh: 42 } }, RUNTIME), CompatibilityError)
  assert.throws(() => evaluatePluginCompatibility({ name: 'p', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': 1 } }, RUNTIME), CompatibilityError)
  assert.throws(() => evaluatePluginCompatibility({ version: '1.0.0', engines: { dsh: '^0.1.0' } }, RUNTIME), CompatibilityError)
})

test('a satisfied manifest with no identity is not reported', () => {
  assert.equal(evaluatePluginCompatibility({ engines: { dsh: '^0.2.2-rc.1' } }, RUNTIME), undefined)
})
