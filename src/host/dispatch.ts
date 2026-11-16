/**
 * The dispatcher: one implementation of every upkeep operation, shared by the
 * Web Client adapter (`host/rpc.ts`) and the model adapter (`host/tool.ts`).
 *
 * M1 scope: read-only monitoring. Each bundle gets a declared-layer evaluation
 * against the running DSH and (when a target is known) against the next DSH, a
 * live runtime row count, an ownership verdict and a maintenance verdict. A
 * `check` run reads the registry once, stores one bounded report, and is the
 * only M1 operation with a side effect (the state file).
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { HostContext, ProfileContext } from './types.js'
import { errorCode, errorMessage, isRecord, pluginManager, profileContext } from './types.js'
import {
  CompatibilityError,
  describeRequirements,
  evaluatePluginCompatibility,
  readVersionExemptions,
} from './compat.js'
import { classifyOwnership, readInstalledManifest, readInstalledPackageDir, readPackageFacts, resolveOwnerIdentity } from './owner.js'
import type { OwnerIdentity, OwnershipVerdict } from './owner.js'
import {
  appendCheck,
  appendRun,
  updateRun,
  lastCheckView,
  readState,
  writeState,
  type LastCheckView,
  type StoredCheck,
  type StoredEvaluation,
  type StoredReport,
  type UpkeepState,
} from './state.js'
import {
  DEFAULT_REGISTRIES,
  detectDesktopChannel,
  fetchTargetVersion,
  type TargetVersion,
} from './feed.js'
import { fetchRemoteGuides, readInstalledGuides, type GuideSet } from './guides.js'
import { summarizeMatches, matchGuides, type ImpactSummary, type GuideMatch } from './match.js'
import { scanSurfaces, type SurfaceInventory } from './surfaces.js'
import { createExecRunner, type ExecRunner } from './exec.js'
import {
  createOneShotTask,
  createUpkeepTask,
  isKnownTimeZone,
  listUpkeepTasks,
  normalizeTimeOfDay,
  scheduleService,
  scheduledTaskViews,
} from './schedule.js'
import {
  buildDeliveryText,
  commitWorkspace,
  createPullRequest,
  mergePullRequest,
  readDeliveryPreview,
  pushBranch,
  type DeliveryPreview,
} from './deliver.js'
import {
  buildUpgradePrompt,
  deriveVerifyCommands,
  inspectRepository,
  prepareWorkspace,
  verifyWorkspace,
  type UpgradeRunRecord,
} from './upgrade.js'
import { compareVersions, parseVersion } from './versions.js'

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
  /** An exact target version; empty means "ask the registry". */
  targetVersion: string
  /** How many minutes a cached registry answer stays fresh. */
  feedTtlMinutes: number
  /** Whether a check runs when the Host starts. */
  checkOnStartup: boolean
  /** How many checks to retain in the state file. */
  checksToKeep: number
  /** Whether a check also matches the migration guides against each plugin's surfaces. */
  analyzeOnCheck: boolean
  /** Commands `upgrade.verify` runs; empty derives them from the package scripts. */
  verifyCommands: string[]
  /** How many upgrade runs to retain in the state file. */
  runsToKeep: number
  /** The branch delivery targets compare against and open PRs against. */
  defaultBaseBranch: string
  /** Whether `delivery.merge` is allowed at all; each merge still needs its own confirmation. */
  allowMerge: boolean
  /** Project directory for the Session a scheduled check creates; empty uses the profile home. */
  scheduleCwd: string
  /** Default interval for a created scheduled check. */
  scheduleIntervalHours: number
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

/** Split a config value into shell command strings, preserving case. */
function normalizeCommandList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : []
  const commands: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const command = entry.trim()
    if (command !== '') commands.push(command)
  }
  return commands.slice(0, 6)
}

/** Read a bounded integer config value. */
function normalizeInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(Math.max(number, minimum), maximum)
}

