import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { classifyOwnership, resolveOwnerIdentity } from '../dist/host/owner.js'

const identity = { handles: ['sleep9ull'], emails: ['sleep9ull@gmail.com'], sources: ['config'] }

test('scope, author, email, repository and git remote all identify the author', () => {
  assert.deepEqual(classifyOwnership({}, identity, '@sleep9ull/thing'), {
    status: 'mine',
    evidence: ['scope:@sleep9ull'],
  })
  assert.equal(classifyOwnership({ authorName: 'Sleep9ull' }, identity, 'thing').status, 'mine')
  assert.equal(classifyOwnership({ authorEmail: 'Sleep9ull@gmail.com' }, identity, 'thing').status, 'mine')
  assert.equal(classifyOwnership({ repositoryOwner: 'sleep9ull' }, identity, 'thing').status, 'mine')
  assert.equal(classifyOwnership({ remoteOwner: 'sleep9ull' }, identity, 'thing').status, 'mine')
})

test('a repository owned by someone else marks the plugin as another author', () => {
  const verdict = classifyOwnership(
    { repositoryOwner: 'someone-else', localPath: '/tmp/worktrace' },
    identity,
    'dsh-worktrace',
  )
  assert.equal(verdict.status, 'other')
  assert.ok(verdict.evidence.includes('repo:someone-else'))
  assert.ok(verdict.evidence.includes('local-checkout'))
})

test('no metadata is unknown, never assumed to be mine', () => {
  const verdict = classifyOwnership({}, identity, 'dsh-worktrace')
  assert.equal(verdict.status, 'unknown')
  assert.deepEqual(verdict.evidence, ['no-metadata'])
})

test('an empty identity cannot claim anything', () => {
  const nobody = { handles: [], emails: [], sources: [] }
  assert.equal(classifyOwnership({ repositoryOwner: 'someone' }, nobody, 'thing').status, 'unknown')
})

test('identity comes from configuration, git config and the gh login', () => {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-owner-'))
  writeFileSync(join(home, '.gitconfig'), [
    '[user]',
    '\tname = Sleep9ull',
    '\temail = sleep9ull@gmail.com',
    '[core]',
    '\teditor = vim',
    '',
  ].join('\n'))
  mkdirSync(join(home, '.config', 'gh'), { recursive: true })
  writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), [
    'github.com:',
    '    oauth_token: secret',
    '    user: sleep9ull',
    '',
  ].join('\n'))

  const detected = resolveOwnerIdentity({}, { home })
  assert.deepEqual(detected.handles, ['sleep9ull'])
  assert.deepEqual(detected.emails, ['sleep9ull@gmail.com'])
  assert.ok(detected.sources.includes('gitconfig'))
  assert.ok(detected.sources.includes('gh'))
})

test('explicit configuration wins and auto-detection can be disabled', () => {
  const identity = resolveOwnerIdentity(
    { handles: '@Other-Dev, second', emails: ' Dev@Example.com ', autoDetect: false },
    { home: '/nonexistent' },
  )
  assert.deepEqual(identity.handles, ['other-dev', 'second'])
  assert.deepEqual(identity.emails, ['dev@example.com'])
  assert.deepEqual(identity.sources, ['config'])
})

test('any machine identity is detected and classified, not one hardcoded account', () => {
  // A completely different person on a different machine: the plugin has no
  // account of its own baked in, it resolves whoever is running it.
  const home = mkdtempSync(join(tmpdir(), 'upkeep-other-'))
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Octocat\n\temail = octocat@example.dev\n')
  mkdirSync(join(home, '.config', 'gh'), { recursive: true })
  writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'github.com:\n    user: octocat\n')

  const theirs = resolveOwnerIdentity({ autoDetect: true }, { home })
  assert.deepEqual(theirs.handles, ['octocat'])
  assert.equal(classifyOwnership({ repositoryOwner: 'octocat' }, theirs, 'plugin-x').status, 'mine')
  assert.equal(classifyOwnership({ repositoryOwner: 'sleep9ull' }, theirs, 'plugin-y').status, 'other')
  assert.equal(classifyOwnership({}, theirs, '@octocat/scoped-plugin').status, 'mine')

  // The reverse holds on the first machine: it does not claim their plugin.
  assert.equal(classifyOwnership({ repositoryOwner: 'octocat' }, identity, 'plugin-x').status, 'other')
})
