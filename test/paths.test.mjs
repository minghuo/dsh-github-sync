import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  encodeWorkspaceKey,
  decodeWorkspaceKey,
  isExcludedSessionFile,
  displayPath,
  listProfiles,
  listWorkspaceDirs,
  workspacePathMap,
} from '../src/paths.js'

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

test('workspacePathMap recovers the real path a folder name cannot', async () => {
  const home = await fs.mkdtemp(join(tmpdir(), 'dshgs-paths-'))
  await fs.mkdir(join(home, 'storages'), { recursive: true })
  const realPath = 'D:\\Program Files\\JetBrains\\git-workspace\\data-push'
  await fs.writeFile(
    join(home, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { workspaceIds: ['w1'] },
      tables: { workspaces: { w1: { path: realPath, title: 'data-push', sessionIds: [] } } },
    }),
  )

  const map = await workspacePathMap(home)
  const key = encodeWorkspaceKey(realPath)
  assert.equal(map.get(key).path, realPath)
  assert.equal(map.get(key).title, 'data-push')
  // This is exactly why the registry is needed: the decode mangles the path.
  assert.notEqual(decodeWorkspaceKey(key), realPath)
  assert.match(decodeWorkspaceKey(key), /git\\workspace\\data\\push$/)
})

test('workspacePathMap degrades quietly on a missing or broken registry', async () => {
  assert.equal((await workspacePathMap(join(tmpdir(), 'dshgs-absent-home'))).size, 0)

  const home = await fs.mkdtemp(join(tmpdir(), 'dshgs-paths-broken-'))
  await fs.mkdir(join(home, 'storages'), { recursive: true })
  await fs.writeFile(join(home, 'storages', 'workspace.json'), '{ not json')
  assert.equal((await workspacePathMap(home)).size, 0)
})
