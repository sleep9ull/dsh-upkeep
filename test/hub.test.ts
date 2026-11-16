import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHub, normalizeConfig } from '../dist/host/dispatch.js'
import { readState } from '../dist/host/state.js'
import type { HostContext } from '../dist/host/types.js'

/** One throwaway home for the whole file: status must never touch the real one. */
const TEST_HOME = mkdtempSync(join(tmpdir(), 'upkeep-hub-'))
const TEST_DEPS = { home: TEST_HOME, startupCheck: false as const }

/** A fake Host context exposing only the services a status read touches. */
function fakeContext(overrides: { bundles?: unknown[]; plugins?: unknown[]; installAnchor?: string; profileDir?: string; home?: string; failBundles?: boolean; workspaceRegistry?: unknown; schedule?: unknown } = {}): HostContext {
  return {
    get(name: string) {
      if (name === 'profileContext') {
        return {
          name: 'desktop',
          dir: overrides.profileDir ?? '/tmp/dsh-profile',
          installAnchor: overrides.installAnchor ?? new URL('../package.json', import.meta.url).pathname,
          home: overrides.home ?? TEST_HOME,
        }
      }
      if (name === 'workspaceRegistry') return overrides.workspaceRegistry
    if (name === 'schedule') return overrides.schedule
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
  }), normalizeConfig(undefined), TEST_DEPS)

  const status = await hub.call('status', {}, { caller: 'client' }) as {
    plugin: { name: string; version: string }
    dsh: { runtimeVersion: string | null }
    profile: { name: string | null }
    bundles: Array<{ name: string; enabled: boolean; rowCount: number; error: { code: string } | null }>
    plugins: { entryCount: number | null }
    warnings: string[]
  }

  assert.match(status.plugin.version, /^\d+\.\d+\.\d+$/)
  assert.equal(status.plugin.name, '@sleep9ull/dsh-upkeep')
  assert.match(status.dsh.runtimeVersion ?? '', /^\d+\.\d+\.\d+/)
  assert.equal(status.profile.name, 'desktop')
  assert.equal(status.bundles.length, 2)
  assert.equal(status.bundles[0]?.rowCount, 2)
  assert.equal(status.bundles[1]?.error?.code, 'incompatible-version')
  assert.equal(status.plugins.entryCount, 3)
  assert.deepEqual(status.warnings, [])
})

test('status degrades with warnings instead of throwing', async () => {
  const hub = createHub(fakeContext({ failBundles: true }), normalizeConfig(undefined), TEST_DEPS)
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
  }), normalizeConfig(undefined), TEST_DEPS)

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
  }), normalizeConfig(undefined), TEST_DEPS)
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
  const hub = createHub(fakeContext(), normalizeConfig(undefined), TEST_DEPS)
  await assert.rejects(
    () => hub.call('does.not.exist', {}, { caller: 'client' }),
    (error: unknown) => (error as { code?: string }).code === 'UNKNOWN_ACTION',
  )
})


