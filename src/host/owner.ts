/**
 * Ownership: decide which monitored plugins belong to this machine's author,
 * and back every verdict with evidence.
 *
 * The plugin is a tool for a maintainer, so the useful question is not "is this
 * plugin compatible" but "does *my* plugin need care". Authorship is inferred
 * from the package's own metadata (scope, author, repository, local checkout and
 * its git remote) matched against the local identity (explicit configuration, the
 * developer's git configuration and GitHub login). Nothing is guessed: with no
 * signal the verdict is `unknown`, and every verdict carries the evidence string
 * the panel shows on hover.
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

import { isRecord } from './types.js'

/** Who a plugin belongs to, as far as this machine can tell. */
export type OwnershipStatus = 'mine' | 'other' | 'unknown'

/** The local author identity used for matching. */
export interface OwnerIdentity {
  /** Normalized account handles (npm scope / GitHub login). */
  handles: string[]
  /** Normalized email addresses. */
  emails: string[]
  /** Where the identity came from: `config`, `gitconfig`, `gh`. */
  sources: string[]
}

/** The facts ownership is decided from. */
export interface OwnershipVerdict {
  status: OwnershipStatus
  /** Short evidence tokens, such as `scope:@sleep9ull` or `repo:someone/plugin`. */
  evidence: string[]
}

/** The ownership-relevant slice of a plugin's package manifest. */
export interface PackageFacts {
  name?: string
  authorName?: string
  authorEmail?: string
  repositoryOwner?: string
  repositoryUrl?: string
  /** The local checkout a `link:` / `file:` install serves. */
  localPath?: string
  /** The owner segment of the checkout's git remote, when readable. */
  remoteOwner?: string
}

/** Raw identity configuration from the Loader row. */
export interface OwnerIdentityConfig {
  handles?: unknown
  emails?: unknown
  autoDetect?: unknown
}

/** Trim, drop empties, lowercase and dedupe a list of strings. */
function normalizeList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const normalized = entry.trim().replace(/^@/, '').toLowerCase()
    if (normalized !== '') seen.add(normalized)
  }
  return [...seen]
}

/** Parse `[user]` out of a git configuration file, tolerating its INI-lite syntax. */
function readGitIdentity(home: string): { name?: string; email?: string } {
  const text = readText(join(home, '.gitconfig'))
  if (text === undefined) return {}
  const result: { name?: string; email?: string } = {}
  let inUser = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    if (line.startsWith('[')) {
      inUser = /^\[user\]/i.test(line)
      continue
    }
    if (!inUser) continue
    const match = /^(name|email)\s*=\s*(.+)$/i.exec(line)
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim()
    if (value !== '') result[key as 'name' | 'email'] = value
  }
  return result
}

/** Read the signed-in GitHub account from the gh CLI configuration, if present. */
function readGhLogin(home: string): string | undefined {
  const text = readText(join(home, '.config', 'gh', 'hosts.yml'))
  if (text === undefined) return undefined
  const match = /^\s+user:\s*(\S+)\s*$/m.exec(text)
  return match?.[1]
}

/** Read a text file, returning `undefined` for an unreadable path. */
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Resolve the local author identity.
 * @param config - the Loader row's `ownerHandles` / `ownerEmails` / `autoDetectOwner`.
 * @param options.home - home directory override for tests; defaults to `os.homedir()`.
 */
export function resolveOwnerIdentity(config: OwnerIdentityConfig, options: { home?: string } = {}): OwnerIdentity {
  const handles = normalizeList(config.handles)
  const emails = normalizeList(config.emails)
  const sources: string[] = []
  if (handles.length > 0 || emails.length > 0) sources.push('config')

  if (config.autoDetect !== false) {
    const home = options.home ?? homedir()
    const git = readGitIdentity(home)
    if (git.name !== undefined && normalizeGitHandle(git.name) !== undefined) {
      handles.push(normalizeGitHandle(git.name) as string)
      sources.push('gitconfig')
    }
    if (git.email !== undefined) {
      emails.push(git.email.toLowerCase())
      sources.push('gitconfig')
    }
    const login = readGhLogin(home)
    if (login !== undefined) {
      handles.push(login.toLowerCase())
      sources.push('gh')
    }
  }

  return {
    handles: [...new Set(handles)],
    emails: [...new Set(emails)],
    sources: [...new Set(sources)],
  }
}

/** A git user name is only usable as a handle when it looks like one. */
function normalizeGitHandle(name: string): string | undefined {
  const value = name.trim().replace(/^@/, '').toLowerCase()
  return /^[a-z0-9][a-z0-9._-]*$/.test(value) ? value : undefined
}

