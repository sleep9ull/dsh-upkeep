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
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false }), TEST_DEPS)

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
  const hub = createHub(fakeContext({ failBundles: true }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false }), TEST_DEPS)
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
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false }), TEST_DEPS)

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
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false }), TEST_DEPS)
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
  const hub = createHub(fakeContext(), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false }), TEST_DEPS)
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
  const guideDir = join(installDir, 'docs', 'upgrade-guide', 'v0.2.2-rc.3', 'tools')
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
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false, targetVersion: '0.2.3-rc.1' }), {
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
  assert.match(prepared.run.workspacePath, /[\\/]\.worktrees[\\/]upkeep[\\/]/)
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
  const hub = createHub(fakeContext(), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false }), TEST_DEPS)
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
  const hub = createHub(fakeContext({ schedule }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false }), TEST_DEPS)

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

test('preparing an upgrade starts it through a one-shot task in the prepared directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-auto-'))
  const profileDir = mkdtempSync(join(tmpdir(), 'upkeep-auto-profile-'))
  const installDir = mkdtempSync(join(tmpdir(), 'upkeep-auto-runtime-'))
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
  const packageDir = join(profileDir, 'node_modules', '@sleep9ull', 'plugin')
  mkdirSync(join(packageDir, 'src'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@sleep9ull/plugin', version: '1.0.0', engines: { dsh: '^0.2.2-rc.1' }, scripts: { test: 'node --version' },
  }))
  writeFileSync(join(packageDir, 'src', 'index.js'), 'ctx.tools.register({})\n')

  const requests: Array<Record<string, any>> = []
  const schedule = {
    create: async (request: unknown) => { requests.push(request as Record<string, any>); return { id: 'shot-1', title: 'Upkeep upgrade: @sleep9ull/plugin' } },
    catalog: async () => [],
  }
  const exec = {
    run: async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'rev-parse') return { exitCode: 0, stdout: packageDir + '\n', stderr: '', timedOut: false }
      if (command === 'git' && args[0] === 'status') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      if (command === 'git' && args[0] === 'worktree') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    },
  }
  const hub = createHub(fakeContext({
    bundles: [{ name: '@sleep9ull/plugin', version: '1.0.0', enabled: true, rows: [], source: 'link:' + packageDir }],
    profileDir,
    installAnchor: join(installDir, 'package.json'),
    home,
    schedule,
    workspaceRegistry: { create: async (path: string, title: string) => ({ id: 'ws-1', path, title }) },
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false, targetVersion: '0.2.2-rc.3', verifyCommands: ['npm test'] }), {
    home, startupCheck: false, now: () => 9_000, exec,
  })

  const prepared = await hub.call('upgrade.prepare', { bundle: '@sleep9ull/plugin', worktree: true, confirm: true }, { caller: 'client' }) as {
    run: { id: string; prompt: string; workspacePath: string }
    autoStarted: boolean
    warnings: string[]
  }

  assert.equal(prepared.autoStarted, true)
  assert.equal(requests.length, 1)
  const request = requests[0] ?? {}
  assert.equal(request.title, 'Upkeep upgrade: @sleep9ull/plugin')
  assert.equal(request.prompt, prepared.run.prompt, 'the delivered prompt is the prepared one')
  assert.deepEqual(request.timing, { kind: 'after', after_seconds: 1 })
  assert.equal(request.target.kind, 'new_once')
  assert.equal(request.target.create.cwd, prepared.run.workspacePath, 'the session opens in the prepared directory')
})

