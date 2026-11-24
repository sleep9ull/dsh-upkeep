/**
 * dsh-upkeep — a compatibility concierge for DeepSeek Harness plugins.
 *
 * The Host half owns every upkeep operation once (`host/dispatch.ts`) and
 * exposes it through two adapters:
 *
 *  - host/rpc.ts  — exact Fetch RPC routes the Web Client panel calls;
 *  - host/tool.ts — the `upkeep_status` agent tool, same actions, same gating.
 *
 * The Web Client half (`src/client.ts`) is declared by `dsh.client` in
 * package.json and renders the Upkeep tab inside Plugins settings.
 *
 * @module @sleep9ull/dsh-upkeep
 */

import { createHub, normalizeConfig } from './host/dispatch.js'
import type { Hub } from './host/dispatch.js'
import { registerRpc } from './host/rpc.js'
import { registerTool } from './host/tool.js'
import type { HostContext } from './host/types.js'
import { toolRegistry } from './host/types.js'

/** Cordis plugin name; matches the Loader row id in cordis.patch.yml. */
export const name = 'upkeep'

/**
 * The Host half needs the connection service, because that is what serves the
 * `/api` bridge the panel calls. Without it the plugin stays inactive rather
 * than throwing; the tool face is registered when it is mounted.
 */
export const inject = ['connection']

/**
 * @param ctx - Host context
 * @param config - the Loader row's raw `config`
 */
export function apply(ctx: HostContext, config: unknown): void {
  const resolved = normalizeConfig(config)
  const hub: Hub = createHub(ctx, resolved)

  ctx.effect(() => () => hub.dispose(), 'upkeep: dispose')

  const routes = registerRpc(ctx, hub)

  // The tools registry can be mounted by a sibling Loader row that is still
  // starting when this row applies (the Loader starts siblings concurrently),
  // so fall back to `ctx.inject`: the tool then appears with the registry
  // instead of silently never existing for the life of the process.
  let toolFace: 'on' | 'deferred' | 'off' = 'off'
  const tools = toolRegistry(ctx.get('tools'))
  if (tools) {
    registerTool(ctx, tools, hub)
    toolFace = 'on'
  } else if (typeof ctx.inject === 'function') {
    toolFace = 'deferred'
    ctx.inject(['tools'], (scoped) => {
      const late = toolRegistry(scoped.get('tools'))
      if (late) registerTool(scoped, late, hub)
    })
  }

  ctx.logger?.info?.(`upkeep ready: ${routes} rpc route(s), tool=${toolFace}, channel=${resolved.targetChannel}`)
}