test('check reads the registry, projects the target and stores one report', async () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-check-'))
  const profileDir = mkdtempSync(join(tmpdir(), 'upkeep-profile-'))
  const installDir = mkdtempSync(join(tmpdir(), 'upkeep-runtime-'))
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
  const packageDir = join(profileDir, 'node_modules', '@sleep9ull', 'plugin')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@sleep9ull/plugin',
    version: '1.0.0',
    engines: { dsh: '>=0.2.2-rc.1 <0.2.3-rc.1' },
  }))
  const fetchImpl = (async () => new Response(JSON.stringify({
    versions: { '0.2.2-rc.3': {}, '0.2.3-rc.1': {} },
    'dist-tags': { next: '0.2.3-rc.1', latest: '0.2.2-rc.3' },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

  const hub = createHub(fakeContext({
    bundles: [{ name: '@sleep9ull/plugin', version: '1.0.0', enabled: true, rows: [] }],
    profileDir,
    installAnchor: join(installDir, 'package.json'),
    home,
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false }), {
    home, startupCheck: false, fetchImpl, now: () => 1_000,
  })

  const status = await hub.call('check', {}, { caller: 'client' }) as {
    target: { version: string | null; channel: string | null; source: string }
    bundles: Array<{
      name: string
      compat: { running: { status: string }; target: { status: string } | null }
      maintenance: { state: string; reasons: string[] }
    }>
  }
  assert.equal(status.target.version, '0.2.3-rc.1')
  assert.equal(status.target.channel, 'next')
  assert.equal(status.target.source, 'network')

  const bundle = status.bundles[0]
  assert.equal(bundle?.compat.running.status, 'compatible')
  assert.equal(bundle?.compat.target?.status, 'incompatible')
  assert.equal(bundle?.maintenance.state, 'attention')
  assert.ok((bundle?.maintenance.reasons ?? []).some(reason => reason.includes('will break on 0.2.3-rc.1')))

  const stored = readState(home)
  assert.equal(stored.checks.length, 1)
  assert.equal(stored.checks[0]?.targetVersion, '0.2.3-rc.1')
  assert.equal(stored.feed?.channel, 'next')

  // A later status read reuses the cached target without another fetch.
  const cached = await hub.call('status', {}, { caller: 'client' }) as { target: { version: string | null; source: string } }
  assert.equal(cached.target.version, '0.2.3-rc.1')
  assert.equal(cached.target.source, 'cache')
})

test('check matches migration guides and report.get returns the hits', async () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-m2-'))
  const profileDir = mkdtempSync(join(tmpdir(), 'upkeep-m2-profile-'))
  const installDir = mkdtempSync(join(tmpdir(), 'upkeep-m2-runtime-'))
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
  const guideDir = join(installDir, 'docs', 'upgrade-guide', 'v0.2.2-rc.1', 'tools')
  mkdirSync(guideDir, { recursive: true })
  writeFileSync(join(guideDir, 'guide.md'), [
    '---', 'kind: upgrade-guide', 'description: "Tools moved."', '---', '',
    '## Change', 'Use ctx.tools through @deepseek-ai/dsh-tools.', '', '## Migration', '1. Update.', '',
  ].join('\n'))

  const packageDir = join(profileDir, 'node_modules', '@sleep9ull', 'plugin')
  mkdirSync(join(packageDir, 'src'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@sleep9ull/plugin',
    version: '1.0.0',
    engines: { dsh: '^0.2.2-rc.1' },
  }))
  writeFileSync(join(packageDir, 'src', 'index.js'), "import '@deepseek-ai/dsh-tools'\nctx.tools.register({})\n")

  const hub = createHub(fakeContext({
    bundles: [{ name: '@sleep9ull/plugin', version: '1.0.0', enabled: true, rows: [] }],
    profileDir,
    installAnchor: join(installDir, 'package.json'),
    home,
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false, targetVersion: '0.2.2-rc.3' }), {
    home, startupCheck: false, now: () => 2_000,
  })

  const status = await hub.call('check', {}, { caller: 'client' }) as {
    bundles: Array<{ name: string; compat: { impact?: { matched: number; versions: string[] } } }>
  }
  assert.ok((status.bundles[0]?.compat.impact?.matched ?? 0) >= 1)

  const stored = readState(home)
  assert.ok((stored.checks[0]?.reports[0]?.impact?.matched ?? 0) >= 1)

  const report = await hub.call('report.get', { bundle: '@sleep9ull/plugin' }, { caller: 'tool' }) as {
    guideSource: string
    matched: Array<{ item: string; change: string; matchedSurfaces: Array<{ value: string }> }>
  }
  assert.equal(report.guideSource, 'installed')
  assert.ok(report.matched.length >= 1)
  assert.match(report.matched[0]?.change ?? '', /ctx\.tools/)
})

