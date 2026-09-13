/**
 * dsh-github-sync — Host half.
 *
 * One private GitHub repository keeps several dsh installations in step.
 * Each machine owns a directory of its own inside the repository:
 *
 *   instances/<instanceId>/sessions/…   session backups (the point of it all)
 *   instances/<instanceId>/plugins/…    per-profile plugin manifests
 *   instances/<instanceId>/settings/…   settings.yaml (opt-in)
 *   instances/<instanceId>/manifest.json
 *
 * Because the paths are disjoint, two machines can never fight over a file, so
 * there is no merge step to get wrong: a push is just "make my directory match
 * my disk". An opt-in pull-request mode adds a reviewable trail on top.
 *
 * Two deliberate choices separate this from a `git`-based mirror:
 *
 *   1. **No git binary.** Everything goes through the GitHub REST API with the
 *      global `fetch` the harness already routes through its proxy policy.
 *      Nothing lands in `.git/config`, and the plugin works on machines that
 *      have no git at all.
 *   2. **Content-addressed diffing.** A file's git blob id is computed locally
 *      (`sha1("blob <len>\0" + bytes)`), so unchanged sessions are never
 *      uploaded — the common case for a 40 MB session tree.
 *
 * The access token is write-only: it can be set through the API, and reads
 * only ever report `hasToken`.
 */

import fs from 'node:fs'
import fsP from 'node:fs/promises'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join, relative, sep } from 'node:path'
import zlib from 'node:zlib'

import { dshHome, displayPath, decodeWorkspaceKey, listProfiles, listWorkspaceDirs, workspacePathMap } from './paths.js'
import { createGithubClient, parseRepoUrl, repoSlug } from './github.js'
import { diffProfilePlugins, installCommand, readAllProfiles } from './plugins.js'
import {
  MANIFEST_NAME,
  buildPlan,
  compareWithRemote,
  groupOfPath,
  createLocalSnapshot,
  instancePrefix,
  listLocalSnapshots,
  localSource,
  pruneLocalSnapshots,
  pushSnapshot,
  remoteInventory,
  remoteSource,
  restoreFrom,
  sanitizeSnapshotName,
  sanitizeWorkspaceKey,
  snapshotsRoot,
  walkFiles,
} from './sync.js'

const NAME = 'dsh-github-sync'
const SETTINGS_NS = 'dsh-github-sync'
const API_PREFIX = `/${NAME}/api`
const MAX_BODY_BYTES = 256 * 1024
const MAX_TEXT_BYTES = 512 * 1024
const HISTORY_LIMIT = 20

/** Composition-layer defaults; the user layer on top wins. */
const DEFAULTS = {
  repoUrl: '',
  branch: 'main',
  token: '',
  syncSessions: true,
  syncPlugins: true,
  /** settings.yaml may carry machine credentials — never on by default. */
  syncSettings: false,
  autoSync: false,
  syncOnStartup: false,
  intervalMinutes: 60,
  pullRequest: false,
  snapshotBeforePush: true,
  snapshotKeep: 20,
  maxFileMb: 45,
  excludeWorkspaces: '',
  profiles: '',
}

/** Keys the settings schema accepts, so a stray client field cannot leak in. */
const BOOLEAN_KEYS = ['syncSessions', 'syncPlugins', 'syncSettings', 'autoSync', 'syncOnStartup', 'pullRequest', 'snapshotBeforePush']
const NUMBER_KEYS = ['intervalMinutes', 'snapshotKeep', 'maxFileMb']
const STRING_KEYS = ['repoUrl', 'branch', 'excludeWorkspaces', 'profiles']

// ── schemastery (optional) ───────────────────────────────────────────────
//
// The settings service requires a schemastery schema. The package is a normal
// dependency, but a profile installed as a pnpm link can end up without it, so
// resolution falls back through the harness's own copies before giving up on
// the settings service entirely (a JSON config file then takes its place).

const requireCjs = createRequire(import.meta.url)

function loadSchemaBuilder() {
  const home = dshHome()
  const candidates = [
    '@deepseek-ai/schemastery',
    join(home, 'profiles', 'node_modules', '@deepseek-ai', 'schemastery'),
    process.env.DSH_GLOBAL_PREFIX
      ? join(process.env.DSH_GLOBAL_PREFIX, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery')
      : '',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const loaded = requireCjs(candidate)
      if (loaded && typeof loaded.object === 'function') return loaded
      if (loaded && loaded.default && typeof loaded.default.object === 'function') return loaded.default
    } catch {
      /* try the next location */
    }
  }
  return null
}

// ── Small HTTP helpers ───────────────────────────────────────────────────

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error && error.message}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * A state-changing request must not come from another origin. The route is
 * registered on the loopback web server, which enforces no auth of its own;
 * browsers already block cross-origin JSON POSTs, and this closes the gap for
 * the few requests a simple form could still make.
 */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    const host = String(req.headers.host || '')
    return parsed.host === host
  } catch {
    return false
  }
}

async function atomicWriteFile(file, data) {
  await fsP.mkdir(join(file, '..'), { recursive: true })
  const tmp = join(join(file, '..'), `.${randomUUID()}.tmp`)
  await fsP.writeFile(tmp, data)
  await fsP.rename(tmp, file)
}

// ── Cross-process lock ───────────────────────────────────────────────────
//
// The web and tui profiles share one `$DSH_HOME`, so two processes can try to
// sync at once. An `O_EXCL` file makes that impossible; a lock left behind by
// a dead process is stolen once its pid is gone.

async function acquireLock(lockFile) {
  const attempt = () => {
    const handle = fs.openSync(lockFile, 'wx')
    fs.writeSync(handle, String(process.pid))
    fs.closeSync(handle)
    return () => {
      try {
        fs.unlinkSync(lockFile)
      } catch {
        /* already gone */
      }
    }
  }
  try {
    return attempt()
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      try {
        fs.mkdirSync(join(lockFile, '..'), { recursive: true })
        return attempt()
      } catch {
        return null
      }
    }
    if (error && error.code === 'EEXIST') {
      try {
        const pid = Number.parseInt(String(fs.readFileSync(lockFile, 'utf8')).trim(), 10)
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0)
            return null
          } catch {
            /* holder is gone — steal the lock */
          }
        }
        fs.unlinkSync(lockFile)
        return attempt()
      } catch {
        return null
      }
    }
    throw error
  }
}

