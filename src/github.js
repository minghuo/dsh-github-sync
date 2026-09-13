'use strict'

/**
 * A small GitHub REST client, built on the global `fetch`.
 *
 * The plugin talks to GitHub **only** over HTTPS: no `git` binary, no working
 * tree, no credential stored in `.git/config`. That keeps the token inside the
 * host process, makes the plugin work on machines without git, and lets the
 * whole transport be exercised in tests by injecting `fetchImpl`.
 *
 * Endpoints used (all under `https://api.github.com`):
 *   GET    /repos/{o}/{r}
 *   GET    /repos/{o}/{r}/git/ref/heads/{branch}
 *   GET    /repos/{o}/{r}/git/commits/{sha}
 *   GET    /repos/{o}/{r}/git/trees/{sha}?recursive=1
 *   GET    /repos/{o}/{r}/git/blobs/{sha}
 *   POST   /repos/{o}/{r}/git/blobs
 *   POST   /repos/{o}/{r}/git/trees
 *   POST   /repos/{o}/{r}/git/commits
 *   POST   /repos/{o}/{r}/git/refs
 *   PATCH  /repos/{o}/{r}/git/refs/heads/{branch}
 *   POST   /repos/{o}/{r}/pulls
 *   GET    /repos/{o}/{r}/pulls/{number}
 *   PUT    /repos/{o}/{r}/pulls/{number}/merge
 */

import { createHash } from 'node:crypto'

export const DEFAULT_API_BASE = 'https://api.github.com'
const USER_AGENT = 'dsh-github-sync'

/** Error carrying the HTTP status and the decoded GitHub message. */
export class GithubError extends Error {
  constructor(message, { status, body, path } = {}) {
    super(message)
    this.name = 'GithubError'
    this.status = status
    this.body = body
    this.path = path
  }
}

/**
 * Accept every shape a user is likely to paste and return `{ owner, repo }`.
 * Supports `https://github.com/o/r(.git)`, `git@github.com:o/r.git`,
 * `ssh://git@github.com/o/r`, and the bare `o/r` shorthand.
 */
