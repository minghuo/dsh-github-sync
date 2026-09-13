/**
 * dsh-github-sync — Browser half.
 *
 * One surface: a `settings.section` page. Everything the page shows comes from
 * the plugin's own HTTP API (`/dsh-github-sync/api/…`), which the host half
 * registers on the loopback web server; that route carries no auth of its own,
 * so this file must never receive the access token — the host reports
 * `hasToken` and nothing else.
 *
 * Conventions this file follows, all of them forced by the client-modules
 * loader:
 *   - plain `React.createElement` (no JSX, no build step beyond inlining);
 *   - `react` and `@deepseek-ai/dsh-client-ui-primitives` come from the
 *     loader's seeded require table, with local shims so the module also loads
 *     under plain Node for contract tests;
 *   - every side effect (style tag, slot registration) is created inside
 *     `ctx.effect` so unload removes it.
 */

let __React = null
try {
  __React = require('react')
} catch {
  /* plain Node */
}
if (!__React || typeof __React.createElement !== 'function') {
  __React = {
    createElement(type, props, ...kids) {
      return { type, props: props || {}, kids }
    },
    useState(init) {
      const box = { value: typeof init === 'function' ? init() : init }
      return [box.value, (next) => { box.value = typeof next === 'function' ? next(box.value) : next }]
    },
    useEffect() {},
    useMemo(fn) { return fn() },
    useRef(v = null) { return { current: v } },
  }
}
const { createElement: h, useState, useEffect, useMemo, useRef } = __React

let P = null
try {
  P = require('@deepseek-ai/dsh-client-ui-primitives')
} catch {
  /* plain Node */
}

/** Use a primitive when the shell provides one, otherwise a plain element. */
const prim = (kind, fallback) => {
  const real = P && P[kind]
  if (real) return real
  return function Shim(props) {
    const { children, variant, size, ...rest } = props || {}
    return h(fallback || 'button', { ...rest, 'data-primitive-shim': kind }, children)
  }
}
const Button = prim('Button')

const NS = 'dsh-github-sync'
const API = '/dsh-github-sync/api'

// ── Copy ─────────────────────────────────────────────────────────────────

const ZH = {
  title: 'GitHub 同步',
  subtitle: '把本机的会话、插件清单与设置备份到一个私有 GitHub 仓库，并在多台机器之间恢复。',
  tabOverview: '概览',
  tabSessions: '会话备份',
  tabSnapshots: '本地快照',
  tabAdvanced: '高级',
  repoLabel: 'GitHub 仓库',
  repoPlaceholder: 'owner/repo 或 https://github.com/owner/repo',
  repoHint: '必须是私有仓库；会话日志含本机绝对路径。',
  branchLabel: '分支',
  tokenLabel: '访问令牌',
  tokenPlaceholder: 'Fine-grained PAT，需 Contents 读写权限',
  tokenStored: '已保存（不会回显）',
  tokenMissing: '未配置',
  clearToken: '清除令牌',
  save: '保存',
  saving: '保存中…',
  saved: '已保存',
  verify: '验证仓库',
  verifying: '验证中…',
  verifyOk: '仓库可用（私有，可推送）',
  verifyPrivateMissing: '该仓库不是私有的，请改为私有仓库',
  syncNow: '立即备份',
  syncing: '备份中…',
  syncDone: '备份完成',
  contentTitle: '备份内容',
  contentHint: '每一类可以单独开关；关闭的那一类不会上传，也不会删除云端已有内容。',
  toggleSessions: '会话 sessions',
  toggleSessionsHint: '每个工作区的会话日志整目录备份，含所有历史版本代',
  togglePlugins: '插件清单',
  togglePluginsHint: '各 profile 的 package.json / cordis.patch.yml / 锁文件，不含 node_modules',
  toggleSettings: '设置 settings.yaml',
  toggleSettingsHint: '含模型与代理配置，默认关闭；仅私有仓库可用',
  autoTitle: '自动备份',
  autoLabel: '定时自动备份',
  autoStartup: '启动时备份一次',
  intervalLabel: '间隔（分钟）',
  statusTitle: '状态',
  instanceLabel: '本机实例 ID',
  lastSyncLabel: '上次备份',
  never: '还没备份过',
  localTitle: '本机数据',
  localWorkspaces: '工作区',
  localSessions: '会话',
  localBytes: '体积',
  snapshotsLabel: '本地快照',
  resultTitle: '上次结果',
  resultNothing: '没有变化，无需提交',
  resultCreated: '新增',
  resultUpdated: '更新',
  resultDeleted: '删除',
  resultUnchanged: '未变化',
  resultPr: '拉取请求',
  sessionsTitle: '本机会话',
  sessionsHint: '按工作区分组；点会话名可以直接阅读日志内容。',
  remoteTitle: '云端备份',
  remoteEmpty: '还没有任何机器备份过。先点「立即备份」。',
  remoteLoad: '刷新云端列表',
  remoteLoading: '读取中…',
  refresh: '刷新',
  sessionsCount: '个会话',
  restore: '恢复到本机',
  restoreAll: '恢复本机全部会话',
  restoreTitle: '恢复会话',
  restoreHint: '会把云端的会话文件写入本机 sessions 目录；恢复前会自动做一份本地快照。',
  restoreOverwrite: '覆盖本机同名文件',
  restoreTarget: '目标工作区',
  restoreKeepKey: '保持原目录名',
  preview: '预览',
  previewing: '预览中…',
  confirmRestore: '确认恢复',
  cancel: '取消',
  restoreDone: '恢复完成',
  restorePreview: '将写入 {n} 个文件',
  snapshotTitle: '本地快照',
  snapshotHint: '快照只存在本机，用于快速回滚；云端备份是另一条独立链路。',
  snapshotNow: '立即快照',
  snapshotName: '快照名（可留空）',
  snapshotEmpty: '还没有快照',
  snapshotRestore: '恢复',
  snapshotDelete: '删除',
  snapshotRestoreDone: '已恢复（当前状态已先拍快照）',
  advancedTitle: '高级',
  pullRequestLabel: '走分支 → PR → 自动合并',
  pullRequestHint: '默认直接提交到分支；打开后每次备份先开 PR，可合并时自动 squash 合并，冲突则留在 PR 里。',
  snapshotBeforePush: '推送前先拍本地快照',
  snapshotKeepLabel: '本地快照保留份数',
  maxFileLabel: '单文件上限（MB）',
  excludeWorkspacesLabel: '排除的工作区目录名（逗号分隔）',
  profilesLabel: '要备份的 profile（逗号分隔，留空=自动）',
  viewerTitle: '会话内容',
  viewerHint: '只展示日志原文；文件较大时请先恢复到本机查看。',
  close: '关闭',
  loading: '加载中…',
  notConfigured: '先填写仓库与令牌，再点保存。',
  operationFailed: '操作失败',
}