/** Parse the owner segment out of a repository URL. */
function ownerFromRepositoryUrl(url: string): string | undefined {
  const trimmed = url.trim()
  if (trimmed === '') return undefined
  const shorthand = /^(?:github|gitlab|bitbucket):([^/]+)\//i.exec(trimmed)
  if (shorthand) return shorthand[1].toLowerCase()
  const host = /^(?:git\+)?(?:https?|ssh|git):\/\/[^/]+\/([^/]+)\//i.exec(trimmed)
  if (host) return host[1].toLowerCase()
  const scp = /^[^@]+@[^:]+:([^/]+)\//.exec(trimmed)
  if (scp) return scp[1].toLowerCase()
  return undefined
}

/** Resolve a `link:` / `file:` spec against the profile directory. */
function localPathFromSource(source: string | undefined, profileDir: string | undefined): string | undefined {
  if (source === undefined) return undefined
  const match = /^(?:link|file):(.+)$/.exec(source.trim())
  if (!match) return undefined
  const target = match[1]
  if (isAbsolute(target)) return resolve(target)
  return profileDir === undefined ? resolve(target) : resolve(profileDir, target)
}

/**
 * The local checkout a spec points at, but only when it really is a directory.
 *
 * `file:` also records local tarballs (`"file:../plugin-0.1.0.tgz"`), and DSH
 * reports both forms as `source: file:/abs/path` without telling them apart
 * (`dsh-plugin-manager`'s `dependencySpec`). A tarball is an install input, not a
 * package root: treating it as one makes every read below it fail, so the scan
 * would report "cannot read the patch" and zero files instead of the package.
 */
function localDirectory(source: string | undefined, profileDir: string | undefined): string | undefined {
  const target = localPathFromSource(source, profileDir)
  if (target === undefined) return undefined
  try {
    return statSync(target).isDirectory() ? target : undefined
  } catch {
    return undefined
  }
}

/** Read the owner of a checkout's `origin` remote. */
function readGitRemoteOwner(checkout: string): string | undefined {
  const text = readText(join(checkout, '.git', 'config'))
  if (text === undefined) return undefined
  let inOrigin = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(line)
      continue
    }
    if (!inOrigin) continue
    const match = /^url\s*=\s*(.+)$/i.exec(line)
    if (match) return ownerFromRepositoryUrl(match[1])
  }
  return undefined
}

