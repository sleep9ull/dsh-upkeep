import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../dist/index.js'
import type { HostContext, ToolDefinition } from '../dist/host/types.js'

/** One throwaway home: applying the plugin must never touch the real one. */
const TEST_HOME = mkdtempSync(join(tmpdir(), 'upkeep-apply-'))

const CONFIG = { ownerHandles: 'sleep9ull', autoDetectOwner: false, checkOnStartup: false }

/** A Host context with no connection (zero RPC routes) and a controllable tools face. */
function context(options: {
  tools?: unknown
  inject?: (deps: string[], callback: (ctx: HostContext) => void) => unknown
} = {}): HostContext {
  return {
    get(name: string) {
      if (name === 'profileContext') {
        return {
          name: 'desktop',
          dir: '/tmp/dsh-profile',
          installAnchor: new URL('../package.json', import.meta.url).pathname,
          home: TEST_HOME,
        }
      }
      if (name === 'tools') return options.tools
      return undefined
    },
    effect(setup: () => (() => void) | void) {
      return setup()
    },
    on() {
      return () => {}
    },
    ...(options.inject === undefined ? {} : { inject: options.inject }),
  }
}

/** A registry that records the tool names it is asked to register. */
function recordingTools(names: string[]): unknown {
  return {
    register(definition: ToolDefinition) {
      names.push(definition.name)
      return () => {}
    },
  }
}

test('the tool is registered when the tools registry is already mounted', () => {
  const names: string[] = []
  apply(context({ tools: recordingTools(names) }), CONFIG)
  assert.deepEqual(names, ['upkeep_status'])
})

test('a tools registry mounted after apply still gets the tool', () => {
  // The Loader starts sibling rows concurrently, so the registry can be missing
  // during apply. `ctx.inject` must then register the tool once it appears.
  const names: string[] = []
  let waiting: { deps: string[]; run: (ctx: HostContext) => void } | undefined
  apply(context({
    inject(deps, callback) {
      waiting = { deps, run: callback }
    },
  }), CONFIG)
  assert.deepEqual(names, [])
  assert.deepEqual(waiting?.deps, ['tools'])
  waiting?.run(context({ tools: recordingTools(names) }))
  assert.deepEqual(names, ['upkeep_status'])
})

test('no tool face and no inject support stays inactive instead of throwing', () => {
  assert.doesNotThrow(() => apply(context(), CONFIG))
})