const EN = {
  title: 'GitHub sync',
  subtitle: 'Back up this machine\'s sessions, plugin manifests and settings to a private GitHub repository, and restore them on another machine.',
  tabOverview: 'Overview',
  tabSessions: 'Sessions',
  tabSnapshots: 'Snapshots',
  tabAdvanced: 'Advanced',
  repoLabel: 'GitHub repository',
  repoPlaceholder: 'owner/repo or https://github.com/owner/repo',
  repoHint: 'Must be private — session logs contain local absolute paths.',
  branchLabel: 'Branch',
  tokenLabel: 'Access token',
  tokenPlaceholder: 'Fine-grained PAT with Contents read/write',
  tokenStored: 'stored (never echoed)',
  tokenMissing: 'not configured',
  clearToken: 'Clear token',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  verify: 'Verify repository',
  verifying: 'Verifying…',
  verifyOk: 'Repository is usable (private, writable)',
  verifyPrivateMissing: 'This repository is not private',
  syncNow: 'Back up now',
  syncing: 'Backing up…',
  syncDone: 'Backup complete',
  contentTitle: 'What to back up',
  contentHint: 'Each group has its own switch; a disabled group is never uploaded and never deleted remotely.',
  toggleSessions: 'Sessions',
  toggleSessionsHint: 'Whole session directories, including every older log generation',
  togglePlugins: 'Plugin manifests',
  togglePluginsHint: 'package.json / cordis.patch.yml / lock files per profile; never node_modules',
  toggleSettings: 'settings.yaml',
  toggleSettingsHint: 'Holds model and proxy configuration — off by default, private repos only',
  autoTitle: 'Automatic backup',
  autoLabel: 'Scheduled backup',
  autoStartup: 'Back up once on startup',
  intervalLabel: 'Interval (minutes)',
  statusTitle: 'Status',
  instanceLabel: 'Machine instance id',
  lastSyncLabel: 'Last backup',
  never: 'never',
  localTitle: 'Local data',
  localWorkspaces: 'workspaces',
  localSessions: 'sessions',
  localBytes: 'size',
  snapshotsLabel: 'local snapshots',
  resultTitle: 'Last result',
  resultNothing: 'Nothing changed',
  resultCreated: 'created',
  resultUpdated: 'updated',
  resultDeleted: 'deleted',
  resultUnchanged: 'unchanged',
  resultPr: 'pull request',
  sessionsTitle: 'Local sessions',
  sessionsHint: 'Grouped by workspace; click a session to read its log.',
  remoteTitle: 'Cloud backups',
  remoteEmpty: 'No machine has backed up yet — hit “Back up now”.',
  remoteLoad: 'Refresh cloud list',
  remoteLoading: 'Loading…',
  refresh: 'Refresh',
  sessionsCount: 'sessions',
  restore: 'Restore to this machine',
  restoreAll: 'Restore all sessions',
  restoreTitle: 'Restore sessions',
  restoreHint: 'Writes the remote session files into this machine\'s sessions directory. A local snapshot is taken first.',
  restoreOverwrite: 'Overwrite local files',
  restoreTarget: 'Target workspace',
  restoreKeepKey: 'Keep original folder name',
  preview: 'Preview',
  previewing: 'Previewing…',
  confirmRestore: 'Restore now',
  cancel: 'Cancel',
  restoreDone: 'Restore complete',
  restorePreview: '{n} files will be written',
  snapshotTitle: 'Local snapshots',
  snapshotHint: 'Snapshots live only on this machine, for fast rollback; the cloud backup is a separate path.',
  snapshotNow: 'Snapshot now',
  snapshotName: 'Snapshot name (optional)',
  snapshotEmpty: 'No snapshots yet',
  snapshotRestore: 'Restore',
  snapshotDelete: 'Delete',
  snapshotRestoreDone: 'Restored (current state snapshotted first)',
  advancedTitle: 'Advanced',
  pullRequestLabel: 'Branch → PR → auto-merge',
  pullRequestHint: 'Off: commit straight to the branch. On: open a PR, squash-merge when possible, leave it open on conflict.',
  snapshotBeforePush: 'Snapshot locally before each push',
  snapshotKeepLabel: 'Local snapshots to keep',
  maxFileLabel: 'Max file size (MB)',
  excludeWorkspacesLabel: 'Workspace folders to skip (comma separated)',
  profilesLabel: 'Profiles to back up (comma separated, empty = auto)',
  viewerTitle: 'Session content',
  viewerHint: 'Raw log text; large files should be restored locally first.',
  close: 'Close',
  loading: 'Loading…',
  notConfigured: 'Fill in the repository and token, then save.',
  operationFailed: 'Operation failed',
}

