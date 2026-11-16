/**
 * A plugin's DSH surface inventory: what a plugin actually uses, recovered
 * mechanically from its package manifest, bundle patch and shipped source.
 *
 * The matcher compares these tokens against the migration guides, so the scan
 * favours recall over precision and records the kind of every hit: a matched
 * service name should read differently from a matched string in a comment.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { isRecord } from './types.js'

/** One matched surface token. */
export interface SurfaceHit {
  kind: 'package' | 'service' | 'event' | 'tool' | 'command' | 'slot' | 'config-key' | 'row-id'
  value: string
}

/** Everything the scan found, plus the files it read. */
export interface SurfaceInventory {
  packageName: string
  packages: string[]
  services: string[]
  events: string[]
  tools: string[]
  commands: string[]
  slots: string[]
  configKeys: string[]
  rowIds: string[]
  filesScanned: number
  warnings: string[]
}

/** Caps that keep a scan bounded on a large checkout. */
const MAX_FILES = 240
const MAX_BYTES = 256 * 1024
const SCANNED_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.json', '.yml', '.yaml']

/** Add a token to a set when it looks like a real identifier. */
function add(target: Set<string>, value: string): void {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.length <= 120) target.add(trimmed)
}

/** Extract `@deepseek-ai/dsh-*` package references from text. */
function scanPackages(text: string, target: Set<string>): void {
  for (const match of text.matchAll(/@deepseek-ai\/(dsh-[a-z0-9-]+)/g)) add(target, '@deepseek-ai/' + match[1])
}

/** JavaScript/context members that are language noise, not DSH services. */
const SERVICE_STOPLIST = new Set([
  'get', 'set', 'on', 'off', 'emit', 'effect', 'inject', 'args', 'options', 'ctx', 'logger',
  'then', 'catch', 'map', 'find', 'filter', 'push', 'slice', 'length', 'name', 'value', 'data',
  'error', 'state', 'type', 'key', 'id', 'run', 'call', 'apply', 'toString', 'hasOwnProperty',
])

/** Extract `ctx.<member>` service references from text. */
function scanServices(text: string, target: Set<string>): void {
  for (const match of text.matchAll(/\bctx\.([a-zA-Z][a-zA-Z0-9]*)/g)) {
    if (!SERVICE_STOPLIST.has(match[1])) add(target, match[1])
  }
}