/** Read the Loader row config defensively; every field has a working default. */
export function normalizeConfig(raw: unknown): HubConfig {
  const config = isRecord(raw) ? raw : {}
  return {
    targetChannel: typeof config.targetChannel === 'string' && config.targetChannel.trim() !== '' ? config.targetChannel.trim() : 'auto',
    targetVersion: typeof config.targetVersion === 'string' ? config.targetVersion.trim() : '',
    feedTtlMinutes: normalizeInteger(config.feedTtlMinutes, 60, 1, 7 * 24 * 60),
    checkOnStartup: config.checkOnStartup !== false,
    checksToKeep: normalizeInteger(config.checksToKeep, 20, 1, 100),
    analyzeOnCheck: config.analyzeOnCheck !== false,
    verifyCommands: normalizeCommandList(config.verifyCommands),
    runsToKeep: normalizeInteger(config.runsToKeep, 10, 1, 20),
    defaultBaseBranch: typeof config.defaultBaseBranch === 'string' && config.defaultBaseBranch.trim() !== '' ? config.defaultBaseBranch.trim() : 'main',
    allowMerge: config.allowMerge === true,
    scheduleCwd: typeof config.scheduleCwd === 'string' ? config.scheduleCwd.trim() : '',
    scheduleIntervalHours: normalizeInteger(config.scheduleIntervalHours, 24, 1, 720),
    concurrency: normalizeInteger(config.concurrency, 2, 1, 8),
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

/** One declared-layer evaluation, as the panel reads it. */
export interface EvaluationView {
  status: 'compatible' | 'incompatible' | 'unknown'
  /** Unmet requirements; empty unless incompatible. */
  requirements: Record<string, string>
  exempted: boolean
  reason?: string
}

/** The compatibility picture of one bundle. */
export interface BundleCompat {
  /** Against the running DSH. */
  running: EvaluationView
  /** Against the target DSH, when one is known. */
  target: EvaluationView | null
  /** Live row health, joined from the plugin inventory. */
  runtime: { failed: number; pending: number }
  /** Migration-guide items that mention this plugin's surfaces (M2). */
  impact?: ImpactSummary
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
  /** Declared-layer compatibility against both versions. */
  compat: BundleCompat
}

/** What one installed plugin entry looks like after the M1 projection. */
export interface StatusSnapshot {
  checkedAt: number
  plugin: { name: string; version: string }
  dsh: { runtimeVersion: string | null; installAnchor: string | null }
  profile: { name: string | null; dir: string | null }
  /** The DSH version the monitor compares against. */
  target: TargetVersion
  /** The newest stored check, when one ran. */
  lastCheck?: LastCheckView
  bundles: BundleSummary[]
  plugins: { entryCount: number | null }
  /** Official DSH packages left out of the monitored view, reported instead of hidden. */
  excluded: { bundles: number; entries: number }
  /** Delivery policy the panel needs to render the right buttons. */
  delivery: { allowMerge: boolean; baseBranch: string }
  /** Optional Host services the profile actually mounted. */
  capabilities: { schedule: boolean; workspaceRegistry: boolean }
  /** Scheduled checks already created through the schedule service. */
  scheduled: { available: boolean; tasks: Array<{ bundle: string | null; title: string; everySeconds: number | null; nextAt: string | null }> }
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

/** Injectable environment, so tests can run the Hub without a plugin context, network or timer. */
export interface HubDeps {
  fetchImpl?: typeof fetch
  /** Command runner for worktrees and verification; tests inject a fake. */
  exec?: ExecRunner
  now?: () => number
  home?: string
  /** Disable the delayed startup check (tests). */
  startupCheck?: boolean
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

/** One listed bundle before ownership, live state and compatibility are joined onto it. */
interface BundleListing {
  base: Omit<BundleSummary, 'owner' | 'maintenance' | 'compat'>
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
      if (isOfficialPackage(moduleName)) excluded += 1
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

/** Evaluate one manifest against one DSH version, turning failures into `unknown`. */
function evaluateManifest(manifest: Record<string, unknown> | undefined, version: string, exemptions: Record<string, string[]>): EvaluationView {
  if (manifest === undefined) {
    return { status: 'unknown', requirements: {}, exempted: false, reason: 'the package manifest is unreadable' }
  }
  try {
    const issue = evaluatePluginCompatibility(manifest, version, exemptions)
    if (issue === undefined) return { status: 'compatible', requirements: {}, exempted: false }
    return { status: 'incompatible', requirements: issue.requirements, exempted: issue.exempted }
  } catch (error) {
    const reason = error instanceof CompatibilityError ? error.message : (errorMessage(error) ?? 'the manifest requirements are invalid')
    return { status: 'unknown', requirements: {}, exempted: false, reason }
  }
}

/** Whether a plugin's own bundle needs care, and why. */
function classifyMaintenance(
  ownership: OwnershipVerdict,
  bundle: Omit<BundleSummary, 'owner' | 'maintenance' | 'compat'>,
  compat: BundleCompat,
  rowEntryIds: string[],
  live: LiveEntries,
  runtimeVersion: string | null,
  target: TargetVersion,
): MaintenanceVerdict {
  if (ownership.status !== 'mine') return { state: 'not-mine', reasons: [] }
  const reasons: string[] = []
  if (compat.running.status === 'incompatible' && !compat.running.exempted) {
    reasons.push('declared incompatible with the running DSH')
  }
  if (compat.target !== null && compat.target.status === 'incompatible' && target.version !== null && (runtimeVersion === null || compareVersions(target.version, runtimeVersion) > 0)) {
    reasons.push(`will break on ${target.version}`)
  }
  if (compat.runtime.failed > 0) reasons.push(`${compat.runtime.failed} plugin ${compat.runtime.failed === 1 ? 'row' : 'rows'} failed to load`)
  if (compat.runtime.pending > 0) reasons.push(`${compat.runtime.pending} plugin ${compat.runtime.pending === 1 ? 'row' : 'rows'} waiting for a service`)
  if (bundle.error?.code === 'incompatible-version') reasons.push('DSH refused the bundle as incompatible')
  if (reasons.length > 0) return { state: 'attention', reasons }
  if (live.monitored === null) return { state: 'unknown', reasons: ['live plugin state is unavailable'] }
  return { state: 'ok', reasons: [] }
}

/** Build the stored compatibility evaluation for one bundle. */
function storedEvaluation(view: EvaluationView): StoredEvaluation {
  return {
    status: view.status,
    requirements: view.requirements,
    exempted: view.exempted,
    ...(view.reason === undefined ? {} : { reason: view.reason }),
  }
}

/** The cached target, or the configured exact version. */
function targetFromState(config: HubConfig, state: UpkeepState, now: number): TargetVersion {
  const configured = config.targetVersion.trim()
  if (configured !== '' && parseVersion(configured) !== undefined) {
    return { version: configured, channel: 'configured', fetchedAt: null, source: 'config', stale: false }
  }
  const feed = state.feed
  if (feed !== undefined) {
    const ageMinutes = Math.max(0, (now - feed.fetchedAt) / 60_000)
    return {
      version: feed.targetVersion,
      channel: feed.channel,
      fetchedAt: feed.fetchedAt,
      source: 'cache',
      stale: ageMinutes > config.feedTtlMinutes,
    }
  }
  return { version: null, channel: null, fetchedAt: null, source: 'none', stale: false }
}

/**
 * Build the Hub over the Host context.
 * @param ctx - the plugin's Host context.
 * @param config - the normalized Loader-row config.
 * @param deps - injectable environment for tests.
 */
export function createHub(ctx: HostContext, config: HubConfig, deps: HubDeps = {}): Hub {
  const profile = profileContext(ctx)
  const manager = pluginManager(ctx)
  const now = deps.now ?? (() => Date.now())
  const home = deps.home ?? profile?.home ?? homedir()
  const ownerIdentity: OwnerIdentity = resolveOwnerIdentity({
    handles: config.ownerHandles,
    emails: config.ownerEmails,
    autoDetect: config.autoDetectOwner,
  })
  const exec = deps.exec ?? createExecRunner()
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  /** One long-running operation at a time: two checks or an upgrade must not interleave state writes. */
  let busy: 'check' | 'upgrade' | null = null

  /** Run one exclusive operation, or fail fast with a stable code. */
  async function exclusive<T>(label: 'check' | 'upgrade', operation: () => Promise<T>): Promise<T> {
    if (busy !== null) throw new HubError('BUSY', `A ${busy} operation is already running; wait for it to finish.`)
    busy = label
    try {
      return await operation()
    } finally {
      busy = null
    }
  }

  /** Which plugins a live scheduled task already watches, with its cadence. */
  async function readScheduled(): Promise<{
    available: boolean
    tasks: Array<{ bundle: string | null; title: string; everySeconds: number | null; nextAt: string | null }>
  }> {
    const service = scheduleService(ctx)
    if (service === undefined) return { available: false, tasks: [] }
    try {
      return { available: true, tasks: scheduledTaskViews(await service.catalog()) }
    } catch {
      return { available: true, tasks: [] }
    }
  }

  /** Resolve one monitored bundle listing by package name. */
  async function monitoredListing(name: string): Promise<BundleListing | undefined> {
    if (manager === undefined) return undefined
    let listed: unknown[] = []
    try {
      listed = await manager.listBundles()
    } catch {
      return undefined
    }
    return listed
      .map(readBundleListing)
      .filter((entry): entry is BundleListing => entry !== undefined)
      .find(entry => entry.base.name === name && !isOfficialPackage(entry.base.name))
  }

  /** Register a prepared directory as a Workspace so a Session can open there. */
  async function registerWorkspace(path: string, title: string): Promise<string> {
    const value = ctx.get('workspaceRegistry')
    if (!isRecord(value) || typeof value.create !== 'function') {
      throw new HubError('WORKSPACE_UNAVAILABLE', 'The workspace registry is not mounted; open the repository as a workspace manually.')
    }
    const created: unknown = await (value.create as (path: string, title?: string) => Promise<unknown>).call(value, path, title)
    if (!isRecord(created) || typeof created.id !== 'string') {
      throw new HubError('WORKSPACE_UNAVAILABLE', 'The workspace registry did not return a workspace id.')
    }
    return created.id
  }

  /** The registry list to ask, from the plugin manager when it exposes one. */
  async function registryPlan(): Promise<string[]> {
    const value = ctx.get('pluginManager')
    const list: string[] = []
    if (isRecord(value) && typeof value.registries === 'function') {
      try {
        const plan: unknown = await (value.registries as () => Promise<unknown>).call(value)
        if (isRecord(plan)) {
          if (typeof plan.registry === 'string') list.push(plan.registry)
          else if (typeof plan.resolved === 'string') list.push(plan.resolved)
          if (Array.isArray(plan.fallbackRegistries)) {
            for (const entry of plan.fallbackRegistries) if (typeof entry === 'string') list.push(entry)
          }
        }
      } catch {
        // Fall through to the defaults.
      }
    }
    const cleaned = list.filter(entry => /^https?:\/\//i.test(entry))
    return cleaned.length > 0 ? [...new Set(cleaned)] : DEFAULT_REGISTRIES
  }

  /** Which guide window applies: future releases when the target is newer, else the installed history. */
  function guideWindow(): { from: string | null; to: string | null } {
    const runtime = readRuntimeVersion(profile).version
    const target = targetFromState(config, readState(home), now())
    if (runtime !== null && target.version !== null && compareVersions(target.version, runtime) > 0) {
      return { from: runtime, to: target.version }
    }
    return { from: null, to: null }
  }

  /** Load installed guides and, for a newer target, the missing ones from the release tag. */
  async function loadGuides(): Promise<{ guides: GuideSet; warnings: string[] }> {
    const window = guideWindow()
    const installed = readInstalledGuides(profile?.installAnchor, window.from, window.to)
    const warnings = [...installed.warnings]
    if (window.to === null) return { guides: installed, warnings }
    const remote = await fetchRemoteGuides({
      targetVersion: window.to,
      from: window.from,
      to: window.to,
      fetchImpl: deps.fetchImpl,
    })
    warnings.push(...remote.warnings)
    const seen = new Set(installed.items.map(item => item.version + '/' + item.item))
    const items = [...installed.items]
    for (const item of remote.items) {
      const key = item.version + '/' + item.item
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
    }
    return {
      guides: {
        source: remote.items.length > 0 ? 'github' : installed.source,
        versions: [...new Set([...installed.versions, ...remote.versions])].sort(compareVersions),
        items,
        warnings,
      },
      warnings,
    }
  }

  /** Match the guides against one bundle's scanned surfaces. */
  async function analyzeBundle(
    listing: BundleListing,
    guides: GuideSet,
  ): Promise<{ impact?: ImpactSummary; matches: GuideMatch[]; inventory?: SurfaceInventory; warnings: string[] }> {
    const source = listing.base.source ?? undefined
    const packageDir = readInstalledPackageDir(listing.base.name, source, profile?.dir, profile?.installAnchor)
    if (packageDir === undefined) {
      return { matches: [], warnings: [`The package directory of ${listing.base.name} could not be resolved.`] }
    }
    const manifest = readInstalledManifest(listing.base.name, source, profile?.dir, profile?.installAnchor)
    const inventory = scanSurfaces(packageDir, manifest)
    const matches = matchGuides(guides, inventory)
    const warnings = [...inventory.warnings]
    if (matches.length === 0) return { matches, inventory, warnings }
    return { impact: summarizeMatches(matches), matches, inventory, warnings }
  }

  /** Build one status snapshot; `targetOverride` carries a freshly fetched target. */
  async function buildSnapshot(options: { targetOverride?: TargetVersion; extraWarnings?: string[] } = {}): Promise<StatusSnapshot> {
    const warnings: string[] = [...(options.extraWarnings ?? [])]
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
    const state = readState(home)
    const target = options.targetOverride ?? targetFromState(config, state, now())
    if (target.source === 'cache' && target.stale) {
      warnings.push('The target DSH version comes from a stale cached answer; run a check to refresh it.')
    }
    const exemptions = readVersionExemptions(profile?.dir)

    const bundles: BundleSummary[] = monitored.map((listing) => {
      const facts = readPackageFacts(listing.base.name, listing.base.source ?? undefined, profile?.dir, profile?.installAnchor)
      const owner = classifyOwnership(facts, ownerIdentity, listing.base.name)
      const manifest = readInstalledManifest(listing.base.name, listing.base.source ?? undefined, profile?.dir, profile?.installAnchor)
      const running = runtime.version === null
        ? { status: 'unknown' as const, requirements: {}, exempted: false, reason: 'the running DSH version is unavailable' }
        : evaluateManifest(manifest, runtime.version, exemptions)
      const projected = target.version !== null && manifest !== undefined ? evaluateManifest(manifest, target.version, {}) : null
      let failed = 0
      let pending = 0
      for (const entryId of listing.rowEntryIds) {
        const entry = live.byEntryId.get(entryId)
        if (entry === undefined) continue
        if (entry.fiberPhase === 'failed') failed += 1
        else if (entry.fiberPhase === 'pending') pending += 1
      }
      const compat: BundleCompat = { running, target: projected, runtime: { failed, pending } }
      return {
        ...listing.base,
        owner,
        compat,
        maintenance: classifyMaintenance(owner, listing.base, compat, listing.rowEntryIds, live, runtime.version, target),
      }
    })

    // Reuse the newest stored analysis instead of rescanning on every status read.
    const storedReports = state.checks[0]?.reports ?? []
    for (const bundle of bundles) {
      const stored = storedReports.find(report => report.bundle === bundle.name)
      if (stored?.impact !== undefined) bundle.compat.impact = stored.impact
    }

    const rollup = { mine: 0, other: 0, unknown: 0, needsMaintenance: 0 }
    for (const bundle of bundles) {
      rollup[bundle.owner.status] += 1
      if (bundle.maintenance.state === 'attention') rollup.needsMaintenance += 1
    }

    return {
      checkedAt: now(),
      plugin: { name: PACKAGE_NAME, version: OWN_VERSION },
      dsh: { runtimeVersion: runtime.version, installAnchor: runtime.anchor },
      profile: { name: profile?.name ?? null, dir: profile?.dir ?? null },
      target,
      delivery: { allowMerge: config.allowMerge, baseBranch: config.defaultBaseBranch },
      scheduled: await readScheduled(),
      capabilities: {
        schedule: scheduleService(ctx) !== undefined,
        workspaceRegistry: isRecord(ctx.get('workspaceRegistry')) && typeof (ctx.get('workspaceRegistry') as Record<string, unknown>).create === 'function',
      },
      ...(lastCheckView(state) === undefined ? {} : { lastCheck: lastCheckView(state) }),
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

  /** Run one check: refresh the target, evaluate everything, store the report. */
  async function runCheck(call: CallContext, force = false): Promise<StatusSnapshot> {
    call.signal?.throwIfAborted()
    const warnings: string[] = []
    const state = readState(home)
    let targetOverride: TargetVersion | undefined
    let cachedFeed = state.feed

    const configured = config.targetVersion.trim()
    const pinning = configured !== '' && parseVersion(configured) !== undefined
    // The panel has one refresh button, so a check must respect the TTL: a fresh
    // cached answer is reused instead of asking the registry on every click. An
    // explicit force (the tool input) skips that shortcut.
    const cachedTarget = targetFromState(config, state, now())
    const freshCache = cachedTarget.source === 'cache' && !cachedTarget.stale
    if (!pinning && (force || !freshCache)) {
      const registries = await registryPlan()
      const channelHint = config.targetChannel === 'auto' ? detectDesktopChannel(profile?.installAnchor) : config.targetChannel
      const fetched = await fetchTargetVersion({ registries, channelHint, fetchImpl: deps.fetchImpl })
      if (fetched.ok) {
        const at = now()
        targetOverride = { version: fetched.target.version, channel: fetched.target.channel, fetchedAt: at, source: 'network', stale: false }
        cachedFeed = { fetchedAt: at, targetVersion: fetched.target.version, channel: fetched.target.channel }
      } else {
        const detail = fetched.attempts.map(attempt => `${attempt.registry}: ${attempt.error}`).join('; ')
        warnings.push(`The DSH version feed is unavailable (${detail}); using the cached target.`)
      }
    }

    const snapshot = await buildSnapshot({ targetOverride, extraWarnings: warnings })

    // M2: one guide read per check, then a bounded scan+match per own bundle.
    if (config.analyzeOnCheck) {
      const loaded = await loadGuides()
      snapshot.warnings.push(...loaded.warnings)
      let listed: BundleListing[] = []
      try {
        listed = ((await manager?.listBundles()) ?? []).map(readBundleListing).filter((entry): entry is BundleListing => entry !== undefined)
      } catch {
        listed = []
      }
      for (const bundle of snapshot.bundles) {
        if (bundle.owner.status !== 'mine') continue
        const listing = listed.find(entry => entry.base.name === bundle.name)
        if (listing === undefined) continue
        const analysis = await analyzeBundle(listing, loaded.guides)
        if (analysis.impact !== undefined) bundle.compat.impact = analysis.impact
        snapshot.warnings.push(...analysis.warnings)
      }
    }

    const reports: StoredReport[] = snapshot.bundles.map(bundle => ({
      bundle: bundle.name,
      version: bundle.version,
      ownership: bundle.owner.status,
      running: storedEvaluation(bundle.compat.running),
      target: bundle.compat.target === null ? null : storedEvaluation(bundle.compat.target),
      runtime: bundle.compat.runtime,
      needsCare: bundle.maintenance.state === 'attention',
      reasons: bundle.maintenance.reasons,
      ...(bundle.compat.impact === undefined ? {} : { impact: bundle.compat.impact }),
    }))
    const check: StoredCheck = {
      id: `${snapshot.checkedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: snapshot.checkedAt,
      runtimeVersion: snapshot.dsh.runtimeVersion,
      targetVersion: snapshot.target.version,
      total: reports.length,
      needsCare: snapshot.ownership.needsMaintenance,
      reports,
    }
    const nextState: UpkeepState = appendCheck({ ...state, ...(cachedFeed === undefined ? {} : { feed: cachedFeed }) }, check, config.checksToKeep)
    writeState(home, nextState)
    snapshot.lastCheck = {
      at: check.at,
      runtimeVersion: check.runtimeVersion,
      targetVersion: check.targetVersion,
      total: check.total,
      needsCare: check.needsCare,
    }
    return snapshot
  }

  const actions: Record<string, ActionSpec> = {
    status: {
      kind: 'read',
      description: 'DSH, profile, target version, bundles, ownership and care verdicts in one snapshot.',
      run: async (_input, call) => {
        call.signal?.throwIfAborted()
        return await buildSnapshot()
      },
    },
    check: {
      kind: 'read',
      description: 'Refresh the target DSH version from the registry, evaluate every bundle and store one report.',
      run: async (input, call) => await exclusive('check', async () => await runCheck(call, input.force === true)),
    },
    'report.get': {
      kind: 'read',
      description: 'Migration-guide report for one monitored bundle: matched guide items, their Change/Migration text and the scanned surfaces.',
      run: async (input) => {
        const name = typeof input.bundle === 'string' ? input.bundle.trim() : ''
        if (name === '') throw new HubError('INVALID_INPUT', 'report.get needs a bundle name')
        const listed = manager
          ? (await manager.listBundles()).map(readBundleListing).filter((entry): entry is BundleListing => entry !== undefined)
          : []
        const listing = listed.find(entry => entry.base.name === name && !isOfficialPackage(entry.base.name))
        if (listing === undefined) throw new HubError('UNKNOWN_BUNDLE', `No monitored bundle named ${name}`)
        const loaded = await loadGuides()
        const analysis = await analyzeBundle(listing, loaded.guides)
        return {
          bundle: name,
          window: guideWindow(),
          guideSource: loaded.guides.source,
          guideVersions: loaded.guides.versions,
          matched: analysis.matches,
          inventory: analysis.inventory ?? null,
          warnings: [...loaded.warnings, ...analysis.warnings],
        }
      },
    },
    'upgrade.prepare': {
      kind: 'write',
      description: 'Prepare a targeted upgrade: match the guides, optionally create a worktree, register its workspace and return the Session prompt.',
      run: async (input) => exclusive('upgrade', async () => {
        if (input.confirm !== true) throw new HubError('CONFIRM_REQUIRED', 'Preparing an upgrade needs confirm: true.')
        const name = typeof input.bundle === 'string' ? input.bundle.trim() : ''
        if (name === '') throw new HubError('INVALID_INPUT', 'upgrade.prepare needs a bundle name')
        const listing = await monitoredListing(name)
        if (listing === undefined) throw new HubError('UNKNOWN_BUNDLE', `No monitored bundle named ${name}`)
        const facts = readPackageFacts(name, listing.base.source ?? undefined, profile?.dir, profile?.installAnchor)
        const ownership = classifyOwnership(facts, ownerIdentity, name)
        if (ownership.status !== 'mine') throw new HubError('NOT_MINE', 'Only your own plugins can be upgraded.')

        const packageDir = readInstalledPackageDir(name, listing.base.source ?? undefined, profile?.dir, profile?.installAnchor)
        if (packageDir === undefined) throw new HubError('NO_SOURCE', 'The package directory could not be resolved.')
        const repo = await inspectRepository(exec, packageDir)
        if (repo === undefined) throw new HubError('NOT_A_REPOSITORY', 'The plugin directory is not inside a git checkout.')

        const status = await buildSnapshot()
        const loaded = await loadGuides()
        const analysis = await analyzeBundle(listing, loaded.guides)
        const manifest = readInstalledManifest(name, listing.base.source ?? undefined, profile?.dir, profile?.installAnchor)
        const verifyCommands = deriveVerifyCommands(config.verifyCommands, manifest)
        const stamp = now().toString(36)
        const prepared = await prepareWorkspace({
          exec,
          repoRoot: repo.repoRoot,
          worktree: input.worktree === true,
          worktreeRoot: config.worktreeRoot,
          bundle: name,
          stamp,
        })
        const workspaceId = await registerWorkspace(prepared.workspacePath, `Upkeep: ${name}`)
        const prompt = buildUpgradePrompt({
          bundle: name,
          repoPath: repo.repoRoot,
          workspacePath: prepared.workspacePath,
          from: status.dsh.runtimeVersion,
          to: status.target.version,
          matches: analysis.matches,
          verifyCommands,
        })
        const run: UpgradeRunRecord = {
          id: `run-${stamp}`,
          bundle: name,
          status: 'prepared',
          createdAt: now(),
          workspacePath: prepared.workspacePath,
          workspaceId,
          worktree: prepared.worktree,
          ...(prepared.branch === undefined ? {} : { branch: prepared.branch }),
          prompt,
          verifyCommands,
          from: status.dsh.runtimeVersion,
          to: status.target.version,
          matched: analysis.matches.length,
        }
        const current = readState(home)
        writeState(home, appendRun(current, run, config.runsToKeep))
        const warnings = [...loaded.warnings, ...analysis.warnings, ...prepared.warnings]

        // Start the work immediately: the workspace API only seeds a draft, so the
        // prompt is delivered to a fresh Session in the prepared directory instead.
        let autoStarted = false
        const scheduler = scheduleService(ctx)
        if (scheduler !== undefined) {
          try {
            await createOneShotTask(scheduler, {
              title: `Upkeep upgrade: ${name}`,
              prompt,
              cwd: prepared.workspacePath,
            })
            autoStarted = true
          } catch (error) {
            warnings.push(`The upgrade session could not be started automatically (${error instanceof Error ? error.message : String(error)}); open the workspace and send the prompt yourself.`)
          }
        } else {
          warnings.push('The schedule service is not mounted, so the upgrade session was not started automatically; open the workspace and send the prompt yourself.')
        }
        if (repo.dirty > 0) warnings.push(`The repository has ${repo.dirty} uncommitted change(s); the worktree starts from HEAD.`)
        return {
          run,
          from: status.dsh.runtimeVersion,
          to: status.target.version,
          matches: analysis.matches,
          verifyCommands,
          warnings,
          autoStarted,
        }
      }),
    },
    'upgrade.verify': {
      kind: 'write',
      description: 'Run the prepared verification commands in the run workspace and record the outcome.',
      run: async (input) => {
        if (input.confirm !== true) throw new HubError('CONFIRM_REQUIRED', 'Verifying a run needs confirm: true.')
        const runId = typeof input.runId === 'string' ? input.runId : ''
        if (runId === '') throw new HubError('INVALID_INPUT', 'upgrade.verify needs a runId')
        const current = readState(home)
        const run = current.runs.find(entry => entry.id === runId)
        if (run === undefined) throw new HubError('UNKNOWN_RUN', `No upgrade run named ${runId}`)
        const results = await verifyWorkspace({ exec, workspacePath: run.workspacePath, commands: run.verifyCommands })
        const ok = results.every(result => result.ok)
        const next = updateRun(current, runId, {
          status: ok ? 'verified' : 'failed',
          verify: results.map(result => ({ command: result.command, exitCode: result.exitCode, ok: result.ok, output: result.output })),
        })
        writeState(home, next)
        const updated = next.runs.find(entry => entry.id === runId) ?? run
        return { run: updated, results, ok }
      },
    },
    'upgrade.runs': {
      kind: 'read',
      description: 'Prepared upgrade runs with their status and verification outcome.',
      run: async () => ({ runs: readState(home).runs }),
    },
    'delivery.preview': {
      kind: 'read',
      description: 'Branch, working-tree, diff and gh facts for one prepared run, plus the commit/PR text.',
      run: async (input) => {
        const runId = typeof input.runId === 'string' ? input.runId : ''
        const run = readState(home).runs.find(entry => entry.id === runId)
        if (run === undefined) throw new HubError('UNKNOWN_RUN', `No upgrade run named ${runId}`)
        const preview = await readDeliveryPreview(exec, run.workspacePath, config.defaultBaseBranch)
        return {
          run,
          preview,
          proposal: buildDeliveryText({ bundle: run.bundle, from: run.from ?? null, to: run.to ?? null, matched: run.matched ?? 0 }),
          allowMerge: config.allowMerge,
        }
      },
    },
    'delivery.create-pr': {
      kind: 'write',
      description: 'Commit the run workspace, push the branch and open a pull request with gh (needs confirm).',
      run: async (input) => {
        if (input.confirm !== true) throw new HubError('CONFIRM_REQUIRED', 'Creating a pull request needs confirm: true.')
        const runId = typeof input.runId === 'string' ? input.runId : ''
        const current = readState(home)
        const run = current.runs.find(entry => entry.id === runId)
        if (run === undefined) throw new HubError('UNKNOWN_RUN', `No upgrade run named ${runId}`)
        const preview = await readDeliveryPreview(exec, run.workspacePath, config.defaultBaseBranch)
        if (!preview.gh.available) throw new HubError('GH_UNAVAILABLE', 'The gh CLI is not installed; push the branch manually.')
        if (!preview.gh.authed) throw new HubError('GH_UNAUTHENTICATED', 'The gh CLI is not signed in.')

        const proposal = buildDeliveryText({ bundle: run.bundle, from: run.from ?? null, to: run.to ?? null, matched: run.matched ?? 0 })
        const commit = await commitWorkspace(exec, run.workspacePath, proposal.commitMessage)
        if (!commit.committed && preview.dirty === 0 && preview.ahead === 0) {
          throw new HubError('NOTHING_TO_DELIVER', 'There are no changes to commit or push.')
        }
        const branch = preview.branch ?? run.branch
        if (branch === null || branch === undefined) throw new HubError('NO_BRANCH', 'The workspace is not on a git branch.')
        const pushed = await pushBranch(exec, run.workspacePath, branch)
        if (!pushed.ok) {
          writeState(home, updateRun(current, runId, { delivery: { stage: 'failed', branch, error: pushed.output.slice(-600) } }))
          throw new HubError('PUSH_FAILED', 'The branch could not be pushed.', pushed.output.slice(-2_000))
        }
        const pr = await createPullRequest(exec, run.workspacePath, {
          base: config.defaultBaseBranch,
          branch,
          title: proposal.prTitle,
          body: proposal.prBody,
        })
        if (!pr.ok || pr.url === undefined) {
          writeState(home, updateRun(current, runId, { delivery: { stage: 'failed', branch, error: pr.output.slice(-600) } }))
          throw new HubError('PR_FAILED', 'The pull request could not be created.', pr.output.slice(-2_000))
        }
        const next = updateRun(current, runId, {
          delivery: { stage: 'pr', branch, prUrl: pr.url, ...(commit.sha === undefined ? {} : { commit: commit.sha }) },
        })
        writeState(home, next)
        return {
          run: next.runs.find(entry => entry.id === runId) ?? run,
          preview,
          committed: commit.committed,
          commit: commit.sha,
          branch,
          prUrl: pr.url,
          warnings: preview.warnings,
        }
      },
    },
    'delivery.merge': {
      kind: 'write',
      description: 'Merge the pull request of a run (requires allowMerge and confirm).',
      run: async (input) => {
        if (input.confirm !== true) throw new HubError('CONFIRM_REQUIRED', 'Merging needs confirm: true.')
        if (!config.allowMerge) throw new HubError('MERGE_DISABLED', 'Merging is disabled; enable allowMerge in the plugin configuration first.')
        const runId = typeof input.runId === 'string' ? input.runId : ''
        const current = readState(home)
        const run = current.runs.find(entry => entry.id === runId)
        if (run === undefined) throw new HubError('UNKNOWN_RUN', `No upgrade run named ${runId}`)
        const prUrl = run.delivery?.prUrl
        if (prUrl === undefined) throw new HubError('NO_PULL_REQUEST', 'This run has no pull request to merge.')
        const merged = await mergePullRequest(exec, run.workspacePath, { ref: prUrl, method: 'merge' })
        if (!merged.ok) throw new HubError('MERGE_FAILED', 'The pull request could not be merged.', merged.output.slice(-2_000))
        const next = updateRun(current, runId, {
          delivery: { ...(run.delivery ?? { stage: 'merged' }), stage: 'merged', prUrl, mergedAt: now() },
        })
        writeState(home, next)
        return { run: next.runs.find(entry => entry.id === runId) ?? run, mergedAt: now() }
      },
    },
    'schedule.create': {
      kind: 'write',
      description: 'Create the recurring compatibility check through the shared schedule service (needs confirm).',
      run: async (input) => {
        if (input.confirm !== true) throw new HubError('CONFIRM_REQUIRED', 'Scheduling a check needs confirm: true.')
        const service = scheduleService(ctx)
        if (service === undefined) throw new HubError('SCHEDULE_UNAVAILABLE', 'The schedule service is not mounted in this profile.')
        const intervalHours = typeof input.intervalHours === 'number' && Number.isFinite(input.intervalHours)
          ? Math.min(Math.max(input.intervalHours, 1), 720)
          : config.scheduleIntervalHours
        const cwd = config.scheduleCwd === '' ? home : config.scheduleCwd
        const bundle = typeof input.bundle === 'string' && input.bundle.trim() !== '' ? input.bundle.trim() : undefined
        // A wall-clock time turns the task into a daily one at that local time.
        const rawTime = typeof input.time === 'string' ? input.time.trim() : ''
        const parsed = rawTime === '' ? '' : normalizeTimeOfDay(rawTime)
        if (parsed === null) throw new HubError('INVALID_INPUT', 'time must be HH:mm')
        const timeOfDay = parsed === '' ? undefined : parsed
        const rawZone = typeof input.timeZone === 'string' ? input.timeZone.trim() : ''
        if (timeOfDay !== undefined && !isKnownTimeZone(rawZone)) {
          throw new HubError('INVALID_INPUT', 'A known IANA timeZone is required with time')
        }
        const task = await createUpkeepTask(service, {
          intervalHours,
          cwd,
          ...(bundle === undefined ? {} : { bundle }),
          ...(timeOfDay === undefined ? {} : { timeOfDay, timeZone: rawZone }),
        })
        return { task, intervalHours, cwd, ...(timeOfDay === undefined ? {} : { time: timeOfDay, timeZone: rawZone }) }
      },
    },
    'schedule.list': {
      kind: 'read',
      description: 'Recurring compatibility checks this plugin created.',
      run: async () => {
        const service = scheduleService(ctx)
        if (service === undefined) return { tasks: [], available: false }
        return { tasks: await listUpkeepTasks(service), available: true }
      },
    },
    'bundles.list': {
      kind: 'read',
      description: 'Monitored (non-official) bundles with their version, source availability, compatibility and load error.',
      run: async (_input, call) => {
        call.signal?.throwIfAborted()
        const status = await buildSnapshot()
        return { checkedAt: status.checkedAt, bundles: status.bundles, excluded: status.excluded, target: status.target }
      },
    },
  }

  // One delayed startup check, unref'd so it never holds the process open.
  if (config.checkOnStartup && deps.startupCheck !== false) {
    startupTimer = setTimeout(() => {
      void runCheck({ caller: 'schedule' }).catch(() => undefined)
    }, 2_000)
    startupTimer.unref?.()
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
        if (error instanceof CompatibilityError) throw new HubError(error.code, error.message)
        throw new HubError(errorCode(error) ?? 'UPKEEP_FAILED', errorMessage(error) ?? 'The upkeep operation failed.')
      }
    },
    dispose() {
      if (startupTimer !== undefined) clearTimeout(startupTimer)
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
