/**
 * Host-half integration test.
 *
 * The plugin is applied to a fake cordis context, the route it registers is
 * driven with fake `node:http` request/response objects, and `globalThis.fetch`
 * is pointed at an in-memory GitHub. That exercises the whole path — settings
 * through the JSON fallback, plan building, the REST push, the remote
 * inventory, restore and snapshots — without a network or a running harness.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createFakeGithub } from './fake-github.mjs'

let plugin
let home
let gh
let realFetch
let route
let disposers = []
/** Flipped by one test to model a read-only token. */
let denyWrites = false

/** Translate the fake GitHub object into the REST replies the client expects. */
function githubFetchServer(fake) {
  return async (url, init = {}) => {
    const parsed = new URL(String(url))
    const method = String(init.method || 'GET').toUpperCase()
    const path = parsed.pathname
    const body = init.body ? JSON.parse(init.body) : undefined
    const send = (status, payload) => ({
      ok: status < 400,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => (payload === undefined ? '' : JSON.stringify(payload)),
    })
    const owner = 'acme'
    const repo = 'dsh-backup'
    const match = (re) => path.match(re)

    // A token that can read but not write — GitHub's answer is 403 with this
    // exact message, and it is worth its own explanation.
    if (denyWrites && method !== 'GET') {
      return send(403, { message: 'Resource not accessible by personal access token' })
    }

    if (method === 'GET' && path === `/repos/${owner}/${repo}`) {
      return send(200, { full_name: `${owner}/${repo}`, private: true, default_branch: 'main', permissions: { push: true } })
    }
    if (method === 'GET' && path === '/user') return send(200, { login: 'acme' })

    let m
    if (method === 'GET' && (m = match(/^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/(.+)$/))) {
      const head = await fake.getBranchHead(owner, repo, decodeURIComponent(m[1]))
      if (head) return send(200, { object: { sha: head } })
      // GitHub's real shape: 409 on a repository with no commits at all,
      // 404 when the repository has history but not that branch.
      return fake.commits.size === 0
        ? send(409, { message: 'Git Repository is empty.' })
        : send(404, { message: 'Not Found' })
    }
    if (method === 'GET' && (m = match(/^\/repos\/[^/]+\/[^/]+\/git\/commits\/(.+)$/))) {
      try {
        return send(200, await fake.getCommit(owner, repo, m[1]))
      } catch (error) {
        return send(404, { message: String(error.message) })
      }
    }
    if (method === 'GET' && (m = match(/^\/repos\/[^/]+\/[^/]+\/git\/trees\/(.+)$/))) {
      try {
        const { map, truncated, sha } = await fake.getTreeMap(owner, repo, m[1])
        return send(200, {
          sha,
          truncated: !!truncated,
          tree: [...map].map(([entryPath, meta]) => ({ path: entryPath, type: 'blob', sha: meta.sha, size: meta.size })),
        })
      } catch (error) {
        return send(404, { message: String(error.message) })
      }
    }
    if (method === 'GET' && (m = match(/^\/repos\/[^/]+\/[^/]+\/git\/blobs\/(.+)$/))) {
      try {
        const buffer = await fake.getBlob(owner, repo, m[1])
        return send(200, { content: buffer.toString('base64'), encoding: 'base64' })
      } catch (error) {
        return send(404, { message: String(error.message) })
      }
    }
    // GitHub refuses every Git Data write until the repository has a commit.
    if (method === 'POST' && /\/git\/blobs$/.test(path)) {
      if (fake.commits.size === 0) return send(409, { message: 'Git Repository is empty.' })
      return send(201, { sha: await fake.createBlob(owner, repo, Buffer.from(body.content, 'base64')) })
    }
    if (method === 'POST' && /\/git\/trees$/.test(path)) {
      if (fake.commits.size === 0) return send(409, { message: 'Git Repository is empty.' })
      return send(201, { sha: await fake.createTree(owner, repo, body.tree, body.base_tree) })
    }
    if (method === 'POST' && /\/git\/commits$/.test(path)) {
      if (fake.commits.size === 0) return send(409, { message: 'Git Repository is empty.' })
      return send(201, { sha: await fake.createCommit(owner, repo, body) })
    }
    if (method === 'PUT' && (m = match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/))) {
      const filePath = decodeURIComponent(m[1])
      return send(201, await fake.putFile(owner, repo, {
        path: filePath,
        content: Buffer.from(body.content, 'base64'),
        message: body.message,
        branch: body.branch || 'main',
      }))
    }
    if (method === 'POST' && /\/git\/refs$/.test(path)) {
      const name = String(body.ref).replace('refs/heads/', '')
      return send(201, await fake.createRef(owner, repo, name, body.sha))
    }
    if (method === 'PATCH' && (m = match(/\/git\/refs\/heads\/(.+)$/))) {
      const name = decodeURIComponent(m[1])
      if (!fake.refs.has(name)) return send(404, { message: 'Not Found' })
      await fake.setRef(owner, repo, name, body.sha, body.force)
      return send(200, { object: { sha: body.sha } })
    }
    return send(404, { message: `unmapped ${method} ${path}` })
  }
}