test('without the schedule service the upgrade falls back to an unsent draft', async () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-nofire-'))
  const profileDir = mkdtempSync(join(tmpdir(), 'upkeep-nofire-profile-'))
  const installDir = mkdtempSync(join(tmpdir(), 'upkeep-nofire-runtime-'))
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
  const packageDir = join(profileDir, 'node_modules', '@sleep9ull', 'plugin')
  mkdirSync(join(packageDir, 'src'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@sleep9ull/plugin', version: '1.0.0', engines: { dsh: '^0.2.2-rc.1' } }))
  writeFileSync(join(packageDir, 'src', 'index.js'), 'void 0\n')

  const exec = {
    run: async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'rev-parse') return { exitCode: 0, stdout: packageDir + '\n', stderr: '', timedOut: false }
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    },
  }
  const hub = createHub(fakeContext({
    bundles: [{ name: '@sleep9ull/plugin', version: '1.0.0', enabled: true, rows: [], source: 'link:' + packageDir }],
    profileDir,
    installAnchor: join(installDir, 'package.json'),
    home,
    workspaceRegistry: { create: async (path: string, title: string) => ({ id: 'ws-1', path, title }) },
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false, targetVersion: '0.2.2-rc.3' }), {
    home, startupCheck: false, now: () => 10_000, exec,
  })

  const prepared = await hub.call('upgrade.prepare', { bundle: '@sleep9ull/plugin', confirm: true }, { caller: 'client' }) as {
    autoStarted: boolean
    warnings: string[]
  }
  assert.equal(prepared.autoStarted, false)
  assert.ok(prepared.warnings.some(warning => /not started automatically/.test(warning)))
})

test('the one-shot task that starts an upgrade is deleted after the cleanup delay', async () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-cleanup-'))
  const profileDir = mkdtempSync(join(tmpdir(), 'upkeep-cleanup-profile-'))
  const installDir = mkdtempSync(join(tmpdir(), 'upkeep-cleanup-runtime-'))
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
  const packageDir = join(profileDir, 'node_modules', '@sleep9ull', 'plugin')
  mkdirSync(join(packageDir, 'src'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@sleep9ull/plugin', version: '1.0.0', engines: { dsh: '^0.2.2-rc.1' } }))
  writeFileSync(join(packageDir, 'src', 'index.js'), 'void 0\n')

  const entries: Array<Record<string, unknown>> = []
  const edits: Array<Record<string, unknown>> = []
  const schedule = {
    create: async (request: unknown) => {
      const entry = { id: 'shot-1', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active', ...(request as Record<string, unknown>) }
      entries.push(entry)
      return entry
    },
    catalog: async () => entries,
    edit: async (request: unknown) => { edits.push(request as Record<string, unknown>); return { id: 'shot-1', deleted: true } },
  }
  const timers: Array<{ callback: () => void; ms: number }> = []
  const exec = {
    run: async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'rev-parse') return { exitCode: 0, stdout: packageDir + '\n', stderr: '', timedOut: false }
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    },
  }
  const hub = createHub(fakeContext({
    bundles: [{ name: '@sleep9ull/plugin', version: '1.0.0', enabled: true, rows: [], source: 'link:' + packageDir }],
    profileDir,
    installAnchor: join(installDir, 'package.json'),
    home,
    schedule,
    workspaceRegistry: { create: async (path: string, title: string) => ({ id: 'ws-1', path, title }) },
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false, targetVersion: '0.2.2-rc.3', upgradeTaskCleanupSeconds: 10 }), {
    home, startupCheck: false, now: () => 11_000, exec,
    setTimer: (callback, ms) => { timers.push({ callback, ms }) },
  })

  await hub.call('upgrade.prepare', { bundle: '@sleep9ull/plugin', confirm: true }, { caller: 'client' })

  assert.equal(timers.length, 1, 'one deferred cleanup was scheduled')
  assert.equal(timers[0]?.ms, 10_000)
  assert.deepEqual(edits, [], 'nothing is deleted before the delay elapses')

  timers[0]?.callback()
  await new Promise(resolve => setTimeout(resolve, 0))
  const deletion = edits[0] as Record<string, unknown> | undefined
  assert.ok(edits.length === 1, 'exactly one delete was issued')
  assert.equal(deletion?.id, 'shot-1')
  assert.equal(deletion?.action, 'delete')
  assert.equal(deletion?.expectedUpdatedAt, '2026-01-01T00:00:00.000Z', 'the delete carries the concurrency token')
})

