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
const CLIENT_NAME = 'dsh-github-sync'
const API = '/dsh-github-sync/api'
/** Lowest host-half API this bundle can drive. */
const REQUIRED_API = 2
/** Identity of the injected stylesheet, in the shell's `data-plugin-css` form. */
const STYLE_TAG_ID = `${CLIENT_NAME}/client.css`

// ── Copy ─────────────────────────────────────────────────────────────────

const ZH = {
  title: 'GitHub 同步',
  subtitle: '把本机的会话、插件清单与设置备份到一个私有 GitHub 仓库，并在多台机器之间恢复。',
  tabOverview: '概览',
  tabSessions: '会话备份',
  tabSnapshots: '本地快照',
  tabAdvanced: '高级',
  repoCardTitle: '仓库',
  repoUrlLabel: '仓库地址',
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
  restoreWritten: '已写入',
  restoreSkipped: '跳过',
  restoreUnchanged: '未变',
  restoreNothingToDo: '本地内容与云端完全一致，没有需要写入的文件',
  restoreAllSkipped: '本地已有同名文件且未允许覆盖 —— 打开「覆盖本机同名文件」再试',
  restoreForce: '仍然恢复（本机自己的备份）',
  restoreTargetHint: '同一项目在两台机器上路径不同时，选本机对应的工作区，恢复的会话就会归到那个分组；留空则保持原来的目录名（可能显示为「未分组」）。',
  ungroupedTag: '未分组',
  regroupHint: '移动到',
  regroupPick: '选择本机工作区…',
  regroupAction: '归入该分组',
  regroupDone: '已移动会话',
  compare: '与云端比较',
  compareTitle: '与云端比较',
  compareHint: '列出「推送会传什么」与「拉取会取什么」；推送=本机覆盖云端，拉取=用云端覆盖本机（同名文件按「覆盖本机同名文件」开关决定）。',
  comparePush: '可推送',
  comparePull: '可拉取',
  pushAction: '推送',
  pullAction: '拉取',
  pullDone: '拉取完成',
  filesInPlan: '个文件',
  progressSync: '正在同步到云端',
  progressRestore: '正在从云端还原',
  phase_准备: '准备',
  phase_检查仓库: '检查仓库',
  phase_盘点本机文件: '盘点本机文件',
  phase_上传: '上传',
  phase_读取云端: '读取云端',
  phase_拍本地快照: '拍本地快照',
  phase_write: '写入本机',
  tabPlugins: '插件',
  pluginsTitle: '本机插件清单',
  pluginsHint: '各 profile 声明的依赖与补丁层；「bundle」标记表示它会被挂载成插件层。',
  pluginsDeps: '个依赖',
  pluginsBundles: '个插件层',
  pluginsNotInstalled: '未安装',
  pluginsBundleTag: 'bundle',
  pluginsMissingTitle: '云端有、本机没有的插件',
  pluginsMissingHint: '这些是别的机器在用的插件，按对应命令安装后重启 dsh web 生效。',
  pluginsMissingNone: '没有缺失的插件——本机与云端的插件清单一致。',
  installAction: '安装',
  updateAction: '更新',
  applyAll: '全部同步',
  applyDone: '已处理',
  applyNone: '没有需要安装或更新的插件',
  applyRestart: '重启 dsh web 后生效',
  restoring: '恢复中…',
  progressInstall: '正在安装插件',
  restartNow: '重启 dsh',
  restartConfirm: '重启会中断当前正在进行的对话与任务。确定现在重启吗？',
  restartIssued: '已发出重启请求',
  restartPending: 'dsh 正在重启，约 5 秒后刷新本页即可继续（登录状态保留）',
  restartReload: '如果刷新后仍无响应，请在终端确认 dsh web 是否已重新启动',
  restartCardTitle: '重启 dsh',
  restartCardHint: '插件安装/更新、切换 profile 之后都需要重启进程才会生效。重启后刷新本页即可，登录状态会保留。',
  pluginsBlockedTitle: '命令行无法安装的插件',
  pluginsBlockedHint: '这些插件属于由桌面（Electron）应用独占管理的 profile，dsh CLI 会直接拒绝（error: profile "desktop" is managed exclusively by the Electron application）。它们仍会被备份，但只能在桌面应用内添加。',
  cloudPluginsTitle: '云端插件列表',
  cloudPluginsHint: '各机器备份里声明的插件，以及那台机器最后一次同步到云端的时间。',
  cloudPluginsEmpty: '云端还没有任何插件清单。',
  cloudSyncedAt: '同步于',
  cloudSyncedUnknown: '同步时间未知',
  thisMachine: '本机',
  copy: '复制',
  copyCommand: '已复制命令',
  hostOutdated: '宿主半边是旧版本（v{version}，接口 {api}）：插件清单、与云端比较、进度显示需要重启 dsh web 才会出现——宿主代码只在进程启动时加载，刷新页面不会更新它。',
  hostApiNone: '无',
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
  repoCardTitle: 'Repository',
  repoUrlLabel: 'Repository address',
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
  restoreWritten: 'written',
  restoreSkipped: 'skipped',
  restoreUnchanged: 'unchanged',
  restoreNothingToDo: 'local content already matches the backup — nothing to write',
  restoreAllSkipped: 'same-named local files exist and overwriting is off — enable “Overwrite local files” and retry',
  restoreForce: 'Restore anyway (this is my own backup)',
  restoreTargetHint: 'When the same project lives at a different path here, pick this machine\'s workspace and the restored sessions join that group; leaving it empty keeps the original folder name (which may show as ungrouped).',
  ungroupedTag: 'ungrouped',
  regroupHint: 'Move to',
  regroupPick: 'Choose a local workspace…',
  regroupAction: 'Move into that group',
  regroupDone: 'Sessions moved',
  compare: 'Compare with cloud',
  compareTitle: 'Compare with cloud',
  compareHint: 'Shows what a push would send and what a pull would bring back. Push = this machine overwrites the cloud; pull = the cloud overwrites this machine (same-named files follow the “Overwrite local files” switch).',
  comparePush: 'to push',
  comparePull: 'to pull',
  pushAction: 'Push',
  pullAction: 'Pull',
  pullDone: 'Pull complete',
  filesInPlan: 'files',
  progressSync: 'Syncing to the cloud',
  progressRestore: 'Restoring from the cloud',
  phase_准备: 'preparing',
  phase_检查仓库: 'checking repository',
  phase_盘点本机文件: 'listing local files',
  phase_上传: 'uploading',
  phase_读取云端: 'reading the cloud',
  phase_拍本地快照: 'taking a local snapshot',
  phase_write: 'writing locally',
  tabPlugins: 'Plugins',
  pluginsTitle: 'Local plugin manifests',
  pluginsHint: 'Dependencies and patch layers declared per profile; a “bundle” tag means it mounts as a plugin layer.',
  pluginsDeps: 'deps',
  pluginsBundles: 'layers',
  pluginsNotInstalled: 'not installed',
  pluginsBundleTag: 'bundle',
  pluginsMissingTitle: 'In the cloud, missing here',
  pluginsMissingHint: 'Plugins another machine uses. Run the matching command, then restart dsh web.',
  pluginsMissingNone: 'Nothing missing — this machine and the cloud declare the same plugins.',
  installAction: 'Install',
  updateAction: 'Update',
  applyAll: 'Sync all',
  applyDone: 'Handled',
  applyNone: 'Nothing to install or update',
  applyRestart: 'restart dsh web to apply',
  restoring: 'Restoring…',
  progressInstall: 'Installing plugins',
  restartNow: 'Restart dsh',
  restartConfirm: 'Restarting interrupts the conversation and tasks in progress. Restart now?',
  restartIssued: 'Restart requested',
  restartPending: 'dsh is restarting — reload this page in about 5 seconds (you stay signed in)',
  restartReload: 'if the page still does not respond, check the terminal that dsh web restarted',
  restartCardTitle: 'Restart dsh',
  restartCardHint: 'Installing or updating a plugin only takes effect when the process restarts. Your login survives the restart.',
  pluginsBlockedTitle: 'Cannot be installed from the CLI',
  pluginsBlockedHint: 'These belong to a profile the desktop (Electron) app manages exclusively — the dsh CLI refuses it outright. They are still backed up, but can only be added inside the desktop app.',
  cloudPluginsTitle: 'Plugins in the cloud',
  cloudPluginsHint: 'Plugins declared in each machine\'s backup, and when that machine last synced.',
  cloudPluginsEmpty: 'No plugin manifests in the cloud yet.',
  cloudSyncedAt: 'synced',
  cloudSyncedUnknown: 'sync time unknown',
  thisMachine: 'this machine',
  copy: 'Copy',
  copyCommand: 'Command copied',
  hostOutdated: 'The host half is an older build (v{version}, api {api}): the plugin inventory, cloud comparison and progress display need a dsh web restart — host code only loads when the process starts, refreshing the page does not update it.',
  hostApiNone: 'none',
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

/**
 * Inject the stylesheet once.
 *
 * A `<style>` element is the only thing that turns this text into rules: a
 * `<div>` whose `innerHTML` is the CSS merely renders it as text, leaving every
 * element at browser defaults — labels sitting inline with their inputs and
 * fields collapsed against each other. The `data-plugin-css` marker is the
 * shell's own convention, so a reload or a second surface cannot double-inject.
 */
function ensureStyles() {
  if (typeof document === 'undefined') return
  const selector = `style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`
  if (typeof document.querySelector === 'function' && document.querySelector(selector) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = CLIENT_NAME
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = STYLE
  document.head.appendChild(tag)
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

function Field({ label, hint, hintTone, children }) {
  const hintClass = hintTone === 'ok' ? 'dgs-hint dgs-ok' : hintTone === 'warn' ? 'dgs-hint dgs-warn' : 'dgs-hint'
  return h(
    'label',
    { className: 'dgs-field' },
    h('span', { className: 'dgs-field-label' }, label),
    children,
    hint ? h('span', { className: hintClass }, hint) : null,
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
  const [outcome, setOutcome] = useState(null)
  const [viewer, setViewer] = useState(null)
  const [expanded, setExpanded] = useState({})
  const [regroupTarget, setRegroupTarget] = useState({})
  const [progress, setProgress] = useState(null)
  const [plugins, setPlugins] = useState(null)
  const [compare, setCompare] = useState(null)
  const [applyResult, setApplyResult] = useState(null)
  const [restarting, setRestarting] = useState(false)
  const [verifyResult, setVerifyResult] = useState(null)
  const toastTimer = useRef(null)

  /**
   * Is the host half new enough for the routes this bundle calls?
   *
   * The bundle is re-read from disk on every page load, while the host half
   * only changes when the dsh process restarts — so a refreshed page is
   * routinely newer than the process behind it. Without this check the new
   * surfaces answer `未知接口` and look broken. Declared before the first hook
   * that depends on it, because a dependency array is evaluated during render.
   */
  const hostIsCurrent = hostSupportsApi(status)
  // Running install/update needs the newer route; an older host still gets the
  // copyable commands, just not the buttons.
  const canApplyPlugins = hostSupportsApi(status, 3)
  // `/restart` and the richer cloud listing arrived with API 4.
  const canRestart = hostSupportsApi(status, 4)

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

  /**
   * Refresh server state.
   *
   * `draft` holds *only local edits* and is deliberately left alone here: it
   * used to be seeded with the whole server section, and since the render
   * merge is `{...server, ...draft}`, any derived field it captured (notably
   * `hasToken`) then shadowed the fresh server value forever — a saved token
   * kept displaying "not configured" until the page was reloaded.
   */
  const loadStatus = async () => {
    const next = await get('/status')
    setStatus(next)
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
    await put('/settings', body)
    setTokenInput('')
    // Everything the draft held is now persisted, so drop it and let the
    // server's own view drive the form again.
    setDraft({})
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
    if (tab === 'plugins' && !plugins && hostIsCurrent) loadPlugins()
  }, [tab, hostIsCurrent])

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
    const key = (workspace && workspace.key) || ''
    setPreview(null)
    setOutcome(null)
    setRestore({
      instanceId,
      workspace: key,
      // Pre-select the local workspace with the same project name, so a
      // cross-machine restore lands in its group instead of "ungrouped".
      map: key ? suggestWorkspace(localWorkspaces, workspace) : '',
      overwrite: true,
    })
  }

  /**
   * A push or a pull of tens of megabytes runs for a minute or more while the
   * request that started it stays open, so the page asks the host what it is
   * doing instead of showing an opaque spinner.
   */
  useEffect(() => {
    if (busy === '' || !hostIsCurrent) {
      setProgress(null)
      return undefined
    }
    let stopped = false
    const read = async () => {
      try {
        const next = await get('/progress')
        if (!stopped) setProgress(next)
      } catch {
        /* the request that matters is still in flight */
      }
    }
    read()
    const timer = setInterval(read, 700)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [busy])

  const loadPlugins = () => run('plugins', async () => {
    setPlugins(await get('/plugins'))
  })

  /** The progress strip, shared by the page top and the panel that started the work. */
  const renderProgress = () => {
    if (!progress || !progress.op) return null
    const percent = progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 8
    const label = progress.op === 'install' ? 'progressInstall' : progress.op === 'pull' || progress.op === 'restore' ? 'progressRestore' : 'progressSync'
    return h('div', { className: 'dgs-progress' },
      h('div', { className: 'dgs-progress-track' },
        h('span', { className: 'dgs-progress-fill', style: { width: `${percent}%` } })),
      h('span', { className: 'dgs-hint' },
        `${t(label)} · ${t(`phase_${progress.phase}`) || progress.phase}`,
        progress.total ? ` · ${progress.done}/${progress.total}` : ''))
  }

  /**
   * Restart the dsh process so freshly installed plugins mount.
   *
   * The browser credential is stored and reused across boots, so the page stays
   * signed in — a reload is all that is needed afterwards.
   */
  const restartHost = () => run('restart', async () => {
    const confirmed = typeof window === 'undefined' || typeof window.confirm !== 'function' || window.confirm(t('restartConfirm'))
    if (!confirmed) return
    await post('/restart', {})
    setRestarting(true)
    notify(t('restartIssued'))
  })

  const loadCompare = () => run('compare', async () => {
    setCompare(await get('/compare'))
  })

  /**
   * Run the install/update commands the page lists — all of them, or one.
   * The host decides *what* may be run from the backup's manifests; this only
   * says which of them the user asked for.
   */
  const applyPlugins = (action) => run('apply', async () => {
    const result = await post('/plugins/apply', action ? { names: [action.name], profiles: [action.profile] } : {})
    setApplyResult(result)
    await loadPlugins()
    const done = (result.applied || []).filter((a) => a.ok).length
    notify(
      (result.applied || []).length
        ? `${t('applyDone')}：${done}/${result.applied.length}${done ? ` · ${t('applyRestart')}` : ''}`
        : result.note || t('applyNone'),
    )
  })

  const pull = (groups, paths) => run('pull', async () => {
    const result = await post('/pull', { instanceId: (status && status.instanceId) || undefined, groups, paths })
    await Promise.all([loadLocalSessions(), loadStatus(), loadCompare()])
    notify(`${t('pullDone')}：${t('restoreWritten')} ${result.written.length} · ${t('restoreSkipped')} ${result.skipped.length}`)
    if ((result.pluginSuggestions || []).length) notify(`${t('pluginsMissingTitle')}：${result.pluginSuggestions.length}`)
  })

  const regroup = (from, to) => run('regroup', async () => {
    const result = await post('/sessions/regroup', { from, to })
    await loadLocalSessions()
    setRegroupTarget((current) => ({ ...current, [from]: '' }))
    notify(`${t('regroupDone')}：${result.moved}${result.skipped.length ? ` · ${t('restoreSkipped')} ${result.skipped.length}` : ''}`)
  })

  const doPreview = () => run('preview', async () => {
    const result = await post('/sessions/restore', {
      instanceId: restore.instanceId,
      workspace: restore.workspace || undefined,
      map: restore.map ? { [restore.workspace || '']: restore.map } : undefined,
      dryRun: true,
    })
    setPreview(result)
  })

  /**
   * Run the restore and keep the outcome **in the panel**.
   *
   * The panel used to close on success and report only through a toast, so a
   * restore that wrote nothing (or a refused one) looked exactly like a click
   * that did nothing at all.
   */
  const doRestore = (force = false) => run('restore', async () => {
    try {
      const result = await post('/sessions/restore', {
        instanceId: restore.instanceId,
        workspace: restore.workspace || undefined,
        map: restore.map && restore.workspace ? { [restore.workspace]: restore.map } : undefined,
        overwrite: restore.overwrite,
        force,
      })
      setPreview(null)
      setOutcome({
        ok: true,
        written: result.written.length,
        skipped: result.skipped.length,
        unchanged: result.unchanged.length,
        safetySnapshot: result.safetySnapshot,
        skippedReasons: result.skipped.slice(0, 3),
      })
      await loadLocalSessions()
      await loadStatus()
      notify(`${t('restoreDone')}：${result.written.length}`)
    } catch (error) {
      const message = String((error && error.message) || error)
      setOutcome({ ok: false, error: message, offerForce: /本机自己的备份/.test(message) })
    }
  })

  const openViewer = (query) => run('viewer', async () => {
    const text = await get(`/sessions/text?${query}`)
    setViewer(text)
  })

  const settings = visibleSettings(status, draft)
  const configured = status ? status.configured : false
  const localWorkspaces = (localSessions && localSessions.workspaces) || []
  // `actions` carries install *and* update; `suggestions` is the install-only
  // shape a version-2 host returns.
  const pluginActions = (plugins && (plugins.actions || plugins.suggestions)) || []

  return h('div', { className: 'dgs-root' },
    h('header', { className: 'dgs-head' },
      h('div', null,
        h('h2', { className: 'dgs-title' }, t('title')),
        h('p', { className: 'dgs-hint' }, t('subtitle'))),
      h('div', { className: 'dgs-row' },
        h(Button, { variant: 'outline', size: 'sm', onClick: verify, disabled: !configured || busy !== '' }, busy === 'verify' ? t('verifying') : t('verify')),
        h(Button, { variant: 'outline', size: 'sm', onClick: loadCompare, disabled: !configured || busy !== '' || !hostIsCurrent }, t('compare')),
        h(Button, { variant: 'primary', size: 'sm', onClick: syncNow, disabled: !configured || busy !== '' }, busy === 'sync' ? t('syncing') : t('syncNow')))),

    // A newer page in front of an older process: say so instead of letting
    // every new surface answer 未知接口.
    status && !hostIsCurrent
      ? h('div', { className: 'dgs-warn dgs-note' },
        t('hostOutdated', { version: status.version || '?', api: status.api === undefined ? t('hostApiNone') : status.api }))
      : null,

    // Live progress for whatever long operation is running. It also appears
    // inside the panel that started the work, because that is where the user is
    // looking — a strip at the top of a scrolled page is easy to miss.
    renderProgress(),

    restarting
      ? h('div', { className: 'dgs-note dgs-ok' }, `${t('restartPending')} —— ${t('restartReload')}`)
      : null,

    h('nav', { className: 'dgs-tabs' },
      // The plugin inventory needs a route the older host half does not have.
      ['overview', 'sessions', ...(hostIsCurrent ? ['plugins'] : []), 'snapshots', 'advanced'].map((key) =>
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
            // Sessions and plugins are reported apart — "12 changed" would hide
            // whether anything needs installing.
            ['sessions', 'plugins'].map((group) => {
              const g = (status.lastResult.groups || {})[group]
              if (!g) return null
              return h('div', { key: group, className: 'dgs-row dgs-wrap' },
                h('span', { className: 'dgs-strong' }, t(group === 'sessions' ? 'tabSessions' : 'togglePlugins')),
                h('span', { className: 'dgs-pill' }, `${t('resultCreated')} ${g.created}`),
                h('span', { className: 'dgs-pill' }, `${t('resultUpdated')} ${g.updated}`),
                h('span', { className: 'dgs-pill' }, `${t('resultDeleted')} ${g.deleted}`),
                h('span', { className: 'dgs-hint' }, `${g.files} ${t('filesInPlan')}`))
            }),
            h('div', { className: 'dgs-row dgs-wrap' },
              h('span', { className: 'dgs-pill' }, `${t('resultUnchanged')} ${status.lastResult.unchanged}`),
              status.lastResult.pr ? h('span', { className: 'dgs-pill dgs-pill-brand' }, `${t('resultPr')} #${status.lastResult.pr.number} · ${status.lastResult.pr.state}`) : null),
            (status.lastResult.pluginSuggestions || []).length
              ? h('div', null,
                h('div', { className: 'dgs-result-head' }, t('pluginsMissingTitle')),
                status.lastResult.pluginSuggestions.map((item) =>
                  h('div', { key: `${item.profile}/${item.name}`, className: 'dgs-row dgs-wrap' },
                    h('span', { className: 'dgs-hint' }, `${item.profile} · ${item.name} · ${item.spec}`),
                    h('code', { className: 'dgs-code' }, item.command))))
              : null)
          : null),

      compare
        ? h(Card, { title: t('compareTitle'), hint: t('compareHint') },
          ['sessions', 'plugins'].map((group) => {
            const g = (compare.groups || {})[group]
            if (!g) return null
            return h('div', { key: group, className: 'dgs-list-item' },
              h('div', { className: 'dgs-row dgs-between' },
                h('span', { className: 'dgs-strong' }, t(group === 'sessions' ? 'tabSessions' : 'togglePlugins')),
                h('span', { className: 'dgs-row dgs-wrap' },
                  h('span', { className: 'dgs-pill' }, `${t('comparePush')} ${g.created + g.updated}`),
                  h('span', { className: 'dgs-pill' }, `${t('comparePull')} ${g.updated + g.deleted}`),
                  h('span', { className: 'dgs-pill' }, `${t('resultUnchanged')} ${g.unchanged}`))),
              h('div', { className: 'dgs-row' },
                h(Button, { variant: 'primary', size: 'sm', disabled: busy !== '', onClick: syncNow }, t('pushAction')),
                h(Button, {
                  variant: 'outline',
                  size: 'sm',
                  disabled: busy !== '',
                  onClick: () => pull([group]),
                }, t('pullAction'))),
              [...(g.createdPaths || [])].slice(0, 4).map((p) => h('div', { key: p, className: 'dgs-hint' }, `+ ${p}`)),
              [...(g.deletedPaths || [])].slice(0, 4).map((p) => h('div', { key: p, className: 'dgs-hint' }, `- ${p}`)))
          }))
        : null,

      h(Card, { title: t('repoCardTitle'), hint: t('repoHint') },
        h(Field, { label: t('repoUrlLabel') },
          h('input', {
            className: 'dgs-input',
            value: settings.repoUrl || '',
            placeholder: t('repoPlaceholder'),
            spellCheck: false,
            onChange: (event) => patch('repoUrl', event.target.value),
          })),
        h('div', { className: 'dgs-field-row' },
          h(Field, { label: t('branchLabel') },
            h('input', {
              className: 'dgs-input',
              value: settings.branch || 'main',
              spellCheck: false,
              onChange: (event) => patch('branch', event.target.value),
            })),
          h(Field, {
            label: t('tokenLabel'),
            hint: settings.hasToken ? t('tokenStored') : t('tokenMissing'),
            hintTone: settings.hasToken ? 'ok' : 'warn',
          },
          h('input', {
            className: 'dgs-input',
            type: 'password',
            value: tokenInput,
            placeholder: t('tokenPlaceholder'),
            autoComplete: 'off',
            spellCheck: false,
            onChange: (event) => setTokenInput(event.target.value),
          }))),
        h('div', { className: 'dgs-actions' },
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
          ? h('p', { className: verifyResult.ok ? 'dgs-note dgs-ok' : 'dgs-note dgs-warn' },
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
                h('span', { className: 'dgs-strong' }, workspaceLabel(workspace)),
                h('span', { className: 'dgs-hint' },
                  workspace.pathIsExact === false ? `${t('ungroupedTag')} · ` : '',
                  `${workspace.sessionCount} ${t('sessionsCount')} · ${formatBytes(workspace.bytes)}`)),
                expanded[workspace.key]
                  ? h('div', { className: 'dgs-sublist' },
                    workspace.sessions.map((session) =>
                      h('div', { key: session.id, className: 'dgs-row dgs-between' },
                        h('button', {
                          type: 'button',
                          className: 'dgs-link',
                          onClick: () => openViewer(`local=1&workspace=${encodeURIComponent(workspace.key)}&session=${encodeURIComponent(session.id)}&file=${encodeURIComponent(session.file || 'session.jsonl.zstd')}`),
                        }, session.id),
                        h('span', { className: 'dgs-hint' }, `${session.files} · ${formatBytes(session.bytes)} · ${formatTime(session.modifiedAt)}`))),
                    // Sessions are grouped by the workspace their folder maps
                    // to; when the folder came from another machine nothing
                    // maps, so dsh shows them ungrouped. Moving the folders is
                    // what regroups them.
                    h('div', { className: 'dgs-row dgs-wrap dgs-regroup' },
                      h('span', { className: 'dgs-hint' }, t('regroupHint')),
                      h('select', {
                        className: 'dgs-input dgs-input-sm',
                        value: regroupTarget[workspace.key] ?? suggestWorkspace(localWorkspaces, workspace),
                        onChange: (event) => setRegroupTarget((current) => ({ ...current, [workspace.key]: event.target.value })),
                      },
                      h('option', { value: '' }, t('regroupPick')),
                      localWorkspaces.filter((w) => w.key !== workspace.key).map((w) =>
                        h('option', { key: w.key, value: w.key }, w.path || w.key))),
                      h(Button, {
                        variant: 'outline',
                        size: 'sm',
                        disabled: busy !== '' || !(regroupTarget[workspace.key] ?? suggestWorkspace(localWorkspaces, workspace)),
                        onClick: () => regroup(workspace.key, regroupTarget[workspace.key] ?? suggestWorkspace(localWorkspaces, workspace)),
                      }, t('regroupAction'))))
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
                      h('span', { title: workspace.key }, workspaceLabel(workspace)),
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
            restore.workspace ? h('span', { className: 'dgs-pill' }, `≈ ${decodeWorkspace(restore.workspace)}`) : null),
          h(Toggle, {
            label: t('restoreOverwrite'),
            checked: restore.overwrite,
            onChange: (v) => setRestore({ ...restore, overwrite: v }),
          }),
          restore.workspace
            ? h(Field, { label: t('restoreTarget'), hint: t('restoreTargetHint') },
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
          renderProgress(),
          outcome
            ? h('div', { className: outcome.ok ? 'dgs-note dgs-ok' : 'dgs-note dgs-warn' },
              outcome.ok
                ? [
                  `${t('restoreWritten')} ${outcome.written}`,
                  `${t('restoreSkipped')} ${outcome.skipped}`,
                  `${t('restoreUnchanged')} ${outcome.unchanged}`,
                  outcome.written === 0 && outcome.skipped === 0
                    ? ` —— ${t('restoreNothingToDo')}`
                    : outcome.written === 0
                      ? ` —— ${t('restoreAllSkipped')}`
                      : '',
                ].join(' · ')
                : h('span', null,
                  outcome.error,
                  outcome.offerForce
                    ? h(Button, {
                      variant: 'outline',
                      size: 'sm',
                      style: { marginLeft: '8px' },
                      onClick: () => doRestore(true),
                      disabled: busy !== '',
                    }, t('restoreForce'))
                    : null))
            : null,
          h('div', { className: 'dgs-row' },
            h(Button, { variant: 'outline', size: 'sm', onClick: doPreview, disabled: busy !== '' }, busy === 'preview' ? t('previewing') : t('preview')),
            h(Button, { variant: 'primary', size: 'sm', onClick: () => doRestore(false), disabled: busy !== '' },
              busy === 'restore' ? t('restoring') : t('confirmRestore')),
            h(Button, { variant: 'outline', size: 'sm', onClick: () => { setRestore(null); setPreview(null); setOutcome(null) } }, t('cancel'))))
        : null),

    tab === 'plugins' && h('div', { className: 'dgs-panes' },
      h(Card, {
        title: t('pluginsTitle'),
        hint: t('pluginsHint'),
        actions: [h(Button, { key: 'r', variant: 'outline', size: 'sm', onClick: loadPlugins, disabled: busy !== '' }, t('refresh'))],
      },
        !plugins
          ? h('p', { className: 'dgs-hint' }, t('loading'))
          : plugins.local.map((profile) =>
            h('div', { key: profile.profile, className: 'dgs-list-item' },
              h('div', { className: 'dgs-row dgs-between' },
                h('span', { className: 'dgs-strong' }, profile.profile),
                h('span', { className: 'dgs-hint' }, `${profile.packages.length} ${t('pluginsDeps')} · ${profile.bundles.length} ${t('pluginsBundles')}`)),
              profile.packages.map((pkg) =>
                h('div', { key: pkg.name, className: 'dgs-row dgs-between dgs-subrow' },
                  h('span', null,
                    h('span', { className: 'dgs-strong' }, pkg.name),
                    h('span', { className: 'dgs-hint' }, ` ${pkg.installedVersion ? `v${pkg.installedVersion}` : t('pluginsNotInstalled')}`)),
                  h('span', { className: 'dgs-row' },
                    pkg.bundle ? h('span', { className: 'dgs-pill' }, t('pluginsBundleTag')) : null,
                    h('span', { className: 'dgs-hint' }, pkg.spec))))))),

      h(Card, {
        title: t('pluginsMissingTitle'),
        hint: t('pluginsMissingHint'),
        actions: canApplyPlugins && pluginActions.length
          ? [h(Button, { key: 'all', variant: 'primary', size: 'sm', disabled: busy !== '', onClick: () => applyPlugins(null) }, t('applyAll'))]
          : null,
      },
        !plugins
          ? h('p', { className: 'dgs-hint' }, t('loading'))
          : pluginActions.length === 0
            ? h('p', { className: 'dgs-hint' }, t('pluginsMissingNone'))
            : pluginActions.map((item) =>
              h('div', { key: `${item.profile}/${item.name}/${item.kind}`, className: 'dgs-list-item' },
                h('div', { className: 'dgs-row dgs-between' },
                  h('span', null,
                    h('span', { className: 'dgs-strong' }, item.name),
                    h('span', { className: 'dgs-hint' },
                      ` · ${item.profile} · `,
                      item.kind === 'install'
                        ? `${t('installAction')} ${item.spec}`
                        : `${t('updateAction')} ${item.from} → ${item.to}`)),
                  h('span', { className: 'dgs-row' },
                    canApplyPlugins
                      ? h(Button, {
                        variant: 'primary',
                        size: 'sm',
                        disabled: busy !== '',
                        onClick: () => applyPlugins(item),
                      }, item.kind === 'install' ? t('installAction') : t('updateAction'))
                      : null,
                    h(Button, {
                      variant: 'outline',
                      size: 'sm',
                      onClick: () => {
                        writeClipboard(item.command)
                        notify(`${t('copyCommand')}：${item.command}`)
                      },
                    }, t('copy')))),
                h('code', { className: 'dgs-code' }, item.command)))),

      applyResult
        ? h('div', { className: applyResult.applied.every((a) => a.ok) ? 'dgs-note dgs-ok' : 'dgs-note dgs-warn' },
          applyResult.applied.map((a) =>
            h('div', { key: `${a.profile}/${a.name}/${a.kind}` },
              `${a.ok ? '✔' : '✘'} ${a.command}`,
              a.ok ? '' : h('pre', { className: 'dgs-code' }, a.output),
              a.hint ? h('div', { className: 'dgs-hint' }, a.hint) : null)),
          applyResult.note ? h('div', { className: 'dgs-hint' }, applyResult.note) : null,
          // Installing is only half the job — a plugin mounts when the process
          // starts, so offer the restart right here.
          applyResult.restartRequired && canRestart
            ? h('div', { className: 'dgs-row' },
              h(Button, { variant: 'primary', size: 'sm', disabled: busy !== '', onClick: restartHost }, t('restartNow')))
            : null)
        : null,

      // The launcher refuses `--profile desktop` outright, so these get a
      // reason instead of a button that could only ever fail.
      (plugins && plugins.blocked || []).length
        ? h(Card, { title: t('pluginsBlockedTitle'), hint: t('pluginsBlockedHint') },
          (plugins.blocked || []).map((item) =>
            h('div', { key: `${item.profile}/${item.name}/${item.kind}`, className: 'dgs-row dgs-between dgs-list-item' },
              h('span', null,
                h('span', { className: 'dgs-strong' }, item.name),
                h('span', { className: 'dgs-hint' }, ` · ${item.profile} · ${item.kind === 'install' ? item.spec : `${item.from} → ${item.to}`}`)),
              h('span', { className: 'dgs-hint' }, item.reason))))
        : null,

      h(Card, { title: t('cloudPluginsTitle'), hint: t('cloudPluginsHint') },
        !plugins
          ? h('p', { className: 'dgs-hint' }, t('loading'))
          : (plugins.instanceInfo || []).length === 0
            ? h('p', { className: 'dgs-hint' }, t('cloudPluginsEmpty'))
            : plugins.instanceInfo.map((info) =>
              h('div', { key: info.instanceId, className: 'dgs-list-item' },
                h('div', { className: 'dgs-row dgs-between' },
                  h('span', null,
                    h('span', { className: 'dgs-strong' }, info.instanceId),
                    info.instanceId === (status && status.instanceId)
                      ? h('span', { className: 'dgs-pill' }, t('thisMachine'))
                      : null),
                  h('span', { className: 'dgs-hint' },
                    info.lastSyncAt ? `${t('cloudSyncedAt')} ${formatTime(info.lastSyncAt)}` : t('cloudSyncedUnknown'))),
                Object.entries((plugins.cloud || {})[info.instanceId] || {}).map(([profile, data]) =>
                  h('div', { key: profile, className: 'dgs-subrow' },
                    h('div', { className: 'dgs-hint' }, `${profile} · ${(data.packages || []).length} ${t('pluginsDeps')}`),
                    (data.packages || []).map((pkg) =>
                      h('div', { key: pkg.name, className: 'dgs-row dgs-between dgs-subrow' },
                        h('span', { className: 'dgs-hint' }, pkg.name),
                        h('span', { className: 'dgs-hint' }, pkg.spec)))))))),

      plugins && plugins.configured === false
        ? h('p', { className: 'dgs-hint' }, t('notConfigured'))
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
          h(Button, { variant: 'primary', size: 'sm', onClick: save, disabled: busy !== '' }, t('save')))),
      canRestart
        ? h(Card, { title: t('restartCardTitle'), hint: t('restartCardHint') },
          h('div', { className: 'dgs-row' },
            h(Button, { variant: 'outline', size: 'sm', onClick: restartHost, disabled: busy !== '' }, t('restartNow'))))
        : null),

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

/**
 * What to print for a workspace. The host sends the registry's real path when
 * it could read it; otherwise the value is decoded from the folder name, which
 * is lossy (`git-workspace\data-push` decodes to `git\workspace\data\push`), so
 * it is marked approximate rather than presented as fact.
 */
function workspaceLabel(workspace) {
  const path = (workspace && workspace.path) || decodeWorkspace(workspace && workspace.key)
  return workspace && workspace.pathIsExact === false ? `≈ ${path}` : path
}

/**
 * What the form shows: the server's view of the settings with the user's
 * unsaved edits on top.
 *
 * `hasToken` is stripped from the draft on purpose. It is not a setting the
 * user edits — it is derived by the host from the stored token — and a draft
 * that carries a stale copy of it would shadow the fresh server value, leaving
 * a saved token displayed as "not configured" until the page was reloaded.
 */
function visibleSettings(status, draft) {
  const { hasToken, ...edits } = draft || {}
  return { ...((status && status.settings) || {}), ...edits }
}

/**
 * Whether the host half serving this page speaks the API this bundle calls.
 *
 * A host that predates the version field reads as 0 — deliberately, because
 * "no answer" and "an old answer" need the same treatment: the page was
 * refreshed after an update but the process was not restarted.
 */
function hostSupportsApi(status, required = REQUIRED_API) {
  const api = status && typeof status.api === 'number' ? status.api : 0
  return api >= required
}

/** Copy helper: the shell's clipboard writer when present, the DOM API otherwise. */
function writeClipboard(text) {
  try {
    if (P && typeof P.writeClipboard === 'function') {
      P.writeClipboard(text)
      return
    }
  } catch {
    /* fall through to the DOM API */
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(text)
  } catch {
    /* clipboard is unavailable — the command is visible either way */
  }
}

/** Last path segment of a project directory — how the same project is recognised across machines. */
function workspaceTitle(path) {
  return String(path || '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || ''
}

/**
 * Which local workspace a remote (or restored) one belongs to.
 *
 * Two machines rarely keep a project at the same absolute path — `D:\Program
 * Files\…\data-push` on one, `D:\JetBrains\…\data-push` on the other — and dsh
 * groups sessions by the workspace their folder maps to, so a session restored
 * under the *other* machine's folder name shows up as ungrouped. Matching on
 * the project folder name is what puts it back in its group; the suggestion is
 * only offered when exactly one local workspace matches.
 */
function suggestWorkspace(localWorkspaces, workspace) {
  const title = workspaceTitle((workspace && workspace.path) || workspace)
  if (!title) return ''
  const hits = (localWorkspaces || []).filter(
    (w) => w && w.key !== (workspace && workspace.key) && workspaceTitle(w.path) === title,
  )
  return hits.length === 1 ? hits[0].key : ''
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
.dgs-root { display: flex; flex-direction: column; gap: 18px; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); font-size: var(--dsw-font-sm-14, 14px); line-height: 1.6; }
.dgs-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dgs-title { margin: 0; font-size: 17px; font-weight: 600; }
.dgs-hint { margin: 2px 0 0; color: var(--dsw-alias-label-tertiary); font-size: var(--dsw-font-xs-13, 12px); line-height: 1.6; }
.dgs-row { display: flex; align-items: center; gap: 8px; }
.dgs-wrap { flex-wrap: wrap; }
.dgs-between { justify-content: space-between; width: 100%; }
.dgs-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dgs-tab { appearance: none; background: none; border: 0; border-bottom: 2px solid transparent; padding: 9px 14px; margin-bottom: -1px; cursor: pointer; color: var(--dsw-alias-label-secondary); font: inherit; }
.dgs-tab:hover { color: var(--dsw-alias-label-primary); }
.dgs-tab.is-active { color: var(--dsw-alias-label-primary); font-weight: 600; border-bottom-color: var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary)); }
.dgs-panes { display: flex; flex-direction: column; gap: 18px; }
.dgs-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-2); padding: 18px; display: flex; flex-direction: column; gap: 16px; }
.dgs-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
/* The trailing control is a button: without this it shrinks to one glyph per
   line as soon as the title next to it is long. */
