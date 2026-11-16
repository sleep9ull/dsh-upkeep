import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

/**
 * Render smoke test.
 *
 * The Client half is a browser script, so nothing else in the suite executes it:
 * a temporal-dead-zone bug or a bad hook order inside the panel blanks the whole
 * page while types and string assertions stay green. This test boots the real
 * bundle in a VM, hands it the loader's `require('react')`, and renders the panel
 * with fixture snapshots for the ready, empty, and error paths.
 */

const nodeRequire = createRequire(import.meta.url)
const React = nodeRequire('react') as {
  createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown
}

/**
 * The Client half subscribes with `useSyncExternalStore(subscribe, get)`, which is
 * correct in the browser but rejects a server render that has no third snapshot.
 * Static rendering only needs the current value, so the shim returns the snapshot
 * and delegates every other hook to the real React.
 */
const ReactShim = {
  ...React,
  useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown): unknown {
    return getSnapshot()
  },
} as typeof React & Record<string, unknown>
const { renderToStaticMarkup } = nodeRequire('react-dom/server') as {
  renderToStaticMarkup: (element: unknown) => string
}

/** Load `dist/client.js` in a VM and return its module plus the locale tables. */
function bootClient(): {
  module: { apply(ctx: unknown): void }
  translate(id: string): (key: string, vars?: Record<string, string | number>) => string
} {
  const source = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')
  const dictionaries = new Map<string, Record<string, Record<string, string>>>()
  let captured: { factory(require: (id: string) => unknown): unknown } | undefined

  const storage = new Map<string, string>()
  const window = {
    __ModuleLoader__: {
      load(spec: { factory(require: (id: string) => unknown): unknown }): void { captured = spec },
    },
    localStorage: {
      getItem(key: string): string | null { return storage.get(key) ?? null },
      setItem(key: string, value: string): void { storage.set(key, value) },
    },
  }
  const context = vm.createContext({
    window,
    React: ReactShim,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Promise,
    require(id: string): unknown {
      if (id === 'react') return React
      throw new Error(`unexpected require: ${id}`)
    },
  })
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.ok(captured !== undefined, 'the bundle registered itself with the module loader')

  const module = captured.factory((id: string) => (id === 'react' ? ReactShim : (() => { throw new Error(id) })())) as {
    apply(ctx: unknown): void
  }

  /** Translate like the host does: `{name}` substitution over the en table. */
  const translate = (id: string): (key: string, vars?: Record<string, string | number>) => string => {
    return (key, vars) => {
      // Looked up per call: apply() registers the tables after it binds the translator.
      const raw = dictionaries.get(id)?.en?.[key] ?? key
      if (vars === undefined) return raw
      return raw.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
    }
  }

  // The dictionaries are registered by apply() itself, so run it once here.
  const registrations = new Map<string, unknown>()
  const ctx = {
    effect(callback: () => unknown): void { callback() },
    locale: {
      bind: (id: string) => translate(id),
      register(id: string, tables: Record<string, Record<string, string>>): () => void {
        dictionaries.set(id, tables)
        return () => {}
      },
      getLocale: () => ({ id: 'en' }),
    },
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register(options: { name: string }, component: unknown): () => void {
        registrations.set(options.name, component)
        return () => {}
      },
    },
    connection: {
      fetch: { register: () => () => {} },
      rpc: { call: async () => ({}) },
    },
    layout: { selectPanel: () => {} },
    uiWorkspace: { startSession: () => {} },
    get: () => undefined,
  }
  module.apply(ctx)
  ;(module as unknown as { registrations: Map<string, unknown> }).registrations = registrations

  return { module, translate }
}