/** A throwaway `$DSH_HOME` with sessions and two profiles. */
async function makeHome() {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'dshgs-plugin-'))
  await fsp.mkdir(join(dir, 'sessions', '--proj-a--', 'session-1'), { recursive: true })
  await fsp.writeFile(join(dir, 'sessions', '--proj-a--', 'session-1', 'session.v3.jsonl.zstd'), Buffer.from([1, 2, 3, 4, 5]))
  await fsp.mkdir(join(dir, 'profiles', 'web'), { recursive: true })
  await fsp.writeFile(join(dir, 'profiles', 'web', 'package.json'), '{"name":"dsh-profile-web"}')
  await fsp.writeFile(join(dir, 'settings.yaml'), 'ui-theme:\n  preference: dark\n')
  return dir
}

/** Minimal `node:http` request/response doubles. */
function callRoute(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const listeners = {}
    const req = {
      method,
      url,
      headers: { host: '127.0.0.1:3080', ...headers },
      on(event, callback) {
        ;(listeners[event] = listeners[event] || []).push(callback)
        return req
      },
      destroy() {},
    }
    const res = {
      statusCode: 0,
      headers: null,
      payload: '',
      writeHead(status, responseHeaders) {
        this.statusCode = status
        this.headers = responseHeaders
      },
      end(chunk) {
        this.payload = chunk || ''
        let parsed = null
        try {
          parsed = this.payload ? JSON.parse(this.payload) : null
        } catch {
          /* non-JSON body */
        }
        resolve({ status: this.statusCode, body: parsed })
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
    setImmediate(() => {
      if (body !== undefined && listeners.data) listeners.data.forEach((cb) => cb(Buffer.from(JSON.stringify(body))))
      if (listeners.end) listeners.end.forEach((cb) => cb())
    })
  })
}

before(async () => {
  home = await makeHome()
  process.env.DSH_HOME = home
  gh = createFakeGithub()
  realFetch = globalThis.fetch
  globalThis.fetch = githubFetchServer(gh)

  plugin = await import('../src/index.js')

  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    effect: (fn, label) => {
      const disposer = fn()
      disposers.push({ label, disposer })
      return () => {}
    },
    inject: () => {},
    get: () => undefined,
    webServer: {
      register: (registered) => {
        route = registered
        return () => {}
      },
    },
  }
  plugin.apply(ctx, {})
})

after(async () => {
  for (const entry of disposers) {
    if (typeof entry.disposer === 'function') await entry.disposer()
  }
  globalThis.fetch = realFetch
  delete process.env.DSH_HOME
})

test('the host plugin exports the host-plane contract', () => {
  assert.equal(plugin.name, 'dsh-github-sync')
  assert.deepEqual([...plugin.inject], ['webServer'])
  assert.equal(typeof plugin.apply, 'function')
})

test('the API route is registered under the plugin path', () => {
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/dsh-github-sync/api')
  assert.equal(typeof route.handler, 'function')
})

test('settings round-trip without ever echoing the token', async () => {
  const saved = await callRoute('PUT', '/dsh-github-sync/api/settings', {
    repoUrl: 'https://github.com/acme/dsh-backup.git',
    token: 'ghp_secret',
    syncSessions: true,
    syncPlugins: true,
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.settings.hasToken, true)
  assert.equal('token' in saved.body.settings, false)
  assert.equal(saved.body.settings.repoUrl, 'https://github.com/acme/dsh-backup.git')

  const status = await callRoute('GET', '/dsh-github-sync/api/status')
  assert.equal(status.body.configured, true)
  assert.equal(status.body.settings.hasToken, true)
  assert.equal(status.body.local.sessions.sessionCount, 1)
  assert.deepEqual(status.body.local.profiles, ['web'])
  assert.equal(status.body.capabilities.zstd, typeof process.versions.node === 'string')
})

test('an unparsable repository is refused', async () => {
  const bad = await callRoute('PUT', '/dsh-github-sync/api/settings', { repoUrl: 'not a repo' })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /无法解析仓库地址/)
})