test('upgrade.prepare gated by confirm, registers a workspace, and verify records the run', async () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-m3-'))
  const profileDir = mkdtempSync(join(tmpdir(), 'upkeep-m3-profile-'))
  const installDir = mkdtempSync(join(tmpdir(), 'upkeep-m3-runtime-'))
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
  const packageDir = join(profileDir, 'node_modules', '@sleep9ull', 'plugin')
  mkdirSync(join(packageDir, 'src'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@sleep9ull/plugin',
    version: '1.0.0',
    engines: { dsh: '^0.2.2-rc.1' },
    scripts: { test: 'node --version' },
  }))
  writeFileSync(join(packageDir, 'src', 'index.js'), "ctx.tools.register({})" + "\n")

  const exec = {
    run: async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'rev-parse') return { exitCode: 0, stdout: packageDir + '\n', stderr: '', timedOut: false }
      if (command === 'git' && args[0] === 'status') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      if (command === 'git' && args[0] === 'worktree') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }
    },
  }

  const hub = createHub(fakeContext({
    bundles: [{ name: '@sleep9ull/plugin', version: '1.0.0', enabled: true, rows: [], source: 'link:' + packageDir }],
    profileDir,
    installAnchor: join(installDir, 'package.json'),
    home,
    workspaceRegistry: { create: async (path: string, title: string) => ({ id: 'ws-1', path, title }) },
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false, targetVersion: '0.2.2-rc.3', verifyCommands: ['npm test'] }), {
    home, startupCheck: false, now: () => 5_000, exec,
  })

  await assert.rejects(
    () => hub.call('upgrade.prepare', { bundle: '@sleep9ull/plugin', confirm: false }, { caller: 'client' }),
    (error: unknown) => (error as { code?: string }).code === 'CONFIRM_REQUIRED',
  )

  const prepared = await hub.call('upgrade.prepare', {
    bundle: '@sleep9ull/plugin', worktree: true, confirm: true,
  }, { caller: 'client' }) as {
    run: { id: string; workspaceId: string; workspacePath: string; worktree: boolean; prompt: string }
  }
  assert.equal(prepared.run.workspaceId, 'ws-1')
  assert.equal(prepared.run.worktree, true)
  assert.match(prepared.run.workspacePath, /-upkeep/)
  assert.match(prepared.run.prompt, /@sleep9ull\/plugin/)
  assert.match(prepared.run.prompt, /npm test/)
  // The panel renders these; they must exist even when everything succeeded.
  const prepareWarnings = (prepared as unknown as { warnings: string[] }).warnings
  assert.ok(Array.isArray(prepareWarnings))
  assert.ok(prepareWarnings.some(warning => /uncommitted changes were not copied/.test(warning)))
  assert.equal(readState(home).runs.length, 1)

  const verified = await hub.call('upgrade.verify', { runId: prepared.run.id, confirm: true }, { caller: 'client' }) as {
    ok: boolean
    results: Array<{ ok: boolean; command: string }>
  }
  assert.equal(verified.ok, true)
  assert.equal(verified.results[0]?.command, 'npm test')
  assert.equal(readState(home).runs[0]?.status, 'verified')
})

test('delivery commits, pushes and opens a PR, then merges when allowed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-m4-'))
  const profileDir = mkdtempSync(join(tmpdir(), 'upkeep-m4-profile-'))
  const installDir = mkdtempSync(join(tmpdir(), 'upkeep-m4-runtime-'))
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
  const packageDir = join(profileDir, 'node_modules', '@sleep9ull', 'plugin')
  mkdirSync(join(packageDir, 'src'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@sleep9ull/plugin', version: '1.0.0', engines: { dsh: '^0.2.2-rc.1' }, scripts: { test: 'node --version' },
  }))
  writeFileSync(join(packageDir, 'src', 'index.js'), 'ctx.tools.register({})\n')

  const exec = {
    run: async (command: string, args: string[]) => {
      const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', timedOut: false })
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('upkeep/x\n')
      if (command === 'git' && args[0] === 'status') return ok(' M src/index.js\n')
      if (command === 'git' && args[0] === 'rev-parse') return ok('abc1234\n')
      if (command === 'git' && args[0] === 'remote') return ok('git@github.com:o/r.git\n')
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') return ok('https://github.com/o/r/pull/9\n')
      return ok()
    },
  }

  const hub = createHub(fakeContext({
    bundles: [{ name: '@sleep9ull/plugin', version: '1.0.0', enabled: true, rows: [], source: 'link:' + packageDir }],
    profileDir,
    installAnchor: join(installDir, 'package.json'),
    home,
    workspaceRegistry: { create: async (path: string, title: string) => ({ id: 'ws-1', path, title }) },
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false, targetVersion: '0.2.2-rc.3', allowMerge: true }), {
    home, startupCheck: false, now: () => 7_000, exec,
  })

  const prepared = await hub.call('upgrade.prepare', { bundle: '@sleep9ull/plugin', confirm: true }, { caller: 'client' }) as { run: { id: string } }

  await assert.rejects(
    () => hub.call('delivery.create-pr', { runId: prepared.run.id, confirm: false }, { caller: 'client' }),
    (error: unknown) => (error as { code?: string }).code === 'CONFIRM_REQUIRED',
  )

  const delivered = await hub.call('delivery.create-pr', { runId: prepared.run.id, confirm: true }, { caller: 'client' }) as {
    prUrl: string
    committed: boolean
    commit?: string
  }
  assert.equal(delivered.prUrl, 'https://github.com/o/r/pull/9')
  assert.equal(delivered.committed, true)
  assert.equal(readState(home).runs[0]?.delivery?.stage, 'pr')
  assert.equal(readState(home).runs[0]?.delivery?.prUrl, 'https://github.com/o/r/pull/9')

  const merged = await hub.call('delivery.merge', { runId: prepared.run.id, confirm: true }, { caller: 'client' }) as { mergedAt: number }
  assert.equal(merged.mergedAt, 7_000)
  assert.equal(readState(home).runs[0]?.delivery?.stage, 'merged')
})

