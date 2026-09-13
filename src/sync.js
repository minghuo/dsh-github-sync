'use strict'

/**
 * dsh-github-sync — the sync engine.
 *
 * Pure-ish logic: it knows how a dsh installation maps onto repository paths,
 * how to diff that against a remote tree, how to push a commit, and how to
 * restore files back into the live installation. It never touches cordis and
 * never opens a socket itself — the GitHub client and the filesystem are
 * passed in — so every path here is unit-testable with a temporary `$DSH_HOME`
 * and a fake transport.
 *
 * Repository layout (one directory per machine — machines never collide):
 *
 *   instances/<instanceId>/manifest.json                  machine + inventory
 *   instances/<instanceId>/sessions/<workspaceKey>/…      session backups
 *   instances/<instanceId>/plugins/<profile>/…            plugin manifests
 *   instances/<instanceId>/settings/settings.yaml         host settings
 */

import fsP from 'node:fs/promises'
import { join, relative, sep, dirname } from 'node:path'

import { isExcludedSessionFile, PLUGIN_MANIFEST_FILES, displayPath, dshHome, listWorkspaceDirs, listProfiles } from './paths.js'
import { gitBlobSha, repoSlug } from './github.js'

/** The three independently switchable mirror groups, in UI order. */
export const GROUPS = ['sessions', 'plugins', 'settings']

export const MANIFEST_NAME = 'manifest.json'

/** Default per-file ceiling; GitHub rejects blobs above 100 MB. */
export const DEFAULT_MAX_FILE_MB = 45

/** The one file the Contents API writes to give an empty repository a commit. */
export const SEED_FILE = 'README.md'

/** Body of {@link SEED_FILE}: what this repository is and how it is laid out. */
export function seedFileBody() {
  return [
    '# dsh 备份仓库',
    '',
    '这个仓库由 dsh 插件 `dsh-github-sync` 维护：把 dsh 的会话、插件清单与设置备份到私有仓库，',
    '并可在另一台机器上按整机 / 工作区 / 单会话恢复。',
    '',
    '```',
    'instances/<实例ID>/',
    '  manifest.json   该机器的清单（主机名、分组、统计、工作区真实路径）',
    '  sessions/…      会话日志，按工作区/会话目录逐字节复制（含各代日志）',
    '  plugins/…       各 profile 的插件清单（package.json / cordis.patch.yml / 锁文件）',
    '  settings/…      settings.yaml（可选，默认关闭）',
    '```',
    '',
    '每台机器只写自己的 `instances/<实例ID>/`，互不覆盖，因此不需要合并。',
    '本文件只用于让空仓库拥有第一个提交 —— 除它之外请勿手工编辑，同步会按磁盘状态覆盖。',
    '',
  ].join('\n')
}

/** `instances/<id>` prefix for one machine. */
export function instancePrefix(instanceId) {
  return `instances/${instanceId}`
}

/** POSIX-style repo path from path segments. */
export function repoPath(...segments) {
  return segments.filter((s) => s !== '' && s !== undefined && s !== null).join('/')
}

// ── Building the local snapshot plan ─────────────────────────────────────

export async function walkFiles(root, { filter, out = [] } = {}) {
  let entries
  try {
    entries = await fsP.readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const abs = join(root, entry.name)
    if (entry.isDirectory()) {
      await walkFiles(abs, { filter, out })
    } else if (entry.isFile()) {
      if (filter && !filter(entry.name, abs)) continue
      out.push(abs)
    }
  }
  return out
}

/**
 * Enumerate everything that would be uploaded for one machine.
 *
 * @param {object} options
 * @param {string} options.home        `$DSH_HOME`
 * @param {string} options.instanceId  stable per-machine id
 * @param {object} options.groups      `{ sessions, plugins, settings }` booleans
 * @param {string[]} options.profiles  profile names to mirror (default: detected)
 * @param {number} [options.maxFileMb] skip files larger than this
 * @param {string[]} [options.excludeWorkspaces] workspace keys to skip
 * @returns {Promise<{files: Array<{repoPath:string, abs:string, size:number, group:string}>, skipped: Array<{path:string, reason:string}>, totals: object}>}
 */