// ── Session inventory (local) ────────────────────────────────────────────

/**
 * Walk `$DSH_HOME/sessions` into something a UI can render: one entry per
 * project folder, with its sessions, byte sizes and newest mtime.
 */
async function localSessionInventory(home = dshHome()) {
  const knownPaths = await workspacePathMap(home)
  const workspaces = []
  let totalSessions = 0
  let totalBytes = 0
  for (const workspace of await listWorkspaceDirs(home)) {
    const sessions = []
    let bytes = 0
    let newest = 0
    let entries = []
    try {
      entries = await fsP.readdir(workspace.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(workspace.dir, entry.name)
      let fileBytes = 0
      let files = 0
      let latest = 0
      let current = null
      for (const file of await walkFiles(dir)) {
        const stat = await fsP.stat(file).catch(() => null)
        if (!stat) continue
        fileBytes += stat.size
        files += 1
        if (stat.mtimeMs > latest) latest = stat.mtimeMs
        // A session folder can hold several generations side by side; the
        // highest `session.vN` is the live one, `session.jsonl` is v0.
        const name = relative(dir, file).split(sep).join('/')
        const version = (name.match(/^session\.v(\d+)\.jsonl/) || [, name === 'session.jsonl' ? '0' : '-1'])[1]
        const rank = Number.parseInt(version, 10)
        if (!current || rank > current.rank || (rank === current.rank && stat.size > current.size)) {
          current = { name, rank, size: stat.size }
        }
      }
      if (files === 0) continue
      bytes += fileBytes
      if (latest > newest) newest = latest
      sessions.push({
        id: entry.name,
        files,
        bytes: fileBytes,
        modifiedAt: latest ? new Date(latest).toISOString() : undefined,
        file: current ? current.name : undefined,
      })
    }
    sessions.sort((a, b) => String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || '')))
    totalSessions += sessions.length
    totalBytes += bytes
    const known = knownPaths.get(workspace.key)
    workspaces.push({
      key: workspace.key,
      path: (known && known.path) || decodeWorkspaceKey(workspace.key),
      title: known ? known.title : undefined,
      // False when the value came from decoding a lossy folder name, so the UI
      // can say "≈" instead of presenting a guess as the real path.
      pathIsExact: Boolean(known),
      sessions,
      sessionCount: sessions.length,
      bytes,
      modifiedAt: newest ? new Date(newest).toISOString() : undefined,
    })
  }
  workspaces.sort((a, b) => b.bytes - a.bytes)
  return { workspaces, sessionCount: totalSessions, bytes: totalBytes }
}

/** Resolve a session file inside `$DSH_HOME/sessions`, refusing to escape it. */
function safeLocalSessionPath(home, workspace, session, file) {
  const root = join(home, 'sessions')
  const target = join(root, String(workspace || ''), String(session || ''), String(file || ''))
  const rel = relative(root, target)
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) return null
  if (!target.startsWith(root)) return null
  return target
}

/**
 * The last path segment of a project directory.
 *
 * Two machines rarely keep the same project at the same absolute path, so the
 * folder name is what identifies "the same project" across them — and what a
 * restored session is matched on when deciding which local workspace should
 * own it.
 */
function workspaceTitle(path) {
  return String(path || '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || ''
}

/**
 * Turn a transport error into something a user can act on.
 *
 * The one that matters is 404. GitHub answers 404 — not 403 — for a repository
 * a fine-grained token has not been granted, which makes "the repository does
 * not exist" and "your token cannot see it" indistinguishable, and the raw
 * `Not Found` sends people looking for a typo in the URL instead of at the
 * token's repository selection.
 */
function explainError(error) {
  const status = error && error.status
  const message = String((error && error.message) || error)
  if (status === 403 && /resource not accessible by personal access token/i.test(message)) {
    return [
      '令牌权限不足（HTTP 403）：这个 fine-grained PAT 对该仓库只有读权限，写不进去。',
      '请到 GitHub → Settings → Developer settings → Fine-grained tokens → 该令牌 → Permissions → Repository permissions，',
      '把 Contents 设为 Read and write（要用 PR 模式再加 Pull requests: Read and write），保存后重试。',
    ].join('')
  }
  if (status === 404 && /\/repos\//.test(String((error && error.path) || message))) {
    const slug = (message.match(/\/repos\/([^/]+\/[^/\s)]+)/) || [])[1] || '该仓库'
    return [
      `仓库 ${slug} 不可见（HTTP 404）。两种可能：`,
      '① 地址写错或仓库不存在；',
      '② 访问令牌没有被授权这个仓库 —— fine-grained PAT 对未授权的仓库返回 404 而不是 403。',
      '请到 GitHub → Settings → Developer settings → Fine-grained tokens，给该令牌的 Repository access 加上这个仓库，',
      '并把 Permissions → Contents 设为 Read and write。',
    ].join('')
  }
  return message
}

/** Zstd is what session logs are compressed with; Node grew support in 22.15. */
function zstdAvailable() {
  return typeof zlib.zstdDecompressSync === 'function'
}

function decompressSession(buffer) {
  if (!zstdAvailable()) return null
  const raw = buffer[0] === 0x28 && buffer[1] === 0xb5 ? zlib.zstdDecompressSync(buffer) : buffer
  return raw.toString('utf8')
}

// ── Plugin ───────────────────────────────────────────────────────────────

