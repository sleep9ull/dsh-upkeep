import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { DEFAULT_REGISTRIES, fetchTargetVersion, parsePackument, pickTarget } from '../dist/host/feed.js'

// The installed rc.3 is the `next` tag while `latest` lags behind it: the feed
// must never trust `latest` alone.
const PACKUMENT = {
  versions: { '0.2.2-rc.1': {}, '0.2.2-rc.2': {}, '0.2.2-rc.3': {}, '0.2.1': {} },
  'dist-tags': { latest: '0.2.2-rc.1', next: '0.2.2-rc.3', alpha: '0.2.2-alpha.3' },
}

test('packument parsing keeps versions and tags', () => {
  const facts = parsePackument(PACKUMENT)
  assert.deepEqual(facts?.versions.sort(), ['0.2.1', '0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3'])
  assert.equal(facts?.tags.next, '0.2.2-rc.3')
  assert.equal(parsePackument({}), undefined)
})

test('a channel maps to its tag; otherwise the highest version wins over latest', () => {
  const facts = parsePackument(PACKUMENT)
  assert.ok(facts)
  assert.deepEqual(pickTarget(facts, 'nightly'), { version: '0.2.2-rc.3', channel: 'next' })
  assert.deepEqual(pickTarget(facts, 'stable'), { version: '0.2.2-rc.1', channel: 'latest' })
  assert.deepEqual(pickTarget(facts, undefined), { version: '0.2.2-rc.3', channel: 'next' })
})

test('fetchTargetVersion falls through registries and reports failures', async () => {
  const requested: string[] = []
  const fetchImpl = (async (url: string) => {
    requested.push(String(url))
    if (requested.length === 1) return new Response('nope', { status: 503 })
    return new Response(JSON.stringify(PACKUMENT), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const result = await fetchTargetVersion({ registries: ['https://a.example/', 'https://b.example/'], fetchImpl })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.registry, 'https://b.example')
    assert.deepEqual(result.target, { version: '0.2.2-rc.3', channel: 'next' })
  }

  const failed = await fetchTargetVersion({
    registries: ['https://a.example/'],
    fetchImpl: (async () => { throw new Error('offline') }) as typeof fetch,
  })
  assert.equal(failed.ok, false)
  if (!failed.ok) assert.equal(failed.attempts[0]?.error, 'offline')
  assert.ok(DEFAULT_REGISTRIES.length >= 2)
})