export function parseRepoUrl(input) {
  const raw = String(input || '').trim()
  if (raw === '') return null
  let m = raw.match(/^(?:https?|ssh):\/\/(?:[^@/]+@)?github\.com[/:]([^/]+)\/([^/?#]+?)(?:\.git)?(?:[/?#].*)?$/i)
  if (!m) m = raw.match(/^git@github\.com:([^/]+)\/([^/?#]+?)(?:\.git)?$/i)
  if (!m) m = raw.match(/^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:\.git)?$/)
  if (!m) return null
  return { owner: m[1], repo: m[2].replace(/\.git$/i, '') }
}

/** `owner/repo` for display. */
export function repoSlug(parsed) {
  return parsed ? `${parsed.owner}/${parsed.repo}` : ''
}

/**
 * The git object id of a byte buffer (`sha1("blob <len>\0" + body)`), so an
 * unchanged file is recognised from the remote tree listing without uploading.
 */
export function gitBlobSha(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const head = Buffer.from(`blob ${buf.length}\0`, 'utf8')
  return createHash('sha1').update(head).update(buf).digest('hex')
}

/**
 * Build a client bound to one token.
 *
 * @param {object} options
 * @param {string} options.token       fine-grained PAT with `contents:write` (+ `pull_requests:write`)
 * @param {string} [options.apiBase]   override for GitHub Enterprise
 * @param {Function} [options.fetchImpl] injected transport (tests)
 * @param {number} [options.timeoutMs] per-request abort timeout
 */
export function createGithubClient({ token, apiBase = DEFAULT_API_BASE, fetchImpl, timeoutMs = 60_000 } = {}) {
  const doFetch = fetchImpl || globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('global fetch is unavailable — Node >= 22 is required')

  /**
   * One authenticated JSON request.
   * @returns {Promise<{status:number, json:any, text:string, headers:Headers}>}
   */
  async function request(method, path, { body, accept = 'application/vnd.github+json', raw = false, allow = [] } = {}) {
    const url = path.startsWith('http') ? path : apiBase + path
    const headers = {
      accept,
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28',
    }
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'

    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
    let res
    try {
      res = await doFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      })
    } catch (error) {
      if (timer) clearTimeout(timer)
      throw new GithubError(`无法连接 GitHub（${method} ${path}）：${error && error.message ? error.message : error}`, { path })
    }
    if (timer) clearTimeout(timer)

    if (raw) {
      if (!res.ok && !allow.includes(res.status)) {
        throw new GithubError(`GitHub 返回 HTTP ${res.status}（${method} ${path}）`, { status: res.status, path })
      }
      return { status: res.status, res }
    }

    const text = await res.text()
    let json = null
    try {
      json = text === '' ? null : JSON.parse(text)
    } catch {
      /* non-JSON error page (proxy, outage) */
    }
    if (!res.ok) {
      if (allow.includes(res.status)) return { status: res.status, json, text, headers: res.headers }
      const detail = (json && (json.message || json.error)) || text.slice(0, 200) || `HTTP ${res.status}`
      throw new GithubError(`GitHub API 失败（${method} ${path}）：${detail}`, { status: res.status, body: json, path })
    }
    return { status: res.status, json, text, headers: res.headers }
  }

  const enc = encodeURIComponent

  return {
    apiBase,
    request,

    /** Repository metadata; `private` tells the caller whether mirroring is safe. */
    async getRepo(owner, repo) {
      const { json } = await request('GET', `/repos/${enc(owner)}/${enc(repo)}`)
      return json
    },

    /** The account the token belongs to (token sanity check). */
    async getUser() {
      const { json } = await request('GET', '/user')
      return json
    },

    /**
     * Resolve a branch to its commit sha, or `null` when it does not exist yet.
     *
     * Two statuses mean "nothing here": 404 for a repository that has history
     * but no such branch, and **409 `Git Repository is empty.`** for one with
     * no commits at all — the shape a freshly created backup repository has,
     * and the case the very first push has to survive.
     */
    async getBranchHead(owner, repo, branch) {
      const { status, json } = await request('GET', `/repos/${enc(owner)}/${enc(repo)}/git/ref/heads/${enc(branch)}`, {
        allow: [404, 409],
      })
      if (status === 404 || status === 409) return null
      return json && json.object ? json.object.sha : null
    },

    /** The tree sha a commit points at. */
    async getCommit(owner, repo, sha) {
      const { json } = await request('GET', `/repos/${enc(owner)}/${enc(repo)}/git/commits/${enc(sha)}`)
      return json
    },

    /**
     * When the given path was last changed on the branch.
     *
     * One commits query with `path=`, which is how the UI dates each machine's
     * backup: the branch head is common to every machine, so it cannot say
     * when *this* machine last synced.
     */
    async lastCommitDate(owner, repo, branch, path) {
      const { status, json } = await request(
        'GET',
        `/repos/${enc(owner)}/${enc(repo)}/commits?sha=${enc(branch)}&path=${enc(path)}&per_page=1`,
        { allow: [404, 409, 422] },
      )
      if (status !== 200 || !Array.isArray(json) || json.length === 0) return undefined
      const commit = json[0].commit
      return (commit && (commit.committer?.date || commit.author?.date)) || undefined
    },

    /**
     * Every path in a tree (recursive), as `Map<path, {sha,size,type}>`.
     * GitHub truncates very large listings; `truncated` is surfaced so callers
     * can refuse instead of silently syncing a partial view.
     */
    async getTreeMap(owner, repo, sha) {
      const { json } = await request('GET', `/repos/${enc(owner)}/${enc(repo)}/git/trees/${enc(sha)}?recursive=1`)
      const map = new Map()
      for (const entry of (json && json.tree) || []) {
        if (entry.type !== 'blob') continue
        map.set(entry.path, { sha: entry.sha, size: entry.size })
      }
      return { map, truncated: !!(json && json.truncated), sha: json && json.sha }
    },

    /** Base64 payload of one blob. */
    async getBlob(owner, repo, sha) {
      const { json } = await request('GET', `/repos/${enc(owner)}/${enc(repo)}/git/blobs/${enc(sha)}`)
      return Buffer.from(String((json && json.content) || '').replace(/\n/g, ''), 'base64')
    },

    /** Upload one blob, returning its sha. */
    async createBlob(owner, repo, content) {
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content)
      const { json } = await request('POST', `/repos/${enc(owner)}/${enc(repo)}/git/blobs`, {
        body: { content: buf.toString('base64'), encoding: 'base64' },
      })
      return json.sha
    },

    /**
     * Create a tree on top of `baseTree`. Entries are repo-relative paths and
     * may contain slashes; `sha: null` deletes the path.
     */
    async createTree(owner, repo, entries, baseTree) {
      const body = { tree: entries }
      if (baseTree) body.base_tree = baseTree
      const { json } = await request('POST', `/repos/${enc(owner)}/${enc(repo)}/git/trees`, { body })
      return json.sha
    },

    async createCommit(owner, repo, { message, tree, parents }) {
      const { json } = await request('POST', `/repos/${enc(owner)}/${enc(repo)}/git/commits`, {
        body: { message, tree, parents },
      })
      return json.sha
    },

    /**
     * Create or replace one file through the **Contents API**.
     *
     * This is the only way to make the *first* commit in a repository: every
     * Git Data endpoint (blobs, trees, commits) answers 409 `Git Repository is
     * empty.` until a commit exists, so a brand-new backup repository has to be
     * seeded through this route before the batch push can take over.
     */
    async putFile(owner, repo, { path, content, message, branch }) {
      const encoded = String(path)
        .split('/')
        .map((segment) => enc(segment))
        .join('/')
      const { json } = await request('PUT', `/repos/${enc(owner)}/${enc(repo)}/contents/${encoded}`, {
        body: {
          message,
          content: Buffer.from(content).toString('base64'),
          ...(branch ? { branch } : {}),
        },
      })
      return json
    },

    async createRef(owner, repo, branch, sha) {
      const { json } = await request('POST', `/repos/${enc(owner)}/${enc(repo)}/git/refs`, {
        body: { ref: `refs/heads/${branch}`, sha },
      })
      return json
    },

    /** Move (or create) a branch. `force` is required for a non-fast-forward. */
    async setRef(owner, repo, branch, sha, force = false) {
      try {
        const { json } = await request('PATCH', `/repos/${enc(owner)}/${enc(repo)}/git/refs/heads/${enc(branch)}`, {
          body: { sha, force },
        })
        return json
      } catch (error) {
        if (error instanceof GithubError && error.status === 404) return this.createRef(owner, repo, branch, sha)
        throw error
      }
    },

    async createPull(owner, repo, { title, head, base, body }) {
      const { json } = await request('POST', `/repos/${enc(owner)}/${enc(repo)}/pulls`, {
        body: { title, head, base, body },
      })
      return json
    },

    async getPull(owner, repo, number) {
      const { json } = await request('GET', `/repos/${enc(owner)}/${enc(repo)}/pulls/${number}`)
      return json
    },

    async mergePull(owner, repo, number, mergeMethod = 'squash') {
      const { json } = await request('PUT', `/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/merge`, {
        body: { merge_method: mergeMethod },
        allow404: false,
      })
      return json
    },

    /** Open pull requests whose head is `branch` (idempotent retries). */
    async findPullByHead(owner, repo, branch) {
      const { json } = await request(
        'GET',
        `/repos/${enc(owner)}/${enc(repo)}/pulls?state=open&head=${enc(owner)}:${enc(branch)}&per_page=10`,
      )
      return Array.isArray(json) && json.length > 0 ? json[0] : null
    },
  }
}


