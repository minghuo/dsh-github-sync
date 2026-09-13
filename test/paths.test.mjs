import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { encodeWorkspaceKey, decodeWorkspaceKey, isExcludedSessionFile, displayPath, listProfiles, listWorkspaceDirs } from '../src/paths.js'

test('encodeWorkspaceKey matches the folders the harness actually creates', () => {
  // Observed verbatim in $DSH_HOME/sessions on Windows.
  assert.equal(encodeWorkspaceKey('C:\\Users\\bewilder\\.dsh'), '--C-Users-bewilder-.dsh--')
  assert.equal(
    encodeWorkspaceKey('D:\\Program Files\\JetBrains\\dsh-plugin'),
    '--D-Program~0020Files-JetBrains-dsh-plugin--',
  )
  assert.equal(encodeWorkspaceKey('/home/me/work'), '--home-me-work--')
  assert.equal(encodeWorkspaceKey('/home/me/my proj'), '--home-me-my~0020proj--')
})

test('decodeWorkspaceKey is a lossy display hint', () => {
  assert.equal(decodeWorkspaceKey('--C-Users-bewilder-.dsh--'), 'C:\\Users\\bewilder\\.dsh')
  assert.match(decodeWorkspaceKey('--D-Program~0020Files-JetBrains-dsh-plugin--'), /Program Files/)
})

test('session caches and temp files are excluded from backups', () => {
  assert.equal(isExcludedSessionFile('session_projcache.json'), true)
  assert.equal(isExcludedSessionFile('x.tmp'), true)
  assert.equal(isExcludedSessionFile('session.jsonl.zstd'), false)
  assert.equal(isExcludedSessionFile('session.v3.jsonl.zstd'), false)
})

test('displayPath abbreviates the home directory only', () => {
  const home = process.env.USERPROFILE || process.env.HOME
  assert.equal(displayPath(home), '~')
  assert.equal(displayPath(join(home, 'x', 'y')), join('~', 'x', 'y'))
  assert.equal(displayPath('/definitely/not/home'), '/definitely/not/home')
})

test('listWorkspaceDirs / listProfiles tolerate a missing $DSH_HOME', async () => {
  assert.deepEqual(await listWorkspaceDirs(join('/nonexistent-dsh-home-xyz')), [])
  assert.deepEqual(await listProfiles(join('/nonexistent-dsh-home-xyz')), [])
})