/** Extract `'a/b'`-style event names from text. */
function scanEvents(text: string, target: Set<string>): void {
  for (const match of text.matchAll(/['"]([a-z][a-z0-9-]*\/[a-z][a-z0-9-]+)['"]/g)) add(target, match[1])
}

/** Extract tool names from `name: 'x'` (the tool registry shape). */
function scanTools(text: string, target: Set<string>): void {
  for (const match of text.matchAll(/\bname:\s*['"]([a-z][a-z0-9_]+)['"]/g)) add(target, match[1])
}

/** Extract command names from `register({ name: 'x' })` or `command: 'x'`. */
function scanCommands(text: string, target: Set<string>): void {
  for (const match of text.matchAll(/\bcommand(?:Name)?:\s*['"]([a-z][a-z0-9-]*)['"]/g)) add(target, match[1])
}

/** Extract dotted slot ids such as `settings.plugins.tab`. */
function scanSlots(text: string, target: Set<string>): void {
  for (const match of text.matchAll(/['"]([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]+){1,4})['"]/g)) add(target, match[1])
}

/** Extract configuration keys declared in a patch or manifest. */
function scanConfigKeys(text: string, target: Set<string>): void {
  for (const match of text.matchAll(/\bconfig:\s*\n?\s*([a-zA-Z][a-zA-Z0-9_]*)\s*:/g)) add(target, match[1])
}

/** Extract Loader row ids from a patch. */
function scanRowIds(text: string, target: Set<string>): void {
  for (const match of text.matchAll(/\bid:\s*['"]?([a-z][a-z0-9-]*)['"]?\s*$/gm)) add(target, match[1])
}

/** Read text from a file, bounded and tolerant. */
function readBounded(path: string): string | undefined {
  try {
    if (statSync(path).size > MAX_BYTES) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Collect the scannable files under a directory, bounded and shallow enough to finish. */
function collectFiles(root: string): string[] {
  const files: string[] = []
  const walk = (directory: string, depth: number): void => {
    if (files.length >= MAX_FILES || depth > 4) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'coverage') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(path, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!SCANNED_EXTENSIONS.some(extension => entry.name.endsWith(extension))) continue
      files.push(path)
    }
  }
  walk(root, 0)
  return files
}

/**
 * Scan a plugin package directory.
 * @param packageDir - the resolved plugin package root.
 * @param manifest - its parsed `package.json`, when already available.
 */
export function scanSurfaces(packageDir: string, manifest: Record<string, unknown> | undefined): SurfaceInventory {
  const packages = new Set<string>()
  const services = new Set<string>()
  const events = new Set<string>()
  const tools = new Set<string>()
  const commands = new Set<string>()
  const slots = new Set<string>()
  const configKeys = new Set<string>()
  const rowIds = new Set<string>()
  const warnings: string[] = []

  const packageName = manifest !== undefined && typeof manifest.name === 'string' ? manifest.name : ''
  if (manifest !== undefined) {
    // The manifest itself names packages and declares bundle/client composition.
    const manifestText = JSON.stringify(manifest)
    scanPackages(manifestText, packages)
    if (isRecord(manifest.dsh) && isRecord(manifest.dsh.client) && Array.isArray(manifest.dsh.client.inject)) {
      for (const entry of manifest.dsh.client.inject) {
        if (typeof entry === 'string') add(packages, entry)
      }
    }
  }

  let filesScanned = 0
  const bundlePatch = manifest !== undefined && isRecord(manifest.dsh) && isRecord(manifest.dsh.bundle) && typeof manifest.dsh.bundle.patch === 'string'
    ? manifest.dsh.bundle.patch
    : undefined
  if (bundlePatch !== undefined) {
    const patchText = readBounded(join(packageDir, bundlePatch))
    if (patchText !== undefined) {
      filesScanned += 1
      scanPackages(patchText, packages)
      scanServices(patchText, services)
      scanConfigKeys(patchText, configKeys)
      scanRowIds(patchText, rowIds)
      for (const match of patchText.matchAll(/\binject:\s*\[([^\]]*)\]/g)) {
        for (const name of match[1].split(',')) add(services, name.replace(/['"\s]/g, ''))
      }
    } else {
      warnings.push(`The bundle patch ${bundlePatch} could not be read.`)
    }
  }

  for (const file of collectFiles(packageDir)) {
    const text = readBounded(file)
    if (text === undefined) continue
    filesScanned += 1
    scanPackages(text, packages)
    scanServices(text, services)
    scanEvents(text, events)
    scanTools(text, tools)
    scanCommands(text, commands)
    scanSlots(text, slots)
    scanConfigKeys(text, configKeys)
    scanRowIds(text, rowIds)
  }

  return {
    packageName,
    packages: [...packages].sort(),
    services: [...services].sort(),
    events: [...events].sort(),
    tools: [...tools].sort(),
    commands: [...commands].sort(),
    slots: [...slots].sort(),
    configKeys: [...configKeys].sort(),
    rowIds: [...rowIds].sort(),
    filesScanned,
    warnings,
  }
}

/** One inventory token as a flat list, used by the matcher and the report. */
export function inventoryHits(inventory: SurfaceInventory): SurfaceHit[] {
  const hits: SurfaceHit[] = []
  for (const value of inventory.packages) hits.push({ kind: 'package', value })
  for (const value of inventory.services) hits.push({ kind: 'service', value })
  for (const value of inventory.events) hits.push({ kind: 'event', value })
  for (const value of inventory.tools) hits.push({ kind: 'tool', value })
  for (const value of inventory.commands) hits.push({ kind: 'command', value })
  for (const value of inventory.slots) hits.push({ kind: 'slot', value })
  for (const value of inventory.configKeys) hits.push({ kind: 'config-key', value })
  for (const value of inventory.rowIds) hits.push({ kind: 'row-id', value })
  return hits
}

/** The package directory relative to its parent, for logs. */
export function displayPath(path: string): string {
  return relative(join(path, '..'), path)
}