// ── Helpers ──────────────────────────────────────────────────────────────

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById('dgs-styles')) return
  const holder = document.createElement('div')
  holder.id = 'dgs-styles'
  holder.style.display = 'none'
  holder.innerHTML = STYLE
  document.head.appendChild(holder)
}

function formatBytes(n) {
  const value = Number(n) || 0
  if (value < 1024) return `${value} B`
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1073741824) return `${(value / 1048576).toFixed(1)} MB`
  return `${(value / 1073741824).toFixed(2)} GB`
}

function formatTime(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function api(path, options) {
  const res = await fetch(API + path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new Error((json && json.error) || `HTTP ${res.status}`)
  return json
}

const get = (path) => api(path)
const put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body || {}) })
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) })

// ── Small presentational pieces ──────────────────────────────────────────

function Field({ label, hint, children }) {
  return h(
    'label',
    { className: 'dgs-field' },
    h('span', { className: 'dgs-field-label' }, label),
    children,
    hint ? h('span', { className: 'dgs-hint' }, hint) : null,
  )
}

function Toggle({ label, hint, checked, onChange, disabled }) {
  return h(
    'div',
    { className: 'dgs-toggle' },
    h('div', { className: 'dgs-toggle-text' },
      h('div', { className: 'dgs-toggle-label' }, label),
      hint ? h('div', { className: 'dgs-hint' }, hint) : null),
    h('input', {
      type: 'checkbox',
      className: 'dgs-switch',
      checked: !!checked,
      disabled: !!disabled,
      onChange: (event) => onChange(event.target.checked),
    }),
  )
}

function Card({ title, hint, children, actions }) {
  return h(
    'section',
    { className: 'dgs-card' },
    h('header', { className: 'dgs-card-head' },
      h('div', null,
        h('h3', { className: 'dgs-card-title' }, title),
        hint ? h('p', { className: 'dgs-hint' }, hint) : null),
      actions ? h('div', { className: 'dgs-row' }, actions) : null),
    h('div', { className: 'dgs-card-body' }, children),
  )
}

function Stat({ label, value }) {
  return h('div', { className: 'dgs-stat' },
    h('div', { className: 'dgs-stat-value' }, value),
    h('div', { className: 'dgs-stat-label' }, label))
}

// ── The settings page ────────────────────────────────────────────────────

