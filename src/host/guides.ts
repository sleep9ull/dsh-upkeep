/**
 * DSH's migration knowledge: the shipped `docs/upgrade-guide` tree, and the
 * same tree fetched from a GitHub tag when the target release is newer than the
 * installation.
 *
 * Layout per release: `v<T>/<item>/guide.md` where `v<T>` means "leaving release
 * T" and each item has a fixed frontmatter `description` plus `## Change` and
 * `## Migration` sections. Only prose ships — there is no machine-readable break
 * index — so the parser keeps those sections verbatim for the matcher.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { isRecord } from './types.js'
import { compareVersions, parseVersion } from './versions.js'

/** One migration-guide item. */
export interface GuideItem {
  /** The release being left, e.g. `0.2.2-rc.1`. */
  version: string
  /** The item's directory name. */
  item: string
  description: string
  change: string
  migration: string
}

/** A selected range of guide items. */
export interface GuideSet {
  source: 'installed' | 'github' | 'none'
  versions: string[]
  items: GuideItem[]
  warnings: string[]
}

/** The shipped guide directory of an installation. */
export function installedGuidesDir(installAnchor: string | undefined): string | undefined {
  if (installAnchor === undefined) return undefined
  const directory = join(dirname(installAnchor), 'docs', 'upgrade-guide')
  try {
    return statSync(directory).isDirectory() ? directory : undefined
  } catch {
    return undefined
  }
}

/** Parse one guide document into its description and two sections. */
export function parseGuideDocument(text: string): { description: string; change: string; migration: string } {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(text)
  const descriptionMatch = frontmatter === null ? null : /^description:\s*"?(.*?)"?\s*$/m.exec(frontmatter[1])
  const description = descriptionMatch?.[1]?.trim() ?? ''

  const section = (heading: string): string => {
    const pattern = new RegExp(`^## ${heading}\\s*$`, 'm')
    const match = pattern.exec(text)
    if (match === null) return ''
    const rest = text.slice(match.index + match[0].length)
    const next = /^## /m.exec(rest)
    return (next === null ? rest : rest.slice(0, next.index)).trim()
  }

  return {
    description,
    change: section('Change').slice(0, 1_200),
    migration: section('Migration').slice(0, 2_400),
  }
}

/** List the version directories of a guide tree. */
function versionDirectories(root: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const versions: Array<{ version: string; dir: string }> = []
  for (const entry of entries) {
    if (!entry.startsWith('v')) continue
    const version = entry.slice(1)
    if (parseVersion(version) === undefined) continue
    versions.push({ version, dir: entry })
  }
  return versions
    .sort((left, right) => compareVersions(left.version, right.version))
    .map(entry => entry.version)
}

/** Whether a release version falls in the half-open interval `[from, to)`. */
function inRange(version: string, from: string | null, to: string | null): boolean {
  if (from !== null && compareVersions(version, from) < 0) return false
  if (to !== null && compareVersions(version, to) >= 0) return false
  return true
}

/** Read every item of one version directory. */
function readVersionItems(root: string, version: string): GuideItem[] {
  const versionDir = join(root, `v${version}`)
  let entries: string[]
  try {
    entries = readdirSync(versionDir)
  } catch {
    return []
  }
  const items: GuideItem[] = []
  for (const item of entries.sort()) {
    const file = join(versionDir, item, 'guide.md')
    if (!existsSync(file)) continue
    try {
      const parsed = parseGuideDocument(readFileSync(file, 'utf8'))
      items.push({ version, item, ...parsed })
    } catch {
      // Skip an unreadable item.
    }
  }
  return items
}

/**
 * Read the installed guide items in `[from, to)`.
 * @param installAnchor - the running installation's `@deepseek-ai/dsh/package.json`.
 * @param from - inclusive start release (null means the oldest installed).
 * @param to - exclusive target release (null means every installed release).
 */
export function readInstalledGuides(
  installAnchor: string | undefined,
  from: string | null,
  to: string | null,
): GuideSet {
  const root = installedGuidesDir(installAnchor)
  if (root === undefined) {
    return { source: 'none', versions: [], items: [], warnings: ['The installed upgrade guides could not be read.'] }
  }
  const versions = versionDirectories(root).filter(version => inRange(version, from, to))
  const items: GuideItem[] = []
  for (const version of versions) items.push(...readVersionItems(root, version))
  return { source: 'installed', versions, items, warnings: [] }
}

/** Options for one remote guide read. */
export interface RemoteGuideOptions {
  /** The target release; its tag (`dsh-v<version>`) is the source ref. */
  targetVersion: string
  from: string | null
  to: string | null
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** The repository that publishes DSH's guides. */
const REPO = 'deepseek-ai/deepseek-harness'

/** Fetch one URL as text, bounded. */
async function fetchText(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<string | undefined> {
  const answer = await fetchImpl(url, {
    headers: { accept: 'application/vnd.github+json' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!answer.ok) return undefined
  return await answer.text()
}

/**
 * Fetch guide items newer than the installation from a GitHub tag.
 * Bounded: at most six release directories and forty items each, so a report
 * stays predictable even for a large jump.
 */
export async function fetchRemoteGuides(options: RemoteGuideOptions): Promise<GuideSet> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 20_000
  const ref = `dsh-v${options.targetVersion}`
  const warnings: string[] = []
  try {
    const listText = await fetchText(`https://api.github.com/repos/${REPO}/contents/docs/upgrade-guide?ref=${encodeURIComponent(ref)}`, fetchImpl, timeoutMs)
    if (listText === undefined) {
      return { source: 'none', versions: [], items: [], warnings: [`The upgrade guides for ${ref} could not be listed.`] }
    }
    const listing: unknown = JSON.parse(listText)
    if (!Array.isArray(listing)) {
      return { source: 'none', versions: [], items: [], warnings: [`The upgrade guides for ${ref} had an unexpected shape.`] }
    }
    const versions: string[] = []
    for (const entry of listing) {
      if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.startsWith('v')) continue
      const version = entry.name.slice(1)
      if (parseVersion(version) !== undefined && inRange(version, options.from, options.to)) versions.push(version)
    }
    versions.sort(compareVersions)
    const selected = versions.slice(-6)
    const items: GuideItem[] = []
    for (const version of selected) {
      const versionText = await fetchText(`https://api.github.com/repos/${REPO}/contents/docs/upgrade-guide/v${version}?ref=${encodeURIComponent(ref)}`, fetchImpl, timeoutMs)
      if (versionText === undefined) {
        warnings.push(`v${version} could not be listed from ${ref}.`)
        continue
      }
      let entries: unknown
      try {
        entries = JSON.parse(versionText)
      } catch {
        continue
      }
      if (!Array.isArray(entries)) continue
      for (const entry of entries.slice(0, 40)) {
        if (!isRecord(entry) || typeof entry.name !== 'string') continue
        const item = entry.name
        const raw = await fetchText(`https://raw.githubusercontent.com/${REPO}/${ref}/docs/upgrade-guide/v${version}/${item}/guide.md`, fetchImpl, timeoutMs)
        if (raw === undefined) continue
        items.push({ version, item, ...parseGuideDocument(raw) })
      }
    }
    return {
      source: items.length > 0 ? 'github' : 'none',
      versions: selected,
      items,
      warnings,
    }
  } catch (error) {
    warnings.push(`The remote upgrade guides could not be read: ${error instanceof Error ? error.message : 'request failed'}`)
    return { source: 'none', versions: [], items: [], warnings }
  }
}
