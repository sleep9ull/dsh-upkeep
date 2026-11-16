import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

import { JSDOM } from 'jsdom'

/**
 * Interaction smoke test.
 *
 * A static render cannot press a button, so the scheduling dialog — the one path
 * where the panel holds state and then calls the Host — was unverified. This test
 * mounts the real bundle in jsdom, clicks Create, edits the time, and asserts the
 * Host call that follows.
 */

const nodeRequire = createRequire(import.meta.url)
const React = nodeRequire('react') as {
  createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown
}
/** react-dom needs the DOM globals present before it is loaded. */
type ReactDOMClient = {
  createRoot(container: Element): { render(element: unknown): void; unmount(): void }
}
type TestUtils = { act(callback: () => void | Promise<void>): void | Promise<void> }

const ReactShim = {
  ...React,
  useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown): unknown {
    return getSnapshot()
  },
}

/** Boot the bundle once and keep its registered components. */
function bootComponents(): Map<string, unknown> {
  const source = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')
  let captured: { factory(require: (id: string) => unknown): unknown } | undefined
  const window = {
    __ModuleLoader__: {
      load(spec: { factory(require: (id: string) => unknown): unknown }): void { captured = spec },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    confirm: undefined,
  }
  const context = vm.createContext({
    window,
    React: ReactShim,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Promise,
  })
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.ok(captured !== undefined)

  const dictionaries = new Map<string, Record<string, Record<string, string>>>()
  const registrations = new Map<string, unknown>()
  const translate = (key: string, vars?: Record<string, string | number>): string => {
    const raw = dictionaries.get('upkeep')?.en?.[key] ?? key
    if (vars === undefined) return raw
    return raw.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
  }
  const ctx = {
    effect(callback: () => unknown): void { callback() },
    locale: {
      bind: () => translate,
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
    connection: { fetch: { register: () => () => {} }, rpc: { call: async () => ({}) } },
    layout: { selectPanel: () => {} },
    uiWorkspace: { startSession: () => {} },
    get: () => undefined,
  }
  ;(captured.factory((id: string) => (id === 'react' ? ReactShim : (() => { throw new Error(id) })())) as {
    apply(ctx: unknown): void
  }).apply(ctx)
  return registrations
}

test('pressing Create opens the dialog and Save sends the chosen time', async () => {
  const components = bootComponents()
  const panel = components.get('main') as unknown as (props: unknown) => unknown

  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' })
  // React DOM reads window/document from the global scope.
  const globals = globalThis as unknown as Record<string, unknown>
  globals.window = dom.window
  globals.document = dom.window.document
  globals.IS_REACT_ACT_ENVIRONMENT = true
  // Node defines navigator as a getter-only global; leave it alone.
  const ReactDOMClient = nodeRequire('react-dom/client') as ReactDOMClient
  const TestUtils = nodeRequire('react-dom/test-utils') as TestUtils
  const container = dom.window.document.getElementById('root')
  assert.ok(container !== null)

  const calls: Array<[string, string]> = []
  const store = {
    subscribe: () => () => {},
    get: () => ({
      phase: 'ready',
      error: null,
      data: {
        dsh: { runtimeVersion: '0.2.2-rc.3' },
        plugin: { name: '@sleep9ull/dsh-upkeep', version: '0.1.0' },
        profile: { name: 'desktop' },
        target: { version: '0.2.2-rc.3', channel: 'next' },
        ownership: { mine: 1, other: 0, unknown: 0 },
        excluded: { bundles: 0, entries: 0 },
        warnings: [],
        capabilities: { schedule: true, workspaceRegistry: true },
        scheduled: { available: true, tasks: [] },
        bundles: [{
          name: '@sleep9ull/plugin',
          version: '1.0.0',
          enabled: true,
          rowCount: 0,
          owner: { status: 'mine', evidence: [] },
          maintenance: { state: 'ok', reasons: [] },
          compat: {
            running: { status: 'compatible', requirements: {}, exempted: false },
            target: { status: 'compatible', requirements: {}, exempted: false },
            runtime: { failed: 0, pending: 0 },
          },
        }],
      },
    }),
    refresh: async () => {},
    check: async () => {},
    upgrade: async () => {},
    verify: async () => {},
    createPr: async () => {},
    merge: async () => {},
    createSchedule: async (bundle: string, time: string) => { calls.push([bundle, time]) },
  }

  const root = ReactDOMClient.createRoot(container)
  const translate = ((key: string, vars?: Record<string, string | number>) => {
    const raw = (({
      create: 'Create',
      cancel: 'Cancel',
      scheduleTitle: 'Schedule a compatibility check',
      scheduleTime: 'Time of day',
      scheduleHint: 'The task runs every day at this local time.',
    } as Record<string, string>)[key]) ?? key
    if (vars === undefined) return raw
    return raw.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
  }) as (key: string, vars?: Record<string, string | number>) => string

  await TestUtils.act(async () => {
    root.render(React.createElement(panel, { store, t: translate, locale: 'en' }))
  })

  const document = dom.window.document
  const create = document.querySelector('.upkeep-scheduled button')
  assert.ok(create !== null, 'the row offers a Create action')
  assert.equal(create.textContent, 'Create')
  assert.equal(document.querySelector('.upkeep-modal'), null, 'no dialog before pressing')

  await TestUtils.act(async () => {
    create.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })

  const modal = document.querySelector('.upkeep-modal')
  assert.ok(modal !== null, 'pressing Create opens the dialog')
  assert.equal(modal.getAttribute('role'), 'dialog')
  const input = modal.querySelector('input[type="time"]') as HTMLInputElement
  assert.ok(input !== null, 'the dialog holds a time input')
  assert.equal(input.value, '08:00', 'the default is 08:00 local')

  // React tracks the value node, so set it through the native setter.
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
  assert.ok(setValue !== undefined)
  await TestUtils.act(async () => {
    setValue.call(input, '09:30')
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  assert.equal((modal.querySelector('input[type="time"]') as HTMLInputElement).value, '09:30')

  const save = modal.querySelector('.upkeep-modal-actions [data-variant="primary"]') as HTMLElement
  assert.ok(save !== null)
  assert.equal(save.textContent, 'Create')
  await TestUtils.act(async () => {
    save.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })

  assert.deepEqual(calls, [['@sleep9ull/plugin', '09:30']], 'Save sends the plugin and the chosen time')
  assert.equal(document.querySelector('.upkeep-modal'), null, 'the dialog closes after saving')

  await TestUtils.act(async () => { root.unmount() })
})