function SettingsSection({ t }) {
  const [status, setStatus] = useState(null)
  const [draft, setDraft] = useState({})
  const [tokenInput, setTokenInput] = useState('')
  const [tab, setTab] = useState('overview')
  const [remote, setRemote] = useState(null)
  const [localSessions, setLocalSessions] = useState(null)
  const [snapshots, setSnapshots] = useState([])
  const [snapshotName, setSnapshotName] = useState('')
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')
  const [restore, setRestore] = useState(null)
  const [preview, setPreview] = useState(null)
  const [viewer, setViewer] = useState(null)
  const [expanded, setExpanded] = useState({})
  const [verifyResult, setVerifyResult] = useState(null)
  const toastTimer = useRef(null)

  const notify = (message) => {
    setToast(message)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 4000)
  }

  const run = async (label, fn) => {
    setBusy(label)
    setError('')
    try {
      return await fn()
    } catch (err) {
      const message = String((err && err.message) || err)
      setError(message)
      notify(`${t('operationFailed')}：${message}`)
      return null
    } finally {
      setBusy('')
    }
  }

  const loadStatus = async () => {
    const next = await get('/status')
    setStatus(next)
    setDraft((current) => ({ ...next.settings, ...current }))
    return next
  }

  useEffect(() => {
    ensureStyles()
    run('load', loadStatus)
  }, [])

  const patch = (key, value) => setDraft((current) => ({ ...current, [key]: value }))

  const save = () => run('save', async () => {
    const body = { ...draft }
    if (tokenInput !== '') body.token = tokenInput
    const saved = await put('/settings', body)
    setTokenInput('')
    setDraft((current) => ({ ...saved.settings, ...current }))
    await loadStatus()
    notify(t('saved'))
  })

  const verify = () => run('verify', async () => {
    const result = await post('/verify', {})
    setVerifyResult(result)
    notify(result.ok ? t('verifyOk') : result.error || t('verifyPrivateMissing'))
  })

  const syncNow = () => run('sync', async () => {
    const result = await post('/sync', {})
    await loadStatus()
    notify(result.nothingToCommit ? t('resultNothing') : `${t('syncDone')}：+${result.created} ~${result.updated} -${result.deleted}`)
  })

  const loadRemote = () => run('remote', async () => {
    const result = await get('/remote')
    setRemote(result)
  })

  const loadLocalSessions = () => run('sessions', async () => {
    const result = await get('/sessions/local')
    setLocalSessions(result)
  })

  const loadSnapshots = () => run('snapshots', async () => {
    const result = await get('/snapshots')
    setSnapshots(result.snapshots || [])
  })

  useEffect(() => {
    if (tab === 'sessions') {
      if (!localSessions) loadLocalSessions()
      if (!remote) loadRemote()
    }
    if (tab === 'snapshots' && snapshots.length === 0) loadSnapshots()
  }, [tab])

  const makeSnapshot = () => run('snapshot', async () => {
    const result = await post('/snapshots', { name: snapshotName })
    setSnapshotName('')
    await loadSnapshots()
    await loadStatus()
    notify(`${t('snapshotNow')}：${result.snapshot.name}`)
  })

  const restoreSnapshot = (name) => run('snapshot-restore', async () => {
    await post('/snapshots/restore', { name })
    await loadSnapshots()
    notify(t('snapshotRestoreDone'))
  })

  const deleteSnapshot = (name) => run('snapshot-delete', async () => {
    await post('/snapshots/delete', { name })
    await loadSnapshots()
    await loadStatus()
  })

  const openRestore = (instanceId, workspace) => {
    setPreview(null)
    setRestore({ instanceId, workspace: workspace || '', map: '', overwrite: true })
  }

  const doPreview = () => run('preview', async () => {
    const result = await post('/sessions/restore', {
      instanceId: restore.instanceId,
      workspace: restore.workspace || undefined,
      map: restore.map ? { [restore.workspace || '']: restore.map } : undefined,
      dryRun: true,
    })
    setPreview(result)
  })

  const doRestore = () => run('restore', async () => {
    const result = await post('/sessions/restore', {
      instanceId: restore.instanceId,
      workspace: restore.workspace || undefined,
      map: restore.map && restore.workspace ? { [restore.workspace]: restore.map } : undefined,
      overwrite: restore.overwrite,
    })
    setRestore(null)
    setPreview(null)
    await loadLocalSessions()
    await loadStatus()
    notify(`${t('restoreDone')}：${result.written.length}`)
  })

  const openViewer = (query) => run('viewer', async () => {
    const text = await get(`/sessions/text?${query}`)
    setViewer(text)
  })

  const settings = status ? { ...status.settings, ...draft } : draft
  const configured = status ? status.configured : false
  const localWorkspaces = (localSessions && localSessions.workspaces) || []

  return h('div', { className: 'dgs-root' },
    h('header', { className: 'dgs-head' },
      h('div', null,
        h('h2', { className: 'dgs-title' }, t('title')),
        h('p', { className: 'dgs-hint' }, t('subtitle'))),
      h('div', { className: 'dgs-row' },
        h(Button, { variant: 'outline', size: 'sm', onClick: verify, disabled: !configured || busy !== '' }, busy === 'verify' ? t('verifying') : t('verify')),
        h(Button, { variant: 'primary', size: 'sm', onClick: syncNow, disabled: !configured || busy !== '' }, busy === 'sync' ? t('syncing') : t('syncNow')))),

    h('nav', { className: 'dgs-tabs' },
      ['overview', 'sessions', 'snapshots', 'advanced'].map((key) =>
        h('button', {
          key,
          type: 'button',
          className: `dgs-tab${tab === key ? ' is-active' : ''}`,
          onClick: () => setTab(key),
        }, t(`tab${key.charAt(0).toUpperCase()}${key.slice(1)}`)))),

    tab === 'overview' && h('div', { className: 'dgs-panes' },
      h(Card, { title: t('statusTitle') },
        !status
          ? h('p', { className: 'dgs-hint' }, t('loading'))
          : h('div', { className: 'dgs-stats' },
            h(Stat, { label: t('instanceLabel'), value: status.instanceId || '—' }),
            h(Stat, { label: t('lastSyncLabel'), value: status.lastSyncAt ? formatTime(status.lastSyncAt) : t('never') }),
            h(Stat, { label: t('localWorkspaces'), value: `${status.local.sessions.workspaces}` }),
            h(Stat, { label: t('localSessions'), value: `${status.local.sessions.sessionCount}` }),
            h(Stat, { label: t('localBytes'), value: formatBytes(status.local.sessions.bytes) }),
            h(Stat, { label: t('snapshotsLabel'), value: `${status.snapshots.count}` })),
        status && status.lastResult
          ? h('div', { className: 'dgs-result' },
            h('div', { className: 'dgs-result-head' }, `${t('resultTitle')} · ${formatTime(status.lastResult.at)} · ${status.lastResult.repo}#${status.lastResult.branch}`),
            h('div', { className: 'dgs-row dgs-wrap' },
              h('span', { className: 'dgs-pill' }, `${t('resultCreated')} ${status.lastResult.created}`),
              h('span', { className: 'dgs-pill' }, `${t('resultUpdated')} ${status.lastResult.updated}`),
              h('span', { className: 'dgs-pill' }, `${t('resultDeleted')} ${status.lastResult.deleted}`),
              h('span', { className: 'dgs-pill' }, `${t('resultUnchanged')} ${status.lastResult.unchanged}`),
              status.lastResult.pr ? h('span', { className: 'dgs-pill dgs-pill-brand' }, `${t('resultPr')} #${status.lastResult.pr.number} · ${status.lastResult.pr.state}`) : null))
          : null),

      h(Card, { title: t('repoLabel'), hint: t('repoHint') },
        h(Field, { label: t('repoLabel') },
          h('input', {
            className: 'dgs-input',
            value: settings.repoUrl || '',
            placeholder: t('repoPlaceholder'),
            onChange: (event) => patch('repoUrl', event.target.value),
          })),
        h('div', { className: 'dgs-grid2' },
          h(Field, { label: t('branchLabel') },
            h('input', { className: 'dgs-input', value: settings.branch || 'main', onChange: (event) => patch('branch', event.target.value) })),
          h(Field, { label: t('tokenLabel'), hint: settings.hasToken ? t('tokenStored') : t('tokenMissing') },
            h('input', {
              className: 'dgs-input',
              type: 'password',
              value: tokenInput,
              placeholder: t('tokenPlaceholder'),
              onChange: (event) => setTokenInput(event.target.value),
            }))),
        h('div', { className: 'dgs-row' },
          h(Button, { variant: 'primary', size: 'sm', onClick: save, disabled: busy !== '' }, busy === 'save' ? t('saving') : t('save')),
          settings.hasToken
            ? h(Button, { variant: 'outline', size: 'sm', onClick: () => run('clear', async () => {
              setTokenInput('')
              await put('/settings', { token: '' })
              await loadStatus()
              notify(t('clearToken'))
            }) }, t('clearToken'))
            : null),
        verifyResult
          ? h('p', { className: verifyResult.ok ? 'dgs-ok' : 'dgs-warn' },
            verifyResult.ok
              ? `${t('verifyOk')} · ${verifyResult.repo} · ${verifyResult.defaultBranch}${verifyResult.user ? ` · ${verifyResult.user}` : ''}`
              : (verifyResult.error || t('verifyPrivateMissing')))
          : null),

      h(Card, { title: t('contentTitle'), hint: t('contentHint') },
        h(Toggle, { label: t('toggleSessions'), hint: t('toggleSessionsHint'), checked: settings.syncSessions !== false, onChange: (v) => patch('syncSessions', v) }),
        h(Toggle, { label: t('togglePlugins'), hint: t('togglePluginsHint'), checked: settings.syncPlugins !== false, onChange: (v) => patch('syncPlugins', v) }),
        h(Toggle, { label: t('toggleSettings'), hint: t('toggleSettingsHint'), checked: settings.syncSettings === true, onChange: (v) => patch('syncSettings', v) })),

      h(Card, { title: t('autoTitle') },
        h(Toggle, { label: t('autoLabel'), checked: settings.autoSync === true, onChange: (v) => patch('autoSync', v) }),
        h(Toggle, { label: t('autoStartup'), checked: settings.syncOnStartup === true, onChange: (v) => patch('syncOnStartup', v) }),
        h(Field, { label: t('intervalLabel') },
          h('input', {
            className: 'dgs-input dgs-input-sm',
            type: 'number',
            min: 5,
            value: settings.intervalMinutes || 60,
            onChange: (event) => patch('intervalMinutes', Number(event.target.value)),
          })))),

    tab === 'sessions' && h('div', { className: 'dgs-panes' },
      h(Card, {
        title: t('sessionsTitle'),
        hint: t('sessionsHint'),
        actions: [h(Button, { key: 'r', variant: 'outline', size: 'sm', onClick: loadLocalSessions, disabled: busy !== '' }, t('refresh'))],
      },
        !localSessions
          ? h('p', { className: 'dgs-hint' }, t('loading'))
          : localWorkspaces.length === 0
            ? h('p', { className: 'dgs-hint' }, t('snapshotEmpty'))
            : localWorkspaces.map((workspace) =>
              h('div', { key: workspace.key, className: 'dgs-list-item' },
                h('button', {
                  type: 'button',
                  className: 'dgs-disclosure',
                  onClick: () => setExpanded((current) => ({ ...current, [workspace.key]: !current[workspace.key] })),
                },
                h('span', { className: 'dgs-strong' }, workspace.path || workspace.key),
                h('span', { className: 'dgs-hint' }, `${workspace.sessionCount} ${t('sessionsCount')} · ${formatBytes(workspace.bytes)}`)),
                expanded[workspace.key]
                  ? h('div', { className: 'dgs-sublist' }, workspace.sessions.map((session) =>
                    h('div', { key: session.id, className: 'dgs-row dgs-between' },
                      h('button', {
                        type: 'button',
                        className: 'dgs-link',
                        onClick: () => openViewer(`local=1&workspace=${encodeURIComponent(workspace.key)}&session=${encodeURIComponent(session.id)}&file=${encodeURIComponent(session.file || 'session.jsonl.zstd')}`),
                      }, session.id),
                      h('span', { className: 'dgs-hint' }, `${session.files} · ${formatBytes(session.bytes)} · ${formatTime(session.modifiedAt)}`))))
                  : null))),

      h(Card, {
        title: t('remoteTitle'),
        hint: remote && remote.savedAt ? `${remote.repo} · ${remote.branch} · ${formatTime(remote.savedAt)}` : remote ? `${remote.repo} · ${remote.branch}` : null,
        actions: [
          h(Button, { key: 'l', variant: 'outline', size: 'sm', onClick: loadRemote, disabled: !configured || busy !== '' }, busy === 'remote' ? t('remoteLoading') : t('remoteLoad')),
        ],
      },
        !configured
          ? h('p', { className: 'dgs-hint' }, t('notConfigured'))
          : !remote
            ? h('p', { className: 'dgs-hint' }, t('loading'))
            : remote.instances.length === 0
              ? h('p', { className: 'dgs-hint' }, t('remoteEmpty'))
              : remote.instances.map((instance) =>
                h('div', { key: instance.instanceId, className: 'dgs-list-item' },
                  h('div', { className: 'dgs-row dgs-between' },
                    h('span', { className: 'dgs-strong' }, instance.instanceId),
                    h('span', { className: 'dgs-hint' },
                      `${instance.sessionCount} ${t('sessionsCount')} · ${formatBytes(instance.sessionBytes)} · ${formatBytes(instance.bytes)}`)),
                  instance.workspaces.map((workspace) =>
                    h('div', { key: workspace.key, className: 'dgs-row dgs-between dgs-subrow' },
                      h('span', { title: workspace.key }, decodeWorkspace(workspace.key)),
                      h('span', { className: 'dgs-row' },
                        h('span', { className: 'dgs-hint' }, `${workspace.sessions} · ${formatBytes(workspace.bytes)}`),
                        h(Button, {
                          variant: 'outline',
                          size: 'sm',
                          disabled: busy !== '',
                          onClick: () => openRestore(instance.instanceId, workspace.key),
                        }, t('restore'))))),
                  h('div', { className: 'dgs-row' },
                    h(Button, {
                      variant: 'outline',
                      size: 'sm',
                      disabled: busy !== '',
                      onClick: () => openRestore(instance.instanceId, ''),
                    }, t('restoreAll')))))),

      restore
        ? h(Card, { title: t('restoreTitle'), hint: t('restoreHint') },
          h('div', { className: 'dgs-row dgs-wrap' },
            h('span', { className: 'dgs-pill' }, restore.instanceId),
            restore.workspace ? h('span', { className: 'dgs-pill' }, decodeWorkspace(restore.workspace)) : null),
          h(Toggle, {
            label: t('restoreOverwrite'),
            checked: restore.overwrite,
            onChange: (v) => setRestore({ ...restore, overwrite: v }),
          }),
          restore.workspace
            ? h(Field, { label: t('restoreTarget') },
              h('select', {
                className: 'dgs-input',
                value: restore.map,
                onChange: (event) => setRestore({ ...restore, map: event.target.value }),
              },
              h('option', { value: '' }, t('restoreKeepKey')),
              localWorkspaces.map((workspace) =>
                h('option', { key: workspace.key, value: workspace.key }, workspace.path || workspace.key))))
            : null,
          preview ? h('p', { className: 'dgs-hint' }, t('restorePreview', { n: preview.files.length })) : null,
          h('div', { className: 'dgs-row' },
            h(Button, { variant: 'outline', size: 'sm', onClick: doPreview, disabled: busy !== '' }, busy === 'preview' ? t('previewing') : t('preview')),
            h(Button, { variant: 'primary', size: 'sm', onClick: doRestore, disabled: busy !== '' }, t('confirmRestore')),
            h(Button, { variant: 'outline', size: 'sm', onClick: () => { setRestore(null); setPreview(null) } }, t('cancel'))))
        : null),

    tab === 'snapshots' && h('div', { className: 'dgs-panes' },
      h(Card, { title: t('snapshotNow'), hint: t('snapshotHint') },
        h('div', { className: 'dgs-row' },
          h('input', {
            className: 'dgs-input',
            value: snapshotName,
            placeholder: t('snapshotName'),
            onChange: (event) => setSnapshotName(event.target.value),
          }),
          h(Button, { variant: 'primary', size: 'sm', onClick: makeSnapshot, disabled: busy !== '' }, t('snapshotNow')))),
      h(Card, { title: t('snapshotTitle') },
        snapshots.length === 0
          ? h('p', { className: 'dgs-hint' }, t('snapshotEmpty'))
          : snapshots.map((snapshot) =>
            h('div', { key: snapshot.name, className: 'dgs-row dgs-between dgs-list-item' },
              h('span', null,
                h('span', { className: 'dgs-strong' }, snapshot.name),
                h('span', { className: 'dgs-hint' }, ` · ${snapshot.files} · ${formatBytes(snapshot.bytes)} · ${formatTime(snapshot.modifiedAt)}`)),
              h('span', { className: 'dgs-row' },
                h(Button, { variant: 'outline', size: 'sm', disabled: busy !== '', onClick: () => restoreSnapshot(snapshot.name) }, t('snapshotRestore')),
                h(Button, { variant: 'outline', size: 'sm', disabled: busy !== '', onClick: () => deleteSnapshot(snapshot.name) }, t('snapshotDelete'))))))),

    tab === 'advanced' && h('div', { className: 'dgs-panes' },
      h(Card, { title: t('advancedTitle') },
        h(Toggle, { label: t('pullRequestLabel'), hint: t('pullRequestHint'), checked: settings.pullRequest === true, onChange: (v) => patch('pullRequest', v) }),
        h(Toggle, { label: t('snapshotBeforePush'), checked: settings.snapshotBeforePush !== false, onChange: (v) => patch('snapshotBeforePush', v) }),
        h('div', { className: 'dgs-grid2' },
          h(Field, { label: t('snapshotKeepLabel') },
            h('input', { className: 'dgs-input', type: 'number', min: 1, value: settings.snapshotKeep || 20, onChange: (e) => patch('snapshotKeep', Number(e.target.value)) })),
          h(Field, { label: t('maxFileLabel') },
            h('input', { className: 'dgs-input', type: 'number', min: 1, max: 95, value: settings.maxFileMb || 45, onChange: (e) => patch('maxFileMb', Number(e.target.value)) }))),
        h(Field, { label: t('excludeWorkspacesLabel') },
          h('input', { className: 'dgs-input', value: settings.excludeWorkspaces || '', onChange: (e) => patch('excludeWorkspaces', e.target.value) })),
        h(Field, { label: t('profilesLabel') },
          h('input', { className: 'dgs-input', value: settings.profiles || '', onChange: (e) => patch('profiles', e.target.value) })),
        h('div', { className: 'dgs-row' },
          h(Button, { variant: 'primary', size: 'sm', onClick: save, disabled: busy !== '' }, t('save'))))),

    viewer
      ? h('div', { className: 'dgs-overlay', onClick: () => setViewer(null) },
        h('div', { className: 'dgs-modal', onClick: (event) => event.stopPropagation() },
          h('header', { className: 'dgs-card-head' },
            h('div', null,
              h('h3', { className: 'dgs-card-title' }, t('viewerTitle')),
              h('p', { className: 'dgs-hint' }, viewer.label)),
            h(Button, { variant: 'outline', size: 'sm', onClick: () => setViewer(null) }, t('close'))),
          h('pre', { className: 'dgs-pre' }, viewer.text.slice(0, 200000))))
      : null,

    error ? h('p', { className: 'dgs-error' }, error) : null,
    toast ? h('div', { className: 'dgs-toast' }, toast) : null,
  )
}

