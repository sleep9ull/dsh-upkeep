import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

import { JSDOM } from 'jsdom'

/**
 * Interaction smoke test.
 *
 * A static render cannot press a button, so the paths where the panel holds state
 * and then calls the Host were unverified: the schedule dialog and the upgrade
 * dialog. This file mounts the real bundle in jsdom and drives them.
 */

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' })
// React DOM reads window/document from the global scope, so install them first.
const globals = globalThis as unknown as Record<string, unknown>
globals.window = dom.window
globals.document = dom.window.document
globals.IS_REACT_ACT_ENVIRONMENT = true

const nodeRequire = createRequire(import.meta.url)
const React = nodeRequire('react') as {
  createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown
}
const ReactDOMClient = nodeRequire('react-dom/client') as {
  createRoot(container: Element): { render(element: unknown): void; unmount(): void }
}
const TestUtils = nodeRequire('react-dom/test-utils') as {
  act(callback: () => void | Promise<void>): void | Promise<void>
}

const ReactShim = {
  ...React,
  useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown): unknown {
    return getSnapshot()
  },
}

const DICTIONARY: Record<string, string> = {
  create: 'Create',
  upgrade: 'Upgrade',
  prepare: 'Prepare',
  cancel: 'Cancel',
  scheduleTitle: 'Schedule a compatibility check',
  scheduleTime: 'Time of day',
  scheduleHint: 'The task runs every day at this local time.',
  stopTitle: 'Stop this scheduled check',
  stopHint: 'The task is deleted.',
  stopSchedule: 'Stop',
  stop: 'Stop',
  scheduleAt: '{time} {cadence}',
  everyday: 'everyday',
  upgradeTitle: 'Prepare a targeted upgrade',
  worktreeOption: 'Edit in a separate git worktree',
  upgradeHint: 'Upkeep matches the guides and opens a session.',
}