/** Read one package manifest into ownership facts. */
function factsFromManifest(name: string, manifest: unknown): PackageFacts {
  const facts: PackageFacts = { name }
  if (!isRecord(manifest)) return facts

  const author = manifest.author
  if (typeof author === 'string') {
    const match = /^([^<(]+?)\s*(?:<([^>]+)>)?\s*$/.exec(author.trim())
    if (match) {
      facts.authorName = match[1].trim()
      if (match[2] !== undefined) facts.authorEmail = match[2].trim()
    }
  } else if (isRecord(author)) {
    if (typeof author.name === 'string') facts.authorName = author.name
    if (typeof author.email === 'string') facts.authorEmail = author.email
  }

  const repository = manifest.repository
  const repositoryUrl = typeof repository === 'string'
    ? repository
    : isRecord(repository) && typeof repository.url === 'string' ? repository.url : undefined
  if (repositoryUrl !== undefined) {
    facts.repositoryUrl = repositoryUrl
    const owner = ownerFromRepositoryUrl(repositoryUrl)
    if (owner !== undefined) facts.repositoryOwner = owner
  }
  if (facts.repositoryOwner === undefined && typeof manifest.homepage === 'string') {
    const owner = ownerFromRepositoryUrl(manifest.homepage)
    if (owner !== undefined) facts.repositoryOwner = owner
  }
  return facts
}

/**
 * Resolve one installed bundle's package directory (the scanned plugin source root).
 * @param name - the bundle's package name.
 * @param source - the `source` spec `listBundles()` reports, when any.
 * @param profileDir - the current profile directory.
 * @param installAnchor - the running DSH manifest path, used as an extra resolution anchor.
 * @returns the local checkout when the spec points at a directory, otherwise the
 *   resolved installed copy; `undefined` when neither can be read.
 */
export function readInstalledPackageDir(
  name: string,
  source: string | undefined,
  profileDir: string | undefined,
  installAnchor: string | undefined,
): string | undefined {
  const localPath = localDirectory(source, profileDir)
  if (localPath !== undefined) return localPath
  const candidates: string[] = []
  if (profileDir !== undefined) candidates.push(profileDir)
  if (installAnchor !== undefined) candidates.push(dirname(installAnchor))
  for (const anchor of candidates) {
    try {
      const requireFrom = createRequire(join(anchor, 'package.json'))
      return dirname(requireFrom.resolve(`${name}/package.json`))
    } catch {
      // Try the next anchor.
    }
  }
  return undefined
}

/**
 * Read one installed bundle's parsed manifest.
 * @param name - the bundle's package name.
 * @param source - the `source` spec `listBundles()` reports, when any.
 * @param profileDir - the current profile directory.
 * @param installAnchor - the running DSH manifest path, used as an extra resolution anchor.
 * @returns the parsed manifest, or `undefined` when it cannot be read.
 */
export function readInstalledManifest(
  name: string,
  source: string | undefined,
  profileDir: string | undefined,
  installAnchor: string | undefined,
): Record<string, unknown> | undefined {
  const localPath = localDirectory(source, profileDir)
  const candidates: string[] = []
  if (localPath !== undefined) candidates.push(localPath)
  if (profileDir !== undefined) candidates.push(profileDir)
  if (installAnchor !== undefined) candidates.push(dirname(installAnchor))
  for (const anchor of candidates) {
    try {
      const requireFrom = createRequire(join(anchor, 'package.json'))
      const manifestPath = requireFrom.resolve(`${name}/package.json`)
      const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (isRecord(parsed)) return parsed
    } catch {
      // Try the next anchor.
    }
  }
  if (localPath !== undefined) {
    const manifest = readText(join(localPath, 'package.json'))
    if (manifest !== undefined) {
      try {
        const parsed: unknown = JSON.parse(manifest)
        if (isRecord(parsed)) return parsed
      } catch {
        // A malformed manifest is unreadable.
      }
    }
  }
  return undefined
}

/**
 * Read the facts for one installed bundle.
 * @param name - the bundle's package name.
 * @param source - the `source` spec `listBundles()` reports, when any.
 * @param profileDir - the current profile directory.
 * @param installAnchor - the running DSH manifest path, used as an extra resolution anchor.
 */
export function readPackageFacts(
  name: string,
  source: string | undefined,
  profileDir: string | undefined,
  installAnchor: string | undefined,
): PackageFacts {
  const localPath = localDirectory(source, profileDir)
  const candidates: string[] = []
  if (localPath !== undefined) candidates.push(localPath)
  if (profileDir !== undefined) candidates.push(profileDir)
  if (installAnchor !== undefined) candidates.push(dirname(installAnchor))

  for (const anchor of candidates) {
    try {
      const requireFrom = createRequire(join(anchor, 'package.json'))
      const manifestPath = requireFrom.resolve(`${name}/package.json`)
      const facts = factsFromManifest(name, JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown)
      if (localPath !== undefined) {
        facts.localPath = localPath
        facts.remoteOwner = readGitRemoteOwner(localPath)
      }
      return facts
    } catch {
      // Try the next anchor.
    }
  }

  const facts: PackageFacts = { name }
  if (localPath !== undefined) {
    facts.localPath = localPath
    facts.remoteOwner = readGitRemoteOwner(localPath)
    const manifest = readText(join(localPath, 'package.json'))
    if (manifest !== undefined) {
      try {
        Object.assign(facts, factsFromManifest(name, JSON.parse(manifest) as unknown))
      } catch {
        // A malformed manifest contributes only the path evidence.
      }
    }
  }
  return facts
}

/**
 * Classify ownership from package facts and the local identity.
 * @param facts - the manifest and checkout facts.
 * @param identity - the resolved local author identity.
 * @param packageName - the bundle's package name, used for the scope signal.
 */
export function classifyOwnership(facts: PackageFacts, identity: OwnerIdentity, packageName: string): OwnershipVerdict {
  const evidence: string[] = []
  const handles = new Set(identity.handles)
  const emails = new Set(identity.emails)
  let mine = 0
  let other = 0

  const scopeMatch = /^@([^/]+)\//.exec(packageName)
  const scope = scopeMatch?.[1]?.toLowerCase()
  if (scope !== undefined) {
    evidence.push(`scope:@${scope}`)
    if (handles.has(scope)) mine += 1
  }

  if (facts.authorName !== undefined && facts.authorName.trim() !== '') {
    const authorName = facts.authorName.trim().replace(/^@/, '').toLowerCase()
    if (handles.has(authorName)) {
      evidence.push(`author:${authorName}`)
      mine += 1
    }
  }
  if (facts.authorEmail !== undefined) {
    const email = facts.authorEmail.trim().toLowerCase()
    if (emails.has(email)) {
      evidence.push(`author-email:${email}`)
      mine += 1
    } else {
      evidence.push(`author-email:${email}`)
    }
  }

  if (facts.repositoryOwner !== undefined) {
    evidence.push(`repo:${facts.repositoryOwner}`)
    if (handles.has(facts.repositoryOwner)) mine += 1
    else if (handles.size > 0) other += 1
  }

  if (facts.localPath !== undefined) evidence.push('local-checkout')
  if (facts.remoteOwner !== undefined) {
    evidence.push(`remote:${facts.remoteOwner}`)
    if (handles.has(facts.remoteOwner)) mine += 1
    else if (handles.size > 0) other += 1
  }

  if (evidence.length === 0) evidence.push('no-metadata')
  if (mine > 0) return { status: 'mine', evidence }
  if (other > 0) return { status: 'other', evidence }
  return { status: 'unknown', evidence }
}