export async function buildPlan({ home = dshHome(), instanceId, groups = {}, profiles, maxFileMb = DEFAULT_MAX_FILE_MB, excludeWorkspaces = [] } = {}) {
  const files = []
  const skipped = []
  const prefix = instancePrefix(instanceId)
  const maxBytes = Math.max(1, maxFileMb) * 1024 * 1024
  const excluded = new Set(excludeWorkspaces)

  if (groups.sessions !== false) {
    for (const ws of await listWorkspaceDirs(home)) {
      if (excluded.has(ws.key)) continue
      const abs = await walkFiles(ws.dir, { filter: (name) => !isExcludedSessionFile(name) })
      for (const file of abs) {
        const rel = relative(ws.dir, file).split(sep).join('/')
        const size = await fsP.stat(file).then((s) => s.size).catch(() => 0)
        if (size > maxBytes) {
          skipped.push({ path: `${prefix}/sessions/${ws.key}/${rel}`, reason: `超过单文件上限 ${maxFileMb} MB（${(size / 1048576).toFixed(1)} MB）` })
          continue
        }
        files.push({ repoPath: `${prefix}/sessions/${ws.key}/${rel}`, abs: file, size, group: 'sessions' })
      }
    }
  }

  if (groups.plugins !== false) {
    const names = profiles && profiles.length > 0 ? profiles : await listProfiles(home)
    for (const profile of names) {
      for (const name of PLUGIN_MANIFEST_FILES) {
        const abs = join(home, 'profiles', profile, name)
        const stat = await fsP.stat(abs).catch(() => null)
        if (!stat || !stat.isFile()) continue
        if (stat.size > maxBytes) {
          skipped.push({ path: `${prefix}/plugins/${profile}/${name}`, reason: `超过单文件上限 ${maxFileMb} MB` })
          continue
        }
        files.push({ repoPath: `${prefix}/plugins/${profile}/${name}`, abs, size: stat.size, group: 'plugins' })
      }
    }
  }

  if (groups.settings === true) {
    const abs = join(home, 'settings.yaml')
    const stat = await fsP.stat(abs).catch(() => null)
    if (stat && stat.isFile()) {
      if (stat.size > maxBytes) skipped.push({ path: `${prefix}/settings/settings.yaml`, reason: '超过单文件上限' })
      else files.push({ repoPath: `${prefix}/settings/settings.yaml`, abs, size: stat.size, group: 'settings' })
    }
  }

  const totals = { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) }
  for (const group of GROUPS) {
    totals[group] = files.filter((f) => f.group === group).length
    totals[`${group}Bytes`] = files.filter((f) => f.group === group).reduce((n, f) => n + f.size, 0)
  }
  return { files, skipped, totals }
}

// ── Repo path ↔ live path ────────────────────────────────────────────────

/**
 * Where a repository file lands in a live installation, or `null` when the
 * file is plugin metadata rather than restorable state.
 */
export function mapRepoPathToLive(repoPath, home = dshHome()) {
  const parts = String(repoPath).split('/')
  if (parts[0] !== 'instances' || parts.length < 3) return null
  const rest = parts.slice(2)
  if (rest[0] === 'sessions' && rest.length >= 2) {
    return { abs: join(home, 'sessions', ...rest.slice(1)), group: 'sessions', workspace: rest[1] }
  }
  if (rest[0] === 'plugins' && rest.length >= 3) {
    return { abs: join(home, 'profiles', ...rest.slice(1)), group: 'plugins', profile: rest[1] }
  }
  if (rest[0] === 'settings' && rest.length === 2 && rest[1] === 'settings.yaml') {
    return { abs: join(home, 'settings.yaml'), group: 'settings' }
  }
  return null
}

/** Inverse of {@link mapRepoPathToLive} for a live absolute path. */
export function mapLivePathToRepo(abs, { home = dshHome(), instanceId } = {}) {
  const prefix = instancePrefix(instanceId)
  const rel = relative(home, abs).split(sep).join('/')
  if (rel.startsWith('../')) return null
  if (rel.startsWith('sessions/')) return `${prefix}/sessions/${rel.slice('sessions/'.length)}`
  if (rel.startsWith('profiles/')) {
    const rest = rel.slice('profiles/'.length)
    const [profile, ...tail] = rest.split('/')
    if (!PLUGIN_MANIFEST_FILES.includes(tail[tail.length - 1])) return null
    return `${prefix}/plugins/${profile}/${tail.join('/')}`
  }
  if (rel === 'settings.yaml') return `${prefix}/settings/settings.yaml`
  return null
}

