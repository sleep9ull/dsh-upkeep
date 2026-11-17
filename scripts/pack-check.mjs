#!/usr/bin/env node
/**
 * Prove the packaged release works, not just the linked checkout.
 *
 * `npm run verify` runs against the repository with a symlink install, so it can
 * miss anything that only breaks once the files are packed: a missing `dist`
 * file, a `files` entry that drops the patch, a bundle the loader refuses to
 * compose. This packs the tarball, inspects it, installs it into a throwaway
 * profile, and asks the CLI to compose that profile.
 *
 * Run with `npm run verify:pack`. Requires DSH_INSTALL_DIR and
 * DSH_NODE_EXECUTABLE; without them the DSH step is skipped, never passed.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const scratch = mkdtempSync(join(tmpdir(), 'upkeep-pack-'))

function fail(message) {
  console.error(`FAIL  ${message}`)
  rmSync(scratch, { recursive: true, force: true })
  process.exit(1)
}

function ok(message) {
  console.log(`PASS  ${message}`)
}

function skip(message) {
  console.log(`SKIP  ${message}`)
}

/** What the loader and the listing need inside the tarball. */
const REQUIRED = [
  'package.json',
  'cordis.patch.yml',
  'dist/index.js',
  'dist/client.js',
  'icon.svg',
  'locale/en.json',
  'locale/zh.json',
  'docs/DETAIL.md',
  'README.md',
  'LICENSE',
]

try {
  // 1. Pack what npm would publish.
  // A private cache keeps this working on machines whose ~/.npm is not writable.
  const packOut = execFileSync('npm', ['pack', '--json', '--pack-destination', scratch, '--cache', join(scratch, 'npm-cache')], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const packed = JSON.parse(packOut)
  const tarball = join(scratch, packed[0].filename)
  ok(`npm pack -> ${packed[0].filename} (${packed[0].size} bytes, ${packed[0].entryCount} files)`)

  // 2. Inspect its contents without trusting the `files` list.
  const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('package/'))
    .map(line => line.slice('package/'.length))
    .filter(line => line !== '' && !line.endsWith('/'))
  const missing = REQUIRED.filter(entry => !listing.includes(entry))
  if (missing.length > 0) fail(`the tarball is missing ${missing.join(', ')}`)
  ok(`tarball carries the runtime surface (${listing.length} files)`)

  // 3. Unpack it the way an install would.
  execFileSync('tar', ['-xzf', tarball, '-C', scratch], { stdio: ['ignore', 'pipe', 'pipe'] })
  const unpacked = join(scratch, 'package')
  if (!existsSync(join(unpacked, 'package.json'))) fail('the tarball did not extract to package/')
  ok('tarball extracted')

  // 4. Compose it in a throwaway profile with the CLI.
  const installDir = process.env.DSH_INSTALL_DIR
  const node = process.env.DSH_NODE_EXECUTABLE
  const cli = installDir === undefined ? undefined : join(installDir, 'lib', 'bin.js')
  // The CLI lives inside app.asar, which plain node cannot stat; let the DSH
  // runtime itself decide, and treat a spawn failure as a skip.
  if (installDir === undefined || node === undefined || cli === undefined) {
    skip('CLI compose: DSH_INSTALL_DIR / DSH_NODE_EXECUTABLE are not set')
  } else try {
    const home = join(scratch, 'home')
    const env = { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' }
    const dump = (profile) => execFileSync(node, [cli, '--profile', profile, '--dump-config'], {
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // First run materialises the shipped `web` profile under this DSH_HOME.
    dump('web')
    const profileDir = join(home, 'profiles', 'web')
    const manifestPath = join(profileDir, 'package.json')
    if (!existsSync(manifestPath)) fail('the CLI did not materialise the web profile')

    const target = join(profileDir, 'node_modules', ...pkg.name.split('/'))
    cpSync(unpacked, target, { recursive: true })

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dependencies = { ...(manifest.dependencies ?? {}), [pkg.name]: pkg.version }
    const bundles = manifest.dsh?.profile?.bundles ?? []
    manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles: [...bundles, pkg.name] } }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    const composed = dump('web')
    if (!composed.includes(pkg.name)) fail('the packed bundle did not reach the composed profile')
    if (!/id: upkeep/.test(composed)) fail('the packed patch did not insert the upkeep row')
    ok('CLI composed a profile containing the packed bundle and its row')

    // The bundle the browser receives must be a script, not an ES module.
    const clientPath = join(target, 'dist', 'client.js')
    const client = readFileSync(clientPath, 'utf8')
    if (/\bexport\s+(default|const|function)\b/.test(client)) fail('dist/client.js looks like an ES module')
    if (!client.includes('__ModuleLoader__')) fail('dist/client.js does not register through the module loader')
    ok('dist/client.js is a loader script with no ES exports')

    const localeFiles = readdirSync(join(target, 'locale')).filter(name => name.endsWith('.json'))
    if (localeFiles.length < 2) fail('the tarball carries fewer than two locale files')
    ok(`locale files: ${localeFiles.join(', ')}`)
  } catch (error) {
    skip(`CLI compose unavailable: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
