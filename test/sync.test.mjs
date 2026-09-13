import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buildPlan,
  pushSnapshot,
  remoteInventory,
  remoteSource,
  localSource,
  restoreFrom,
  mapRepoPathToLive,
  mapLivePathToRepo,
  createLocalSnapshot,
  listLocalSnapshots,
  pruneLocalSnapshots,
  sanitizeSnapshotName,
} from '../src/sync.js'
import { gitBlobSha, parseRepoUrl } from '../src/github.js'
import { createFakeGithub } from './fake-github.mjs'

const INSTANCE = 'laptop-a'

/** A throwaway `$DSH_HOME` with sessions, plugin manifests and settings. */
async function makeHome({ sessions = true, settings = true } = {}) {
  const home = await fsp.mkdtemp(join(tmpdir(), 'dshgs-'))
  if (sessions) {
    await fsp.mkdir(join(home, 'sessions', '--proj-a--', 'session-1'), { recursive: true })
    await fsp.mkdir(join(home, 'sessions', '--proj-a--', 'session-2'), { recursive: true })
    await fsp.writeFile(join(home, 'sessions', '--proj-a--', 'session-1', 'session.v3.jsonl.zstd'), Buffer.from([1, 2, 3, 4]))
    await fsp.writeFile(join(home, 'sessions', '--proj-a--', 'session-2', 'session.jsonl.zstd'), Buffer.from([9, 9]))
    await fsp.writeFile(join(home, 'sessions', '--proj-a--', 'session_projcache.json'), '{}')
  }
  await fsp.mkdir(join(home, 'profiles', 'web', 'node_modules'), { recursive: true })
  await fsp.writeFile(join(home, 'profiles', 'web', 'package.json'), '{"name":"dsh-profile-web"}')
  await fsp.writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), '# patch')
  await fsp.writeFile(join(home, 'profiles', 'web', 'cordis.yml'), '# generated loader output')
  await fsp.writeFile(join(home, 'profiles', 'web', 'node_modules', 'junk.js'), 'x')
  if (settings) await fsp.writeFile(join(home, 'settings.yaml'), 'ui-theme:\n  preference: dark\n')
  return home
}

const planFor = (home, groups = { sessions: true, plugins: true, settings: false }) =>
  buildPlan({ home, instanceId: INSTANCE, groups })

// ── Plan ────────────────────────────────────────────────────────────────

test('buildPlan mirrors sessions and plugin manifests, and nothing else', async () => {
  const home = await makeHome()
  const plan = await planFor(home)
  const paths = plan.files.map((f) => f.repoPath).sort()

  assert.deepEqual(paths, [
    `instances/${INSTANCE}/plugins/web/cordis.patch.yml`,
    `instances/${INSTANCE}/plugins/web/package.json`,
    `instances/${INSTANCE}/sessions/--proj-a--/session-1/session.v3.jsonl.zstd`,
    `instances/${INSTANCE}/sessions/--proj-a--/session-2/session.jsonl.zstd`,
  ])
  assert.equal(plan.totals.files, 4)
  assert.equal(plan.totals.sessions, 2)
  assert.equal(plan.totals.plugins, 2, 'node_modules and cordis.yml are not plugin manifests')
})

test('buildPlan honours group toggles and the per-file size ceiling', async () => {
  const home = await makeHome()
  const onlySessions = await buildPlan({ home, instanceId: INSTANCE, groups: { sessions: true, plugins: false, settings: false } })
  assert.deepEqual([...new Set(onlySessions.files.map((f) => f.group))], ['sessions'])

  const withSettings = await buildPlan({ home, instanceId: INSTANCE, groups: { sessions: false, plugins: false, settings: true } })
  assert.deepEqual(withSettings.files.map((f) => f.repoPath), [`instances/${INSTANCE}/settings/settings.yaml`])

  await fsp.writeFile(join(home, 'sessions', '--proj-a--', 'session-2', 'session.jsonl.zstd'), Buffer.alloc(1_500_000, 1))
  const capped = await buildPlan({ home, instanceId: INSTANCE, groups: { sessions: true, plugins: true, settings: false }, maxFileMb: 1 })
  assert.equal(capped.skipped.length, 1, 'oversized files are reported, not silently dropped')
  assert.match(capped.skipped[0].reason, /超过单文件上限/)
  assert.equal(capped.files.length, 3)
})