// ── Sources (remote tree or local snapshot directory) ────────────────────

/** List/read files from a GitHub tree. */
export function remoteSource({ client, owner, repo, treeMap }) {
  return {
    kind: 'remote',
    async list() {
      const out = []
      for (const [path, meta] of treeMap) out.push({ path, size: meta.size || 0, sha: meta.sha })
      return out
    },
    async read(path) {
      const meta = treeMap.get(path)
      if (!meta) throw new Error(`远端不存在该文件：${path}`)
      return client.getBlob(owner, repo, meta.sha)
    },
  }
}

/** List/read files from a local snapshot directory (`<dir>/<repoPath>`). */
export function localSource(dir) {
  return {
    kind: 'local',
    async list() {
      const files = await walkFiles(dir)
      const out = []
      for (const abs of files) {
        const stat = await fsP.stat(abs).catch(() => null)
        out.push({ path: relative(dir, abs).split(sep).join('/'), size: stat ? stat.size : 0 })
      }
      return out
    },
    async read(path) {
      return fsP.readFile(join(dir, ...String(path).split('/')))
    },
  }
}

// ── Restore ──────────────────────────────────────────────────────────────

/** Every zstd frame starts with these four bytes. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Would writing this file stop the harness from starting?
 *
 * dsh reads every session log's header while building its workspace registry,
 * and a log it cannot decode is a **fatal** error — `corrupt Zstandard session
 * log: invalid frame magic` takes the whole profile down, not just that one
 * session. So a restore refuses anything that is not a zstd frame instead of
 * landing a file that bricks the next boot.
 */
export function isCorruptSessionLog(repoPath, buffer) {
  if (!/\.jsonl\.zstd$/i.test(String(repoPath))) return false
  if (!Buffer.isBuffer(buffer) || buffer.length < ZSTD_MAGIC.length) return true
  return !buffer.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)
}

/** A workspace folder name must stay a single, harness-shaped path segment. */
export function sanitizeWorkspaceKey(key) {
  const s = String(key || '')
  return /^--[A-Za-z0-9._~-]{1,251}--$/.test(s) ? s : null
}

/**
 * Write files from a source back into the live installation.
 *
 * @param {object} options
 * @param {object} options.source    `remoteSource()` / `localSource()`
 * @param {string} [options.home]
 * @param {object} [options.only]    `{ groups?: string[], workspace?: string, instanceId?: string, paths?: string[] }`
 * @param {boolean} [options.overwrite] replace existing live files (default true)
 * @param {boolean} [options.dryRun]
 * @param {boolean} [options.allowSettings] gate for `settings.yaml` (caller decides)
 */
export async function restoreFrom({ source, home = dshHome(), only = {}, overwrite = true, dryRun = false, allowSettings = false, workspaceMap = {}, onProgress } = {}) {
  const listed = await source.list()
  const groups = only.groups && only.groups.length > 0 ? new Set(only.groups) : null
  const explicit = only.paths && only.paths.length > 0 ? new Set(only.paths) : null

  const written = []
  const unchanged = []
  const skipped = []
  const planned = []

  for (const entry of listed) {
    if (explicit && !explicit.has(entry.path)) continue
    if (only.instanceId && !entry.path.startsWith(`instances/${only.instanceId}/`)) continue
    const target = mapRepoPathToLive(entry.path, home)
    if (!target) continue
    if (groups && !groups.has(target.group)) continue
    if (target.group === 'settings' && !allowSettings) {
      skipped.push({ path: entry.path, reason: '设置同步未开启' })
      continue
    }
    if (only.workspace && target.group === 'sessions' && target.workspace !== only.workspace) continue
    if (target.group === 'sessions' && workspaceMap && workspaceMap[target.workspace]) {
      // Cross-machine restore: the same project lives at a different absolute
      // path on this machine, so its session folder is renamed on the way in.
      const mapped = sanitizeWorkspaceKey(workspaceMap[target.workspace])
      if (mapped) {
        const rest = relative(join(home, 'sessions', target.workspace), target.abs)
        target.abs = join(home, 'sessions', mapped, rest)
        target.workspace = mapped
        target.remapped = true
      }
    }
    planned.push({ entry, target })
  }

  if (dryRun) {
    return { dryRun: true, files: planned.map((p) => ({ path: p.entry.path, to: displayPath(p.target.abs), size: p.entry.size })), written: [], unchanged: [], skipped }
  }

  let handled = 0
  for (const { entry, target } of planned) {
    const buffer = await source.read(entry.path)
    handled += 1
    if (typeof onProgress === 'function') {
      onProgress({ phase: 'write', done: handled, total: planned.length, current: entry.path })
    }
    if (isCorruptSessionLog(entry.path, buffer)) {
      skipped.push({ path: entry.path, reason: '不是合法的 zstd 会话日志；写入它会让 dsh 无法启动，已跳过' })
      continue
    }
    const existing = await fsP.readFile(target.abs).catch(() => null)
    if (existing && Buffer.compare(existing, buffer) === 0) {
      unchanged.push(entry.path)
      continue
    }
    if (existing && !overwrite) {
      skipped.push({ path: entry.path, reason: '本地已存在且未允许覆盖' })
      continue
    }
    await fsP.mkdir(dirname(target.abs), { recursive: true })
    const tmp = `${target.abs}.dshgs-${process.pid}-${Date.now()}.tmp`
    await fsP.writeFile(tmp, buffer)
    await fsP.rename(tmp, target.abs)
    written.push({ path: entry.path, to: displayPath(target.abs), bytes: buffer.length, replaced: !!existing })
  }

  return { dryRun: false, files: planned.map((p) => p.entry.path), written, unchanged, skipped }
}

