import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fetchRemoteGuides, parseGuideDocument, readInstalledGuides } from '../dist/host/guides.js'

const GUIDE = `---
kind: upgrade-guide
description: "Tools moved behind a new registry."
---

# Tools moved

English | [中文](guide.zh.md)

## Change

The \`ctx.tools\` registry is now reached through \`@deepseek-ai/dsh-tools\`.

## Migration

1. Update the import.
2. Re-register the tool.
`

test('a guide document splits into description, change and migration', () => {
  const parsed = parseGuideDocument(GUIDE)
  assert.equal(parsed.description, 'Tools moved behind a new registry.')
  assert.match(parsed.change, /ctx\.tools/)
  assert.match(parsed.migration, /Re-register/)
})

test('installed guides are read for a half-open release range', () => {
  const root = mkdtempSync(join(tmpdir(), 'upkeep-guides-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }))
  const guideDir = join(root, 'docs', 'upgrade-guide')
  for (const [version, item] of [['0.2.2-alpha.3', 'old'], ['0.2.2-rc.1', 'tools']] as const) {
    mkdirSync(join(guideDir, `v${version}`, item), { recursive: true })
    writeFileSync(join(guideDir, `v${version}`, item, 'guide.md'), GUIDE)
  }
  const range = readInstalledGuides(join(root, 'package.json'), '0.2.2-alpha.2', '0.2.2-rc.2')
  assert.deepEqual(range.versions, ['0.2.2-alpha.3', '0.2.2-rc.1'])
  assert.equal(range.items.length, 2)
  assert.equal(range.source, 'installed')

  const limited = readInstalledGuides(join(root, 'package.json'), '0.2.2-rc.1', '0.2.2-rc.2')
  assert.deepEqual(limited.versions, ['0.2.2-rc.1'])

  const missing = readInstalledGuides(join(root, 'package.json'), '9.0.0', null)
  assert.equal(missing.items.length, 0)
})

test('a newer target reads the missing guides from the release tag', async () => {
  const calls: string[] = []
  const fetchImpl = (async (url: string) => {
    calls.push(String(url))
    if (String(url).includes('/contents/docs/upgrade-guide?')) {
      return new Response(JSON.stringify([{ name: 'v0.2.2-rc.2' }, { name: 'v0.2.3-rc.1' }]), { status: 200 })
    }
    if (String(url).includes('/contents/docs/upgrade-guide/v0.2.2-rc.2?')) {
      return new Response(JSON.stringify([{ name: 'tools' }]), { status: 200 })
    }
    if (String(url).includes('raw.githubusercontent.com')) {
      return new Response(GUIDE, { status: 200 })
    }
    return new Response('missing', { status: 404 })
  }) as typeof fetch

  const result = await fetchRemoteGuides({ targetVersion: '0.2.3-rc.1', from: '0.2.2-rc.1', to: '0.2.3-rc.1', fetchImpl })
  assert.equal(result.source, 'github')
  assert.deepEqual(result.versions, ['0.2.2-rc.2'])
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]?.item, 'tools')
  assert.ok(calls.some(url => url.includes('dsh-v0.2.3-rc.1')))
})