/** Best-effort readable form of a workspace folder key (display only). */
function decodeWorkspace(key) {
  let s = String(key || '')
  if (s.startsWith('--') && s.endsWith('--')) s = s.slice(2, -2)
  s = s.replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  s = s.replace(/-/g, '\\')
  if (/^[A-Za-z]\\/.test(s)) s = `${s[0]}:${s.slice(1)}`
  return s
}

const STYLE = `
.dgs-root { display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); font-size: var(--dsw-font-sm-14, 14px); }
.dgs-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.dgs-title { margin: 0; font-size: 16px; font-weight: 600; }
.dgs-hint { margin: 2px 0 0; color: var(--dsw-alias-label-tertiary); font-size: var(--dsw-font-xs-13, 12px); line-height: 1.5; }
.dgs-row { display: flex; align-items: center; gap: 8px; }
.dgs-wrap { flex-wrap: wrap; }
.dgs-between { justify-content: space-between; width: 100%; }
.dgs-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dgs-tab { appearance: none; background: none; border: 0; border-bottom: 2px solid transparent; padding: 8px 10px; cursor: pointer; color: var(--dsw-alias-label-secondary); font: inherit; }
.dgs-tab.is-active { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary)); }
.dgs-panes { display: flex; flex-direction: column; gap: 14px; }
.dgs-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.dgs-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.dgs-card-title { margin: 0; font-size: 14px; font-weight: 600; }
.dgs-card-body { display: flex; flex-direction: column; gap: 10px; }
.dgs-field { display: flex; flex-direction: column; gap: 4px; }
.dgs-field-label { color: var(--dsw-alias-label-secondary); font-size: var(--dsw-font-xs-13, 12px); }
.dgs-input { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; }
.dgs-input-sm { max-width: 140px; }
.dgs-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.dgs-toggle { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 6px 0; }
.dgs-toggle-text { display: flex; flex-direction: column; }
.dgs-toggle-label { font-weight: 500; }
.dgs-switch { width: 16px; height: 16px; margin-top: 3px; accent-color: var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary)); }
.dgs-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
.dgs-stat { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 8px 10px; }
.dgs-stat-value { font-weight: 600; word-break: break-all; }
.dgs-stat-label { color: var(--dsw-alias-label-tertiary); font-size: var(--dsw-font-xs-13, 12px); }
.dgs-result { border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.dgs-result-head { color: var(--dsw-alias-label-secondary); font-size: var(--dsw-font-xs-13, 12px); }
.dgs-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary); font-size: var(--dsw-font-xs-13, 12px); }
.dgs-pill-brand { background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary-inverted, #fff); }
.dgs-list-item { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 8px 10px; background: var(--dsw-alias-bg-layer-1); }
.dgs-subrow { padding-left: 10px; }
.dgs-sublist { display: flex; flex-direction: column; gap: 4px; padding-top: 4px; border-top: 1px dashed var(--dsw-alias-border-l2); }
.dgs-disclosure { appearance: none; background: none; border: 0; padding: 0; cursor: pointer; color: inherit; font: inherit; text-align: left; display: flex; flex-direction: column; gap: 2px; }
.dgs-link { appearance: none; background: none; border: 0; padding: 0; cursor: pointer; color: var(--dsw-alias-state-business-primary); font: inherit; text-align: left; }
.dgs-strong { font-weight: 600; word-break: break-all; }
.dgs-ok { color: var(--dsw-alias-state-business-primary); font-size: var(--dsw-font-xs-13, 12px); }
.dgs-warn, .dgs-error { color: var(--dsw-alias-state-error-primary); font-size: var(--dsw-font-xs-13, 12px); }
.dgs-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 60; }
.dgs-modal { width: min(880px, 92vw); max-height: 82vh; overflow: auto; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 10px; box-shadow: var(--dsw-shadow-lv3); }
.dgs-pre { margin: 0; padding: 10px; background: var(--dsw-alias-bg-layer-1); border-radius: 8px; max-height: 60vh; overflow: auto; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
.dgs-toast { position: sticky; bottom: 0; align-self: flex-start; padding: 8px 12px; border-radius: 8px; background: var(--dsw-alias-bg-layer-3); box-shadow: var(--dsw-shadow-lv2); }
`