// ── Push ─────────────────────────────────────────────────────────────────

/**
 * Diff the plan against the remote tree and push one commit.
 *
 * Only under `instances/<instanceId>/` is ever written, so two machines can
 * never fight over a path; `pullRequest` adds the branch → PR → auto-merge
 * ritual on top for teams that want a reviewable trail.
 *
 * @returns {Promise<object>} a report: counts, commit sha, and (in PR mode) the PR.
 */
export async function pushSnapshot({
  client,
  owner,
  repo,
  branch = 'main',
  instanceId,
  plan,
  extraFiles = [],
  message,
  pullRequest = false,
  mergeMethod = 'squash',
  logger = () => {},
  onProgress,
}) {
  let head = await client.getBranchHead(owner, repo, branch)
  if (!head) {
    // A repository with no commits cannot be written through the Git Data API
    // at all — blobs, trees and commits all answer 409 `Git Repository is
    // empty.` — so the first commit is made through the Contents API and the
    // batch push continues from the commit it produces.
    await client.putFile(owner, repo, {
      path: SEED_FILE,
      content: seedFileBody(),
      message: 'dsh-github-sync: 初始化备份仓库',
      branch,
    })
    head = await client.getBranchHead(owner, repo, branch)
    logger('空仓库：已通过 Contents API 创建初始提交')
    if (!head) throw new Error('仓库初始化后仍读不到分支，请检查令牌是否有 Contents: Read and write 权限')
  }
  const commit = head ? await client.getCommit(owner, repo, head) : null
  const baseTree = commit ? commit.tree.sha : undefined

  let remoteMap = new Map()
  let truncated = false
  if (head) {
    const tree = await client.getTreeMap(owner, repo, baseTree)
    remoteMap = tree.map
    truncated = tree.truncated
    if (truncated) logger('远端目录树被 GitHub 截断，本次只做增量比对')
  }

  const prefix = `${instancePrefix(instanceId)}/`
  const wanted = new Map()
  const manifestEntry = extraFiles.find((f) => f.repoPath.endsWith(`/${MANIFEST_NAME}`))
  for (const file of [...plan.files, ...extraFiles]) wanted.set(file.repoPath, file)

  const created = []
  const updated = []
  const unchanged = []
  const treeEntries = []
  let uploaded = 0

  for (const [path, file] of wanted) {
    let buffer
    if (file.content !== undefined) buffer = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content)
    else buffer = await fsP.readFile(file.abs)
    const sha = gitBlobSha(buffer)
    const existing = remoteMap.get(path)
    if (existing && existing.sha === sha) {
      unchanged.push(path)
      continue
    }
    const blobSha = await client.createBlob(owner, repo, buffer)
    treeEntries.push({ path, mode: '100644', type: 'blob', sha: blobSha })
    uploaded += 1
    if (typeof onProgress === 'function') {
      onProgress({ phase: 'upload', done: uploaded, total: wanted.size, current: path })
    }
    if (existing) updated.push(path)
    else created.push(path)
  }

  // Files that vanished locally disappear remotely too — but only inside this
  // machine's own prefix, so another machine's backup is never touched.
  const deleted = []
  for (const path of remoteMap.keys()) {
    if (!path.startsWith(prefix)) continue
    if (path.endsWith(`/${MANIFEST_NAME}`) && !manifestEntry) continue
    if (wanted.has(path)) continue
    if (fileMissingOnPurpose(path, plan, extraFiles)) {
      treeEntries.push({ path, mode: '100644', type: 'blob', sha: null })
      deleted.push(path)
    }
  }

  if (treeEntries.length === 0) {
    return { pushed: false, nothingToCommit: true, commit: head, branch, created: [], updated: [], deleted: [], unchanged: unchanged.length, truncated }
  }

  const treeSha = await client.createTree(owner, repo, treeEntries, baseTree)
  const commitMessage = message || `dsh-github-sync: ${instanceId} @ ${new Date().toISOString()}`
  const newCommit = await client.createCommit(owner, repo, {
    message: commitMessage,
    tree: treeSha,
    parents: head ? [head] : [],
  })

  const report = {
    pushed: true,
    commit: newCommit,
    baseCommit: head,
    branch,
    created,
    updated,
    deleted,
    unchanged: unchanged.length,
    truncated,
    pr: null,
  }

  if (!pullRequest) {
    await client.setRef(owner, repo, branch, newCommit, false)
    return report
  }

  const syncBranch = `dsh-github-sync/${instanceId}/${Date.now()}`
  await client.createRef(owner, repo, syncBranch, newCommit)
  let pr = await client.findPullByHead(owner, repo, syncBranch)
  if (!pr) {
    pr = await client.createPull(owner, repo, {
      title: `dsh-github-sync: ${instanceId}`,
      head: syncBranch,
      base: branch,
      body: [
        `自动同步来自实例 \`${instanceId}\`。`,
        '',
        `- 新增 ${created.length} · 更新 ${updated.length} · 删除 ${deleted.length} · 未变 ${unchanged.length}`,
        `- 提交 \`${newCommit}\``,
      ].join('\n'),
    })
  }
  report.pr = { number: pr.number, url: pr.html_url, branch: syncBranch, repo: repoSlug({ owner, repo }) }

  const mergeable = await waitForMergeable(client, owner, repo, pr.number, logger)
  if (mergeable === false) {
    report.pr.state = 'conflict'
    return report
  }
  try {
    const merged = await client.mergePull(owner, repo, pr.number, mergeMethod)
    report.pr.state = 'merged'
    report.pr.mergeCommit = merged && merged.sha
  } catch (error) {
    report.pr.state = 'open'
    report.pr.error = String((error && error.message) || error)
  }
  return report
}