test('a zero cleanup delay keeps the task', async () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-keep-'))
  const profileDir = mkdtempSync(join(tmpdir(), 'upkeep-keep-profile-'))
  const installDir = mkdtempSync(join(tmpdir(), 'upkeep-keep-runtime-'))
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
  const packageDir = join(profileDir, 'node_modules', '@sleep9ull', 'plugin')
  mkdirSync(join(packageDir, 'src'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@sleep9ull/plugin', version: '1.0.0', engines: { dsh: '^0.2.2-rc.1' } }))
  writeFileSync(join(packageDir, 'src', 'index.js'), 'void 0\n')

  const schedule = {
    create: async (request: unknown) => ({ id: 'shot-1', ...(request as Record<string, unknown>) }),
    catalog: async () => [],
    edit: async () => ({}),
  }
  const timers: unknown[] = []
  const exec = {
    run: async (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'rev-parse') return { exitCode: 0, stdout: packageDir + '\n', stderr: '', timedOut: false }
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    },
  }
  const hub = createHub(fakeContext({
    bundles: [{ name: '@sleep9ull/plugin', version: '1.0.0', enabled: true, rows: [], source: 'link:' + packageDir }],
    profileDir,
    installAnchor: join(installDir, 'package.json'),
    home,
    schedule,
    workspaceRegistry: { create: async (path: string, title: string) => ({ id: 'ws-1', path, title }) },
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false, targetVersion: '0.2.2-rc.3', upgradeTaskCleanupSeconds: 0 }), {
    home, startupCheck: false, now: () => 12_000, exec,
    setTimer: (callback, ms) => { timers.push({ callback, ms }) },
  })

  await hub.call('upgrade.prepare', { bundle: '@sleep9ull/plugin', confirm: true }, { caller: 'client' })
  assert.deepEqual(timers, [], 'no cleanup is scheduled when the delay is zero')
})

test('a target that is not newer than the running DSH reports no migration items', async () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-window-'))
  const profileDir = mkdtempSync(join(tmpdir(), 'upkeep-window-profile-'))
  const installDir = mkdtempSync(join(tmpdir(), 'upkeep-window-runtime-'))
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
  // A guide for an OLDER release: the plugin already absorbed it, so it must not match.
  const guideDir = join(installDir, 'docs', 'upgrade-guide', 'v0.2.2-rc.1', 'tools')
  mkdirSync(guideDir, { recursive: true })
  writeFileSync(join(guideDir, 'guide.md'), [
    '---', 'kind: upgrade-guide', 'description: "Tools moved."', '---', '',
    '## Change', 'Use ctx.tools through @deepseek-ai/dsh-tools.', '', '## Migration', '1. Update.', '',
  ].join('\n'))

  const packageDir = join(profileDir, 'node_modules', '@sleep9ull', 'plugin')
  mkdirSync(join(packageDir, 'src'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@sleep9ull/plugin', version: '1.0.0', engines: { dsh: '^0.2.2-rc.1' },
  }))
  writeFileSync(join(packageDir, 'src', 'index.js'), "import '@deepseek-ai/dsh-tools'\nctx.tools.register({})\n")

  const hub = createHub(fakeContext({
    bundles: [{ name: '@sleep9ull/plugin', version: '1.0.0', enabled: true, rows: [] }],
    profileDir,
    installAnchor: join(installDir, 'package.json'),
    home,
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false, targetVersion: '0.2.2-rc.3' }), {
    home, startupCheck: false, now: () => 3_000,
  })

  const status = await hub.call('check', {}, { caller: 'client' }) as {
    bundles: Array<{ compat: { impact?: { matched: number } }; maintenance: { state: string } }>
  }
  assert.equal(status.bundles[0]?.compat.impact?.matched ?? 0, 0, 'nothing from an older release is reported')
  assert.equal(status.bundles[0]?.maintenance.state, 'ok', 'and the plugin stays healthy')

  const report = await hub.call('report.get', { bundle: '@sleep9ull/plugin' }, { caller: 'tool' }) as {
    guideSource: string
    matched: unknown[]
  }
  assert.equal(report.guideSource, 'none')
  assert.equal(report.matched.length, 0)
})

