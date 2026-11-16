/**
 * Target-version awareness: which DSH release the monitor compares against.
 *
 * DSH exposes no "latest version" service, so the answer comes from the npm
 * registry (the host process fetch is already proxied), cached under
 * `$DSH_HOME/upkeep/state.json`. The `latest` dist-tag is deliberately NOT the
 * source of truth: it lags `next` during a release-candidate cycle, so the
 * fallback is the highest published semver and the tag is only a label.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { highestVersion, parseVersion } from './versions.js'
import { isRecord } from './types.js'

/** The comparison target the panel shows. */
export interface TargetVersion {
  version: string | null
  channel: string | null
  fetchedAt: number | null
  source: 'config' | 'network' | 'cache' | 'none'
  /** Whether a cached answer is older than the configured TTL. */
  stale: boolean
}

/** Registries asked in order when the plugin manager cannot name a plan. */
export const DEFAULT_REGISTRIES = ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/']

/** One registry's parsed answer. */
export interface PackumentFacts {
  versions: string[]
  tags: Record<string, string>
}

/** Map a desktop update channel to the npm dist-tag that carries it. */
function channelTag(channel: string | undefined): string | undefined {
  if (channel === undefined) return undefined
  const normalized = channel.trim().toLowerCase()
  if (normalized === 'stable') return 'latest'
  if (normalized === 'nightly' || normalized === 'beta' || normalized === 'rc') return 'next'
  if (normalized === 'alpha') return 'alpha'
  return normalized === '' ? undefined : normalized
}

/**
 * Read the desktop app's update channel from the app-update.yml beside the
 * running installation. Non-desktop installations simply return `undefined`.
 */
export function detectDesktopChannel(installAnchor: string | undefined): string | undefined {
  if (installAnchor === undefined) return undefined
  let directory = dirname(installAnchor)
  for (let depth = 0; depth < 7; depth += 1) {
    try {
      const text = readFileSync(join(directory, 'app-update.yml'), 'utf8')
      const match = /^\s*channel:\s*(\S+)\s*$/m.exec(text)
      if (match) return match[1]
    } catch {
      // Keep walking up.
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

/**
 * Parse the fields the feed needs out of an npm packument.
 * @param raw - decoded registry JSON.
 * @returns published versions and dist-tags, or `undefined` when the shape is wrong.
 */
export function parsePackument(raw: unknown): PackumentFacts | undefined {
  if (!isRecord(raw)) return undefined
  const versions = isRecord(raw.versions) ? Object.keys(raw.versions) : []
  const tagsRaw = isRecord(raw['dist-tags']) ? raw['dist-tags'] : {}
  const tags: Record<string, string> = {}
  for (const [name, value] of Object.entries(tagsRaw)) {
    if (typeof value === 'string') tags[name] = value
  }
  if (versions.length === 0) return undefined
  return { versions, tags }
}

/**
 * Choose the version to compare against.
 * @param facts - published versions and tags.
 * @param channelHint - the desktop channel (or a tag name); omitted means "highest published".
 * @returns the chosen version with its channel label.
 */
export function pickTarget(facts: PackumentFacts, channelHint?: string): { version: string | null; channel: string | null } {
  const tag = channelTag(channelHint)
  if (tag !== undefined && facts.tags[tag] !== undefined && parseVersion(facts.tags[tag]) !== undefined) {
    return { version: facts.tags[tag], channel: tag }
  }
  const highest = highestVersion(facts.versions)
  if (highest === undefined) return { version: null, channel: null }
  const matchingTag = Object.entries(facts.tags).find(([, value]) => value === highest)?.[0]
  return { version: highest, channel: matchingTag ?? 'latest-available' }
}

/** Options for one feed read. */
export interface FetchFeedOptions {
  registries: string[]
  channelHint?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** A failed registry attempt. */
export interface FeedAttempt {
  registry: string
  error: string
}

/**
 * Ask the registries in order for the published versions.
 * @returns the parsed answer with the registry that produced it, or every attempt's failure.
 */
export async function fetchTargetVersion(
  options: FetchFeedOptions,
): Promise<{ ok: true; facts: PackumentFacts; registry: string; target: { version: string | null; channel: string | null } } | { ok: false; attempts: FeedAttempt[] }> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  const attempts: FeedAttempt[] = []
  const seen = new Set<string>()
  for (const raw of options.registries) {
    const registry = raw.trim().replace(/\/+$/, '')
    if (registry === '' || seen.has(registry)) continue
    seen.add(registry)
    try {
      const answer = await fetchImpl(`${registry}/@deepseek-ai/dsh`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!answer.ok) {
        attempts.push({ registry, error: `HTTP ${answer.status}` })
        continue
      }
      const facts = parsePackument(await answer.json() as unknown)
      if (facts === undefined) {
        attempts.push({ registry, error: 'unexpected registry response' })
        continue
      }
      return { ok: true, facts, registry, target: pickTarget(facts, options.channelHint) }
    } catch (error) {
      attempts.push({ registry, error: error instanceof Error ? error.message : 'request failed' })
    }
  }
  return { ok: false, attempts }
}