function SettingsSectionSlot({ __t }) {
  useEffect(ensureStyles, [])
  return h(SettingsSection, { t: __t })
}

// ── Plugin plane contract ────────────────────────────────────────────────

const CLIENT_NAME = 'dsh-github-sync'

const plugin = {
  name: CLIENT_NAME,
  inject: ['slots', 'locale'],
  __internals: { NS, ZH, EN, formatBytes, formatTime, decodeWorkspace },
  apply(ctx) {
    let t = (key, vars) => {
      let out = EN[key] || key
      if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v))
      return out
    }
    try {
      if (ctx.locale && typeof ctx.locale.register === 'function') {
        ctx.locale.register(NS, 'zh', ZH)
        ctx.locale.register(NS, 'en', EN)
        const bound = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : null
        if (bound) {
          t = (key, vars) => {
            let out = bound(key) || EN[key] || key
            if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v))
            return out
          }
        }
      }
    } catch (error) {
      try {
        console.error('[dsh-github-sync] locale init:', error)
      } catch {
        /* ignore */
      }
    }

    ctx.effect(
      () =>
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: CLIENT_NAME,
              order: 95,
              locale: NS,
              // `label` is read on every render, so the nav entry follows the
              // shell's language without re-registering.
              label: () => t('title'),
              inject: () => ({}),
            },
            function DshGithubSyncSettingsSlot() {
              return h(SettingsSectionSlot, { __t: t })
            },
          ),
        ),
      `${CLIENT_NAME}: settings section`,
    )
  },
}

module.exports = plugin
