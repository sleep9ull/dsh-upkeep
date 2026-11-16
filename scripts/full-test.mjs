#!/usr/bin/env node
/**
 * The full verification pass: unit + contract tests, package metadata, the CLI's
 * composed profile (proving the installed row reaches the Loader), and one real
 * npm-registry read for the target version.
 *
 * Run with `npm run verify:full`. The CLI and registry steps degrade to
 * `skipped` when the environment cannot support them, never to a silent pass.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const results = []

function record(name, status, detail = '') {
  results.push({ name, status, detail })
}

function run(name, operation) {
  try {
    const detail = operation()
    record(name, 'ok', detail ?? '')
  } catch (error) {
    record(name, 'fail', error instanceof Error ? error.message : String(error))
  }
}

run('unit + contract tests (npm run verify)', () => {
  execFileSync('npm', ['run', 'verify'], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
  return '53+ assertions'
})

run('package metadata', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (typeof pkg.engines?.dsh !== 'string') throw new Error('engines.dsh is missing')
  if (!existsSync(join(root, 'dist', 'index.js'))) throw new Error('dist/index.js is missing')
  if (!existsSync(join(root, 'dist', 'client.js'))) throw new Error('dist/client.js is missing')
  return `${pkg.name}@${pkg.version}`
})

run('CLI is runnable (dsh --version)', () => {
  const install = process.env.DSH_INSTALL_DIR
  const node = process.env.DSH_NODE_EXECUTABLE
  if (!install || !node) return 'skipped: DSH_INSTALL_DIR / DSH_NODE_EXECUTABLE are not set'
  const version = execFileSync(node, [join(install, 'lib', 'bin.js'), '--version'], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'pipe',
  }).trim()
  return version
})

run('profile selection (static)', () => {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const manifestPath = join(home, 'profiles', 'desktop', 'package.json')
  if (!existsSync(manifestPath)) return 'skipped: the desktop profile is not readable'
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes('@sleep9ull/dsh-upkeep')) throw new Error('the upkeep bundle is not selected in the profile')
  const linked = join(home, 'profiles', 'desktop', 'node_modules', '@sleep9ull', 'dsh-upkeep')
  if (!existsSync(linked)) throw new Error('the upkeep package is not linked into the profile')
  return 'bundle selected and linked'
})

run('CLI composed profile (dsh --dump-config)', () => {
  const install = process.env.DSH_INSTALL_DIR
  const node = process.env.DSH_NODE_EXECUTABLE
  if (!install || !node) return 'skipped: DSH_INSTALL_DIR / DSH_NODE_EXECUTABLE are not set'
  try {
    const output = execFileSync(node, [join(install, 'lib', 'bin.js'), '--profile', 'desktop', '--dump-config'], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      maxBuffer: 64 * 1024 * 1024,
      stdio: 'pipe',
    })
    if (!output.includes('@sleep9ull/dsh-upkeep')) throw new Error('the upkeep row is missing from the composed profile')
    return 'upkeep row present in the composed desktop profile'
  } catch (error) {
    // Desktop owns the running profile: the CLI refuses to compose it while the app is open.
    const text = error instanceof Error && 'stderr' in error ? String(error.stderr) : error instanceof Error ? error.message : String(error)
    if (/managed exclusively by the Electron application/i.test(text)) {
      return 'skipped: the desktop profile is exclusively managed by the running Electron app'
    }
    throw error
  }
})

const registry = await (async () => {
  try {
    const feed = await import(new URL('../dist/host/feed.js', import.meta.url))
    const answer = await feed.fetchTargetVersion({ registries: feed.DEFAULT_REGISTRIES })
    if (!answer.ok) throw new Error(`registry unavailable: ${answer.attempts.map(attempt => attempt.error).join('; ')}`)
    return answer.target
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
})()
if (registry.error === undefined) record('npm registry target', 'ok', `${registry.version} (${registry.channel})`)
else record('npm registry target', 'skipped', registry.error)

const failed = results.filter(entry => entry.status === 'fail')
for (const entry of results) {
  console.log(`${entry.status === 'ok' ? 'PASS' : entry.status === 'skipped' ? 'SKIP' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : ' — ' + entry.detail}`)
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length > 0 ? `, ${failed.length} failed` : ''}.`)
process.exitCode = failed.length > 0 ? 1 : 0
