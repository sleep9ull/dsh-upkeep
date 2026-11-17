import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { scanSurfaces } from '../dist/host/surfaces.js'
import { localizeWarnings } from '../dist/host/messages.js'

test('a plugin surface scan recovers packages, services, events, tools, slots and rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upkeep-surfaces-'))
  const manifest = {
    name: '@sleep9ull/plugin',
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: { inject: ['@deepseek-ai/dsh-client-ui-settings-plugins'] },
    },
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: sleep-row',
    "      name: '@sleep9ull/plugin'",
    '      config:',
    '        targetChannel: auto',
    "      inject: ['tools', 'connection']",
    '',
  ].join('\n'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'index.ts'), [
    "import { Session } from '@deepseek-ai/dsh-session'",
    'export function apply(ctx) {',
    "  ctx.tools.register({ name: 'my_tool', description: 'x' })",
    "  ctx.on('session/event', () => undefined)",
    "  ctx.commands.register({ commandName: 'upkeep' })",
    "  ctx.slots.inject('settings.plugins.tab', () => undefined)",
    '}',
    '',
  ].join('\n'))

  const inventory = scanSurfaces(dir, manifest)
  assert.ok(inventory.filesScanned >= 2)
  assert.ok(inventory.packages.includes('@deepseek-ai/dsh-session'))
  assert.ok(inventory.packages.includes('@deepseek-ai/dsh-client-ui-settings-plugins'))
  assert.ok(inventory.services.includes('tools'))
  assert.ok(inventory.services.includes('commands'))
  assert.ok(inventory.events.includes('session/event'))
  assert.ok(inventory.tools.includes('my_tool'))
  assert.ok(inventory.commands.includes('upkeep'))
  assert.ok(inventory.slots.includes('settings.plugins.tab'))
  assert.ok(inventory.rowIds.includes('sleep-row'))
  assert.ok(inventory.configKeys.includes('targetChannel'))
})

test('an unreadable bundle patch names the bundle and reads in the requested language', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upkeep-surfaces-patch-'))
  const manifest = {
    name: '@isdou/dsh-wardrobe',
    version: '0.1.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))

  const inventory = scanSurfaces(dir, manifest)
  assert.equal(inventory.filesScanned, 1)
  assert.equal(inventory.warnings.length, 1)
  assert.match(inventory.warnings[0] ?? '', /^bundlePatchUnreadable\u0000/)

  const english = localizeWarnings(inventory.warnings, 'en')
  assert.match(english[0] ?? '', /bundle patch of @isdou\/dsh-wardrobe \(\.\/cordis\.patch\.yml\) could not be read/)
  const chinese = localizeWarnings(inventory.warnings, 'zh')
  assert.match(chinese[0] ?? '', /读不到 @isdou\/dsh-wardrobe \(\.\/cordis\.patch\.yml\)/)
})

test('a directory with nothing readable is unknown, not clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upkeep-surfaces-empty-'))
  const inventory = scanSurfaces(dir, undefined)
  assert.equal(inventory.filesScanned, 0)
  assert.ok(inventory.warnings.some(entry => entry.startsWith('surfaceScanEmpty\u0000')))
})
