/**
 * An in-memory GitHub stand-in with the same surface as
 * `createGithubClient()` (src/github.js), so the sync engine can be driven end
 * to end without a network round trip.
 */

import { createHash } from 'node:crypto'

const blobSha = (buf) => createHash('sha1').update(Buffer.from(`blob ${buf.length}\0`)).update(buf).digest('hex')
const objectSha = (seed) => createHash('sha1').update(seed).digest('hex')

/** GitHub's answer for any Git Data write against a repository with no commits. */
function emptyRepo() {
  const error = new Error('Git Repository is empty.')
  error.status = 409
  return error
}

export function createFakeGithub({ branch = 'main', initialFiles = {} } = {}) {
  const blobs = new Map()
  const trees = new Map()
  const commits = new Map()
  const refs = new Map()
  const pulls = []
  const calls = []
  let seq = 0
  const next = (kind) => objectSha(`${kind}:${seq++}`)

  const snapshot = new Map()
  for (const [path, content] of Object.entries(initialFiles)) {
    const buf = Buffer.from(content)
    const sha = blobSha(buf)
    blobs.set(sha, buf)
    snapshot.set(path, { sha, size: buf.length })
  }
  if (snapshot.size > 0 || initialFiles.__force) {
    const tree = next('tree')
    trees.set(tree, new Map(snapshot))
    const commit = next('commit')
    commits.set(commit, { tree, parents: [], message: 'seed', committer: { date: new Date().toISOString() } })
    refs.set(branch, commit)
  }

  return {
    blobs,
    trees,
    commits,
    refs,
    pulls,
    calls,
    owner: 'acme',
    repo: 'dsh-backup',

    async getRepo() {
      return { full_name: 'acme/dsh-backup', private: true, default_branch: branch }
    },

    async getBranchHead(owner, repo, name) {
      calls.push(['getBranchHead', name])
      return refs.get(name) ?? null
    },

    async getCommit(owner, repo, sha) {
      const commit = commits.get(sha)
      if (!commit) throw new Error(`no commit ${sha}`)
      return { sha, tree: { sha: commit.tree }, parents: commit.parents, committer: commit.committer }
    },

    async getTreeMap(owner, repo, sha) {
      const map = trees.get(sha)
      if (!map) throw new Error(`no tree ${sha}`)
      return { map: new Map(map), truncated: false, sha }
    },

    /**
     * When a path last changed. A flat timestamp: the fake does not model
     * per-path history, only that the query is made and its answer surfaced.
     */
    async lastCommitDate(owner, repo, branch, path) {
      calls.push(['lastCommitDate', path])
      const head = refs.get(branch)
      if (!head) return undefined
      const commit = commits.get(head)
      return (commit && commit.committer && commit.committer.date) || undefined
    },

    async getBlob(owner, repo, sha) {
      const buf = blobs.get(sha)
      if (!buf) throw new Error(`no blob ${sha}`)
      return Buffer.from(buf)
    },

    async createBlob(owner, repo, content) {
      // Mirrors GitHub: no Git Data write works before the first commit.
      if (commits.size === 0) throw emptyRepo()
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content)
      const sha = blobSha(buf)
      blobs.set(sha, buf)
      calls.push(['createBlob', sha])
      return sha
    },

    /** The Contents API — the one route that can make a repository's first commit. */
    async putFile(owner, repo, { path, content, message = 'seed', branch = 'main' }) {
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content)
      const sha = blobSha(buf)
      blobs.set(sha, buf)
      const tree = next('tree')
      trees.set(tree, new Map([[path, { sha, size: buf.length }]]))
      const commit = next('commit')
      commits.set(commit, { tree, parents: [], message, committer: { date: new Date().toISOString() } })
      refs.set(branch, commit)
      calls.push(['putFile', path])
      return { commit: { sha: commit }, content: { path } }
    },

    async createTree(owner, repo, entries, baseTree) {
      if (commits.size === 0) throw emptyRepo()
      const map = new Map(baseTree ? trees.get(baseTree) : [])
      for (const entry of entries) {
        if (entry.sha === null) map.delete(entry.path)
        else map.set(entry.path, { sha: entry.sha, size: (blobs.get(entry.sha) || Buffer.alloc(0)).length })
      }
      const sha = next('tree')
      trees.set(sha, map)
      calls.push(['createTree', entries.length])
      return sha
    },

    async createCommit(owner, repo, { message, tree, parents }) {
      if (commits.size === 0) throw emptyRepo()
      const sha = next('commit')
      commits.set(sha, { tree, parents, message, committer: { date: new Date().toISOString() } })
      calls.push(['createCommit', message])
      return sha
    },

    async createRef(owner, repo, name, sha) {
      refs.set(name, sha)
      calls.push(['createRef', name])
      return { ref: `refs/heads/${name}`, object: { sha } }
    },

    async setRef(owner, repo, name, sha, force = false) {
      const current = refs.get(name)
      if (!current && !force) {
        refs.set(name, sha)
        return { ref: `refs/heads/${name}`, object: { sha } }
      }
      refs.set(name, sha)
      calls.push(['setRef', name])
      return { ref: `refs/heads/${name}`, object: { sha } }
    },

    async createPull(owner, repo, { title, head, base, body }) {
      const pr = { number: pulls.length + 1, title, head: { ref: head }, base: { ref: base }, body, html_url: `https://example.test/pr/${pulls.length + 1}`, state: 'open', mergeable: true }
      pulls.push(pr)
      calls.push(['createPull', head])
      return pr
    },

    async getPull(owner, repo, number) {
      return pulls.find((p) => p.number === number) ?? null
    },

    async mergePull(owner, repo, number, method = 'squash') {
      const pr = pulls.find((p) => p.number === number)
      if (!pr) throw new Error(`no pull ${number}`)
      const sha = refs.get(pr.head.ref)
      refs.set(pr.base.ref, sha)
      pr.state = 'closed'
      pr.merged = true
      calls.push(['mergePull', number, method])
      return { sha, merged: true }
    },

    async findPullByHead(owner, repo, name) {
      return pulls.find((p) => p.head.ref === name && p.state === 'open') ?? null
    },

    /** Paths currently visible on `branch` — what a fresh clone would see. */
    files(branchName = branch) {
      const head = refs.get(branchName)
      if (!head) return new Map()
      return trees.get(commits.get(head).tree)
    },
  }
}