test('a read-only token is told which permission is missing', async () => {
  denyWrites = true
  try {
    const result = await callRoute('POST', '/dsh-github-sync/api/sync', {})
    assert.equal(result.status, 400)
    assert.match(result.body.error, /令牌权限不足/)
    assert.match(result.body.error, /Contents 设为 Read and write/)
  } finally {
    denyWrites = false
  }
})

test('a repository the token cannot see explains itself instead of saying Not Found', async () => {
  // GitHub answers 404 for a repo a fine-grained token was never granted, so
  // the bare message sends people hunting for a typo in the URL.
  await callRoute('PUT', '/dsh-github-sync/api/settings', { repoUrl: 'acme/never-granted' })
  const result = await callRoute('POST', '/dsh-github-sync/api/verify', {})
  assert.equal(result.status, 400)
  assert.match(result.body.error, /acme\/never-granted/)
  assert.match(result.body.error, /Repository access/)
  assert.match(result.body.error, /404 而不是 403/)

  await callRoute('PUT', '/dsh-github-sync/api/settings', { repoUrl: 'acme/dsh-backup' })
})

test('verify reports the repository as private and writable', async () => {
  const result = await callRoute('POST', '/dsh-github-sync/api/verify', {})
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.repo, 'acme/dsh-backup')
  assert.equal(result.body.user, 'acme')
})

test('a manual sync pushes sessions and plugin manifests to GitHub', async () => {
  const result = await callRoute('POST', '/dsh-github-sync/api/sync', {})
  assert.equal(result.status, 200)
  assert.equal(result.body.pushed, true)
  assert.equal(result.body.created >= 3, true, 'sessions + manifests + manifest.json')
  assert.equal(result.body.bytes > 0, true)

  const paths = [...gh.files().keys()]
  assert.equal(paths.some((p) => p.endsWith('/sessions/--proj-a--/session-1/session.v3.jsonl.zstd')), true)
  assert.equal(paths.some((p) => p.endsWith('/plugins/web/package.json')), true)
  assert.equal(paths.some((p) => p.endsWith('/manifest.json')), true)
  assert.equal(paths.some((p) => p.includes('/settings/')), false, 'settings.yaml is off by default')
})

test('a second sync finds nothing to commit', async () => {
  const result = await callRoute('POST', '/dsh-github-sync/api/sync', {})
  assert.equal(result.body.pushed, false)
  assert.equal(result.body.nothingToCommit, true)
})

test('the remote inventory lists this machine and its workspaces', async () => {
  const result = await callRoute('GET', '/dsh-github-sync/api/remote')
  assert.equal(result.status, 200)
  assert.equal(result.body.instances.length, 1)
  const instance = result.body.instances[0]
  assert.equal(instance.sessionCount, 1)
  assert.equal(instance.workspaces[0].key, '--proj-a--')
  assert.equal(instance.manifest.groups.sessions, true)
  assert.equal(instance.manifest.totals.sessions, 1)
  assert.equal(instance.manifest.version, 1)
  assert.equal(typeof result.body.savedAt, 'string', 'the branch commit date is the "when" of a backup')
})

test('the local session inventory is grouped by workspace', async () => {
  const result = await callRoute('GET', '/dsh-github-sync/api/sessions/local')
  assert.equal(result.status, 200)
  assert.equal(result.body.sessionCount, 1)
  const workspace = result.body.workspaces[0]
  assert.equal(workspace.key, '--proj-a--')
  assert.equal(workspace.sessions[0].id, 'session-1')
  assert.equal(workspace.sessions[0].file, 'session.v3.jsonl.zstd')
})

