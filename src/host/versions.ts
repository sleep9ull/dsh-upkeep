/**
 * Minimal semantic-version comparison.
 *
 * Upkeep has to compare arbitrary DSH and plugin versions — including the
 * prerelease versions DSH publishes during a release candidate cycle — without
 * depending on a package that may not resolve inside a linked plugin bundle.
 * This file implements only the comparison, not range satisfaction; ranges
 * arrive with the compatibility engine in M1.
 */

/** A parsed semantic version. */
export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** Dot-separated prerelease identifiers, empty for a release. */
  prerelease: string[]
  /** Build metadata, ignored by comparison. */
  build: string
}

const PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

/**
 * Parse a semantic version.
 * @param value - version text, with an optional leading `v`.
 * @returns the parsed version, or `undefined` when the text is not semver.
 */
export function parseVersion(value: string): ParsedVersion | undefined {
  const match = PATTERN.exec(value.trim())
  if (!match) return undefined
  const [, major, minor, patch, prerelease, build] = match
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
    build: build ?? '',
  }
}

/** Compare two prerelease identifier lists according to the semver precedence rules. */
function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const difference = Number(a) - Number(b)
      if (difference !== 0) return difference < 0 ? -1 : 1
      continue
    }
    if (aNumeric) return -1
    if (bNumeric) return 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/**
 * Compare two versions by semver precedence.
 * @returns negative when `left < right`, positive when `left > right`, zero when equal.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return left < right ? -1 : left > right ? 1 : 0
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  return comparePrerelease(a.prerelease, b.prerelease)
}

/** Whether `candidate` is strictly newer than `base`; unparseable input is never newer. */
export function isNewer(candidate: string, base: string): boolean {
  if (parseVersion(candidate) === undefined || parseVersion(base) === undefined) return false
  return compareVersions(candidate, base) > 0
}

/**
 * Pick the highest version from a list, ignoring unparseable entries.
 * @param versions - candidate version strings.
 * @returns the highest semver, or `undefined` for an empty/uncmpariable list.
 */
export function highestVersion(versions: readonly string[]): string | undefined {
  let best: string | undefined
  for (const version of versions) {
    if (parseVersion(version) === undefined) continue
    if (best === undefined || compareVersions(version, best) > 0) best = version
  }
  return best
}