test('repo paths round-trip back to live paths', () => {
  const home = 'C:\\dsh'
  assert.deepEqual(mapRepoPathToLive(`instances/x/sessions/--p--/s1/session.jsonl.zstd`, home), {
    abs: join(home, 'sessions', '--p--', 's1', 'session.jsonl.zstd'),
    group: 'sessions',
    workspace: '--p--',
  })
  assert.deepEqual(mapRepoPathToLive('instances/x/plugins/web/package.json', home), {
    abs: join(home, 'profiles', 'web', 'package.json'),
    group: 'plugins',
    profile: 'web',
  })
  assert.deepEqual(mapRepoPathToLive('instances/x/settings/settings.yaml', home), { abs: join(home, 'settings.yaml'), group: 'settings' })
  assert.equal(mapRepoPathToLive('instances/x/manifest.json', home), null)

  const live = join(home, 'sessions', '--p--', 's1', 'session.jsonl.zstd')
  assert.equal(mapLivePathToRepo(live, { home, instanceId: 'x' }), 'instances/x/sessions/--p--/s1/session.jsonl.zstd')
})

// ── Push ────────────────────────────────────────────────────────────────

test('pushSnapshot seeds an empty repository, then reports nothing to commit', async () => {
  const home = await makeHome()
  const gh = createFakeGithub()
  const plan = await planFor(home)

  const first = await pushSnapshot({
    client: gh, owner: 'acme', repo: 'dsh-backup', branch: 'main', instanceId: INSTANCE, plan,
    extraFiles: [{ repoPath: `instances/${INSTANCE}/manifest.json`, content: JSON.stringify({ instanceId: INSTANCE }) }],
  })
  assert.equal(first.pushed, true)
  assert.equal(first.created.length, 5)
  assert.equal(gh.files().size, 5)

  const second = await pushSnapshot({ client: gh, owner: 'acme', repo: 'dsh-backup', branch: 'main', instanceId: INSTANCE, plan })
  assert.equal(second.pushed, false)
  assert.equal(second.nothingToCommit, true)
})

test('pushSnapshot uploads only what changed and prunes deleted sessions', async () => {
  const home = await makeHome()
  const gh = createFakeGithub()
  await pushSnapshot({ client: gh, owner: 'acme', repo: 'dsh-backup', branch: 'main', instanceId: INSTANCE, plan: await planFor(home) })
  const blobsAfterFirst = gh.calls.filter((c) => c[0] === 'createBlob').length

  // one session changes, one is deleted
  await fsp.writeFile(join(home, 'sessions', '--proj-a--', 'session-1', 'session.v3.jsonl.zstd'), Buffer.from([7, 7, 7, 7, 7]))
  await fsp.rm(join(home, 'sessions', '--proj-a--', 'session-2'), { recursive: true })

  const report = await pushSnapshot({ client: gh, owner: 'acme', repo: 'dsh-backup', branch: 'main', instanceId: INSTANCE, plan: await planFor(home) })
  assert.deepEqual(report.updated, [`instances/${INSTANCE}/sessions/--proj-a--/session-1/session.v3.jsonl.zstd`])
  assert.deepEqual(report.deleted, [`instances/${INSTANCE}/sessions/--proj-a--/session-2/session.jsonl.zstd`])
  assert.equal(gh.calls.filter((c) => c[0] === 'createBlob').length - blobsAfterFirst, 1, 'unchanged plugin manifests are not re-uploaded')
  assert.equal(gh.files().size, 3)
})

test('a disabled group is never deleted from the remote', async () => {
  const home = await makeHome()
  const gh = createFakeGithub()
  await pushSnapshot({ client: gh, owner: 'acme', repo: 'dsh-backup', branch: 'main', instanceId: INSTANCE, plan: await planFor(home) })

  // sessions turned off: the session files must survive on the remote
  const plan = await buildPlan({ home, instanceId: INSTANCE, groups: { sessions: false, plugins: true, settings: false } })
  const report = await pushSnapshot({ client: gh, owner: 'acme', repo: 'dsh-backup', branch: 'main', instanceId: INSTANCE, plan })
  assert.deepEqual(report.deleted ?? [], [])
  assert.equal(gh.files().size, 4)
})

