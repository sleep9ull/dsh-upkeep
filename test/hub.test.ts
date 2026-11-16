import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createHub, normalizeConfig } from '../dist/host/dispatch.js'
import type { HostContext } from '../dist/host/types.js'

/** A fake Host context exposing only the services a status read touches. */
function fakeContext(overrides: { bundles?: unknown[]; plugins?: unknown[]; installAnchor?: string; failBundles?: boolean } = {}): HostContext {
  return {
    get(name: string) {
      if (name === 'profileContext') {
        return {
          name: 'desktop',
          dir: '/tmp/dsh-profile',
          installAnchor: overrides.installAnchor ?? new URL('../package.json', import.meta.url).pathname,
        }
      }
      if (name === 'pluginManager') {
        return {
          listBundles: async () => {
            if (overrides.failBundles === true) throw new Error('manager unavailable')
            return overrides.bundles ?? []
          },
          listPlugins: async () => overrides.plugins ?? [{}, {}, {}],
        }
      }
      return undefined
    },
    effect(setup: () => (() => void) | void) {
      return setup()
    },
    on() {
      return () => {}
    },
  }
}

test('status reads the runtime version, profile and bundles', async () => {
  // The fake installation anchor is this package's own manifest, so the read path
  // is exercised without depending on a particular DSH release.
  const hub = createHub(fakeContext({
    bundles: [
      { name: '@example/a', version: '1.2.3', enabled: true, official: false, availability: 'profile', rows: [{}, {}] },
      { name: '@example/b', version: '0.1.0', enabled: false, official: true, availability: 'installation', rows: [], error: { code: 'incompatible-version', diagnostic: 'engines.dsh rejects 0.2.2-rc.3' } },
    ],
  }), normalizeConfig(undefined))

  const status = await hub.call('status', {}, { caller: 'client' }) as {
    plugin: { version: string }
    dsh: { runtimeVersion: string | null }
    profile: { name: string | null }
    bundles: Array<{ name: string; enabled: boolean; rowCount: number; error: { code: string } | null }>
    plugins: { entryCount: number | null }
    warnings: string[]
  }

  assert.equal(status.plugin.version, '0.1.0')
  assert.equal(status.dsh.runtimeVersion, '0.1.0')
  assert.equal(status.profile.name, 'desktop')
  assert.equal(status.bundles.length, 2)
  assert.equal(status.bundles[0]?.rowCount, 2)
  assert.equal(status.bundles[1]?.error?.code, 'incompatible-version')
  assert.equal(status.plugins.entryCount, 3)
  assert.deepEqual(status.warnings, [])
})

test('status degrades with warnings instead of throwing', async () => {
  const hub = createHub(fakeContext({ failBundles: true }), normalizeConfig(undefined))
  const status = await hub.call('status', {}, { caller: 'tool' }) as { bundles: unknown[]; warnings: string[] }
  assert.equal(status.bundles.length, 0)
  assert.equal(status.warnings.length, 1)
  assert.match(status.warnings[0] ?? '', /could not be listed/)
})

test('official @deepseek-ai packages are excluded and reported, not silently dropped', async () => {
  const hub = createHub(fakeContext({
    bundles: [
      { name: '@deepseek-ai/dsh-base', version: '0.2.2-rc.3', enabled: true, rows: [{}, {}] },
      { name: 'dsh-context', version: '0.84.1', enabled: true, rows: [{}] },
    ],
    plugins: [
      { moduleName: '@deepseek-ai/dsh-tool-bash' },
      { moduleName: '@deepseek-ai/dsh-web' },
      { moduleName: 'dsh-context' },
    ],
  }), normalizeConfig(undefined))

  const status = await hub.call('status', {}, { caller: 'client' }) as {
    bundles: Array<{ name: string }>
    plugins: { entryCount: number | null }
    excluded: { bundles: number; entries: number }
  }

  // The official bundle never appears in the monitored list, and the counts say
  // exactly what was left out.
  assert.deepEqual(status.bundles.map(bundle => bundle.name), ['dsh-context'])
  assert.equal(status.plugins.entryCount, 1)
  assert.deepEqual(status.excluded, { bundles: 1, entries: 2 })
})

test('bundles.list projects the same bundle summaries', async () => {
  const hub = createHub(fakeContext({
    bundles: [
      { name: '@example/a', version: '1.0.0', enabled: true, rows: [] },
      { name: '@deepseek-ai/dsh-base', version: '0.2.2-rc.3', enabled: true, rows: [] },
    ],
  }), normalizeConfig(undefined))
  const listed = await hub.call('bundles.list', {}, { caller: 'client' }) as {
    bundles: Array<{ name: string }>
    excluded: { bundles: number; entries: number }
  }
  assert.deepEqual(listed.bundles.map(bundle => bundle.name), ['@example/a'])
  assert.equal(listed.excluded.bundles, 1)
})

test('ownership joins the local identity and decides which plugins need care', async () => {
  const hub = createHub(fakeContext({
    bundles: [
      { name: '@sleep9ull/broken-plugin', version: '0.1.0', enabled: false, rows: [{ entryId: 'row-broken' }], error: { code: 'incompatible-version' } },
      { name: '@sleep9ull/fine-plugin', version: '0.2.0', enabled: true, rows: [{ entryId: 'row-fine' }] },
      { name: 'dsh-worktrace', version: '0.2.1', enabled: false, rows: [{ entryId: 'row-other' }] },
    ],
    plugins: [
      { entryId: 'row-broken', moduleName: '@sleep9ull/broken-plugin', fiberPhase: 'failed' },
      { entryId: 'row-fine', moduleName: '@sleep9ull/fine-plugin', fiberPhase: 'active' },
      { entryId: 'row-other', moduleName: 'dsh-worktrace', fiberPhase: 'failed' },
    ],
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false }))

  const status = await hub.call('status', {}, { caller: 'client' }) as {
    bundles: Array<{
      name: string
      owner: { status: string; evidence: string[] }
      maintenance: { state: string; reasons: string[] }
    }>
    ownership: { mine: number; other: number; unknown: number; needsMaintenance: number; identity: { handles: string[]; sources: string[] } }
  }
  const byName = Object.fromEntries(status.bundles.map(bundle => [bundle.name, bundle]))

  assert.equal(byName['@sleep9ull/broken-plugin']?.owner.status, 'mine')
  assert.equal(byName['@sleep9ull/broken-plugin']?.maintenance.state, 'attention')
  assert.match((byName['@sleep9ull/broken-plugin']?.maintenance.reasons ?? []).join('; '), /incompatible/)
  assert.equal(byName['@sleep9ull/fine-plugin']?.owner.status, 'mine')
  assert.equal(byName['@sleep9ull/fine-plugin']?.maintenance.state, 'ok')
  assert.equal(byName['dsh-worktrace']?.owner.status, 'unknown')
  assert.equal(byName['dsh-worktrace']?.maintenance.state, 'not-mine')

  assert.equal(status.ownership.mine, 2)
  assert.equal(status.ownership.unknown, 1)
  assert.equal(status.ownership.needsMaintenance, 1)
  assert.deepEqual(status.ownership.identity.handles, ['sleep9ull'])
  assert.deepEqual(status.ownership.identity.sources, ['config'])
})

test('unknown actions fail with a stable code', async () => {
  const hub = createHub(fakeContext(), normalizeConfig(undefined))
  await assert.rejects(
    () => hub.call('does.not.exist', {}, { caller: 'client' }),
    (error: unknown) => (error as { code?: string }).code === 'UNKNOWN_ACTION',
  )
})
