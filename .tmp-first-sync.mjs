/** Temp: point the running instance at the sync repo, verify, then run the first backup. */
const base = process.argv[2] || 'http://127.0.0.1:3080'
const token = process.env.SYNC_TOKEN
const repoUrl = process.env.SYNC_REPO || 'https://github.com/minghuo/dsh-sync.git'

const call = async (path, init = {}, timeoutMs = 600000) => {
  const res = await fetch(base + path, {
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    ...init,
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body }
}

const save = await call('/dsh-github-sync/api/settings', {
  method: 'PUT',
  body: JSON.stringify({ repoUrl, token, syncSessions: true, syncPlugins: true, syncSettings: false }),
}, 30000)
console.log('1) 保存设置 :', save.status, '| hasToken =', save.body?.settings?.hasToken, '| repo =', save.body?.settings?.repoUrl)

const verify = await call('/dsh-github-sync/api/verify', { method: 'POST', body: '{}' }, 60000)
console.log('2) 验证仓库 :', verify.status, JSON.stringify(verify.body))

if (!verify.body || verify.body.ok !== true) {
  console.log('验证未通过，停止。')
  process.exit(1)
}

const started = Date.now()
const sync = await call('/dsh-github-sync/api/sync', { method: 'POST', body: '{}' }, 900000)
console.log(`3) 首次备份 : ${sync.status}  用时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log('   ', JSON.stringify(sync.body, null, 1).slice(0, 1400))

const remote = await call('/dsh-github-sync/api/remote', {}, 120000)
console.log('4) 远端清单 :', remote.status)
for (const inst of remote.body?.instances || []) {
  console.log(`    ${inst.instanceId}  sessions=${inst.sessionCount} (${(inst.sessionBytes / 1048576).toFixed(1)} MB)  files=${inst.files}  bytes=${(inst.bytes / 1048576).toFixed(1)} MB`)
  for (const w of inst.workspaces.slice(0, 12)) console.log(`      ${w.pathIsExact ? ' ' : '≈'} ${w.path || w.key}  (${w.sessions})`)
}
console.log('    branch commit:', remote.body?.commit, '| savedAt:', remote.body?.savedAt)