test('another machine\'s backup is never touched', async () => {
  const homeA = await makeHome()
  const gh = createFakeGithub()
  await pushSnapshot({ client: gh, owner: 'acme', repo: 'dsh-backup', branch: 'main', instanceId: 'laptop-a', plan: await buildPlan({ home: homeA, instanceId: 'laptop-a', groups: { sessions: true, plugins: true, settings: false } }) })
  const afterA = gh.files().size

  const homeB = await makeHome()
  await pushSnapshot({ client: gh, owner: 'acme', repo: 'dsh-backup', branch: 'main', instanceId: 'laptop-b', plan: await buildPlan({ home: homeB, instanceId: 'laptop-b', groups: { sessions: true, plugins: true, settings: false } }) })
  assert.equal(gh.files().size, afterA * 2)

  const tree = await remoteInventory({ client: gh, owner: 'acme', repo: 'dsh-backup', branch: 'main' })
  assert.deepEqual(tree.instances.map((i) => i.instanceId).sort(), ['laptop-a', 'laptop-b'])
  assert.equal(tree.instances.every((i) => i.sessions === 2), true)
})

test('pull-request mode opens, then squash-merges the sync branch', async () => {
  const home = await makeHome()
  const gh = createFakeGithub()
  const report = await pushSnapshot({
    client: gh, owner: 'acme', repo: 'dsh-backup', branch: 'main', instanceId: INSTANCE,
    plan: await planFor(home), pullRequest: true,
  })
  assert.equal(report.pr.state, 'merged')
  assert.equal(gh.pulls.length, 1)
  assert.equal(gh.refs.get('main'), report.commit)
})

// ── Restore ─────────────────────────────────────────────────────────────

test('restoreFrom pulls a remote backup into a fresh installation', async () => {
  const source = await makeHome()
  const gh = createFakeGithub()
  await pushSnapshot({ client: gh, owner: 'acme', repo: 'dsh-backup', branch: 'main', instanceId: INSTANCE, plan: await planFor(source), extraFiles: [{ repoPath: `instances/${INSTANCE}/manifest.json`, content: '{"instanceId":"laptop-a","savedAt":"2026-01-01T00:00:00.000Z"}' }] })

  const target = await fsp.mkdtemp(join(tmpdir(), 'dshgs-restore-'))
  const tree = await remoteInventory({ client: gh, owner: 'acme', repo: 'dsh-backup', branch: 'main' })
  const result = await restoreFrom({
    source: remoteSource({ client: gh, owner: 'acme', repo: 'dsh-backup', treeMap: tree.tree }),
    home: target,
    only: { instanceId: INSTANCE, groups: ['sessions'] },
  })

  assert.equal(result.written.length, 2)
  const restored = await fsp.readFile(join(target, 'sessions', '--proj-a--', 'session-1', 'session.v3.jsonl.zstd'))
  assert.deepEqual([...restored], [1, 2, 3, 4])
  await assert.rejects(fsp.access(join(target, 'profiles', 'web', 'package.json')), 'plugins group was not requested')
})

test('settings.yaml is only written when the caller allows it', async () => {
  const source = await makeHome()
  const gh = createFakeGithub()
  await pushSnapshot({ client: gh, owner: 'acme', repo: 'dsh-backup', branch: 'main', instanceId: INSTANCE, plan: await buildPlan({ home: source, instanceId: INSTANCE, groups: { sessions: false, plugins: false, settings: true } }) })

  const target = await fsp.mkdtemp(join(tmpdir(), 'dshgs-settings-'))
  const tree = await remoteInventory({ client: gh, owner: 'acme', repo: 'dsh-backup', branch: 'main' })
  const blocked = await restoreFrom({ source: remoteSource({ client: gh, owner: 'acme', repo: 'dsh-backup', treeMap: tree.tree }), home: target })
  assert.equal(blocked.written.length, 0)
  assert.match(blocked.skipped[0].reason, /设置同步未开启/)

  const allowed = await restoreFrom({ source: remoteSource({ client: gh, owner: 'acme', repo: 'dsh-backup', treeMap: tree.tree }), home: target, allowSettings: true })
  assert.equal(allowed.written.length, 1)
  assert.match(await fsp.readFile(join(target, 'settings.yaml'), 'utf8'), /preference: dark/)
})

