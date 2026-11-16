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
import { classifyOwnership, readPackageFacts, resolveOwnerIdentity } from './owner.js'
import type { OwnerIdentity, OwnershipVerdict } from './owner.js'

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
  /** Account handles that identify this machine's author; empty means auto-detect only. */
  ownerHandles: string[]
  /** Author email addresses that identify this machine's author. */
  ownerEmails: string[]
  /** Whether the local git and GitHub identity may be used for matching. */
  autoDetectOwner: boolean
}

/** Split a config value into a normalized string list. */
function normalizeConfigList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const normalized = entry.trim().replace(/^@/, '').toLowerCase()
    if (normalized !== '') seen.add(normalized)
  }
  return [...seen]
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
    ownerHandles: normalizeConfigList(config.ownerHandles),
    ownerEmails: normalizeConfigList(config.ownerEmails),
    autoDetectOwner: config.autoDetectOwner !== false,
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

/** Whether one of the author's own plugins needs attention. */
export interface MaintenanceVerdict {
  state: 'ok' | 'attention' | 'unknown' | 'not-mine'
  /** Short, human-readable reasons shown on hover; empty unless the state is `attention`. */
  reasons: string[]
}

/** A client-safe bundle summary. */
export interface BundleSummary {
  name: string
  version: string | null
  enabled: boolean
  official: boolean
  availability: string | null
  /** The spec the profile records, when the bundle lists one. */
  source: string | null
  rowCount: number
  error: { code: string; diagnostic: string | null } | null
  /** Authorship with the evidence behind it. */
  owner: OwnershipVerdict
  /** Whether this author's plugin needs care. */
  maintenance: MaintenanceVerdict
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
  /** Authorship rollup plus the identity it was matched against. */
  ownership: {
    mine: number
    other: number
    unknown: number
    needsMaintenance: number
    identity: { handles: string[]; sources: string[] }
  }
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

/** One listed bundle before ownership and live state are joined onto it. */
interface BundleListing {
  base: Omit<BundleSummary, 'owner' | 'maintenance'>
  rowEntryIds: string[]
}

/** Project one `listBundles()` row into the client-safe base fields. */
function readBundleListing(value: unknown): BundleListing | undefined {
  if (!isRecord(value) || typeof value.name !== 'string') return undefined
  const rows = Array.isArray(value.rows) ? value.rows : []
  const error = isRecord(value.error)
    ? {
        code: typeof value.error.code === 'string' ? value.error.code : 'unknown',
        diagnostic: typeof value.error.diagnostic === 'string' ? value.error.diagnostic : null,
      }
    : null
  const rowEntryIds: string[] = []
  for (const row of rows) {
    if (isRecord(row) && typeof row.entryId === 'string') rowEntryIds.push(row.entryId)
  }
  return {
    base: {
      name: value.name,
      version: typeof value.version === 'string' ? value.version : null,
      enabled: value.enabled === true,
      official: value.official === true,
      availability: typeof value.availability === 'string' ? value.availability : null,
      source: typeof value.source === 'string' ? value.source : null,
      rowCount: rows.length,
      error,
    },
    rowEntryIds,
  }
}

/** One live plugin entry the maintenance verdict reads. */
interface LiveEntry {
  fiberPhase: string | null
  diagnostic: string | null
}

/** Live plugin entries plus the monitored/excluded counts. */
interface LiveEntries {
  byEntryId: Map<string, LiveEntry>
  monitored: number | null
  excluded: number
}

/** Read live plugin entries once, excluding the rows of official DSH packages from the count. */
async function readPluginEntries(ctx: HostContext): Promise<LiveEntries> {
  const empty: LiveEntries = { byEntryId: new Map(), monitored: null, excluded: 0 }
  const value = ctx.get('pluginManager')
  if (!isRecord(value) || typeof value.listPlugins !== 'function') return empty
  try {
    const listed: unknown = await (value.listPlugins as () => Promise<unknown>).call(value)
    if (!Array.isArray(listed)) return empty
    const byEntryId = new Map<string, LiveEntry>()
    let monitored = 0
    let excluded = 0
    for (const entry of listed) {
      if (!isRecord(entry)) continue
      const moduleName = typeof entry.moduleName === 'string' ? entry.moduleName : ''
      const official = isOfficialPackage(moduleName)
      if (official) excluded += 1
      else monitored += 1
      if (typeof entry.entryId === 'string') {
        byEntryId.set(entry.entryId, {
          fiberPhase: typeof entry.fiberPhase === 'string' ? entry.fiberPhase : null,
          diagnostic: typeof entry.diagnostic === 'string' ? entry.diagnostic : null,
        })
      }
    }
    return { byEntryId, monitored, excluded }
  } catch {
    return empty
  }
}

/** Whether one of the author's plugins currently needs care, and why. */
function classifyMaintenance(
  ownership: OwnershipVerdict,
  bundle: Omit<BundleSummary, 'owner' | 'maintenance'>,
  rowEntryIds: string[],
  live: LiveEntries,
): MaintenanceVerdict {
  if (ownership.status !== 'mine') return { state: 'not-mine', reasons: [] }
  const reasons: string[] = []
  if (bundle.error?.code === 'incompatible-version') reasons.push('declared incompatible with the running DSH')

  let failed = 0
  let pending = 0
  for (const entryId of rowEntryIds) {
    const entry = live.byEntryId.get(entryId)
    if (entry === undefined) continue
    if (entry.fiberPhase === 'failed') failed += 1
    else if (entry.fiberPhase === 'pending') pending += 1
  }
  if (failed > 0) reasons.push(`${failed} plugin ${failed === 1 ? 'row' : 'rows'} failed to load`)
  if (pending > 0) reasons.push(`${pending} plugin ${pending === 1 ? 'row' : 'rows'} waiting for a service`)

  if (reasons.length > 0) return { state: 'attention', reasons }
  if (live.monitored === null) return { state: 'unknown', reasons: ['live plugin state is unavailable'] }
  return { state: 'ok', reasons: [] }
}

/**
 * Build the Hub over the Host context.
 * @param ctx - the plugin's Host context.
 * @param config - the normalized Loader-row config.
 */
export function createHub(ctx: HostContext, config: HubConfig): Hub {
  const profile = profileContext(ctx)
  const manager = pluginManager(ctx)
  const ownerIdentity: OwnerIdentity = resolveOwnerIdentity({
    handles: config.ownerHandles,
    emails: config.ownerEmails,
    autoDetect: config.autoDetectOwner,
  })

  /** Read the status snapshot once; every read action projects from it. */
  async function snapshot(call: CallContext): Promise<StatusSnapshot> {
    call.signal?.throwIfAborted()
    const warnings: string[] = []
    const runtime = readRuntimeVersion(profile)
    if (runtime.version === null) warnings.push('The running DSH version could not be read from the profile installation anchor.')
    if (ownerIdentity.handles.length === 0 && ownerIdentity.emails.length === 0) {
      warnings.push('No owner identity was detected; ownership is reported as unknown. Set ownerHandles in the plugin configuration.')
    }

    let listings: BundleListing[] = []
    if (manager) {
      try {
        const listed = await manager.listBundles()
        listings = listed.map(readBundleListing).filter((entry): entry is BundleListing => entry !== undefined)
      } catch (error) {
        warnings.push(`Installed bundles could not be listed: ${errorMessage(error) ?? 'unknown error'}`)
      }
    } else {
      warnings.push('The plugin manager service is not mounted; installed bundles are unknown.')
    }

    const live = await readPluginEntries(ctx)
    const monitored = listings.filter(entry => !isOfficialPackage(entry.base.name))
    const excludedBundles = listings.length - monitored.length

    const bundles: BundleSummary[] = monitored.map((listing) => {
      const facts = readPackageFacts(listing.base.name, listing.base.source ?? undefined, profile?.dir, profile?.installAnchor)
      const owner = classifyOwnership(facts, ownerIdentity, listing.base.name)
      return {
        ...listing.base,
        owner,
        maintenance: classifyMaintenance(owner, listing.base, listing.rowEntryIds, live),
      }
    })

    const rollup = { mine: 0, other: 0, unknown: 0, needsMaintenance: 0 }
    for (const bundle of bundles) {
      rollup[bundle.owner.status] += 1
      if (bundle.maintenance.state === 'attention') rollup.needsMaintenance += 1
    }

    return {
      checkedAt: Date.now(),
      plugin: { name: PACKAGE_NAME, version: OWN_VERSION },
      dsh: { runtimeVersion: runtime.version, installAnchor: runtime.anchor },
      profile: { name: profile?.name ?? null, dir: profile?.dir ?? null },
      bundles,
      plugins: { entryCount: live.monitored },
      excluded: { bundles: excludedBundles, entries: live.excluded },
      ownership: {
        ...rollup,
        identity: { handles: ownerIdentity.handles, sources: ownerIdentity.sources },
      },
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