test('merging retires the worktree and its branch', async () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-retire-'))
  const profileDir = mkdtempSync(join(tmpdir(), 'upkeep-retire-profile-'))
  const installDir = mkdtempSync(join(tmpdir(), 'upkeep-retire-runtime-'))
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
  const packageDir = join(profileDir, 'node_modules', '@sleep9ull', 'plugin')
  mkdirSync(join(packageDir, 'src'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@sleep9ull/plugin', version: '1.0.0', engines: { dsh: '^0.2.2-rc.1' } }))
  writeFileSync(join(packageDir, 'src', 'index.js'), 'void 0\n')

  const calls: string[][] = []
  const exec = {
    run: async (command: string, args: string[]) => {
      calls.push([command, ...args])
      const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', timedOut: false })
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('upkeep/x\n')
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--git-common-dir') return ok(packageDir + '/.git\n')
      if (command === 'git' && args[0] === 'rev-parse') return ok(packageDir + '\n')
      if (command === 'git' && args[0] === 'remote') return ok('git@github.com:o/r.git\n')
      if (command === 'git' && args[0] === 'status') return ok('')
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
    home, startupCheck: false, now: () => 15_000, exec,
  })

  const prepared = await hub.call('upgrade.prepare', { bundle: '@sleep9ull/plugin', worktree: true, confirm: true }, { caller: 'client' }) as {
    run: { id: string; workspacePath: string; branch?: string; worktree: boolean }
  }
  assert.equal(prepared.run.worktree, true)
  assert.ok(prepared.run.branch?.startsWith('upkeep/'))

  await hub.call('delivery.create-pr', { runId: prepared.run.id, confirm: true }, { caller: 'client' })
  calls.length = 0
  const merged = await hub.call('delivery.merge', { runId: prepared.run.id, confirm: true }, { caller: 'client' }) as { cleanup: string[] }

  assert.deepEqual(merged.cleanup, [prepared.run.workspacePath])
  assert.ok(calls.some(call => call[1] === 'worktree' && call[2] === 'remove' && call[4] === prepared.run.workspacePath))
  assert.ok(calls.some(call => call[1] === 'branch' && call[2] === '-D' && call[3] === prepared.run.branch))
})

test('schedule.refresh rewrites an old launcher but leaves a rewritten prompt alone', async () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-launch-'))
  const profileDir = mkdtempSync(join(tmpdir(), 'upkeep-launch-profile-'))
  const installDir = mkdtempSync(join(tmpdir(), 'upkeep-launch-runtime-'))
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
  const packageDir = join(profileDir, 'node_modules', '@sleep9ull', 'plugin')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@sleep9ull/plugin', version: '1.0.0', engines: { dsh: '^0.2.2-rc.1' } }))

  const edits: Array<Record<string, unknown>> = []
  const schedule = {
    create: async () => ({}),
    catalog: async () => [
      {
        id: 'old-launcher', title: 'Upkeep compatibility check', status: 'active', updatedAt: 'T1',
        prompt: 'Run the dsh-upkeep compatibility check.\n\nold instructions\n\n<!-- upkeep-task:v1 -->',
      },
      {
        id: 'customised', title: 'Upkeep compatibility check (mine)', status: 'active', updatedAt: 'T2',
        prompt: 'My own reminder text <!-- upkeep-task:v1 -->',
      },
      { id: 'current', title: 'Upkeep compatibility check (fresh)', status: 'active', updatedAt: 'T3', prompt: 'Run the dsh-upkeep compatibility check.\n\n<!-- upkeep-task:v2 -->' },
    ],
    edit: async (request: unknown) => { edits.push(request as Record<string, unknown>); return { id: (request as { id: string }).id } },
  }
  const hub = createHub(fakeContext({
    bundles: [{ name: '@sleep9ull/plugin', version: '1.0.0', enabled: true, rows: [] }],
    profileDir,
    installAnchor: join(installDir, 'package.json'),
    home,
    schedule,
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false, targetVersion: '0.2.2-rc.3' }), {
    home, startupCheck: false, now: () => 20_000,
  })

  // A check is read-shaped: it must not touch the author's tasks.
  await hub.call('check', {}, { caller: 'client' })
  assert.equal(edits.length, 0, 'a check does not rewrite stored tasks')

  await assert.rejects(
    () => hub.call('schedule.refresh', { confirm: false }, { caller: 'client' }),
    (error: unknown) => (error as { code?: string }).code === 'CONFIRM_REQUIRED',
  )
  const refreshed = await hub.call('schedule.refresh', { confirm: true }, { caller: 'client' }) as {
    refreshed: boolean
    warnings: string[]
  }

  assert.equal(edits.length, 1, 'only the outdated launcher is rewritten')
  assert.equal(edits[0]?.id, 'old-launcher')
  assert.equal(edits[0]?.action, 'update')
  assert.equal(edits[0]?.expectedUpdatedAt, 'T1', 'the edit keeps the concurrency token')
  const patch = edits[0]?.patch as { prompt: string }
  assert.match(patch.prompt, /follow the `brief` block/)
  assert.equal(refreshed.refreshed, true)
  assert.ok(refreshed.warnings.some(warning => /Refreshed the launcher/.test(warning)))

  // The policy travels with the snapshot, not with the task.
  const status = await hub.call('status', {}, { caller: 'client' }) as { brief: { version: number; lines: string[] } }
  assert.ok(status.brief.lines.length >= 4)
  assert.ok(status.brief.lines.some(line => /P0 \(data loss/.test(line)))
})

test('startup refreshes old launchers even when the startup check is off', async () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-startup-'))
  const profileDir = mkdtempSync(join(tmpdir(), 'upkeep-startup-profile-'))
  const installDir = mkdtempSync(join(tmpdir(), 'upkeep-startup-runtime-'))
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
  const packageDir = join(profileDir, 'node_modules', '@sleep9ull', 'plugin')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@sleep9ull/plugin', version: '1.0.0', engines: { dsh: '^0.2.2-rc.1' } }))

  const edits: Array<Record<string, unknown>> = []
  const schedule = {
    create: async () => ({}),
    catalog: async () => [{
      id: 'old', title: 'Upkeep compatibility check', status: 'active', updatedAt: 'T1',
      prompt: 'Run the dsh-upkeep compatibility check.\n\nold\n\n<!-- upkeep-task:v1 -->',
    }],
    edit: async (request: unknown) => { edits.push(request as Record<string, unknown>); return { id: 'old' } },
  }
  // checkOnStartup stays false: only the launcher refresh should run.
  createHub(fakeContext({
    bundles: [{ name: '@sleep9ull/plugin', version: '1.0.0', enabled: true, rows: [] }],
    profileDir,
    installAnchor: join(installDir, 'package.json'),
    home,
    schedule,
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false, checkOnStartup: false }), {
    home, now: () => 30_000, startupDelayMs: 0,
  })

  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(edits.length, 1, 'the stored launcher was refreshed at startup')
  assert.equal(edits[0]?.id, 'old')
  assert.match(((edits[0]?.patch as { prompt: string }).prompt), /follow the `brief` block/)
})

