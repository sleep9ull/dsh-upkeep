/**
 * Structural types for the Harness Host services this plugin touches.
 *
 * The Host half reads services defensively (`ctx.get(...)`) instead of importing
 * Harness packages: a third-party plugin that imports first-party internals is
 * coupled to an API with no stability promise. Everything below describes only
 * the members this plugin calls.
 */

/** Any JSON-safe value. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Narrow an unknown value to a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The Host logger face this plugin uses; every method is optional. */
export interface HostLogger {
  info?(message: string): void
  warn?(message: string): void
  error?(message: string): void
}

/** The Cordis plugin context, limited to what this plugin calls. */
export interface HostContext {
  /** Resolve an optional Harness service by name; absent services are `undefined`. */
  get(name: string): unknown
  /** Own a disposable inside this plugin's fiber. */
  effect(setup: () => (() => void) | void, label?: string): unknown
  /** Subscribe to a Host event. */
  on(event: string, handler: (...args: unknown[]) => unknown): unknown
  logger?: HostLogger
}

/** One exact Fetch route the connection bridge serves to the Web Client. */
export interface FetchRoute {
  path: string
  methods: string[]
  requestBody: 'buffered' | 'stream'
  fetch(request: Request, peer?: unknown): Response | Promise<Response>
}

/** The `ctx.connection.fetch` registry. */
export interface FetchRegistry {
  register(route: FetchRoute): () => void
}

/** Read the Fetch registry structurally; `undefined` when the transport is absent. */
export function fetchRegistry(ctx: HostContext): FetchRegistry | undefined {
  const connection = ctx.get('connection')
  if (!isRecord(connection)) return undefined
  const registry = connection.fetch
  if (!isRecord(registry) || typeof registry.register !== 'function') return undefined
  const register = registry.register
  return {
    register: (route) => {
      const dispose: unknown = register.call(registry, route)
      return typeof dispose === 'function' ? (dispose as () => void) : () => {}
    },
  }
}

/** The model-facing tool definition shape the `ctx.tools` registry accepts. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  timeoutMs: number
  output: {
    schema: Record<string, unknown>
    render(args: Record<string, unknown>, value: unknown): Array<{ type: string; text: string }>
  }
  execute(args: Record<string, unknown>, exec: { signal?: AbortSignal }): Promise<unknown>
}

/** The `ctx.tools` registry face. */
export interface ToolRegistry {
  register(definition: ToolDefinition): (() => void) | void
}

/** Read the tool registry structurally; `undefined` when no tool face is mounted. */
export function toolRegistry(value: unknown): ToolRegistry | undefined {
  if (!isRecord(value) || typeof value.register !== 'function') return undefined
  const register = value.register
  return {
    register: (definition) => {
      const dispose: unknown = register.call(value, definition)
      return typeof dispose === 'function' ? (dispose as () => void) : undefined
    },
  }
}

/** The profile facts the launcher provides (`ctx.profileContext`). */
export interface ProfileContext {
  name?: string
  dir?: string
  /** Absolute path of the running `@deepseek-ai/dsh/package.json`. */
  installAnchor?: string
  /** The profile's home directory (`$DSH_HOME`), where plugin state belongs. */
  home?: string
}

/** Read `ctx.profileContext` structurally. */
export function profileContext(ctx: HostContext): ProfileContext | undefined {
  const value = ctx.get('profileContext')
  if (!isRecord(value)) return undefined
  return {
    name: typeof value.name === 'string' ? value.name : undefined,
    dir: typeof value.dir === 'string' ? value.dir : undefined,
    installAnchor: typeof value.installAnchor === 'string' ? value.installAnchor : undefined,
    home: typeof value.home === 'string' ? value.home : undefined,
  }
}

/** One row of `pluginManager.listBundles()`, limited to client-safe fields. */
export interface BundleInfoLike {
  name?: unknown
  version?: unknown
  enabled?: unknown
  installed?: unknown
  official?: unknown
  availability?: unknown
  rows?: unknown
  error?: unknown
}

/** Read `ctx.pluginManager` structurally. */
export function pluginManager(ctx: HostContext): { listBundles(): Promise<unknown[]> } | undefined {
  const service = ctx.get('pluginManager')
  if (!isRecord(service) || typeof service.listBundles !== 'function') return undefined
  const listBundles = service.listBundles
  return {
    listBundles: async () => {
      const result: unknown = await listBundles.call(service)
      return Array.isArray(result) ? result : []
    },
  }
}

/** A failure the wire and the model can both carry. */
export function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined
}

/** The message of an unknown thrown value. */
export function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message
  return isRecord(error) && typeof error.message === 'string' ? error.message : undefined
}
