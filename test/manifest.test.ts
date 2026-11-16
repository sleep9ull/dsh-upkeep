import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { normalizeConfig } from '../dist/host/dispatch.js'

test('config defaults are safe and channel-aware', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.targetChannel, 'auto')
  assert.equal(config.checkOnStartup, true)
  assert.equal(config.concurrency, 2)
  assert.equal(config.worktreeRoot, '')
})

test('config clamps concurrency and ignores wrong types', () => {
  assert.equal(normalizeConfig({ concurrency: 99 }).concurrency, 8)
  assert.equal(normalizeConfig({ concurrency: 0 }).concurrency, 1)
  assert.equal(normalizeConfig({ concurrency: 'many' }).concurrency, 2)
  assert.equal(normalizeConfig({ targetChannel: '   ' }).targetChannel, 'auto')
  assert.equal(normalizeConfig({ checkOnStartup: false }).checkOnStartup, false)
})

test('bundle metadata declares what the plugin manager reads', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    name?: unknown
    version?: unknown
    engines?: { dsh?: unknown }
    dsh?: { bundle?: { patch?: unknown }; client?: { platform?: unknown } }
    exports?: Record<string, unknown>
  }
  assert.equal(manifest.name, '@sleep9ull/dsh-upkeep')
  assert.equal(typeof manifest.version, 'string')
  assert.equal(typeof manifest.engines?.dsh, 'string')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.ok(manifest.exports?.['./client'], 'the client entry must be exported')
  assert.ok(manifest.exports?.['./icon'], 'the icon must be exported')
})

test('bundle patch names the same package the client module id uses', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: upkeep/)
  assert.match(patch, /@sleep9ull\/dsh-upkeep/)
})

test('locale files carry display metadata and parse as JSON', () => {
  for (const language of ['en', 'zh']) {
    const locale = JSON.parse(readFileSync(new URL(`../locale/${language}.json`, import.meta.url), 'utf8')) as {
      meta?: { title?: unknown; description?: unknown; detail?: unknown }
    }
    assert.equal(typeof locale.meta?.title, 'string')
    assert.equal(typeof locale.meta?.description, 'string')
    assert.equal(locale.meta?.detail, 'docs/DETAIL.md')
  }
})

test('client bundle registers the fixed sidebar panel, its icon, and the settings tab', () => {
  const client = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')
  // The panel id, the icon id and the settings-tab id must all agree; the sidebar
  // owner addresses a main panel by the list id.
  assert.match(client, /const PANEL_ID = TAB_ID/)
  assert.match(client, /name: 'main'/)
  assert.match(client, /name: 'sidebar\.panellist'/)
  assert.match(client, /name: 'settings\.plugins\.tab'/)
  assert.match(client, /id: '@sleep9ull\/dsh-upkeep'/)
  assert.match(client, /inject: \['slots', 'locale', 'connection', 'layout', 'uiWorkspace'\]/)
  // The panel separates the author's own plugins from everyone else's by group.
  assert.match(client, /upkeep-groups/)
  assert.match(client, /'data-group'/)
  assert.match(client, /groupMine/)
  assert.match(client, /groupOthers/)
  // Other authors' plugins stay folded until asked for, and the choice persists.
  assert.match(client, /upkeep-group-toggle/)
  assert.match(client, /dsh\.upkeep\.othersExpanded/)
  // The panel is a ledger: one status sentence, a meta line, grouped tables, a footer.
  assert.match(client, /upkeep-status/)
  assert.match(client, /upkeep-meta/)
  assert.match(client, /upkeep-footer/)
  assert.match(client, /upkeep-table-scroll/)
  // M1: one Refresh button triggers the check that fetches the target and stores a report.
  assert.match(client, /refreshing/)
  assert.match(client, /t\('check'\)|'check'/)
  assert.doesNotMatch(client, /checkNow/)
  // M3: the panel can prepare an upgrade session and verify it afterwards.
  assert.match(client, /upgrade.prepare/)
  assert.match(client, /upgrade.verify/)
  assert.match(client, /upkeep-notice/)
  assert.match(client, /verifyNow/)
  // M3/M4 notices carry the Host's warnings next to the outcome.
  assert.match(client, /noticeWarnings/)
  assert.match(client, /upkeep-notice-warnings/)
  assert.match(client, /NOTICE_WARNING_LIMIT/)
  // Healthy plugins must never offer the upgrade action.
  assert.match(client, /const eligible = options\.mine && options\.onUpgrade && care === 'attention'/)
  assert.doesNotMatch(client, /care === 'attention' \|\|/)
  // One status column: the live enabled flag moved into the row tooltip.
  assert.doesNotMatch(client, /t\('state'\)/)
  assert.match(client, /h\('th', \{ key: 'status' \}, t\('status'\)\)/)
  // The sidebar label carries the pending-care count; the glyph stays decorative.
  assert.match(client, /function careCountOf/)
  assert.match(client, /labelCareMany/)
  assert.doesNotMatch(client, /dsh-upkeep-count/)
  assert.match(client, /const careCount = careCountOf\(data\)/)
})

test('both READMEs exist, link to each other, and ship with their license', () => {
  const english = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const chinese = readFileSync(new URL('../README.zh.md', import.meta.url), 'utf8')
  assert.match(english, /\[简体中文\]\(README\.zh\.md\)/)
  assert.match(chinese, /\[English\]\(README\.md\)/)
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    files?: unknown
    license?: unknown
    repository?: { url?: unknown }
  }
  assert.ok(Array.isArray(manifest.files))
  for (const entry of ['README.md', 'README.zh.md', 'LICENSE', 'dist', 'cordis.patch.yml']) {
    assert.ok((manifest.files as unknown[]).includes(entry), `files must include ${entry}`)
  }
  assert.equal(manifest.license, 'MIT')
  assert.equal(typeof manifest.repository?.url, 'string')
  assert.equal(readFileSync(new URL('../LICENSE', import.meta.url), 'utf8').split('\n')[0], 'MIT License')
})

test('the client dictionaries carry the same keys', () => {
  const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
  const block = (name: string): string => {
    const match = new RegExp('const ' + name + ': Record<string, string> = \\{([\\s\\S]*?)\\n      \\}').exec(source)
    if (match === null) throw new Error('dictionary not found: ' + name)
    return match[1]
  }
  const keys = (text: string): string[] => [...text.matchAll(/^\s{8}([A-Za-z0-9]+):/gm)].map(match => match[1]).sort()
  assert.deepEqual(keys(block('en')), keys(block('zh')))
})
