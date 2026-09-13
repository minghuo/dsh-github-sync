#!/usr/bin/env node
/**
 * Publish this plugin without a working `git` remote.
 *
 * Everything goes through the GitHub REST API using Node's global `fetch`, so
 * the script runs from environments where the git transport is unavailable
 * (the DSH sandbox blocks schannel and the credential manager) and never needs
 * a credential helper: the token comes from `GITHUB_TOKEN` / `GH_TOKEN` and is
 * used only for the requests it makes.
 *
 *   node scripts/publish-github.mjs status               # what exists already
 *   node scripts/publish-github.mjs repo                 # create + push + topics
 *   node scripts/publish-github.mjs repo --dry-run       # print the plan only
 *   node scripts/publish-github.mjs registry             # PR the market entry
 *
 * Options: --owner <login>  --repo <name>  --private  --branch <name>
 *          --upstream <owner/repo> (registry target)
 *
 * The registry step refuses to run while the target repository is younger than
 * one day, because the market's CI checks exactly that and would fail the PR.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin'
const MIN_REPO_AGE_MS = 24 * 60 * 60 * 1000

const argv = process.argv.slice(2)
const command = argv.find((a) => !a.startsWith('--')) || 'status'
const flag = (name) => argv.includes(`--${name}`)
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
const apiBase = 'https://api.github.com'
const dryRun = flag('dry-run')

// ── Files to publish ─────────────────────────────────────────────────────
// The same set `git ls-files` reports: the working tree minus the paths the
// repository's .gitignore removes. Kept as code rather than shelling out,
// because this script exists precisely where shelling out to git does not work.

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.reference', '.ref-dsh-sync'])
const IGNORED_SUFFIXES = ['.log']
const IGNORED_NAMES = new Set(['.DS_Store'])

async function collectFiles(dir = ROOT, out = []) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git' && dir === ROOT) continue
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      await collectFiles(join(dir, entry.name), out)
      continue
    }
    if (!entry.isFile()) continue
    if (IGNORED_NAMES.has(entry.name)) continue
    if (IGNORED_SUFFIXES.some((s) => entry.name.endsWith(s))) continue
    const abs = join(dir, entry.name)
    const rel = relative(ROOT, abs).split(sep).join('/')
    out.push({ path: rel, abs })
  }
  return out
}

// ── GitHub plumbing ──────────────────────────────────────────────────────

async function gh(method, path, { body, allow404 = false } = {}) {
  const res = await fetch(path.startsWith('http') ? path : apiBase + path, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-github-sync-publish',
      'x-github-api-version': '2022-11-28',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = text === '' ? null : JSON.parse(text)
  } catch {
    /* non-JSON */
  }
  if (!res.ok && !(allow404 && res.status === 404)) {
    const detail = (json && (json.message || json.error)) || text.slice(0, 200)
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${detail}`)
  }
  return { status: res.status, json }
}

const blobSha = (buf) => createHash('sha1').update(Buffer.from(`blob ${buf.length}\0`)).update(buf).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function whoami() {
  const { json } = await gh('GET', '/user')
  return json.login
}

/** Push the working tree as one commit, creating blobs only for what changed. */
async function pushTree({ owner, repo, branch, message, verbose = true }) {
  const head = await gh('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`, { allow404: true })
  const headSha = head.status === 200 ? head.json.object.sha : null

  let baseTree
  let remoteMap = new Map()
  if (headSha) {
    const { json: commit } = await gh('GET', `/repos/${owner}/${repo}/git/commits/${headSha}`)
    baseTree = commit.tree.sha
    const { json: tree } = await gh('GET', `/repos/${owner}/${repo}/git/trees/${baseTree}?recursive=1`)
    for (const entry of tree.tree || []) if (entry.type === 'blob') remoteMap.set(entry.path, entry.sha)
  }

  const files = await collectFiles()
  const entries = []
  let uploaded = 0
  let unchanged = 0
  for (const file of files) {
    const buffer = await fsp.readFile(file.abs)
    const sha = blobSha(buffer)
    if (remoteMap.get(file.path) === sha) {
      unchanged += 1
      continue
    }
    if (dryRun) {
      entries.push({ path: file.path, mode: '100644', type: 'blob', sha: '(dry-run)' })
      uploaded += 1
      continue
    }
    const { json: blob } = await gh('POST', `/repos/${owner}/${repo}/git/blobs`, {
      body: { content: buffer.toString('base64'), encoding: 'base64' },
    })
    entries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha })
    uploaded += 1
  }

  // Files that vanished locally leave the branch too.
  for (const path of remoteMap.keys()) {
    if (!files.some((f) => f.path === path)) entries.push({ path, mode: '100644', type: 'blob', sha: null })
  }

  if (verbose) console.log(`  文件 ${files.length} · 上传 ${uploaded} · 未变 ${unchanged}`)
  if (entries.length === 0) return { pushed: false, headSha }

  if (dryRun) return { pushed: true, dryRun: true, entries: entries.length }

  const { json: tree } = await gh('POST', `/repos/${owner}/${repo}/git/trees`, {
    body: baseTree ? { base_tree: baseTree, tree: entries } : { tree: entries },
  })
  const { json: commit } = await gh('POST', `/repos/${owner}/${repo}/git/commits`, {
    body: { message, tree: tree.sha, parents: headSha ? [headSha] : [] },
  })
  if (headSha) {
    await gh('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, { body: { sha: commit.sha, force: false } })
  } else {
    await gh('POST', `/repos/${owner}/${repo}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: commit.sha } })
  }
  return { pushed: true, commit: commit.sha }
}

// ── Commands ─────────────────────────────────────────────────────────────

async function target() {
  const pkg = JSON.parse(await fsp.readFile(join(ROOT, 'package.json'), 'utf8'))
  const explicitOwner = option('owner', '')
  if (!explicitOwner && !TOKEN) throw new Error('缺少令牌（GITHUB_TOKEN）或 --owner <login>')
  const owner = explicitOwner || (await whoami())
  const repo = option('repo', pkg.name.replace(/^@[^/]+\//, ''))
  return { pkg, owner, repo, slug: `${owner}/${repo}`, branch: option('branch', 'main') }
}

async function cmdStatus() {
  const { pkg, slug } = await target()
  console.log(`包        ${pkg.name}@${pkg.version}`)
  console.log(`dsh.bundle ${pkg.dsh?.bundle?.patch ? '✔ ' + pkg.dsh.bundle.patch : '✗ 缺失（dsh plugin add 装不上）'}`)
  console.log(`dsh.client ${pkg.dsh?.client?.platform ? '✔ ' + pkg.dsh.client.platform : '—'}`)
  const { status, json } = await gh('GET', `/repos/${slug}`, { allow404: true })
  if (status === 404) {
    console.log(`仓库      ${slug} → 不存在`)
    return
  }
  const ageMs = Date.now() - new Date(json.created_at).getTime()
  console.log(`仓库      ${slug} → ${json.private ? '私有' : '公开'} · 建于 ${json.created_at} · ${(ageMs / 3600000).toFixed(1)} 小时`)
  console.log(`上架条件  仓库满 1 天：${ageMs >= MIN_REPO_AGE_MS ? '已满足' : '未满足（' + Math.ceil((MIN_REPO_AGE_MS - ageMs) / 3600000) + ' 小时后可提 PR）'}`)
  const topics = json.topics || []
  console.log(`topics    ${topics.length ? topics.join(', ') : '(无)'}`)
  const files = await collectFiles()
  console.log(`待发布    ${files.length} 个文件`)
}

async function cmdRepo() {
  const { pkg, owner, repo, branch, slug } = await target()
  console.log(`发布到 ${slug}${dryRun ? '（dry-run）' : ''}`)

  let exists = (await gh('GET', `/repos/${slug}`, { allow404: true })).status === 200
  if (!exists) {
    if (dryRun) {
      console.log(`  + 创建仓库 ${slug}（${flag('private') ? '私有' : '公开'}）`)
    } else {
      await gh('POST', '/user/repos', {
        body: {
          name: repo,
          description: pkg.description,
          homepage: `https://github.com/${slug}`,
          private: flag('private'),
          has_issues: true,
          has_wiki: false,
          auto_init: false,
        },
      })
      console.log(`  ✔ 已创建仓库 ${slug}`)
      exists = true
    }
  } else {
    console.log('  · 仓库已存在，改为推送当前工作树')
  }

  // Only touched when asked for: an existing repository's description is the
  // owner's, and silently rewriting it would be a surprise.
  const description = option('description', '')
  if (description && !dryRun) {
    await gh('PATCH', `/repos/${slug}`, { body: { description, homepage: `https://github.com/${slug}` } })
    console.log(`  ✔ 描述已更新`)
  }

  if (exists || dryRun) {
    const result = await pushTree({ owner, repo, branch, message: `release: ${pkg.name}@${pkg.version}` })
    if (result.dryRun) console.log(`  + 将写入 ${result.entries} 个树条目`)
    else console.log(result.pushed ? `  ✔ 已推送 ${result.commit}` : '  · 没有变化')
  }

  const topics = ['dsh', 'dsh-plugin', 'deepseek-harness', 'cordis', 'github', 'session', 'sync', 'backup']
  if (dryRun) {
    console.log(`  + topics: ${topics.join(', ')}`)
    return
  }
  await gh('PUT', `/repos/${slug}/topics`, { body: { names: topics } })
  console.log(`  ✔ topics: ${topics.join(', ')}`)
  console.log(`\n安装命令：dsh plugin --profile web add github:${slug}`)
}