/** A snapshot with one healthy plugin and one that needs care. */
const SNAPSHOT = {
  dsh: { runtimeVersion: '0.2.2-rc.3', installAnchor: '/runtime/package.json' },
  plugin: { name: '@sleep9ull/dsh-upkeep', version: '0.1.0' },
  profile: { name: 'desktop', dir: '/profile' },
  target: { version: '0.2.3-rc.1', channel: 'next', fetchedAt: 1_700_000_000_000, source: 'network', stale: false },
  bundles: [
    {
      name: '@sleep9ull/healthy',
      version: '1.0.0',
      enabled: true,
      rowCount: 2,
      source: 'link',
      owner: { status: 'mine', evidence: ['scope:@sleep9ull'] },
      maintenance: { state: 'ok', reasons: [] },
      compat: {
        running: { status: 'compatible', requirements: {}, exempted: false },
        target: { status: 'compatible', requirements: {}, exempted: false },
        runtime: { failed: 0, pending: 0 },
      },
    },
    {
      name: '@sleep9ull/careful',
      version: '2.0.0',
      enabled: true,
      rowCount: 1,
      source: 'link',
      owner: { status: 'mine', evidence: ['scope:@sleep9ull'] },
      maintenance: { state: 'attention', reasons: ['will break on 0.2.3-rc.1'] },
      compat: {
        running: { status: 'compatible', requirements: {}, exempted: false },
        target: { status: 'incompatible', requirements: { 'engines.dsh': '>=0.2.2-rc.1 <0.2.3-rc.1' }, exempted: false },
        runtime: { failed: 0, pending: 0 },
        impact: { matched: 3, versions: ['0.2.3-rc.1'], top: [] },
      },
    },
    {
      name: 'someone-else',
      version: '0.9.0',
      enabled: false,
      rowCount: 0,
      owner: { status: 'other', evidence: ['author:someone'] },
      maintenance: { state: 'not-mine', reasons: [] },
      compat: {
        running: { status: 'unknown', requirements: {}, exempted: false, reason: 'not readable' },
        target: null,
        runtime: { failed: 0, pending: 0 },
      },
    },
  ],
  ownership: { mine: 2, other: 1, unknown: 0 },
  excluded: { bundles: 4, entries: 12 },
  warnings: ['The DSH version feed is unavailable; using the cached target.'],
  capabilities: { schedule: true, workspaceRegistry: true },
  scheduled: {
    available: true,
    tasks: [{
      bundle: '@sleep9ull/careful',
      title: 'Upkeep: @sleep9ull/careful',
      everySeconds: 86_400,
      nextAt: '2026-11-17T00:00:00.000Z',
    }],
  },
  delivery: { allowMerge: false, baseBranch: 'main' },
}

/** A store whose state never changes during the render. */
function fakeStore(state: { phase: string; data: unknown; error: unknown }): unknown {
  return {
    subscribe: () => () => {},
    get: () => state,
    refresh: async () => {},
    check: async () => {},
    upgrade: async () => {},
    verify: async () => {},
    createPr: async () => {},
    merge: async () => {},
    createSchedule: async () => {},
  }
}

test('the panel renders the ledger, its columns and the care sentence', () => {
  const { module, translate } = bootClient()
  const registrations = (module as unknown as { registrations: Map<string, unknown> }).registrations
  const panel = registrations.get('main')
  assert.ok(typeof panel === 'function', 'the main panel registered a component')

  const t = translate('upkeep')
  const markup = renderToStaticMarkup(React.createElement(panel, {
    store: fakeStore({ phase: 'ready', data: SNAPSHOT, error: null }),
    t,
    locale: 'en',
  }))

  assert.match(markup, /upkeep-table/)
  assert.match(markup, /@sleep9ull\/healthy/)
  assert.match(markup, /@sleep9ull\/careful/)
  // One sentence answers the question, and the ledger keeps one status column.
  assert.match(markup, /needs care/)
  assert.match(markup, /Scheduled/)
  // The care row offers Upgrade; the healthy one does not.
  assert.equal((markup.match(/>Upgrade</g) ?? []).length, 1)
  // The plugin with a task shows its cadence; the other offers Create.
  assert.equal((markup.match(/Every 24h/g) ?? []).length, 1)
  assert.equal((markup.match(/>Create</g) ?? []).length, 1)
  assert.doesNotMatch(markup, /New Scheduled/)
})

test('the panel renders its loading, empty and error states', () => {
  const { module, translate } = bootClient()
  const registrations = (module as unknown as { registrations: Map<string, unknown> }).registrations
  const panel = registrations.get('main') as unknown as (props: unknown) => unknown
  const t = translate('upkeep')

  const loading = renderToStaticMarkup(React.createElement(panel, {
    store: fakeStore({ phase: 'loading', data: null, error: null }),
    t,
    locale: 'en',
  }))
  assert.match(loading, /upkeep/)

  const failed = renderToStaticMarkup(React.createElement(panel, {
    store: fakeStore({ phase: 'error', data: null, error: { code: 'BUSY', message: 'busy' } }),
    t,
    locale: 'en',
  }))
  assert.match(failed, /BUSY/)

  const bare = renderToStaticMarkup(React.createElement(panel, {
    store: fakeStore({ phase: 'ready', data: { ...SNAPSHOT, bundles: [], ownership: { mine: 0, other: 0, unknown: 0 } }, error: null }),
    t,
    locale: 'en',
  }))
  assert.match(bare, /upkeep/)
})

test('the settings tab renders with the same data', () => {
  const { module, translate } = bootClient()
  const registrations = (module as unknown as { registrations: Map<string, unknown> }).registrations
  const tab = registrations.get('settings.plugins.tab') as unknown as (props: unknown) => unknown
  assert.ok(typeof tab === 'function')

  const markup = renderToStaticMarkup(React.createElement(tab, {
    store: fakeStore({ phase: 'ready', data: SNAPSHOT, error: null }),
    t: translate('upkeep'),
    locale: 'en',
    openPanel: () => {},
  }))
  assert.match(markup, /upkeep-table/)
  assert.match(markup, /Open panel/)
})