/** A tracked file that no longer exists locally is a deletion, not a skip. */
export function fileMissingOnPurpose(path, plan, extraFiles) {
  const known = [...plan.files, ...extraFiles].some((f) => f.repoPath === path)
  if (known) return false
  // Never delete outside the groups this run covers: a plan built with
  // `sessions: false` simply does not contain session paths, and those must
  // stay on the remote.
  for (const group of GROUPS) {
    if (plan.totals && plan.totals[group] === 0) {
      if (path.includes(`/${group}/`)) return false
    }
  }
  return true
}

/** GitHub computes `mergeable` asynchronously; poll briefly. */
export async function waitForMergeable(client, owner, repo, number, logger = () => {}, attempts = 6, delayMs = 1500) {
  for (let i = 0; i < attempts; i++) {
    const pr = await client.getPull(owner, repo, number).catch(() => null)
    if (pr && pr.mergeable !== null && pr.mergeable !== undefined) {
      if (pr.mergeable === false) logger(`PR #${number} 存在冲突，保留为待处理`)
      return pr.mergeable
    }
    await new Promise((r) => setTimeout(r, delayMs))
  }
  logger(`PR #${number} 的 mergeable 状态未在预期时间内就绪，按无冲突处理`)
  return null
}

// ── Remote inventory ─────────────────────────────────────────────────────

/**
 * Summarise every machine backup visible on the remote branch.
 * @returns {Promise<{commit:string|null, tree:Map<string,object>, instances:Array<object>, truncated:boolean}>}
 */