async function cmdRegistry() {
  const { pkg, owner, repo, slug } = await target()
  const upstream = option('upstream', DEFAULT_UPSTREAM)
  const [upOwner, upRepo] = upstream.split('/')
  const entryPath = `data/plugins/${owner}__${repo}.yml`
  const entryFile = join(ROOT, 'docs', 'registry-entry.yml')

  if (!fs.existsSync(entryFile)) throw new Error(`缺少上架条目文件：${entryFile}`)
  const entryBody = await fsp.readFile(entryFile, 'utf8')

  const repoInfo = await gh('GET', `/repos/${slug}`, { allow404: true })
  if (repoInfo.status === 404) throw new Error(`先发布仓库：node scripts/publish-github.mjs repo`)
  const ageMs = Date.now() - new Date(repoInfo.json.created_at).getTime()
  if (ageMs < MIN_REPO_AGE_MS) {
    const hours = Math.ceil((MIN_REPO_AGE_MS - ageMs) / 3600000)
    throw new Error(`仓库创建不足 1 天（还差约 ${hours} 小时），上架 CI 会拒绝；稍后再跑本命令`)
  }

  const branch = `entry/${owner}-${repo}`
  console.log(`提交上架条目 ${entryPath} → ${upstream}`)

  if (dryRun) {
    console.log(`  + fork ${upstream}`)
    console.log(`  + 分支 ${branch}`)
    console.log(`  + 文件 ${entryPath}`)
    console.log(entryBody)
    return
  }

  await gh('POST', `/repos/${upOwner}/${upRepo}/forks`, { body: {} })
  for (let i = 0; i < 20; i += 1) {
    const fork = await gh('GET', `/repos/${owner}/${upRepo}`, { allow404: true })
    if (fork.status === 200) break
    await sleep(3000)
  }

  const upstreamHead = await gh('GET', `/repos/${upOwner}/${upRepo}/git/ref/heads/main`)
  const baseSha = upstreamHead.json.object.sha
  const { json: baseCommit } = await gh('GET', `/repos/${upOwner}/${upRepo}/git/commits/${baseSha}`)

  const { json: blob } = await gh('POST', `/repos/${owner}/${upRepo}/git/blobs`, {
    body: { content: Buffer.from(entryBody, 'utf8').toString('base64'), encoding: 'base64' },
  })
  const { json: tree } = await gh('POST', `/repos/${owner}/${upRepo}/git/trees`, {
    body: { base_tree: baseCommit.tree.sha, tree: [{ path: entryPath, mode: '100644', type: 'blob', sha: blob.sha }] },
  })
  const { json: commit } = await gh('POST', `/repos/${owner}/${upRepo}/git/commits`, {
    body: { message: `add ${owner}/${repo}`, tree: tree.sha, parents: [baseSha] },
  })
  await gh('POST', `/repos/${owner}/${upRepo}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: commit.sha } })

  const { json: pr } = await gh('POST', `/repos/${upOwner}/${upRepo}/pulls`, {
    body: {
      title: `Add ${owner}/${repo}`,
      head: `${owner}:${branch}`,
      base: 'main',
      body: [
        `Adds \`${entryPath}\`.`,
        '',
        `- 仓库：https://github.com/${slug}`,
        `- 声明 \`dsh.bundle.patch\`：${pkg.dsh?.bundle?.patch || '—'}`,
        `- 类别：${(entryBody.match(/^category:\s*(.+)$/m) || [, '?'])[1]}`,
      ].join('\n'),
    },
  })
  console.log(`  ✔ PR #${pr.number} ${pr.html_url}`)
}

const commands = { status: cmdStatus, repo: cmdRepo, registry: cmdRegistry }
const run = commands[command]
if (!run) {
  console.error(`unknown command "${command}" — use status | repo | registry`)
  process.exit(2)
}
if (command !== 'status' && !TOKEN && !dryRun) {
  console.error('缺少令牌：请设置 GITHUB_TOKEN（fine-grained PAT，需要 Contents: write；创建仓库还需要 Administration: write）')
  process.exit(2)
}
run().catch((error) => {
  console.error(`失败：${error.message}`)
  process.exit(1)
})
