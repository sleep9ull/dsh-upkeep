import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { scanSurfaces } from '../dist/host/surfaces.js'

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