export async function remoteInventory({ client, owner, repo, branch = 'main' }) {
  const head = await client.getBranchHead(owner, repo, branch)
  if (!head) return { commit: null, commitDate: undefined, tree: new Map(), instances: [], truncated: false }
  const commit = await client.getCommit(owner, repo, head)
  const commitDate = (commit && commit.committer && commit.committer.date) || undefined
  const { map, truncated } = await client.getTreeMap(owner, repo, commit.tree.sha)

  const byInstance = new Map()
  for (const [path, meta] of map) {
    const parts = path.split('/')
    if (parts[0] !== 'instances' || parts.length < 3) continue
    const id = parts[1]
    if (!byInstance.has(id)) {
      byInstance.set(id, { instanceId: id, files: 0, bytes: 0, sessions: 0, sessionBytes: 0, workspaces: new Map(), manifest: null, groups: {} })
    }
    const info = byInstance.get(id)
    info.files++
    info.bytes += meta.size || 0
    const group = parts[2]
    info.groups[group] = (info.groups[group] || 0) + 1
    if (group === 'sessions' && parts.length >= 4) {
      info.sessions++
      info.sessionBytes += meta.size || 0
      const ws = parts[3]
      if (!info.workspaces.has(ws)) info.workspaces.set(ws, { key: ws, sessions: 0, bytes: 0 })
      const w = info.workspaces.get(ws)
      w.sessions++
      w.bytes += meta.size || 0
    }
    if (group === MANIFEST_NAME) info.manifestPath = path
  }

  for (const info of byInstance.values()) {
    if (info.manifestPath) {
      try {
        const buf = await client.getBlob(owner, repo, map.get(info.manifestPath).sha)
        info.manifest = JSON.parse(buf.toString('utf8'))
      } catch {
        info.manifest = null
      }
    }
    // The manifest is the only place a remote machine's real project paths
    // exist — a folder name alone cannot be decoded back into one.
    const declared = new Map(
      ((info.manifest && info.manifest.workspaces) || [])
        .filter((w) => w && typeof w.key === 'string')
        .map((w) => [w.key, w]),
    )
    info.workspaces = [...info.workspaces.values()]
      .map((w) => {
        const meta = declared.get(w.key)
        return {
          ...w,
          path: (meta && meta.path) || undefined,
          // Only a manifest that says so carries a registry-derived path;
          // older manifests stored a decoded guess under the same key.
          pathIsExact: Boolean(meta && meta.path && meta.pathIsExact === true),
        }
      })
      .sort((a, b) => b.bytes - a.bytes)
  }

  const instances = [...byInstance.values()].sort((a, b) => String(a.instanceId).localeCompare(String(b.instanceId)))

  // "When was this machine last backed up?" is a property of its manifest's
  // last commit, not of the branch head — every push from any machine moves
  // the head. A manifest is fixed size, so this is one small query per
  // instance rather than a walk over its session blobs.
  if (typeof client.lastCommitDate === 'function') {
    await Promise.all(
      instances.map(async (instance) => {
        instance.lastSyncAt = await client
          .lastCommitDate(owner, repo, branch, `${instancePrefix(instance.instanceId)}/${MANIFEST_NAME}`)
          .catch(() => undefined)
      }),
    )
  }

  return { commit: head, commitDate, tree: map, instances, truncated }
}

// ── Comparison (what a push or a pull would change) ──────────────────────

/** Which mirror group a repository path belongs to, or `null` for metadata. */
export function groupOfPath(repoPath) {
  const parts = String(repoPath).split('/')
  if (parts[0] !== 'instances' || parts.length < 3) return null
  return GROUPS.includes(parts[2]) ? parts[2] : null
}

/**
 * Compare this machine's plan against the remote tree, per group.
 *
 * This is the read-only half of a sync: it answers "what would a push send"
 * (`created` + `updated`), "what would a pull bring down" (`updated` +
 * `deleted`, i.e. files the remote has and we do not) and "what is already
 * identical" — the three questions a user asks before either direction.
 *
 * @returns `{ branch, head, truncated, groups: { [group]: {created, updated,
 *   deleted, unchanged, createdPaths, updatedPaths, deletedPaths} } }`
 */