test('sessions from another machine can be previewed and restored', async () => {
  const instanceId = (await callRoute('GET', '/dsh-github-sync/api/status')).body.instanceId
  const other = instanceId === 'other-machine' ? 'third-machine' : 'other-machine'

  // Pretend a second machine pushed its own sessions.
  const seed = await import('../src/sync.js')
  const plan = { files: [{ repoPath: `instances/${other}/sessions/--proj-z--/session-9/session.jsonl.zstd`, content: Buffer.from('remote-bytes'), size: 12 }], totals: { sessions: 1, plugins: 0, settings: 0 } }
  await seed.pushSnapshot({
    client: {
      getBranchHead: (...a) => gh.getBranchHead(...a),
      getCommit: (...a) => gh.getCommit(...a),
      getTreeMap: (...a) => gh.getTreeMap(...a),
      createBlob: (...a) => gh.createBlob(...a),
      createTree: (...a) => gh.createTree(...a),
      createCommit: (...a) => gh.createCommit(...a),
      createRef: (...a) => gh.createRef(...a),
      setRef: (...a) => gh.setRef(...a),
      getBlob: (...a) => gh.getBlob(...a),
    },
    owner: 'acme', repo: 'dsh-backup', branch: 'main', instanceId: other, plan,
  })

  const preview = await callRoute('POST', '/dsh-github-sync/api/sessions/restore', { instanceId: other, dryRun: true })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.files.length, 1)

  const restored = await callRoute('POST', '/dsh-github-sync/api/sessions/restore', { instanceId: other })
  assert.equal(restored.status, 200)
  assert.equal(restored.body.written.length, 1)
  assert.match(restored.body.safetySnapshot, /^pre-restore-/)

  const written = await fsp.readFile(join(home, 'sessions', '--proj-z--', 'session-9', 'session.jsonl.zstd'), 'utf8')
  assert.equal(written, 'remote-bytes')
})

test('restoring this machine onto itself needs an explicit force', async () => {
  const instanceId = (await callRoute('GET', '/dsh-github-sync/api/status')).body.instanceId
  const refused = await callRoute('POST', '/dsh-github-sync/api/sessions/restore', { instanceId })
  assert.equal(refused.status, 400)
  assert.match(refused.body.error, /本机自己的备份/)
})

test('a workspace can be remapped while restoring', async () => {
  const instanceId = (await callRoute('GET', '/dsh-github-sync/api/status')).body.instanceId
  const result = await callRoute('POST', '/dsh-github-sync/api/sessions/restore', {
    instanceId,
    force: true,
    map: { '--proj-a--': '--remapped--' },
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.written.length, 1)
  const remapped = await fsp.readFile(join(home, 'sessions', '--remapped--', 'session-1', 'session.v3.jsonl.zstd'))
  assert.deepEqual([...remapped], [1, 2, 3, 4, 5])

  const bad = await callRoute('POST', '/dsh-github-sync/api/sessions/restore', {
    instanceId,
    force: true,
    map: { '--proj-a--': '../escape' },
  })
  assert.equal(bad.status, 200, 'a rejected mapping simply keeps the original folder')
})

test('snapshots can be taken, listed, restored and deleted', async () => {
  const made = await callRoute('POST', '/dsh-github-sync/api/snapshots', { name: 'unit-test' })
  assert.equal(made.status, 200)
  assert.equal(made.body.snapshot.name, 'unit-test')
  assert.equal(made.body.snapshot.files >= 2, true)

  const listed = await callRoute('GET', '/dsh-github-sync/api/snapshots')
  assert.equal(listed.body.snapshots.some((s) => s.name === 'unit-test'), true)

  // Change a session after the snapshot, then roll it back.
  const sessionFile = join(home, 'sessions', '--proj-a--', 'session-1', 'session.v3.jsonl.zstd')
  await fsp.writeFile(sessionFile, Buffer.from([9, 9, 9, 9, 9]))
  const restored = await callRoute('POST', '/dsh-github-sync/api/snapshots/restore', { name: 'unit-test', groups: ['sessions'] })
  assert.equal(restored.status, 200)
  assert.equal(restored.body.written.length, 1)
  assert.match(restored.body.safetySnapshot, /^pre-restore-/)
  assert.deepEqual([...await fsp.readFile(sessionFile)], [1, 2, 3, 4, 5])

  const deleted = await callRoute('POST', '/dsh-github-sync/api/snapshots/delete', { name: 'unit-test' })
  assert.equal(deleted.status, 200)
  const after = await callRoute('GET', '/dsh-github-sync/api/snapshots')
  assert.equal(after.body.snapshots.some((s) => s.name === 'unit-test'), false)
})

test('state-changing requests from another origin are refused', async () => {
  const refused = await callRoute('POST', '/dsh-github-sync/api/sync', {}, { origin: 'https://evil.example' })
  assert.equal(refused.status, 403)
})

test('unknown routes answer 404 rather than falling through to the SPA', async () => {
  const missing = await callRoute('GET', '/dsh-github-sync/api/nope')
  assert.equal(missing.status, 404)
})
