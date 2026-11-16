/**
 * DSH's compatibility verdict, vendored.
 *
 * DSH decides whether a plugin may run with `evaluatePluginCompatibility` in
 * `@deepseek-ai/dsh-app-boot`. That package has no stability promise and the
 * record shape already changed once (`peers` → `requirements`), so the Host half
 * owns a copy of the rule instead of importing it: an own `engines.dsh` range
 * decides alone; without it every DSH peer must match; prereleases participate;
 * `workspace:` ranges mean the running version; an exact `name@version` →
 * exact DSH version exemption is the only escape.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isRecord } from './types.js'
import { satisfiesRange } from './versions.js'

/** Unmet requirements and the exact exemption decision for one plugin. */
export interface PluginCompatibility {
  name: string
  version: string
  runtimeVersion: string
  /** Only requirements the runtime does not satisfy, keyed `engines.dsh` or by peer name. */
  requirements: Record<string, string>
  exempted: boolean
}

/** A malformed manifest whose requirements cannot be evaluated. */
export class CompatibilityError extends Error {
  readonly code = 'MALFORMED_MANIFEST'

  constructor(message: string) {
    super(message)
    this.name = 'CompatibilityError'
  }
}

/** Read the profile's exact-version exemptions; a broken file authorizes nothing. */
export function readVersionExemptions(profileDir: string | undefined): Record<string, string[]> {
  if (profileDir === undefined) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(profileDir, 'compatibility.json'), 'utf8')) as unknown
  } catch {
    return {}
  }
  if (!isRecord(parsed)) return {}
  const exemptions: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) continue
    const versions = value.filter((entry): entry is string => typeof entry === 'string')
    if (versions.length > 0) exemptions[key] = versions
  }
  return exemptions
}

/** Whether the range holds; an empty or invalid range is unmet, as semver reports. */
function satisfies(runtimeVersion: string, range: string): boolean {
  return range.trim() !== '' && satisfiesRange(runtimeVersion, range)
}

/** The unmet requirements of one manifest, following DSH's field precedence. */
function unmetRequirements(manifest: Record<string, unknown>, runtimeVersion: string): Record<string, string> {
  if (Object.hasOwn(manifest, 'engines')) {
    const engines = isRecord(manifest.engines) ? manifest.engines : (() => {
      throw new CompatibilityError('Plugin manifest engines must be an object')
    })()
    if (Object.hasOwn(engines, 'dsh')) {
      const range = engines.dsh
      if (typeof range !== 'string') throw new CompatibilityError('Plugin manifest engines.dsh must be a string')
      return satisfies(runtimeVersion, range) ? {} : { 'engines.dsh': range }
    }
  }
  if (!Object.hasOwn(manifest, 'peerDependencies')) return {}
  const peers = isRecord(manifest.peerDependencies)
    ? manifest.peerDependencies
    : (() => {
        throw new CompatibilityError('Plugin manifest peerDependencies must be an object')
      })()
  const unmet: Record<string, string> = {}
  for (const [name, value] of Object.entries(peers)) {
    if (typeof value !== 'string') {
      throw new CompatibilityError(`Plugin manifest peerDependencies[${JSON.stringify(name)}] must be a string`)
    }
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(value) ? runtimeVersion : value
    if (!satisfies(runtimeVersion, requirement)) unmet[name] = value
  }
  return unmet
}

/** A non-empty identity field, required only once a mismatch must be reported. */
function identityField(manifest: Record<string, unknown>, field: 'name' | 'version'): string {
  const value = Object.hasOwn(manifest, field) ? manifest[field] : undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CompatibilityError(`Plugin manifest ${field} must be a non-empty string when its DSH requirements are unmet`)
  }
  return value
}

/**
 * Evaluate a plugin manifest against one DSH version.
 * @param manifest - the plugin's parsed `package.json`.
 * @param runtimeVersion - the DSH version to compare against.
 * @param exemptions - exact `name@version` → exact DSH versions.
 * @returns the unmet requirements (with the exemption decision), or `undefined` when satisfied.
 * @throws {CompatibilityError} when a declared requirement field is malformed.
 */
export function evaluatePluginCompatibility(
  manifest: unknown,
  runtimeVersion: string,
  exemptions: Readonly<Record<string, readonly string[]>> = {},
): PluginCompatibility | undefined {
  if (!isRecord(manifest)) throw new CompatibilityError('Plugin manifest must be an object')
  const requirements = unmetRequirements(manifest, runtimeVersion)
  if (Object.keys(requirements).length === 0) return undefined
  const name = identityField(manifest, 'name')
  const version = identityField(manifest, 'version')
  const key = `${name}@${version}`
  const exempted = exemptions[key]?.includes(runtimeVersion) === true
  return { name, version, runtimeVersion, requirements, exempted }
}

/** The requirement table rendered as one short sentence, for reasons and tooltips. */
export function describeRequirements(requirements: Record<string, string>): string {
  return Object.entries(requirements).map(([key, range]) => `${key} ${range}`).join(', ')
}