test('a preparation that cannot register its workspace removes the worktree it made', async () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-rollback-'))
  const profileDir = mkdtempSync(join(tmpdir(), 'upkeep-rollback-profile-'))
  const installDir = mkdtempSync(join(tmpdir(), 'upkeep-rollback-runtime-'))
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
  const packageDir = join(profileDir, 'node_modules', '@sleep9ull', 'plugin')
  mkdirSync(join(packageDir, 'src'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@sleep9ull/plugin', version: '1.0.0', engines: { dsh: '^0.2.2-rc.1' } }))
  writeFileSync(join(packageDir, 'src', 'index.js'), 'void 0\n')

  const calls: string[][] = []
  const exec = {
    run: async (command: string, args: string[]) => {
      calls.push([command, ...args])
      if (command === 'git' && args[0] === 'rev-parse') return { exitCode: 0, stdout: packageDir + '\n', stderr: '', timedOut: false }
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    },
  }
  const hub = createHub(fakeContext({
    bundles: [{ name: '@sleep9ull/plugin', version: '1.0.0', enabled: true, rows: [], source: 'link:' + packageDir }],
    profileDir,
    installAnchor: join(installDir, 'package.json'),
    home,
    workspaceRegistry: { create: async () => { throw new Error('registry offline') } },
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false, targetVersion: '0.2.2-rc.3' }), {
    home, startupCheck: false, now: () => 40_000, exec,
  })

  await assert.rejects(() => hub.call('upgrade.prepare', { bundle: '@sleep9ull/plugin', worktree: true, confirm: true }, { caller: 'client' }))
  assert.ok(calls.some(call => call[1] === 'worktree' && call[2] === 'remove'), 'the orphan worktree was removed')
  assert.ok(calls.some(call => call[1] === 'branch' && call[2] === '-D'), 'and its branch too')
})

test('schedule.remove deletes only the task that belongs to the named plugin', async () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-remove-'))
  const profileDir = mkdtempSync(join(tmpdir(), 'upkeep-remove-profile-'))
  const installDir = mkdtempSync(join(tmpdir(), 'upkeep-remove-runtime-'))
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
  const packageDir = join(profileDir, 'node_modules', '@sleep9ull', 'plugin')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@sleep9ull/plugin', version: '1.0.0', engines: { dsh: '^0.2.2-rc.3' } }))

  const edits: Array<Record<string, unknown>> = []
  const schedule = {
    create: async () => ({}),
    catalog: async () => [
      { id: 'mine', title: 'Upkeep: @sleep9ull/plugin', status: 'active', updatedAt: 'T1', everySeconds: 86_400 },
      { id: 'other', title: 'Upkeep: @sleep9ull/other', status: 'active', updatedAt: 'T2', everySeconds: 86_400 },
      { id: 'global', title: 'Upkeep compatibility check', status: 'active', updatedAt: 'T3', everySeconds: 86_400 },
    ],
    edit: async (request: unknown) => { edits.push(request as Record<string, unknown>); return { id: 'mine', deleted: true } },
  }
  const hub = createHub(fakeContext({
    bundles: [{ name: '@sleep9ull/plugin', version: '1.0.0', enabled: true, rows: [] }],
    profileDir,
    installAnchor: join(installDir, 'package.json'),
    home,
    schedule,
  }), normalizeConfig({ ownerHandles: 'sleep9ull', autoDetectOwner: false }), {
    home, startupCheck: false, now: () => 50_000,
  })

  await assert.rejects(
    () => hub.call('schedule.remove', { bundle: '@sleep9ull/plugin', confirm: false }, { caller: 'client' }),
    (error: unknown) => (error as { code?: string }).code === 'CONFIRM_REQUIRED',
  )

  const removed = await hub.call('schedule.remove', { bundle: '@sleep9ull/plugin', confirm: true }, { caller: 'client' }) as { removed: boolean }
  assert.equal(removed.removed, true)
  assert.equal(edits.length, 1, 'one task deleted')
  assert.equal(edits[0]?.id, 'mine')
  assert.equal(edits[0]?.action, 'delete')
  assert.equal(edits[0]?.expectedUpdatedAt, 'T1')

  // A plugin without a task gets a stable refusal rather than deleting something else.
  await assert.rejects(
    () => hub.call('schedule.remove', { bundle: '@sleep9ull/nothing', confirm: true }, { caller: 'client' }),
    (error: unknown) => (error as { code?: string }).code === 'TASK_NOT_FOUND',
  )
})

