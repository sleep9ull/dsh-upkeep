import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { matchGuides, summarizeMatches } from '../dist/host/match.js'
import type { GuideSet } from '../dist/host/guides.js'
import type { SurfaceInventory } from '../dist/host/surfaces.js'

const guides: GuideSet = {
  source: 'installed',
  versions: ['0.2.2-rc.1'],
  warnings: [],
  items: [
    { version: '0.2.2-rc.1', item: 'tools', description: 'Tools registry changed', change: 'Use ctx.tools through @deepseek-ai/dsh-tools.', migration: 'Update the import.' },
    { version: '0.2.2-rc.1', item: 'unrelated', description: 'Something else', change: 'Unrelated change.', migration: 'Nothing to do.' },
  ],
}

const inventory: SurfaceInventory = {
  packageName: '@sleep9ull/plugin',
  packages: ['@deepseek-ai/dsh-tools'],
  services: ['tools'],
  events: [],
  tools: [],
  commands: [],
  slots: [],
  configKeys: [],
  rowIds: [],
  filesScanned: 3,
  warnings: [],
}

test('only items mentioning a real surface are matched, strongest first', () => {
  const matches = matchGuides(guides, inventory)
  assert.equal(matches.length, 1)
  assert.equal(matches[0]?.item, 'tools')
  assert.equal(matches[0]?.score, 5)
  assert.deepEqual(matches[0]?.matchedSurfaces.map(hit => hit.value).sort(), ['@deepseek-ai/dsh-tools', 'tools'])
  const summary = summarizeMatches(matches)
  assert.equal(summary.matched, 1)
  assert.deepEqual(summary.versions, ['0.2.2-rc.1'])
  assert.equal(summary.top[0]?.item, 'tools')
})

test('a token only counts on identifier boundaries', () => {
  const boundary: GuideSet = {
    source: 'installed',
    versions: ['v'],
    warnings: [],
    items: [{ version: 'v', item: 'x', description: 'toolshed', change: 'ctx.toolshed was renamed', migration: '' }],
  }
  assert.equal(matchGuides(boundary, inventory).length, 0)
})