function translate(key: string, vars?: Record<string, string | number>): string {
  const raw = DICTIONARY[key] ?? key
  if (vars === undefined) return raw
  return raw.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
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

  const registrations = new Map<string, unknown>()
  const ctx = {
    effect(callback: () => unknown): void { callback() },
    locale: {
      bind: () => translate,
      register(): () => void { return () => {} },
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

const components = bootComponents()
const panel = components.get('main') as unknown as (props: unknown) => unknown

/** A store whose snapshot is fixed, recording the calls the panel makes. */
function fakeStore(care: boolean): {
  store: unknown
  schedules: Array<[string, string]>
  upgrades: Array<[string, boolean]>
} {
  const schedules: Array<[string, string]> = []
  const upgrades: Array<[string, boolean]> = []
  const store = {
    subscribe: () => () => {},
    get: () => ({
      phase: 'ready',
      error: null,
      data: {
        dsh: { runtimeVersion: '0.2.2-rc.3' },
        plugin: { name: '@sleep9ull/dsh-upkeep', version: '0.1.0' },
        profile: { name: 'desktop' },
        target: { version: '0.2.3-rc.1', channel: 'next' },
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
          maintenance: care
            ? { state: 'attention', reasons: ['will break on 0.2.3-rc.1'] }
            : { state: 'ok', reasons: [] },
          compat: {
            running: { status: 'compatible', requirements: {}, exempted: false },
            target: { status: care ? 'incompatible' : 'compatible', requirements: {}, exempted: false },
            runtime: { failed: 0, pending: 0 },
          },
        }],
      },
    }),
    refresh: async () => {},
    check: async () => {},
    upgrade: async (name: string, worktree: boolean) => { upgrades.push([name, worktree]) },
    verify: async () => {},
    createPr: async () => {},
    merge: async () => {},
    createSchedule: async (bundle: string, time: string) => { schedules.push([bundle, time]) },
  }
  return { store, schedules, upgrades }
}

/** Mount the panel into a fresh container. */
function mount(store: unknown): { container: HTMLElement; root: { unmount(): void } } {
  const container = dom.window.document.createElement('div')
  dom.window.document.body.append(container)
  const root = ReactDOMClient.createRoot(container)
  TestUtils.act(() => {
    root.render(React.createElement(panel, { store, t: translate, locale: 'en' }))
  })
  return { container, root: root as unknown as { unmount(): void } }
}

function click(element: Element): void {
  TestUtils.act(() => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}

test('pressing Create opens the dialog and Save sends the chosen time', () => {
  const { store, schedules } = fakeStore(false)
  const { container, root } = mount(store)
  const document = dom.window.document

  const create = container.querySelector('.upkeep-scheduled button')
  assert.ok(create !== null, 'the row offers a Create action')
  assert.equal(create.textContent, 'Create')
  assert.equal(container.querySelector('.upkeep-modal'), null, 'no dialog before pressing')

  click(create)
  const modal = container.querySelector('.upkeep-modal')
  assert.ok(modal !== null, 'pressing Create opens the dialog')
  assert.equal(modal.getAttribute('role'), 'dialog')
  const input = modal.querySelector('input[type="time"]') as HTMLInputElement
  assert.ok(input !== null, 'the dialog holds a time input')
  assert.equal(input.value, '08:00', 'the default is 08:00 local')

  // React tracks the value node, so set it through the native setter.
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
  assert.ok(setValue !== undefined)
  TestUtils.act(() => {
    setValue.call(input, '09:30')
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  assert.equal((container.querySelector('input[type="time"]') as HTMLInputElement).value, '09:30')

  const save = modal.querySelector('.upkeep-modal-actions [data-variant="primary"]') as HTMLElement
  assert.ok(save !== null)
  assert.equal(save.textContent, 'Create')
  click(save)

  assert.deepEqual(schedules, [['@sleep9ull/plugin', '09:30']], 'Save sends the plugin and the chosen time')
  assert.equal(container.querySelector('.upkeep-modal'), null, 'the dialog closes after saving')
  TestUtils.act(() => { root.unmount() })
  container.remove()
  void document
})

test('pressing Upgrade opens the preparation dialog and carries the worktree choice', () => {
  const { store, upgrades } = fakeStore(true)
  const { container, root } = mount(store)

  const upgrade = container.querySelector('.upkeep-col-actions button')
  assert.ok(upgrade !== null, 'a plugin that needs care offers Upgrade')
  assert.equal(upgrade.textContent, 'Upgrade')

  click(upgrade)
  const modal = container.querySelector('.upkeep-modal')
  assert.ok(modal !== null, 'pressing Upgrade opens its dialog')
  assert.match(modal.textContent ?? '', /Prepare a targeted upgrade/)
  assert.match(modal.textContent ?? '', /@sleep9ull\/plugin/)

  const checkbox = modal.querySelector('input[type="checkbox"]') as HTMLInputElement
  assert.ok(checkbox !== null, 'the dialog offers the worktree choice')
  assert.equal(checkbox.checked, false, 'the checkout is the default')
  click(checkbox)
  assert.equal((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked, true)

  const prepare = modal.querySelector('.upkeep-modal-actions [data-variant="primary"]') as HTMLElement
  assert.equal(prepare.textContent, 'Prepare')
  click(prepare)

  assert.deepEqual(upgrades, [['@sleep9ull/plugin', true]], 'Prepare forwards the plugin and the worktree choice')
  assert.equal(container.querySelector('.upkeep-modal'), null, 'the dialog closes after starting')
  TestUtils.act(() => { root.unmount() })
  container.remove()
})

test('Cancel closes a dialog without calling the Host', () => {
  const { store, upgrades } = fakeStore(true)
  const { container, root } = mount(store)

  const upgrade = container.querySelector('.upkeep-col-actions button')
  assert.ok(upgrade !== null)
  click(upgrade)
  const cancel = container.querySelector('.upkeep-modal-actions .upkeep-btn') as HTMLElement
  assert.ok(cancel !== null)
  assert.equal(cancel.textContent, 'Cancel')
  click(cancel)

  assert.equal(container.querySelector('.upkeep-modal'), null)
  assert.deepEqual(upgrades, [], 'Cancel makes no call')
  TestUtils.act(() => { root.unmount() })
  container.remove()
})

test('pressing Stop asks once, then deletes that plugin\'s task', () => {
  const base = fakeStore(false)
  const typed = base.store as { get: () => { data: { scheduled: { available: boolean; tasks: unknown[] } } } }
  const snapshot = typed.get()
  // Next run at 08:00 local, the way a daily task is created.
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(8, 0, 0, 0)
  snapshot.data.scheduled.tasks = [{
    bundle: '@sleep9ull/plugin',
    title: 'Upkeep: @sleep9ull/plugin',
    everySeconds: 86_400,
    nextAt: tomorrow.toISOString(),
  }]
  const removed: string[] = []
  const store = { ...(base.store as object), get: () => snapshot, removeSchedule: async (bundle: string) => { removed.push(bundle) } }

  const { container, root } = mount(store)
  const document = dom.window.document
  const stop = container.querySelector('.upkeep-col-scheduled .upkeep-stop')
  assert.ok(stop !== null, 'a scheduled row offers Stop next to its cadence')
  assert.equal(stop.textContent, 'Stop')
  assert.match(container.textContent ?? '', /8:00am/, 'the cadence is shown beside it')

  click(stop)
  const modal = container.querySelector('.upkeep-modal')
  assert.ok(modal !== null, 'Stop opens the dialog')
  assert.match(modal.textContent ?? '', /Stop this scheduled check/)
  const confirm = Array.from(modal.querySelectorAll('button')).find(button => button.textContent === 'Stop')
  assert.ok(confirm !== undefined, 'the dialog confirms with Stop, not Create')

  click(confirm)
  assert.deepEqual(removed, ['@sleep9ull/plugin'], 'the panel asks the Host to delete that task')
  root.unmount()
})