test('a request with locale zh reads its warnings in Chinese', async () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-locale-'))
  const profileDir = mkdtempSync(join(tmpdir(), 'upkeep-locale-profile-'))
  const installDir = mkdtempSync(join(tmpdir(), 'upkeep-locale-runtime-'))
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
  const packageDir = join(profileDir, 'node_modules', '@sleep9ull', 'plugin')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@sleep9ull/plugin', version: '1.0.0', engines: { dsh: '^0.2.2-rc.3' } }))

  const hub = createHub(fakeContext({
    bundles: [{ name: '@sleep9ull/plugin', version: '1.0.0', enabled: true, rows: [], source: 'link:' + packageDir }],
    profileDir,
    installAnchor: join(installDir, 'package.json'),
    home,
  }), normalizeConfig({ autoDetectOwner: false }), { home, startupCheck: false, now: () => 60_000 })

  const english = await hub.call('status', {}, { caller: 'client' }) as { warnings: string[] }
  assert.ok(english.warnings.some(text => /No owner identity/.test(text)), 'the default is English')

  const chinese = await hub.call('status', { locale: 'zh-CN' }, { caller: 'client' }) as { warnings: string[] }
  assert.ok(chinese.warnings.some(text => /没有检测到你的身份/.test(text)), 'a zh request reads Chinese')
  assert.ok(!chinese.warnings.some(text => /No owner identity/.test(text)))
})
