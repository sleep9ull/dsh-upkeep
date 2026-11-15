/**
 * The Web Client adapter: one exact Fetch route per Hub action, under the
 * `/api` bridge owned by `@deepseek-ai/dsh-client-connection`.
 *
 * Why this channel: the bridge already enforces browser trust (401 for an
 * unauthenticated peer, 403 for a non-owner peer), it writes nothing to the
 * session log or model history, and it needs no build-time code generation —
 * the same pattern the installed `@sleep9ull/dsh-asc-hub` plugin uses.
 *
 * Wire contract:
 *   request   { type: 'client-request', rpcId, method: 'upkeep/<action>', payload: { action, input } }
 *   response  { type: 'server-response', rpcId, result: { ok: true, value } | { ok: false, error } }
 */

import type { CallContext, Hub } from './dispatch.js'
import { HubError } from './dispatch.js'
import type { HostContext } from './types.js'
import { errorMessage, fetchRegistry, isRecord } from './types.js'

/** Every action route lives under this prefix. */
const PREFIX = '/api/upkeep/'
/** The RPC method namespace the client sends. */
const METHOD_PREFIX = 'upkeep/'

/** One failure the panel renders. */
export interface RpcFailure {
  ok: false
  error: { code: string; message: string; details: { text?: string } }
}

/** One success the panel renders. */
export interface RpcSuccess {
  ok: true
  value: unknown
}

/** Answer with JSON and no caching. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/** Turn an unknown thrown value into the wire failure envelope. */
function failure(error: unknown): RpcFailure {
  const code = error instanceof HubError ? error.code : 'UPKEEP_FAILED'
  const message = errorMessage(error) ?? 'The upkeep operation failed.'
  const detail = error instanceof HubError && error.detail ? error.detail : undefined
  return {
    ok: false,
    error: { code, message: message.slice(0, 600), details: detail ? { text: detail.slice(0, 8_000) } : {} },
  }
}

/** Whether the peer is a recognizable non-owner; the bridge already refuses these, this is belt-and-braces. */
function isForeignPeer(peer: unknown): boolean {
  if (!isRecord(peer)) return false
  const principal = peer.principal
  if (!isRecord(principal)) return false
  return typeof principal.kind === 'string' && principal.kind !== 'owner'
}

/**
 * Register one POST route per Hub action.
 * @returns the number of routes registered.
 */
export function registerRpc(ctx: HostContext, hub: Hub): number {
  const registry = fetchRegistry(ctx)
  if (!registry) {
    ctx.logger?.warn?.('upkeep: no connection fetch registry; the panel cannot reach the Host half')
    return 0
  }

  let count = 0
  for (const action of Object.keys(hub.actions)) {
    const method = `${METHOD_PREFIX}${action}`
    const dispose = registry.register({
      path: `${PREFIX}${action}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request, peer) => {
        if (isForeignPeer(peer)) return jsonResponse({ error: 'owner connection required' }, 403)
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return jsonResponse({ error: 'body is not JSON' }, 400)
        }
        if (!isRecord(body) || body.type !== 'client-request' || typeof body.rpcId !== 'string' || body.method !== method) {
          return jsonResponse({ error: 'invalid upkeep request envelope' }, 400)
        }
        const payload = isRecord(body.payload) ? body.payload : {}
        if (payload.action !== undefined && payload.action !== action) {
          return jsonResponse({ error: 'action does not match the route' }, 400)
        }
        const input = isRecord(payload.input) ? payload.input : {}
        const call: CallContext = { caller: 'client', signal: request.signal }
        let result: RpcSuccess | RpcFailure
        try {
          const value = await hub.call(action, input, call)
          result = { ok: true, value: value === undefined ? null : value }
        } catch (error) {
          result = failure(error)
        }
        return jsonResponse({ type: 'server-response', rpcId: body.rpcId, result })
      },
    })
    // Registering through `ctx.effect` keeps the route owned by this plugin's
    // fiber, so unloading the row removes the surface with it.
    ctx.effect(() => dispose, `upkeep: rpc ${action}`)
    count += 1
  }
  return count
}