test('merging is refused when the configuration does not allow it', async () => {
  const hub = createHub(fakeContext(), normalizeConfig({ allowMerge: false }), TEST_DEPS)
  await assert.rejects(
    () => hub.call('delivery.merge', { runId: 'run-x', confirm: true }, { caller: 'client' }),
    (error: unknown) => (error as { code?: string }).code === 'MERGE_DISABLED',
  )
})

test('schedule.create asks for confirmation and creates the recurring check', async () => {
  const requests: unknown[] = []
  const schedule = {
    create: async (request: unknown) => { requests.push(request); return { id: 'task-1', title: 'Upkeep compatibility check' } },
    catalog: async () => [
      { id: 'task-1', title: 'Upkeep compatibility check', status: 'active', prompt: 'p' },
      { id: 'task-2', title: 'other', status: 'active', prompt: 'q' },
    ],
    list: async () => ({ items: [] }),
  }
  const hub = createHub(fakeContext({ schedule }), normalizeConfig({ scheduleIntervalHours: 12 }), TEST_DEPS)

  await assert.rejects(
    () => hub.call('schedule.create', { confirm: false }, { caller: 'client' }),
    (error: unknown) => (error as { code?: string }).code === 'CONFIRM_REQUIRED',
  )
  const created = await hub.call('schedule.create', { confirm: true }, { caller: 'client' }) as {
    task: { id: string | null; title: string }
    intervalHours: number
  }
  assert.equal(created.task.id, 'task-1')
  assert.equal(created.intervalHours, 12)
  const request = requests[0] as { timing: { every_seconds: number }; target: { kind: string; create: { cwd?: string } } }
  assert.equal(request.timing.every_seconds, 12 * 3_600)
  assert.equal(request.target.kind, 'new_once')
  assert.equal(request.target.create.cwd, TEST_HOME)

  const listed = await hub.call('schedule.list', {}, { caller: 'client' }) as { tasks: Array<{ id: string }>; available: boolean }
  assert.equal(listed.available, true)
  assert.deepEqual(listed.tasks.map(task => task.id), ['task-1'])
})

test('without the schedule service the actions degrade explicitly', async () => {
  const hub = createHub(fakeContext(), normalizeConfig(undefined), TEST_DEPS)
  await assert.rejects(
    () => hub.call('schedule.create', { confirm: true }, { caller: 'client' }),
    (error: unknown) => (error as { code?: string }).code === 'SCHEDULE_UNAVAILABLE',
  )
  const listed = await hub.call('schedule.list', {}, { caller: 'client' }) as { tasks: unknown[]; available: boolean }
  assert.deepEqual(listed, { tasks: [], available: false })
})