.dgs-card-head > :last-child { flex: none; }
.dgs-root button { white-space: nowrap; }
.dgs-card-title { margin: 0; font-size: 14px; font-weight: 600; }
.dgs-card-body { display: flex; flex-direction: column; gap: 16px; }
.dgs-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dgs-field-label { color: var(--dsw-alias-label-secondary); font-size: var(--dsw-font-xs-13, 12px); }
.dgs-field-row { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 16px; align-items: start; }
.dgs-input { width: 100%; box-sizing: border-box; min-width: 0; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; }
.dgs-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary)); }
.dgs-input::placeholder { color: var(--dsw-alias-label-tertiary); }
.dgs-input-sm { max-width: 160px; }
.dgs-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; align-items: start; }
.dgs-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 2px; }
.dgs-toggle { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 10px 0; }
.dgs-toggle + .dgs-toggle { border-top: 1px solid var(--dsw-alias-border-l2); }
.dgs-toggle-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dgs-toggle-label { font-weight: 500; }
.dgs-switch { width: 18px; height: 18px; margin-top: 2px; flex: none; accent-color: var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary)); }
.dgs-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.dgs-stat { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; }
.dgs-note { margin: 0; }
.dgs-progress { display: flex; flex-direction: column; gap: 6px; }
.dgs-progress-track { height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-3); overflow: hidden; }
.dgs-progress-fill { display: block; height: 100%; background: var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary)); transition: width .3s ease; }
.dgs-code { display: block; margin-top: 4px; padding: 6px 8px; border-radius: 6px; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family-mono, ui-monospace, monospace); font-size: 12px; word-break: break-all; }
.dgs-stat-value { font-weight: 600; word-break: break-all; }
.dgs-stat-label { color: var(--dsw-alias-label-tertiary); font-size: var(--dsw-font-xs-13, 12px); }
.dgs-result { border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.dgs-result-head { color: var(--dsw-alias-label-secondary); font-size: var(--dsw-font-xs-13, 12px); }
.dgs-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary); font-size: var(--dsw-font-xs-13, 12px); }
.dgs-pill-brand { background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary-inverted, #fff); }
.dgs-list-item { display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 12px 14px; background: var(--dsw-alias-bg-layer-1); }
.dgs-subrow { padding-left: 12px; }
.dgs-regroup { padding-top: 8px; border-top: 1px dashed var(--dsw-alias-border-l2); }
.dgs-regroup .dgs-input-sm { max-width: 260px; }
.dgs-sublist { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px dashed var(--dsw-alias-border-l2); }
.dgs-disclosure { appearance: none; background: none; border: 0; padding: 0; cursor: pointer; color: inherit; font: inherit; text-align: left; display: flex; flex-direction: column; gap: 2px; }
.dgs-link { appearance: none; background: none; border: 0; padding: 0; cursor: pointer; color: var(--dsw-alias-state-business-primary); font: inherit; text-align: left; }
.dgs-strong { font-weight: 600; word-break: break-all; }
.dgs-ok { color: var(--dsw-alias-state-business-primary); font-size: var(--dsw-font-xs-13, 12px); }
.dgs-warn, .dgs-error { color: var(--dsw-alias-state-error-primary); font-size: var(--dsw-font-xs-13, 12px); }
.dgs-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 60; }
.dgs-modal { width: min(880px, 92vw); max-height: 82vh; overflow: auto; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 18px; display: flex; flex-direction: column; gap: 14px; box-shadow: var(--dsw-shadow-lv3); }
@media (max-width: 620px) { .dgs-field-row { grid-template-columns: minmax(0, 1fr); } }
.dgs-pre { margin: 0; padding: 10px; background: var(--dsw-alias-bg-layer-1); border-radius: 8px; max-height: 60vh; overflow: auto; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
/* Fixed, so a message is visible whichever tab is scrolled and from inside the
   session viewer overlay. */
.dgs-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 80; max-width: min(560px, 80vw); padding: 10px 14px; border-radius: 10px; background: var(--dsw-alias-bg-layer-3); border: 1px solid var(--dsw-alias-border-l1); box-shadow: var(--dsw-shadow-lv3); }
`

function SettingsSectionSlot({ __t }) {
  useEffect(ensureStyles, [])
  return h(SettingsSection, { t: __t })
}

// ── Plugin plane contract ────────────────────────────────────────────────

const plugin = {
  name: CLIENT_NAME,
  inject: ['slots', 'locale'],
  __internals: { NS, ZH, EN, STYLE, STYLE_TAG_ID, ensureStyles, visibleSettings, hostSupportsApi, suggestWorkspace, workspaceTitle, formatBytes, formatTime, decodeWorkspace },
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
