/**
 * The dispatcher: one implementation of every upkeep operation, shared by the
 * Web Client adapter (`host/rpc.ts`) and the model adapter (`host/tool.ts`).
 *
 * M0 scope: read-only status. Compatibility evaluation, migration reports and
 * the upgrade pipeline land in later milestones against the same Hub, so the
 * panels and the agent never get a second implementation of an operation.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { HostContext, ProfileContext } from './types.js'
import { errorCode, errorMessage, isRecord, pluginManager, profileContext } from './types.js'

/** The plugin's own version, read once from the package manifest beside `dist/`. */
const OWN_VERSION = (() => {
  try {
    const manifest: unknown = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'))
    return isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** The package name the client module and the Loader row share. */
export const PACKAGE_NAME = '@sleep9ull/dsh-upkeep'

/**
 * Packages in this npm scope are the Harness itself. They ship inside the
 * running DSH and follow its version, so they are never the plugin author's
 * subject: the monitor excludes them instead of reporting them as compatible.
 */
const OFFICIAL_SCOPE = '@deepseek-ai/'

/** Whether a package name belongs to the official DSH scope. */
export function isOfficialPackage(name: string): boolean {
  return name.startsWith(OFFICIAL_SCOPE)
}

/** How the plugin was configured in its Loader row. */
export interface HubConfig {
  /** Which DSH release channel the monitor compares against; `auto` follows the Desktop update channel. */
  targetChannel: string
  /** Whether a check runs when the Host starts. */
  checkOnStartup: boolean
  /** How many entries a check may inspect concurrently. */
  concurrency: number
  /** Directory under which upgrade worktrees are created; empty means the repository's sibling directory. */
  worktreeRoot: string
}

/** Read the Loader row config defensively; every field has a working default. */
export function normalizeConfig(raw: unknown): HubConfig {
  const config = isRecord(raw) ? raw : {}
  const concurrency = typeof config.concurrency === 'number' && Number.isFinite(config.concurrency) ? Math.trunc(config.concurrency) : 2
  return {
    targetChannel: typeof config.targetChannel === 'string' && config.targetChannel.trim() !== '' ? config.targetChannel.trim() : 'auto',
    checkOnStartup: config.checkOnStartup !== false,
    concurrency: Math.min(Math.max(concurrency, 1), 8),
    worktreeRoot: typeof config.worktreeRoot === 'string' ? config.worktreeRoot : '',
  }
}

/** Who is calling an operation, and how it may be cancelled. */
export interface CallContext {
  caller: 'client' | 'tool' | 'schedule'
  signal?: AbortSignal
}

/** A failure that is safe for both the wire and the model. */
export class HubError extends Error {
  /** Stable machine code. */
  readonly code: string
  /** Safe detail; already redacted by the caller. */
  readonly detail: string | undefined

  constructor(code: string, message: string, detail?: string) {
    super(message)
    this.name = 'HubError'
    this.code = code
    this.detail = detail
  }
}

/** One operation the Hub owns. */
export interface ActionSpec {
  /** `read` operations are safe to expose to the model without approval. */
  kind: 'read' | 'write'
  /** Short English description used in tool documentation. */
  description: string
  run(input: Record<string, unknown>, call: CallContext): Promise<unknown>
}

/** A client-safe bundle summary. */
export interface BundleSummary {
  name: string
  version: string | null
  enabled: boolean
  official: boolean
  availability: string | null
  rowCount: number
  error: { code: string; diagnostic: string | null } | null
}

/** What one installed plugin entry looks like after the M0 projection. */
export interface StatusSnapshot {
  checkedAt: number
  plugin: { name: string; version: string }
  dsh: { runtimeVersion: string | null; installAnchor: string | null }
  profile: { name: string | null; dir: string | null }
  bundles: BundleSummary[]
  plugins: { entryCount: number | null }
  /** Official DSH packages left out of the monitored view, reported instead of hidden. */
  excluded: { bundles: number; entries: number }
  warnings: string[]
}

/** The shared operation surface. */
export interface Hub {
  readonly config: HubConfig
  readonly actions: Readonly<Record<string, ActionSpec>>
  call(action: string, input: Record<string, unknown>, call: CallContext): Promise<unknown>
  dispose(): void
}

/** Read a JSON file, returning `undefined` instead of throwing. */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** The running DSH version, from the profile's installation anchor. */
function readRuntimeVersion(profile: ProfileContext | undefined): { version: string | null; anchor: string | null } {
  const anchor = profile?.installAnchor ?? null
  if (!anchor) return { version: null, anchor }
  const manifest = readJson(anchor)
  return {
    version: isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : null,
    anchor,
  }
}

/** Project one `listBundles()` row into the client-safe summary. */
function summarizeBundle(value: unknown): BundleSummary | undefined {
  if (!isRecord(value) || typeof value.name !== 'string') return undefined
  const rows = Array.isArray(value.rows) ? value.rows : []
  const error = isRecord(value.error)
    ? {
        code: typeof value.error.code === 'string' ? value.error.code : 'unknown',
        diagnostic: typeof value.error.diagnostic === 'string' ? value.error.diagnostic : null,
      }
    : null
  return {
    name: value.name,
    version: typeof value.version === 'string' ? value.version : null,
    enabled: value.enabled === true,
    official: value.official === true,
    availability: typeof value.availability === 'string' ? value.availability : null,
    rowCount: rows.length,
    error,
  }
}

/** Live plugin-entry counts, split into what the monitor watches and what it excludes. */
interface EntryCounts {
  monitored: number | null
  excluded: number
}

/** Count live plugin entries, excluding the rows of official DSH packages. */
async function countPluginEntries(ctx: HostContext): Promise<EntryCounts> {
  const value = ctx.get('pluginManager')
  if (!isRecord(value) || typeof value.listPlugins !== 'function') return { monitored: null, excluded: 0 }
  try {
    const entries: unknown = await (value.listPlugins as () => Promise<unknown>).call(value)
    if (!Array.isArray(entries)) return { monitored: null, excluded: 0 }
    let monitored = 0
    let excluded = 0
    for (const entry of entries) {
      const moduleName = isRecord(entry) && typeof entry.moduleName === 'string' ? entry.moduleName : ''
      if (isOfficialPackage(moduleName)) excluded += 1
      else monitored += 1
    }
    return { monitored, excluded }
  } catch {
    return { monitored: null, excluded: 0 }
  }
}

/**
 * Build the Hub over the Host context.
 * @param ctx - the plugin's Host context.
 * @param config - the normalized Loader-row config.
 */
export function createHub(ctx: HostContext, config: HubConfig): Hub {
  const profile = profileContext(ctx)
  const manager = pluginManager(ctx)

  /** Read the status snapshot once; every read action projects from it. */
  async function snapshot(call: CallContext): Promise<StatusSnapshot> {
    call.signal?.throwIfAborted()
    const warnings: string[] = []
    const runtime = readRuntimeVersion(profile)
    if (runtime.version === null) warnings.push('The running DSH version could not be read from the profile installation anchor.')

    let bundles: BundleSummary[] = []
    let excludedBundles = 0
    if (manager) {
      try {
        const listed = await manager.listBundles()
        const summaries = listed.map(summarizeBundle).filter((entry): entry is BundleSummary => entry !== undefined)
        bundles = summaries.filter(entry => !isOfficialPackage(entry.name))
        excludedBundles = summaries.length - bundles.length
      } catch (error) {
        warnings.push(`Installed bundles could not be listed: ${errorMessage(error) ?? 'unknown error'}`)
      }
    } else {
      warnings.push('The plugin manager service is not mounted; installed bundles are unknown.')
    }

    const entries = await countPluginEntries(ctx)

    return {
      checkedAt: Date.now(),
      plugin: { name: PACKAGE_NAME, version: OWN_VERSION },
      dsh: { runtimeVersion: runtime.version, installAnchor: runtime.anchor },
      profile: { name: profile?.name ?? null, dir: profile?.dir ?? null },
      bundles,
      plugins: { entryCount: entries.monitored },
      excluded: { bundles: excludedBundles, entries: entries.excluded },
      warnings,
    }
  }

  const actions: Record<string, ActionSpec> = {
    status: {
      kind: 'read',
      description: 'Plugin, DSH, profile and installed-bundle status in one snapshot.',
      run: async (_input, call) => await snapshot(call),
    },
    'bundles.list': {
      kind: 'read',
      description: 'Monitored (non-official) bundles with their version, source availability and load error.',
      run: async (_input, call) => {
        const status = await snapshot(call)
        return { checkedAt: status.checkedAt, bundles: status.bundles, excluded: status.excluded }
      },
    },
  }

  return {
    config,
    actions,
    async call(action, input, call) {
      const spec = actions[action]
      if (!spec) throw new HubError('UNKNOWN_ACTION', `Unknown upkeep action: ${action}`)
      try {
        return await spec.run(input, call)
      } catch (error) {
        if (error instanceof HubError) throw error
        throw new HubError(errorCode(error) ?? 'UPKEEP_FAILED', errorMessage(error) ?? 'The upkeep operation failed.')
      }
    },
    dispose() {
      // M0 holds no resources. Later milestones register timers and locks here.
    },
  }
}

/** The directory this module runs from; exported for later filesystem work. */
export function pluginDistDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/** Join a path under the plugin root; exported for later milestones. */
export function pluginRootPath(...segments: string[]): string {
  return join(pluginDistDir(), '..', '..', ...segments)
}