test('one refresh button: a check reuses a fresh cached target and only refetches when it must', async () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-ttl-'))
  const profileDir = mkdtempSync(join(tmpdir(), 'upkeep-ttl-profile-'))
  const installDir = mkdtempSync(join(tmpdir(), 'upkeep-ttl-runtime-'))
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
  const packageDir = join(profileDir, 'node_modules', '@sleep9ull', 'plugin')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@sleep9ull/plugin',
    version: '1.0.0',
    engines: { dsh: '>=0.2.2-rc.1 <0.3.0' },
  }))

  let clock = 1_000
  let fetches = 0
  const fetchImpl = (async () => {
    fetches += 1
    return new Response(JSON.stringify({
      versions: { '0.2.2-rc.3': {} },
      'dist-tags': { next: '0.2.2-rc.3', latest: '0.2.2-rc.3' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  const hub = createHub(fakeContext({
    bundles: [{ name: '@sleep9ull/plugin', version: '1.0.0', enabled: true, rows: [] }],
    profileDir,
    installAnchor: join(installDir, 'package.json'),
    home,
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false, feedTtlMinutes: 60 }), {
    home, startupCheck: false, fetchImpl, now: () => clock,
  })

  await hub.call('check', {}, { caller: 'client' })
  assert.equal(fetches, 1)

  // Inside the TTL the cached answer wins: no second network round trip, but the
  // evaluation and the stored report still happen.
  clock += 5 * 60_000
  await hub.call('check', {}, { caller: 'client' })
  assert.equal(fetches, 1)
  assert.equal(readState(home).checks.length, 2)

  // An explicit force asks the registry anyway.
  await hub.call('check', { force: true }, { caller: 'client' })
  assert.equal(fetches, 2)

  // Past the TTL the cache is stale, so the next click refetches on its own.
  clock += 61 * 60_000
  await hub.call('check', {}, { caller: 'client' })
  assert.equal(fetches, 3)
})

test('the snapshot reports the task that watches each plugin, with its cadence', async () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-sched-'))
  const profileDir = mkdtempSync(join(tmpdir(), 'upkeep-sched-profile-'))
  const installDir = mkdtempSync(join(tmpdir(), 'upkeep-sched-runtime-'))
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
  const packageDir = join(profileDir, 'node_modules', '@sleep9ull', 'plugin')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@sleep9ull/plugin', version: '1.0.0', engines: { dsh: '>=0.2.2-rc.1 <0.3.0' },
  }))

  const tasks: Array<Record<string, unknown>> = []
  const schedule = {
    create: async (request: unknown) => {
      const body = request as { title: string; timing: { every_seconds: number } }
      const entry = {
        id: 'task-' + String(tasks.length + 1),
        status: 'active',
        everySeconds: body.timing.every_seconds,
        scheduledAt: '2026-11-17T00:00:00.000Z',
        ...body,
      }
      tasks.push(entry)
      return entry
    },
    catalog: async () => tasks,
  }
  const hub = createHub(fakeContext({
    bundles: [{ name: '@sleep9ull/plugin', version: '1.0.0', enabled: true, rows: [] }],
    profileDir,
    installAnchor: join(installDir, 'package.json'),
    home,
    schedule,
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false, scheduleIntervalHours: 6 }), TEST_DEPS)

  type ScheduledView = {
    scheduled: { available: boolean; tasks: Array<{ bundle: string | null; title: string; everySeconds: number | null; nextAt: string | null }> }
  }
  const before = await hub.call('status', {}, { caller: 'client' }) as ScheduledView
  assert.equal(before.scheduled.available, true)
  assert.deepEqual(before.scheduled.tasks, [])

  // One task per plugin: the row can then show its cadence.
  await hub.call('schedule.create', { confirm: true, bundle: '@sleep9ull/plugin' }, { caller: 'client' })
  const scoped = await hub.call('status', {}, { caller: 'client' }) as ScheduledView
  assert.equal(scoped.scheduled.tasks.length, 1)
  assert.equal(scoped.scheduled.tasks[0]?.bundle, '@sleep9ull/plugin')
  assert.equal(scoped.scheduled.tasks[0]?.title, 'Upkeep: @sleep9ull/plugin')
  assert.equal(scoped.scheduled.tasks[0]?.everySeconds, 6 * 3_600)
  assert.equal(scoped.scheduled.tasks[0]?.nextAt, '2026-11-17T00:00:00.000Z')

  // A profile-wide task reports a null bundle so every row can show it.
  await hub.call('schedule.create', { confirm: true }, { caller: 'client' })
  const wide = await hub.call('status', {}, { caller: 'client' }) as ScheduledView
  assert.ok(wide.scheduled.tasks.some(task => task.bundle === null))

  // Paused tasks stop counting.
  tasks.forEach(task => { task.status = 'paused' })
  const paused = await hub.call('status', {}, { caller: 'client' }) as ScheduledView
  assert.deepEqual(paused.scheduled.tasks, [])
})

test('schedule.create at a chosen time makes a daily task in that zone', async () => {
  const requests: Array<Record<string, unknown>> = []
  const schedule = {
    create: async (request: unknown) => {
      requests.push(request as Record<string, unknown>)
      return { id: 'task-1', title: 'Upkeep: @sleep9ull/plugin' }
    },
    catalog: async () => [],
  }
  const hub = createHub(fakeContext({ schedule }), normalizeConfig(undefined), TEST_DEPS)

  const created = await hub.call('schedule.create', {
    confirm: true,
    bundle: '@sleep9ull/plugin',
    time: '8:00',
    timeZone: 'Asia/Shanghai',
  }, { caller: 'client' }) as { task: { title: string }; time: string; timeZone: string }

  assert.equal(created.time, '08:00:00')
  assert.equal(created.timeZone, 'Asia/Shanghai')
  const timing = requests[0]?.timing as { kind: string; daily?: { time: string; time_zone: string } }
  assert.equal(timing.kind, 'daily')
  assert.deepEqual(timing.daily, { time: '08:00:00', time_zone: 'Asia/Shanghai' })

  await assert.rejects(
    () => hub.call('schedule.create', { confirm: true, time: '25:99', timeZone: 'UTC' }, { caller: 'client' }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT',
  )
  await assert.rejects(
    () => hub.call('schedule.create', { confirm: true, time: '08:00', timeZone: 'Mars/Olympus' }, { caller: 'client' }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT',
  )
})
