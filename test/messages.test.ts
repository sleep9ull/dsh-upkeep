import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { hostLocale, hostMessage, localizeResult, localizeWarnings, warning } from '../dist/host/messages.js'

test('host copy speaks the reader language and keeps unknown text verbatim', () => {
  assert.equal(hostLocale('zh-CN'), 'zh')
  assert.equal(hostLocale('en-US'), 'en')
  assert.equal(hostLocale(undefined), 'en')
  assert.equal(hostLocale('ja-JP'), 'en', 'unsupported languages read English')

  assert.match(hostMessage('runtimeUnreadable', 'en'), /running DSH version/)
  assert.match(hostMessage('runtimeUnreadable', 'zh'), /无法从 profile/)
  assert.match(hostMessage('repoDirty', 'zh', '3'), /3 处未提交改动/)

  // Machine detail survives: a git error must not turn into an empty string.
  assert.deepEqual(localizeWarnings(['bundlesUnlistable\u0000boom'], 'zh')[0], '无法列出已安装的 bundle：boom')
  assert.deepEqual(localizeWarnings(['Custom warning from a module'], 'zh'), ['Custom warning from a module'])
})

test('localizeResult rewrites warnings and leaves the rest untouched', () => {
  const input = {
    warnings: [warning('noOwnerIdentity')],
    bundles: [{ name: '@a/b', warnings: [warning('targetStale')] }],
    brief: { version: 2, lines: ['keep me'] },
  }
  const en = localizeResult(input, 'en')
  assert.match(en.warnings[0] ?? '', /No owner identity/)
  assert.match(en.bundles[0]?.warnings[0] ?? '', /stale cached answer/)
  assert.deepEqual(en.brief.lines, ['keep me'])
  const zh = localizeResult(input, 'zh')
  assert.match(zh.warnings[0] ?? '', /没有检测到你的身份/)
})