export async function compareWithRemote({
  client,
  owner,
  repo,
  branch = 'main',
  instanceId,
  plan,
  extraFiles = [],
  limit = 50,
}) {
  const head = await client.getBranchHead(owner, repo, branch)
  let remoteMap = new Map()
  let truncated = false
  if (head) {
    const commit = await client.getCommit(owner, repo, head)
    const tree = await client.getTreeMap(owner, repo, commit.tree.sha)
    remoteMap = tree.map
    truncated = tree.truncated
  }

  const prefix = `${instancePrefix(instanceId)}/`
  const wanted = new Map()
  for (const file of [...plan.files, ...extraFiles]) wanted.set(file.repoPath, file)

  const buckets = Object.fromEntries(GROUPS.map((group) => [group, { created: [], updated: [], deleted: [], unchanged: 0 }]))

  for (const [path, file] of wanted) {
    if (!path.startsWith(prefix)) continue
    const group = groupOfPath(path)
    if (!group) continue
    const existing = remoteMap.get(path)
    if (!existing) {
      buckets[group].created.push(path)
      continue
    }
    const buffer = file.content !== undefined ? Buffer.from(file.content) : await fsP.readFile(file.abs)
    if (gitBlobSha(buffer) === existing.sha) buckets[group].unchanged += 1
    else buckets[group].updated.push(path)
  }

  for (const path of remoteMap.keys()) {
    if (!path.startsWith(prefix) || wanted.has(path)) continue
    const group = groupOfPath(path)
    if (!group) continue
    // A group that is switched off is simply absent from the plan; its remote
    // files are not deletions.
    if (plan.totals && plan.totals[group] === 0) continue
    buckets[group].deleted.push(path)
  }

  const groups = {}
  for (const group of GROUPS) {
    const b = buckets[group]
    groups[group] = {
      created: b.created.length,
      updated: b.updated.length,
      deleted: b.deleted.length,
      unchanged: b.unchanged,
      createdPaths: b.created.slice(0, limit),
      updatedPaths: b.updated.slice(0, limit),
      deletedPaths: b.deleted.slice(0, limit),
      truncated: b.created.length > limit || b.updated.length > limit || b.deleted.length > limit,
    }
  }
  return { branch, head, truncated, groups }
}

// ── Local snapshots ──────────────────────────────────────────────────────

/** Directory holding locally-kept snapshots. */
export function snapshotsRoot(syncDir) {
  return join(syncDir, 'snapshots')
}

/**
 * Copy the current plan into a local snapshot folder (repo-relative layout,
 * so restoring a snapshot and restoring the cloud use the same code path).
 */
export async function createLocalSnapshot({ syncDir, name, plan }) {
  const dir = join(snapshotsRoot(syncDir), name)
  await fsP.rm(dir, { recursive: true, force: true })
  await fsP.mkdir(dir, { recursive: true })
  let bytes = 0
  for (const file of plan.files) {
    const dest = join(dir, ...file.repoPath.split('/'))
    await fsP.mkdir(dirname(dest), { recursive: true })
    await fsP.copyFile(file.abs, dest)
    bytes += file.size
  }
  return { name, dir, files: plan.files.length, bytes }
}

/** Snapshots on disk, newest first. */
export async function listLocalSnapshots(syncDir) {
  const root = snapshotsRoot(syncDir)
  let entries
  try {
    entries = await fsP.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const files = await walkFiles(dir)
    let bytes = 0
    let newest = 0
    for (const f of files) {
      const stat = await fsP.stat(f).catch(() => null)
      if (!stat) continue
      bytes += stat.size
      if (stat.mtimeMs > newest) newest = stat.mtimeMs
    }
    out.push({ name: entry.name, dir, files: files.length, bytes, modifiedAt: newest ? new Date(newest).toISOString() : undefined })
  }
  return out.sort((a, b) => b.name.localeCompare(a.name))
}

/** Drop all but the newest `keep` snapshots, protecting `pinned` names. */
export async function pruneLocalSnapshots(syncDir, keep = 30, pinned = []) {
  const pinnedSet = new Set(pinned)
  const all = await listLocalSnapshots(syncDir)
  const removable = all.filter((s) => !pinnedSet.has(s.name))
  const doomed = removable.slice(Math.max(0, keep - (all.length - removable.length)))
  const removed = []
  for (const snap of doomed) {
    await fsP.rm(snap.dir, { recursive: true, force: true }).catch(() => {})
    removed.push(snap.name)
  }
  return removed
}

/** Filesystem-safe snapshot name (no separators, no `..` runs). */
export function sanitizeSnapshotName(name) {
  const cleaned = String(name || '')
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned.slice(0, 80)
}


