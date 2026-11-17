/**
 * Durable upkeep state: the latest compatibility reports and the version-feed
 * cache, kept as one small JSON file under `$DSH_HOME/upkeep/state.json`.
 *
 * DSH's domain storage needs zod record schemas, and the Host half must stay
 * runtime-dependency-free, so this module owns a versioned, bounded file with
 * atomic writes instead. The file is derived data: losing it costs a re-check,
 * never plugin behaviour.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isRecord } from './types.js'

/** One evaluation stored in a report. */
export interface StoredEvaluation {
  status: 'compatible' | 'incompatible' | 'unknown'
  /** Unmet requirements; empty unless incompatible. */
  requirements: Record<string, string>
  exempted: boolean
  /** Why the evaluation is unknown or incompatible, when a range alone does not say. */
  reason?: string
}

/** One plugin's stored verdicts from a check. */
export interface StoredReport {
  bundle: string
  version: string | null
  ownership: 'mine' | 'other' | 'unknown'
  running: StoredEvaluation
  target: StoredEvaluation | null
  runtime: { failed: number; pending: number }
  needsCare: boolean
  reasons: string[]
  /** Migration-guide items that mention this plugin's surfaces (M2). */
  impact?: {
    matched: number
    versions: string[]
    top: Array<{ version: string; item: string; description: string }>
  }
}

/** One completed check. */
export interface StoredCheck {
  id: string
  at: number
  runtimeVersion: string | null
  targetVersion: string | null
  total: number
  needsCare: number
  reports: StoredReport[]
}

/** One prepared upgrade run (M3). */
export interface StoredRun {
  id: string
  bundle: string
  status: 'prepared' | 'verified' | 'failed'
  createdAt: number
  workspacePath: string
  workspaceId: string
  worktree: boolean
  branch?: string
  prompt: string
  verifyCommands: string[]
  from?: string | null
  to?: string | null
  matched?: number
  verify?: Array<{ command: string; exitCode: number | null; ok: boolean; output: string }>
  /** Delivery progress: commit, push, pull request, merge. */
  delivery?: {
    stage: 'committed' | 'pushed' | 'pr' | 'merged' | 'failed'
    commit?: string
    branch?: string
    prUrl?: string
    mergedAt?: number
    error?: string
  }
}

/** The cached target-version answer from the registry. */
export interface CachedFeed {
  fetchedAt: number
  targetVersion: string | null
  channel: string | null
}

/** The whole state file. */
export interface UpkeepState {
  version: 1
  feed?: CachedFeed
  checks: StoredCheck[]
  runs: StoredRun[]
}

/** The newest stored check, as the panel reads it. */
export interface LastCheckView {
  at: number
  runtimeVersion: string | null
  targetVersion: string | null
  total: number
  needsCare: number
}

/** The directory that holds the state file. */
export function stateDir(home: string): string {
  return join(home, 'upkeep')
}

/** The state file path. */
export function statePath(home: string): string {
  return join(stateDir(home), 'state.json')
}

/** An empty state. */
export function emptyState(): UpkeepState {
  return { version: 1, checks: [], runs: [] }
}

/**
 * Read the state file.
 * @param home - the profile's home directory.
 * @returns the parsed state, or an empty one when the file is missing or invalid.
 */
/** Version of the file this build writes. */
export const STATE_VERSION = 1

/**
 * Bring an older payload forward instead of discarding it.
 *
 * A missing version is the pre-versioning shape, which is field-compatible. A
 * payload from a NEWER build is returned as-is by `readState` only when it can be
 * read safely; otherwise it is treated as unknown so the caller starts empty
 * rather than writing a downgraded file over it.
 */
function migrate(record: Record<string, unknown>): Record<string, unknown> | null {
  const version = typeof record.version === 'number' ? record.version : 0
  if (version > STATE_VERSION) return null
  return { ...record, version: STATE_VERSION }
}

export function readState(home: string): UpkeepState {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(statePath(home), 'utf8')) as unknown
  } catch {
    return emptyState()
  }
  const migrated = isRecord(parsed) ? migrate(parsed) : null
  if (migrated === null) return emptyState()
  const source = migrated
  const checks = Array.isArray(source.checks)
    ? source.checks.filter((entry): entry is StoredCheck => isStoredCheck(entry))
    : []
  const feed = isCachedFeed(source.feed) ? source.feed : undefined
  const runs = Array.isArray(source.runs) ? source.runs.filter((entry): entry is StoredRun => isStoredRun(entry)) : []
  return { version: 1, ...(feed === undefined ? {} : { feed }), checks, runs }
}

/** Structural check for one stored check entry. */
function isStoredCheck(value: unknown): value is StoredCheck {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.at === 'number'
    && Array.isArray(value.reports)
    && (typeof value.runtimeVersion === 'string' || value.runtimeVersion === null)
    && (typeof value.targetVersion === 'string' || value.targetVersion === null)
    && typeof value.total === 'number'
    && typeof value.needsCare === 'number'
}

/** Structural check for one stored run. */
function isStoredRun(value: unknown): value is StoredRun {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.bundle === 'string'
    && typeof value.status === 'string'
    && typeof value.createdAt === 'number'
    && typeof value.workspacePath === 'string'
    && typeof value.workspaceId === 'string'
    && Array.isArray(value.prompt === undefined ? [] : value.verifyCommands)
}

/** Structural check for the cached feed. */
function isCachedFeed(value: unknown): value is CachedFeed {
  return isRecord(value)
    && typeof value.fetchedAt === 'number'
    && (typeof value.targetVersion === 'string' || value.targetVersion === null)
    && (typeof value.channel === 'string' || value.channel === null)
}

/**
 * Write the state file atomically. Failures are swallowed: state is a cache.
 * @returns whether the write succeeded.
 */
export function writeState(home: string, state: UpkeepState): boolean {
  const path = statePath(home)
  const temporary = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(stateDir(home), { recursive: true })
    writeFileSync(temporary, JSON.stringify(state), 'utf8')
    renameSync(temporary, path)
    return true
  } catch {
    return false
  }
}

/**
 * Return a new state with one check prepended and older checks bounded.
 * @param state - the current state.
 * @param check - the check to record.
 * @param keep - how many checks to retain.
 */
export function appendCheck(state: UpkeepState, check: StoredCheck, keep: number): UpkeepState {
  const limit = Math.min(Math.max(Math.trunc(keep), 1), 100)
  return { ...state, checks: [check, ...state.checks].slice(0, limit) }
}

/**
 * Summarize the newest check for the status snapshot.
 * @param state - the current state.
 */
export function lastCheckView(state: UpkeepState): LastCheckView | undefined {
  const check = state.checks[0]
  if (check === undefined) return undefined
  return {
    at: check.at,
    runtimeVersion: check.runtimeVersion,
    targetVersion: check.targetVersion,
    total: check.total,
    needsCare: check.needsCare,
  }
}

/** Return a new state with one run prepended and older runs bounded. */
export function appendRun(state: UpkeepState, run: StoredRun, keep: number): UpkeepState {
  const limit = Math.min(Math.max(Math.trunc(keep), 1), 20)
  return { ...state, runs: [run, ...state.runs].slice(0, limit) }
}

/** Replace one run by id; unknown ids leave the state unchanged. */
export function updateRun(state: UpkeepState, id: string, patch: Partial<StoredRun>): UpkeepState {
  return { ...state, runs: state.runs.map(run => (run.id === id ? { ...run, ...patch } : run)) }
}

/** Whether a state directory exists yet; used to avoid creating one on a read-only check. */
export function hasState(home: string): boolean {
  return existsSync(statePath(home))
}