test('restoreFrom never overwrites a modified local file unless asked', async () => {
  const home = await makeHome()
  const gh = createFakeGithub()
  const plan = await planFor(home)
  await pushSnapshot({ client: gh, owner: 'acme', repo: 'dsh-backup', branch: 'main', instanceId: INSTANCE, plan })
  const tree = await remoteInventory({ client: gh, owner: 'acme', repo: 'dsh-backup', branch: 'main' })
  const source = remoteSource({ client: gh, owner: 'acme', repo: 'dsh-backup', treeMap: tree.tree })

  const local = join(home, 'sessions', '--proj-a--', 'session-1', 'session.v3.jsonl.zstd')
  await fsp.writeFile(local, Buffer.from([5, 5, 5, 5, 5]))
  const guarded = await restoreFrom({ source, home, only: { groups: ['sessions'] }, overwrite: false })
  assert.equal(guarded.written.length, 0, 'the locally modified session is left alone')
  assert.equal(guarded.skipped.length, 1)
  assert.match(guarded.skipped[0].reason, /未允许覆盖/)
  assert.equal(guarded.unchanged.length, 1)
  assert.deepEqual([...await fsp.readFile(local)], [5, 5, 5, 5, 5])

  const forced = await restoreFrom({ source, home, only: { groups: ['sessions'] }, overwrite: true })
  assert.deepEqual([...await fsp.readFile(local)], [1, 2, 3, 4])
  assert.equal(forced.written[0].replaced, true)
})

// ── Local snapshots ─────────────────────────────────────────────────────

test('local snapshots are written, listed, restored and pruned by age', async () => {
  const home = await makeHome()
  const syncDir = await fsp.mkdtemp(join(tmpdir(), 'dshgs-snap-'))
  const plan = await planFor(home)

  for (const name of ['2026-01-01', '2026-01-02', '2026-01-03']) {
    await createLocalSnapshot({ syncDir, name, plan })
  }
  const listed = await listLocalSnapshots(syncDir)
  assert.deepEqual(listed.map((s) => s.name), ['2026-01-03', '2026-01-02', '2026-01-01'])

  const pristine = await fsp.mkdtemp(join(tmpdir(), 'dshgs-pristine-'))
  const restored = await restoreFrom({ source: localSource(join(syncDir, 'snapshots', '2026-01-02')), home: pristine, only: { groups: ['sessions'] } })
  assert.equal(restored.written.length, 2)

  const removed = await pruneLocalSnapshots(syncDir, 2, [])
  assert.deepEqual(removed, ['2026-01-01'])
  assert.equal((await listLocalSnapshots(syncDir)).length, 2)
})

test('sanitizeSnapshotName keeps filesystem-safe characters', () => {
  assert.equal(sanitizeSnapshotName('  my/../snap shot  '), 'my-snap-shot')
  assert.equal(sanitizeSnapshotName(''), '')
})

// ── Pure github helpers ─────────────────────────────────────────────────

test('gitBlobSha is the git object id, so unchanged files cost nothing', () => {
  assert.equal(gitBlobSha(Buffer.from('hello')), 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0')
  assert.equal(gitBlobSha(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
})

test('parseRepoUrl accepts every shape a user pastes', () => {
  const expected = { owner: 'acme', repo: 'dsh-backup' }
  for (const input of [
    'https://github.com/acme/dsh-backup',
    'https://github.com/acme/dsh-backup.git',
    'git@github.com:acme/dsh-backup.git',
    'ssh://git@github.com/acme/dsh-backup.git',
    'acme/dsh-backup',
  ]) {
    assert.deepEqual(parseRepoUrl(input), expected, input)
  }
  assert.equal(parseRepoUrl('https://gitcode.com/acme/dsh-backup'), null)
  assert.equal(parseRepoUrl(''), null)
})
