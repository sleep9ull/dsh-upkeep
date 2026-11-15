/**
 * The model adapter: `upkeep_status` over the same dispatcher the panel uses.
 *
 * "One operation, two callers": the tool never re-implements an operation, and
 * it inherits the same gating. M0 exposes read-only operations only; the
 * upgrade pipeline's write actions will pass through `tools/pre-execute` so a
 * human always sees a mutating action before it happens.
 */

import type { Hub } from './dispatch.js'
import type { HostContext, ToolDefinition, ToolRegistry } from './types.js'
import { errorMessage } from './types.js'

/** The tool name the agent calls. */
export const TOOL_NAME = 'upkeep_status'

const DESCRIPTION = `Read the upkeep status of this DeepSeek Harness installation.

Returns the running DSH version, the current profile, and every installed bundle with its version, whether it is enabled, where it comes from, and the load error the plugin manager recorded. Use it before suggesting a plugin upgrade or investigating why a plugin is not running.

Read-only: it never installs, enables, edits, or contacts the network.`

const PARAMETERS: Record<string, unknown> = {
  action: {
    type: 'string',
    enum: ['status', 'bundles.list'],
    description: 'status: DSH, profile and bundles in one snapshot (default). bundles.list: installed bundles only.',
  },
}

/** Register the tool and own its disposer through the plugin fiber. */
export function registerTool(ctx: HostContext, tools: ToolRegistry, hub: Hub): void {
  const definition: ToolDefinition = {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    timeoutMs: 20_000,
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const action = typeof args?.action === 'string' && args.action !== '' ? args.action : 'status'
      try {
        return await hub.call(action, {}, { caller: 'tool', signal: exec?.signal })
      } catch (error) {
        const failure = new Error(errorMessage(error) ?? 'The upkeep operation failed.')
        failure.name = 'UpkeepError'
        throw failure
      }
    },
  }
  const dispose = tools.register(definition)
  ctx.effect(() => dispose, 'upkeep: tool')
}
