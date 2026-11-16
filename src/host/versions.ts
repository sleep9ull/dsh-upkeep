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

/* ------------------------------------------------------------------ *
 * Range satisfaction
 *
 * DSH decides compatibility with `semver.satisfies(runtime, range,
 * { includePrerelease: true })`. The Host half must reproduce that verdict
 * without a runtime dependency, so this section implements the subset real
 * plugin manifests use: comparators, carets, tildes, hyphen ranges, x-ranges,
 * partial versions and `||` unions. An empty or unparseable range is unmet,
 * which is what semver reports and what DSH relies on.
 * ------------------------------------------------------------------ */

/** A comparator in a conjunction: `operator version`. */
interface Comparator {
  op: '<' | '<=' | '>' | '>=' | '='
  version: ParsedVersion
}

/** A version with an omitted patch, as partial ranges allow. */
interface PartialVersion {
  major: number
  minor?: number
  patch?: number
  prerelease: string[]
}

const PARTIAL_PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Parse a possibly partial version; `undefined` when it is not a version at all. */
function parsePartial(value: string): PartialVersion | undefined {
  if (value === '' || value === '*' || value === 'x' || value === 'X') return { major: 0, prerelease: [] }
  const match = PARTIAL_PATTERN.exec(value.trim())
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? undefined : Number(match[2]),
    patch: match[3] === undefined ? undefined : Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** Build a concrete version from a partial, defaulting omitted fields to zero. */
function concrete(partial: PartialVersion, overrides: { major?: number; minor?: number; patch?: number; prerelease?: string[] } = {}): ParsedVersion {
  return {
    major: overrides.major ?? partial.major,
    minor: overrides.minor ?? partial.minor ?? 0,
    patch: overrides.patch ?? partial.patch ?? 0,
    prerelease: overrides.prerelease ?? partial.prerelease,
    build: '',
  }
}

/** The next version after a partial's fixed prefix. */
function nextAfter(partial: PartialVersion): ParsedVersion {
  if (partial.minor === undefined) return concrete(partial, { major: partial.major + 1, minor: 0, patch: 0, prerelease: [] })
  if (partial.patch === undefined) return concrete(partial, { minor: partial.minor + 1, patch: 0, prerelease: [] })
  return concrete(partial, { patch: partial.patch + 1, prerelease: [] })
}

/** Expand `^` into an inclusive lower bound and an exclusive upper bound. */
function caret(partial: PartialVersion): Comparator[] {
  const lower: Comparator = { op: '>=', version: concrete(partial) }
  if (partial.minor === undefined) {
    return [lower, { op: '<', version: concrete(partial, { major: partial.major + 1, minor: 0, patch: 0, prerelease: [] }) }]
  }
  if (partial.patch === undefined) {
    if (partial.major > 0) return [lower, { op: '<', version: concrete(partial, { major: partial.major + 1, minor: 0, patch: 0, prerelease: [] }) }]
    return [lower, { op: '<', version: concrete(partial, { minor: partial.minor + 1, patch: 0, prerelease: [] }) }]
  }
  if (partial.major > 0) return [lower, { op: '<', version: concrete(partial, { major: partial.major + 1, minor: 0, patch: 0, prerelease: [] }) }]
  if (partial.minor > 0) return [lower, { op: '<', version: concrete(partial, { minor: partial.minor + 1, patch: 0, prerelease: [] }) }]
  return [lower, { op: '<', version: concrete(partial, { patch: partial.patch + 1, prerelease: [] }) }]
}

/** Expand `~` into bounds. */
function tilde(partial: PartialVersion): Comparator[] {
  const lower: Comparator = { op: '>=', version: concrete(partial) }
  if (partial.minor === undefined) {
    return [lower, { op: '<', version: concrete(partial, { major: partial.major + 1, minor: 0, patch: 0, prerelease: [] }) }]
  }
  return [lower, { op: '<', version: concrete(partial, { minor: partial.minor + 1, patch: 0, prerelease: [] }) }]
}

/** Translate one whitespace-separated range token into comparators. */
function tokenComparators(token: string): Comparator[] | undefined {
  const opMatch = /^(<=|>=|<|>|=|\^|~)\s*(.+)$/.exec(token)
  const op = opMatch?.[1]
  const raw = (opMatch?.[2] ?? token).trim()
  if (raw === '' ) return undefined
  const wildcard = /^(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/.exec(raw)
  if (wildcard) {
    const [, majorRaw, minorRaw, patchRaw] = wildcard
    const isWild = (value: string | undefined): boolean => value === undefined || value === 'x' || value === 'X' || value === '*'
    if (majorRaw === 'x' || majorRaw === 'X' || majorRaw === '*') return []
    const partial: PartialVersion = {
      major: Number(majorRaw),
      minor: isWild(minorRaw) ? undefined : Number(minorRaw),
      patch: isWild(patchRaw) ? undefined : Number(patchRaw),
      prerelease: [],
    }
    if (partial.minor === undefined) return [{ op: '>=', version: concrete(partial) }, { op: '<', version: nextAfter(partial) }]
    if (partial.patch === undefined) return [{ op: '>=', version: concrete(partial) }, { op: '<', version: nextAfter(partial) }]
  }
  const partial = parsePartial(raw)
  if (partial === undefined) return undefined

  if (op === '^') return caret(partial)
  if (op === '~') return tilde(partial)
  if (op === '=') {
    if (partial.minor === undefined || partial.patch === undefined) {
      return [{ op: '>=', version: concrete(partial) }, { op: '<', version: nextAfter(partial) }]
    }
    return [{ op: '=', version: concrete(partial) }]
  }
  if (op === '>' || op === '>=' || op === '<' || op === '<=') {
    if (partial.minor === undefined || partial.patch === undefined) {
      const lower = concrete(partial)
      const upper = nextAfter(partial)
      if (op === '>=') return [{ op: '>=', version: lower }]
      if (op === '>') return [{ op: '>=', version: upper }]
      if (op === '<') return [{ op: '<', version: lower }]
      return [{ op: '<', version: upper }]
    }
    return [{ op, version: concrete(partial) }]
  }
  // Bare version: exact when complete, a prefix range when partial.
  if (partial.minor === undefined || partial.patch === undefined) {
    return [{ op: '>=', version: concrete(partial) }, { op: '<', version: nextAfter(partial) }]
  }
  return [{ op: '=', version: concrete(partial) }]
}

/** Translate one `||` clause into a comparator conjunction. */
function clauseComparators(clause: string): Comparator[] | undefined {
  const hyphen = /^(.+?)\s+-\s+(.+)$/.exec(clause)
  if (hyphen) {
    const low = parsePartial(hyphen[1].trim())
    const high = parsePartial(hyphen[2].trim())
    if (low === undefined || high === undefined) return undefined
    const lower: Comparator = { op: '>=', version: concrete(low) }
    if (high.minor === undefined || high.patch === undefined) {
      return [lower, { op: '<', version: nextAfter(high) }]
    }
    return [lower, { op: '<=', version: concrete(high) }]
  }
  const comparators: Comparator[] = []
  for (const token of clause.split(/\s+/)) {
    if (token === '') continue
    const expanded = tokenComparators(token)
    if (expanded === undefined) return undefined
    comparators.push(...expanded)
  }
  return comparators.length === 0 ? [] : comparators
}

/** Whether one comparator holds for a version. */
function holds(version: ParsedVersion, comparator: Comparator): boolean {
  const order = compareParsed(version, comparator.version)
  switch (comparator.op) {
    case '<': return order < 0
    case '<=': return order <= 0
    case '>': return order > 0
    case '>=': return order >= 0
    case '=': return order === 0
  }
}

/** Compare two already parsed versions by precedence. */
function compareParsed(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  const encode = (value: string): string => value
  const a = left.prerelease
  const b = right.prerelease
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const x = a[index]
    const y = b[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      const difference = Number(x) - Number(y)
      if (difference !== 0) return difference < 0 ? -1 : 1
      continue
    }
    if (xNumeric) return -1
    if (yNumeric) return 1
    if (encode(x) !== encode(y)) return x < y ? -1 : 1
  }
  return 0
}

/**
 * Whether a version satisfies a semver range, with DSH's `includePrerelease` behaviour.
 * @param version - concrete version, prereleases allowed inside the bounds.
 * @param range - semver range; empty or unparseable ranges are unmet.
 * @returns true when at least one `||` clause holds.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseVersion(version)
  if (parsed === undefined) return false
  const clauses = range.trim().split(/\s*\|\|\s*/)
  if (clauses.length === 0 || range.trim() === '') return false
  for (const clause of clauses) {
    const comparators = clauseComparators(clause.trim())
    if (comparators === undefined) continue
    if (comparators.every(comparator => holds(parsed, comparator))) return true
  }
  return false
}