export const name = NAME
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const home = dshHome()
  const syncDir = join(home, 'dsh-github-sync')
  const stateFile = join(syncDir, 'state.json')
  const configFile = join(syncDir, 'config.json')
  const lockFile = join(syncDir, '.lock')
  const log = ctx.logger ? ctx.logger(NAME) : console

  // ── Settings (settings service when available, JSON file otherwise) ──

  const baseSettings = () => {
    const base = { ...DEFAULTS }
    const fromConfig = config && typeof config === 'object' ? config : {}
    for (const key of Object.keys(base)) if (fromConfig[key] !== undefined) base[key] = fromConfig[key]
    return base
  }

  // Late-bound on purpose: `settings` is not a hard dependency of this plugin
  // (a machine whose settings provider is absent still gets a working sync via
  // config.json), so the namespace is registered through a dynamic injection
  // that runs whenever the service appears — synchronously when it is already
  // there, which is the normal case.
  const settingsPlug = { scope: null }
  const Schema = loadSchemaBuilder()
  if (Schema && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['settings'], (settingsCtx) => {
        const svc = settingsCtx.settings
        if (!svc || typeof svc.register !== 'function') return
        try {
          settingsPlug.scope = svc.register(
            SETTINGS_NS,
            Schema.object({
              repoUrl: Schema.string().default(''),
              branch: Schema.string().default('main'),
              token: Schema.string().role('secret').default(''),
              syncSessions: Schema.boolean().default(true),
              syncPlugins: Schema.boolean().default(true),
              syncSettings: Schema.boolean().default(false),
              autoSync: Schema.boolean().default(false),
              syncOnStartup: Schema.boolean().default(false),
              intervalMinutes: Schema.number().default(60),
              pullRequest: Schema.boolean().default(false),
              snapshotBeforePush: Schema.boolean().default(true),
              snapshotKeep: Schema.number().default(20),
              maxFileMb: Schema.number().default(45),
              excludeWorkspaces: Schema.string().default(''),
              profiles: Schema.string().default(''),
            }),
            { base: baseSettings() },
          )
        } catch (error) {
          log.warn(`settings 命名空间注册失败，改用本地配置文件：${error && error.message}`)
          settingsPlug.scope = null
        }
        ctx.effect(
          () => () => {
            settingsPlug.scope = null
          },
          `${NAME}: settings scope`,
        )
      })
    } catch (error) {
      log.warn(`settings 注入失败，改用本地配置文件：${error && error.message}`)
    }
  }

  const settingsScope = () => settingsPlug.scope

  // The fallback store is read at boot by the auto-sync effect and written by
  // the settings route, so both the load and the write are serialised: without
  // that, a load that started while the file was still empty would land after
  // a save and quietly erase it.
  let fileSettings = null
  let fileSettingsLoad = null
  let writeChain = Promise.resolve()

  const loadFileSettings = () => {
    if (fileSettings) return Promise.resolve(fileSettings)
    if (!fileSettingsLoad) {
      fileSettingsLoad = fsP
        .readFile(configFile, 'utf8')
        .catch(() => null)
        .then((raw) => {
          let parsed = {}
          try {
            parsed = raw ? JSON.parse(raw) : {}
          } catch {
            parsed = {}
          }
          if (!fileSettings) fileSettings = parsed
          return fileSettings
        })
        .finally(() => {
          fileSettingsLoad = null
        })
    }
    return fileSettingsLoad
  }

  const readSettings = () => {
    const scope = settingsScope()
    if (scope) {
      const value = scope.get()
      if (value && typeof value === 'object') return { ...baseSettings(), ...value }
    }
    return { ...baseSettings(), ...(fileSettings || {}) }
  }

  /** Async variant: the JSON fallback may not have been read yet. */
  const readSettingsAsync = async () => {
    if (settingsScope()) return readSettings()
    await loadFileSettings()
    return readSettings()
  }

  const writeSettings = (patch) => {
    const next = writeChain.then(async () => {
      const scope = settingsScope()
      if (scope) {
        await scope.update(patch)
        return readSettings()
      }
      await loadFileSettings()
      fileSettings = { ...fileSettings, ...patch }
      await atomicWriteFile(configFile, JSON.stringify(fileSettings, null, 2))
      return readSettings()
    })
    writeChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /** Never hand the token to a caller; report only whether one is stored. */
  const publicSettings = (settings) => {
    const { token, ...rest } = settings
    return { ...rest, hasToken: typeof token === 'string' && token !== '' }
  }

  const listFromCsv = (value) =>
    String(value || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

  const groupToggles = (settings) => ({
    sessions: settings.syncSessions !== false,
    plugins: settings.syncPlugins !== false,
    settings: settings.syncSettings === true,
  })

  // ── State ──────────────────────────────────────────────────────────────

  const state = {
    instanceId: undefined,
    lastSyncAt: undefined,
    lastResult: undefined,
    history: [],
  }

  const stateLoaded = fsP
    .readFile(stateFile, 'utf8')
    .then((raw) => {
      Object.assign(state, JSON.parse(raw))
    })
    .catch(() => {})

  const saveState = () => atomicWriteFile(stateFile, JSON.stringify(state, null, 2)).catch(() => {})

  /** A stable, human-readable machine id; minted once and kept in state.json. */
  const ensureInstanceId = async () => {
    if (typeof state.instanceId === 'string' && state.instanceId !== '') return state.instanceId
    const host = String(hostname() || 'machine').replace(/[^\w.-]+/g, '-').slice(0, 32)
    state.instanceId = `${host}-${randomUUID().slice(0, 4)}`
    await saveState()
    return state.instanceId
  }

  let syncRun = null

  /**
   * What the long operations are doing right now.
   *
   * A push or a restore of tens of megabytes runs for a minute or more, and
   * the client's request only settles at the end — without this the page has
   * nothing to show but a spinner. The client polls `/progress` while it
   * waits, so the phases and the file counter are real, not decorative.
   */
  const progress = { op: null, phase: '', done: 0, total: 0, current: '', startedAt: 0, at: 0 }
  const beginProgress = (op) => {
    Object.assign(progress, { op, phase: '准备', done: 0, total: 0, current: '', startedAt: Date.now(), at: Date.now() })
    return {
      phase(phase, patch = {}) {
        Object.assign(progress, { phase, at: Date.now() }, patch)
      },
      tick(update = {}) {
        Object.assign(progress, update, { at: Date.now() })
      },
      end() {
        Object.assign(progress, { op: null, phase: '', done: 0, total: 0, current: '', at: Date.now() })
      },
    }
  }

  const requireClient = async () => {
    const settings = await readSettingsAsync()
    const parsed = parseRepoUrl(settings.repoUrl)
    if (!parsed) throw new Error('未配置仓库：请填写 GitHub 仓库（owner/repo 或完整 URL）')
    if (!settings.token) throw new Error('未配置访问令牌（需要该私有仓库的 Contents 读写权限）')
    const client = createGithubClient({ token: settings.token })
    return { settings, parsed, client }
  }

  // ── Sync ───────────────────────────────────────────────────────────────

  /**
   * Push this machine's snapshot. Only `instances/<instanceId>/…` is written,
   * so a concurrent run from another machine can never collide.
   */
  const runSync = async ({ reason = 'manual' } = {}) => {
    if (syncRun) return syncRun
    syncRun = (async () => {
      const release = await acquireLock(lockFile)
      if (release === null) throw new Error('另一个同步进程正在运行，请稍后再试')
      const started = Date.now()
      const watch = beginProgress('sync')
      try {
        await stateLoaded
        const instanceId = await ensureInstanceId()
        const { settings, parsed, client } = await requireClient()
        watch.phase('检查仓库')
        const repo = await client.getRepo(parsed.owner, parsed.repo)
        if (repo && repo.private === false) {
          throw new Error('检测到公共仓库。会话与插件清单会带上本机路径与内容，必须使用私有仓库。')
        }

        const groups = groupToggles(settings)
        const profiles = listFromCsv(settings.profiles)
        const excludeWorkspaces = listFromCsv(settings.excludeWorkspaces)
        watch.phase('盘点本机文件')
        const plan = await buildPlan({
          home,
          instanceId,
          groups,
          profiles,
          maxFileMb: Number(settings.maxFileMb) || 45,
          excludeWorkspaces,
        })

        if (settings.snapshotBeforePush !== false) {
          const name = `pre-push-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
          await createLocalSnapshot({ syncDir, name, plan }).catch((error) => log.warn(`本地快照失败：${error && error.message}`))
          await pruneLocalSnapshots(syncDir, Number(settings.snapshotKeep) || 20, []).catch(() => {})
        }

        // The manifest must be *deterministic* for identical inputs: a
        // timestamp (or the trigger that caused the run) inside it would make
        // every scheduled sync produce a commit even when nothing changed. The
        // commit date on GitHub carries "when" instead.
        const manifest = {
          version: 1,
          instanceId,
          hostname: hostname(),
          platform: process.platform,
          groups,
          totals: plan.totals,
          skipped: plan.skipped,
          workspaces: await describeWorkspaces(home, plan),
        }

        watch.phase('上传', { done: 0, total: plan.files.length + 1 })
        const report = await pushSnapshot({
          client,
          owner: parsed.owner,
          repo: parsed.repo,
          branch: settings.branch || 'main',
          instanceId,
          plan,
          extraFiles: [{ repoPath: `${instancePrefix(instanceId)}/${MANIFEST_NAME}`, content: JSON.stringify(manifest, null, 2) }],
          pullRequest: settings.pullRequest === true,
          logger: (message) => log.warn(message),
          onProgress: (update) => watch.tick({ phase: '上传', ...update }),
        })

        const result = {
          at: new Date().toISOString(),
          reason,
          durationMs: Date.now() - started,
          repo: repoSlug(parsed),
          branch: settings.branch || 'main',
          instanceId,
          pushed: report.pushed === true,
          nothingToCommit: report.nothingToCommit === true,
          commit: report.commit,
          created: (report.created || []).length,
          updated: (report.updated || []).length,
          deleted: (report.deleted || []).length,
          unchanged: report.unchanged || 0,
          skipped: plan.skipped,
          bytes: plan.totals.bytes,
          pr: report.pr || null,
          // Sessions and plugins are reported apart: they are different kinds
          // of thing to act on, and a single "12 changed" number hides which.
          groups: Object.fromEntries(
            ['sessions', 'plugins', 'settings'].map((group) => [
              group,
              {
                created: (report.created || []).filter((p) => groupOfPath(p) === group).length,
                updated: (report.updated || []).filter((p) => groupOfPath(p) === group).length,
                deleted: (report.deleted || []).filter((p) => groupOfPath(p) === group).length,
                files: plan.totals[group] || 0,
              },
            ]),
          ),
        }

        // What another machine has that this one does not — the actionable part
        // of a plugin sync, since a manifest alone cannot install anything.
        if (groups.plugins) {
          try {
            const plugins = await pluginReport({ client, owner: parsed.owner, repo: parsed.repo, branch: settings.branch || 'main', instanceId })
            result.pluginSuggestions = plugins.suggestions
          } catch (error) {
            log.warn(`同步后读取插件清单失败：${error && error.message}`)
          }
        }
        state.lastSyncAt = result.at
        state.lastResult = result
        state.history = [result, ...(Array.isArray(state.history) ? state.history : [])].slice(0, HISTORY_LIMIT)
        await saveState()
        log.info(`同步完成：新增 ${result.created} · 更新 ${result.updated} · 删除 ${result.deleted} · 未变 ${result.unchanged}`)
        return result
      } finally {
        watch.end()
        release()
      }
    })().finally(() => {
      syncRun = null
    })
    return syncRun
  }

  /**
   * Plugin manifests as the backup holds them: `{ [instanceId]: { [profile]: { packages } } }`.
   * A profile's declaration is four small files, so reading them all is cheap
   * enough to do on every report rather than caching something that can drift.
   */
  async function cloudPluginManifests({ client, owner, repo, inventory }) {
    const out = {}
    for (const [path, meta] of inventory.tree) {
      const match = path.match(/^instances\/([^/]+)\/plugins\/([^/]+)\/package\.json$/)
      if (!match) continue
      const [, instanceId, profile] = match
      const buffer = await client.getBlob(owner, repo, meta.sha).catch(() => null)
      if (!buffer) continue
      let manifest
      try {
        manifest = JSON.parse(buffer.toString('utf8'))
      } catch {
        continue
      }
      out[instanceId] = out[instanceId] || {}
      out[instanceId][profile] = {
        packages: Object.entries(manifest.dependencies || {}).map(([name, spec]) => ({ name, spec: String(spec) })),
        bundles: (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || [],
      }
    }
    return out
  }

  /**
   * Local plugins versus every machine's backup.
   *
   * `suggestions` is the part a user acts on: packages another machine has
   * declared that this one does not, each with the command that installs it.
   * A profile only exists on a machine that uses it, so the comparison runs
   * per profile rather than globally.
   */
  async function pluginReport({ client, owner, repo, branch, instanceId }) {
    const local = await readAllProfiles(home)
    if (!client) return { local, cloud: {}, diff: {}, suggestions: [], configured: false }

    const inventory = await remoteInventory({ client, owner, repo, branch })
    const cloud = await cloudPluginManifests({ client, owner, repo, inventory })

    // Union of what every *other* machine declares — what this one is missing.
    const others = {}
    for (const [id, profiles] of Object.entries(cloud)) {
      if (id === instanceId) continue
      for (const [profile, info] of Object.entries(profiles)) {
        others[profile] = others[profile] || { packages: [] }
        const seen = new Set(others[profile].packages.map((p) => p.name))
        for (const pkg of info.packages) if (!seen.has(pkg.name)) others[profile].packages.push(pkg)
      }
    }

    const diff = {}
    for (const [id, profiles] of Object.entries(cloud)) {
      diff[id] = diffProfilePlugins(local, profiles).profiles
    }
    const ownDiff = diffProfilePlugins(local, cloud[instanceId] || {})
    const suggestions = []
    for (const row of diffProfilePlugins(local, others).profiles) {
      for (const pkg of row.added) suggestions.push({ profile: row.profile, ...pkg, command: installCommand(row.profile, pkg) })
    }

    return {
      configured: true,
      local,
      cloud,
      diff,
      own: ownDiff.profiles,
      suggestions,
      instances: inventory.instances.map((i) => i.instanceId),
    }
  }

  /**
   * Per-workspace summary derived from a plan, for the remote manifest.
   * The path comes from the workspace registry when it is readable, so the
   * other machine sees the real project path rather than a lossy guess.
   */
  async function describeWorkspaces(homeDir, plan) {
    const knownPaths = await workspacePathMap(homeDir)
    const byWorkspace = new Map()
    for (const file of plan.files) {
      if (file.group !== 'sessions') continue
      const parts = file.repoPath.split('/')
      const key = parts[3]
      if (!byWorkspace.has(key)) {
        const known = knownPaths.get(key)
        byWorkspace.set(key, {
          key,
          path: (known && known.path) || decodeWorkspaceKey(key),
          pathIsExact: Boolean(known),
          sessions: new Set(),
          bytes: 0,
        })
      }
      const entry = byWorkspace.get(key)
      entry.sessions.add(parts[4])
      entry.bytes += file.size
    }
    return [...byWorkspace.values()].map((w) => ({
      key: w.key,
      path: w.path,
      pathIsExact: w.pathIsExact,
      sessions: w.sessions.size,
      bytes: w.bytes,
    }))
  }

  // ── Auto sync ──────────────────────────────────────────────────────────

  ctx.effect(() => {
    const fire = async (reason) => {
      await stateLoaded
      const settings = await readSettingsAsync()
      if (!settings.autoSync) return
      if (reason === 'startup' && settings.syncOnStartup !== true) return
      if (!settings.repoUrl || !settings.token) return
      await runSync({ reason }).catch((error) => log.warn(`自动同步失败：${error && error.message}`))
    }
    void fire('startup')
    const minutes = Math.max(5, Number(readSettings().intervalMinutes) || 60)
    const timer = setInterval(() => void fire('interval'), minutes * 60 * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, `${NAME}: auto sync`)

  // ── HTTP API ───────────────────────────────────────────────────────────

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          const url = new URL(req.url || '/', 'http://dsh.local')
          const route = url.pathname.replace(/\/+$/, '')
          const method = req.method || 'GET'
          const mutations = method !== 'GET' && method !== 'HEAD'

          try {
            if (mutations && !sameOrigin(req)) {
              sendJson(res, 403, { error: '拒绝跨站请求' })
              return
            }

            // GET /status
            if (method === 'GET' && route === `${API_PREFIX}/status`) {
              await stateLoaded
              const settings = await readSettingsAsync()
              const local = await localSessionInventory(home)
              const snapshots = await listLocalSnapshots(syncDir)
              sendJson(res, 200, {
                instanceId: await ensureInstanceId(),
                dir: displayPath(syncDir),
                configured: Boolean(parseRepoUrl(settings.repoUrl) && settings.token),
                repo: settings.repoUrl,
                branch: settings.branch,
                settings: publicSettings(settings),
                lastSyncAt: state.lastSyncAt,
                lastResult: state.lastResult,
                history: state.history || [],
                syncing: syncRun !== null,
                local: {
                  sessions: { workspaces: local.workspaces.length, sessionCount: local.sessionCount, bytes: local.bytes },
                  profiles: await listProfiles(home),
                },
                snapshots: { count: snapshots.length, latest: snapshots[0] ? snapshots[0].name : null, bytes: snapshots.reduce((n, s) => n + s.bytes, 0) },
                capabilities: { zstd: zstdAvailable(), settingsService: Boolean(settingsScope()) },
              })
              return
            }

            // GET /progress — what a running push or pull is doing right now
            if (method === 'GET' && route === `${API_PREFIX}/progress`) {
              sendJson(res, 200, { ...progress, busy: syncRun !== null })
              return
            }

            // GET /plugins — this machine's declared plugins, the backup's, and
            // what is missing here with the command that installs it
            if (method === 'GET' && route === `${API_PREFIX}/plugins`) {
              const settings = await readSettingsAsync()
              const parsed = parseRepoUrl(settings.repoUrl)
              const client = parsed && settings.token ? createGithubClient({ token: settings.token }) : null
              const report = await pluginReport({
                client,
                owner: parsed && parsed.owner,
                repo: parsed && parsed.repo,
                branch: settings.branch || 'main',
                instanceId: await ensureInstanceId(),
              })
              sendJson(res, 200, report)
              return
            }

            // GET /compare?instance= — the read-only diff behind a push or a pull
            if (method === 'GET' && route === `${API_PREFIX}/compare`) {
              const { settings, parsed, client } = await requireClient()
              const instanceId = url.searchParams.get('instance') || (await ensureInstanceId())
              const plan = await buildPlan({
                home,
                instanceId,
                groups: groupToggles(settings),
                profiles: listFromCsv(settings.profiles),
                maxFileMb: Number(settings.maxFileMb) || 45,
                excludeWorkspaces: listFromCsv(settings.excludeWorkspaces),
              })
              const manifest = {
                version: 1,
                instanceId,
                hostname: hostname(),
                platform: process.platform,
                groups: groupToggles(settings),
                totals: plan.totals,
                skipped: plan.skipped,
                workspaces: await describeWorkspaces(home, plan),
              }
              const comparison = await compareWithRemote({
                client,
                owner: parsed.owner,
                repo: parsed.repo,
                branch: settings.branch || 'main',
                instanceId,
                plan,
                extraFiles: [{ repoPath: `${instancePrefix(instanceId)}/${MANIFEST_NAME}`, content: JSON.stringify(manifest, null, 2) }],
              })
              sendJson(res, 200, { instanceId, repo: repoSlug(parsed), ...comparison })
              return
            }

            // POST /pull {instanceId, groups?, paths?, overwrite?} — bring the
            // backup down onto this machine (the other half of a sync)
            if (method === 'POST' && route === `${API_PREFIX}/pull`) {
              const body = await readJsonBody(req)
              const { settings, parsed, client } = await requireClient()
              const instanceId = String(body.instanceId || '')
              if (!instanceId) {
                sendJson(res, 400, { error: '缺少 instanceId' })
                return
              }
              const inventory = await remoteInventory({ client, owner: parsed.owner, repo: parsed.repo, branch: settings.branch || 'main' })
              if (!inventory.tree.size) {
                sendJson(res, 404, { error: '远端还没有任何备份' })
                return
              }
              const only = { instanceId, groups: Array.isArray(body.groups) && body.groups.length ? body.groups : ['sessions', 'plugins'] }
              if (Array.isArray(body.paths) && body.paths.length) only.paths = body.paths
              if (body.workspace) only.workspace = String(body.workspace)

              const watch = beginProgress('pull')
              try {
                watch.phase('读取云端')
                const result = await restoreFrom({
                  source: remoteSource({ client, owner: parsed.owner, repo: parsed.repo, treeMap: inventory.tree }),
                  home,
                  only,
                  overwrite: body.overwrite !== false,
                  allowSettings: body.allowSettings === true,
                  workspaceMap: body.map && typeof body.map === 'object' ? body.map : {},
                  onProgress: (update) => watch.tick({ phase: '写入本机', ...update }),
                })
                const response = { ...result, instanceId }
                if (only.groups.includes('plugins')) {
                  response.pluginSuggestions = (await pluginReport({
                    client,
                    owner: parsed.owner,
                    repo: parsed.repo,
                    branch: settings.branch || 'main',
                    instanceId: await ensureInstanceId(),
                  }).catch(() => ({ suggestions: [] }))).suggestions
                  response.installHint = '插件清单已拉到本机；缺少的依赖用上面列出的命令安装，然后重启 dsh web。'
                }
                sendJson(res, 200, response)
              } finally {
                watch.end()
              }
              return
            }

            // PUT /settings
            if (method === 'PUT' && route === `${API_PREFIX}/settings`) {
              const body = await readJsonBody(req)
              const patch = {}
              for (const key of BOOLEAN_KEYS) if (typeof body[key] === 'boolean') patch[key] = body[key]
              for (const key of NUMBER_KEYS) if (typeof body[key] === 'number' && Number.isFinite(body[key])) patch[key] = body[key]
              for (const key of STRING_KEYS) if (typeof body[key] === 'string') patch[key] = body[key]
              if (typeof body.token === 'string') patch.token = body.token
              if (typeof patch.repoUrl === 'string' && patch.repoUrl !== '') {
                if (!parseRepoUrl(patch.repoUrl)) {
                  sendJson(res, 400, { error: '无法解析仓库地址，请填写 owner/repo 或 https://github.com/owner/repo' })
                  return
                }
              }
              if (patch.intervalMinutes !== undefined) patch.intervalMinutes = Math.max(5, Math.floor(patch.intervalMinutes))
              if (patch.snapshotKeep !== undefined) patch.snapshotKeep = Math.max(1, Math.floor(patch.snapshotKeep))
              if (patch.maxFileMb !== undefined) patch.maxFileMb = Math.min(95, Math.max(1, Math.floor(patch.maxFileMb)))
              await writeSettings(patch)
              sendJson(res, 200, { settings: publicSettings(await readSettingsAsync()) })
              return
            }

            // POST /verify — check the repository is reachable and private
            if (method === 'POST' && route === `${API_PREFIX}/verify`) {
              const { parsed, client } = await requireClient()
              const repo = await client.getRepo(parsed.owner, parsed.repo)
              const user = await client.getUser().catch(() => null)
              const privateRepo = repo.private === true || repo.visibility === 'private'
              sendJson(res, 200, {
                ok: privateRepo,
                repo: repo.full_name,
                private: privateRepo,
                defaultBranch: repo.default_branch,
                canPush: Boolean(repo.permissions && (repo.permissions.push === true || repo.permissions.admin === true)),
                user: user ? user.login : null,
                error: privateRepo ? undefined : '该仓库不是私有仓库——会话与设置不得推送到公共仓库',
              })
              return
            }

            // POST /sync
            if (method === 'POST' && route === `${API_PREFIX}/sync`) {
              const result = await runSync({ reason: 'manual' })
              sendJson(res, 200, result)
              return
            }

            // GET /remote
            if (method === 'GET' && route === `${API_PREFIX}/remote`) {
              const { settings, parsed, client } = await requireClient()
              const inventory = await remoteInventory({ client, owner: parsed.owner, repo: parsed.repo, branch: settings.branch || 'main' })
              sendJson(res, 200, {
                repo: repoSlug(parsed),
                branch: settings.branch || 'main',
                commit: inventory.commit,
                savedAt: inventory.commitDate,
                truncated: inventory.truncated,
                instances: inventory.instances.map((instance) => ({
                  instanceId: instance.instanceId,
                  files: instance.files,
                  bytes: instance.bytes,
                  sessionCount: instance.sessions,
                  sessionBytes: instance.sessionBytes,
                  groups: instance.groups,
                  manifest: instance.manifest,
                  workspaces: instance.workspaces,
                })),
              })
              return
            }

            // GET /sessions/local
            if (method === 'GET' && route === `${API_PREFIX}/sessions/local`) {
              const inventory = await localSessionInventory(home)
              sendJson(res, 200, { ...inventory, dir: displayPath(join(home, 'sessions')) })
              return
            }

            // POST /sessions/restore
            if (method === 'POST' && route === `${API_PREFIX}/sessions/restore`) {
              const body = await readJsonBody(req)
              const { settings, parsed, client } = await requireClient()
              const instanceId = String(body.instanceId || '')
              if (!instanceId) {
                sendJson(res, 400, { error: '缺少 instanceId' })
                return
              }
              if (instanceId === (await ensureInstanceId()) && body.force !== true) {
                sendJson(res, 400, { error: '这是本机自己的备份；如确要回滚本机会话，请传 force: true' })
                return
              }
              const inventory = await remoteInventory({ client, owner: parsed.owner, repo: parsed.repo, branch: settings.branch || 'main' })
              if (!inventory.tree.size) {
                sendJson(res, 404, { error: '远端还没有任何备份' })
                return
              }

              const workspace = body.workspace ? String(body.workspace) : undefined
              const map = {}
              if (body.map && typeof body.map === 'object') {
                for (const [from, to] of Object.entries(body.map)) {
                  const cleanFrom = sanitizeWorkspaceKey(from)
                  const cleanTo = sanitizeWorkspaceKey(to)
                  if (cleanFrom && cleanTo) map[cleanFrom] = cleanTo
                }
              }

              const source = remoteSource({ client, owner: parsed.owner, repo: parsed.repo, treeMap: inventory.tree })
              const only = { instanceId, groups: ['sessions'] }
              if (workspace) only.workspace = workspace

              if (body.dryRun === true) {
                const preview = await restoreFrom({ source, home, only, dryRun: true, workspaceMap: map })
                sendJson(res, 200, preview)
                return
              }

              const watch = beginProgress('restore')
              try {
                // Safety net: snapshot what is on disk *before* touching it.
                watch.phase('拍本地快照')
                const plan = await buildPlan({ home, instanceId: await ensureInstanceId(), groups: { sessions: true, plugins: false, settings: false } })
                const safety = `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
                await createLocalSnapshot({ syncDir, name: safety, plan }).catch(() => {})

                watch.phase('读取云端')
                const result = await restoreFrom({
                  source,
                  home,
                  only,
                  overwrite: body.overwrite !== false,
                  workspaceMap: map,
                  onProgress: (update) => watch.tick({ phase: '写入本机', ...update }),
                })
                sendJson(res, 200, { ...result, safetySnapshot: safety })
              } finally {
                watch.end()
              }
              return
            }

            // GET /sessions/grouping — which session folders have no matching
            // local workspace, and which local workspace each one most likely
            // belongs to (matched by project folder name).
            if (method === 'GET' && route === `${API_PREFIX}/sessions/grouping`) {
              const inventory = await localSessionInventory(home)
              const known = inventory.workspaces.filter((w) => w.pathIsExact)
              const groups = inventory.workspaces.map((w) => {
                const title = workspaceTitle(w.path)
                const candidates = known.filter((k) => k.key !== w.key && workspaceTitle(k.path) === title)
                return {
                  key: w.key,
                  path: w.path,
                  title,
                  sessions: w.sessionCount,
                  bytes: w.bytes,
                  grouped: w.pathIsExact,
                  suggest: candidates.length === 1 ? candidates[0].key : '',
                  suggestPath: candidates.length === 1 ? candidates[0].path : '',
                }
              })
              sendJson(res, 200, { workspaces: groups, local: known.map((w) => ({ key: w.key, path: w.path, title: workspaceTitle(w.path) })) })
              return
            }

            // POST /sessions/regroup { from, to, dryRun? } — move whole session
            // folders into another workspace folder, which is what changes the
            // group dsh shows them under.
            if (method === 'POST' && route === `${API_PREFIX}/sessions/regroup`) {
              const body = await readJsonBody(req)
              const from = sanitizeWorkspaceKey(body.from)
              const to = sanitizeWorkspaceKey(body.to)
              if (!from || !to) {
                sendJson(res, 400, { error: '工作区目录名不合法' })
                return
              }
              if (from === to) {
                sendJson(res, 400, { error: '源与目标是同一个工作区' })
                return
              }
              const fromDir = join(home, 'sessions', from)
              const toDir = join(home, 'sessions', to)
              const entries = await fsP.readdir(fromDir, { withFileTypes: true }).catch(() => null)
              if (!entries) {
                sendJson(res, 404, { error: `源工作区目录不存在：${displayPath(fromDir)}` })
                return
              }
              const sessions = entries.filter((e) => e.isDirectory())
              if (body.dryRun === true) {
                sendJson(res, 200, { dryRun: true, sessions: sessions.length, from: displayPath(fromDir), to: displayPath(toDir) })
                return
              }

              await fsP.mkdir(toDir, { recursive: true })
              const moved = []
              const skipped = []
              for (const entry of sessions) {
                const source = join(fromDir, entry.name)
                const target = join(toDir, entry.name)
                const clash = await fsP.access(target).then(() => true).catch(() => false)
                if (clash) {
                  skipped.push({ session: entry.name, reason: '目标工作区已有同名会话' })
                  continue
                }
                try {
                  await fsP.rename(source, target)
                  moved.push(entry.name)
                } catch (error) {
                  skipped.push({ session: entry.name, reason: String((error && error.message) || error) })
                }
              }
              // The source folder is what dsh renders as its own group, so an
              // emptied one is removed rather than left as an empty group.
              const remaining = await fsP.readdir(fromDir).catch(() => ['?'])
              let removedSource = false
              if (remaining.length === 0) {
                await fsP.rm(fromDir, { recursive: true, force: true }).catch(() => {})
                removedSource = true
              }
              log.info(`会话归组：${displayPath(fromDir)} → ${displayPath(toDir)}，移动 ${moved.length}，跳过 ${skipped.length}`)
              sendJson(res, 200, { from: displayPath(fromDir), to: displayPath(toDir), moved: moved.length, skipped, removedSource })
              return
            }

            // GET /sessions/text?instance=&path=  |  ?local=1&workspace=&session=&file=
            if (method === 'GET' && route === `${API_PREFIX}/sessions/text`) {
              const query = url.searchParams
              let buffer = null
              let label = ''
              if (query.get('local') === '1') {
                const target = safeLocalSessionPath(home, query.get('workspace'), query.get('session'), query.get('file'))
                if (!target) {
                  sendJson(res, 400, { error: '非法路径' })
                  return
                }
                buffer = await fsP.readFile(target).catch(() => null)
                label = displayPath(target)
              } else {
                const { settings, parsed, client } = await requireClient()
                const repoPath = String(query.get('path') || '')
                if (!repoPath.startsWith('instances/')) {
                  sendJson(res, 400, { error: '非法路径' })
                  return
                }
                const inventory = await remoteInventory({ client, owner: parsed.owner, repo: parsed.repo, branch: settings.branch || 'main' })
                const meta = inventory.tree.get(repoPath)
                if (!meta) {
                  sendJson(res, 404, { error: '远端不存在该文件' })
                  return
                }
                buffer = await client.getBlob(parsed.owner, parsed.repo, meta.sha)
                label = repoPath
              }
              if (!buffer) {
                sendJson(res, 404, { error: '文件不存在' })
                return
              }
              if (buffer.length > MAX_TEXT_BYTES) {
                sendJson(res, 413, { error: `文件过大（${(buffer.length / 1048576).toFixed(1)} MB），请先恢复到本机再查看` })
                return
              }
              const text = decompressSession(buffer)
              if (text === null) {
                sendJson(res, 501, { error: '当前 Node 不支持 zstd 解压，无法在浏览器里直接阅读会话日志' })
                return
              }
              sendJson(res, 200, { label, bytes: buffer.length, text })
              return
            }

            // GET /snapshots
            if (method === 'GET' && route === `${API_PREFIX}/snapshots`) {
              const snapshots = await listLocalSnapshots(syncDir)
              sendJson(res, 200, { dir: displayPath(snapshotsRoot(syncDir)), snapshots })
              return
            }

            // POST /snapshots { name?, groups? }
            if (method === 'POST' && route === `${API_PREFIX}/snapshots`) {
              const body = await readJsonBody(req)
              const settings = await readSettingsAsync()
              let name = sanitizeSnapshotName(body.name)
              if (!name) name = `manual-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
              const existing = await fsP.access(join(snapshotsRoot(syncDir), name)).then(() => true).catch(() => false)
              if (existing) name = `${name}-${Date.now()}`
              const plan = await buildPlan({
                home,
                instanceId: await ensureInstanceId(),
                groups: body.groups || groupToggles(settings),
                profiles: listFromCsv(settings.profiles),
                maxFileMb: Number(settings.maxFileMb) || 45,
              })
              const snapshot = await createLocalSnapshot({ syncDir, name, plan })
              const pruned = await pruneLocalSnapshots(syncDir, Number(settings.snapshotKeep) || 20, [])
              sendJson(res, 200, { snapshot, pruned })
              return
            }

            // POST /snapshots/restore { name, groups? }
            if (method === 'POST' && route === `${API_PREFIX}/snapshots/restore`) {
              const body = await readJsonBody(req)
              const settings = await readSettingsAsync()
              const name = sanitizeSnapshotName(body.name)
              if (!name) {
                sendJson(res, 400, { error: '缺少快照名' })
                return
              }
              const dir = join(snapshotsRoot(syncDir), name)
              const exists = await fsP.access(dir).then(() => true).catch(() => false)
              if (!exists) {
                sendJson(res, 404, { error: `快照 ${name} 不存在` })
                return
              }
              const safetyName = `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
              const current = await buildPlan({
                home,
                instanceId: await ensureInstanceId(),
                groups: groupToggles(settings),
                profiles: listFromCsv(settings.profiles),
                maxFileMb: Number(settings.maxFileMb) || 45,
              })
              await createLocalSnapshot({ syncDir, name: safetyName, plan: current }).catch(() => {})
              const result = await restoreFrom({
                source: localSource(dir),
                home,
                only: { groups: body.groups },
                overwrite: body.overwrite !== false,
                // A local snapshot is the user's own data and restoring it is
                // an explicit action, so settings inside it are written back.
                allowSettings: body.allowSettings !== false,
              })
              sendJson(res, 200, { ...result, safetySnapshot: safetyName })
              return
            }

            // POST /snapshots/delete { name }
            if (method === 'POST' && route === `${API_PREFIX}/snapshots/delete`) {
              const body = await readJsonBody(req)
              const name = sanitizeSnapshotName(body.name)
              if (!name) {
                sendJson(res, 400, { error: '缺少快照名' })
                return
              }
              await fsP.rm(join(snapshotsRoot(syncDir), name), { recursive: true, force: true })
              sendJson(res, 200, { deleted: name })
              return
            }

            sendJson(res, 404, { error: `未知接口 ${method} ${route}` })
          } catch (error) {
            const message = explainError(error)
            log.warn(`${method} ${route} 失败：${message}`)
            sendJson(res, 400, { error: message })
          }
        },
      }),
    `${NAME}: api route`,
  )

  log.info(`已加载。状态目录 ${displayPath(syncDir)}`)
}
