import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createHub, normalizeConfig } from '../dist/host/dispatch.js'
import type { HostContext } from '../dist/host/types.js'

/** A fake Host context exposing only the services a status read touches. */
function fakeContext(overrides: { bundles?: unknown[]; installAnchor?: string; failBundles?: boolean } = {}): HostContext {
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
          listPlugins: async () => [{}, {}, {}],
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

test('bundles.list projects the same bundle summaries', async () => {
  const hub = createHub(fakeContext({ bundles: [{ name: '@example/a', version: '1.0.0', enabled: true, rows: [] }] }), normalizeConfig(undefined))
  const listed = await hub.call('bundles.list', {}, { caller: 'client' }) as { bundles: Array<{ name: string }> }
  assert.deepEqual(listed.bundles.map(bundle => bundle.name), ['@example/a'])
})

test('unknown actions fail with a stable code', async () => {
  const hub = createHub(fakeContext(), normalizeConfig(undefined))
  await assert.rejects(
    () => hub.call('does.not.exist', {}, { caller: 'client' }),
    (error: unknown) => (error as { code?: string }).code === 'UNKNOWN_ACTION',
  )
})
