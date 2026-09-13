/**
 * dsh-github-sync — filesystem layout of a dsh installation.
 *
 * Everything this plugin mirrors lives under `$DSH_HOME` (default `~/.dsh`):
 *
 *   sessions/<workspaceKey>/<sessionId>/session[.vN].jsonl.zstd
 *   profiles/<profile>/{package.json,cordis.patch.yml,pnpm-lock.yaml,pnpm-workspace.yaml}
 *   settings.yaml
 *   dsh-github-sync/{state.json,config.json,snapshots/}   ← this plugin
 *
 * The module is dependency-free on purpose: pure path arithmetic plus a little
 * `fs` reading, so the whole sync engine stays testable outside a harness.
 *
 * Two facts drive the shape of this file, both verified against the harness
 * sources (`dsh-session-persistence-jsonl`):
 *   - a project directory name is `projectKey(cwd)`, a *lossy* encoding;
 *   - a session directory may hold several generations of the log at once
 *     (`session.jsonl.zstd` plus a newer `session.vN.jsonl.zstd`), so a backup
 *     must copy the whole directory, never "the newest file".
 */

import fs from 'node:fs'
import fsP from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** Plugin state directory name under `$DSH_HOME`. */
export const STATE_DIR_NAME = 'dsh-github-sync'

/** `$DSH_HOME`, honouring the env override the harness itself uses. */
export function dshHome(env = process.env) {
  return env.DSH_HOME ? resolve(env.DSH_HOME) : join(homedir(), '.dsh')
}

/** `~`-abbreviated form for display in the UI (never used for IO). */
export function displayPath(p) {
  const home = homedir()
  if (p === home) return '~'
  if (p.startsWith(home + sep)) return '~' + p.slice(home.length)
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length)
  return p
}

// ── Workspace directory keys ─────────────────────────────────────────────
//
// A workspace directory becomes exactly one `sessions/<key>/` folder. Observed:
//
//   C:\Users\me\.dsh                     → --C-Users-me-.dsh--
//   D:\Program Files\JetBrains\dsh-plugin → --D-Program~0020Files-JetBrains-dsh-plugin--
//
// i.e. `[A-Za-z0-9._-]` pass through, `~` and every other unsafe code unit
// become `~XXXX` (uppercase hex), runs of `/ \ :` collapse into one `-`,
// leading dashes are dropped, the segment is capped at 251 chars, and the
// whole thing is wrapped in `--…--`.

const WORKSPACE_SAFE = /^[A-Za-z0-9._-]$/

/**
 * Mirror of the harness's `projectKey()` — keep the two in step, because a
 * mismatch would write a restored session into a folder the harness never
 * looks at.
 */
export function encodeWorkspaceKey(dir) {
  const raw = String(dir)
  let out = ''
  let separatorRun = false
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) out += '-'
      separatorRun = true
    } else if (ch !== '~' && WORKSPACE_SAFE.test(ch)) {
      out += ch
      separatorRun = false
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(out.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Best-effort inverse of {@link encodeWorkspaceKey}, for display only.
 * The harness encoding is intentionally lossy (`:`, `\` and `/` all become
 * `-`), so a decoded key is a hint and never a path to write to.
 */
export function decodeWorkspaceKey(key) {
  let s = String(key)
  if (s.startsWith('--') && s.endsWith('--')) s = s.slice(2, -2)
  s = s.replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  s = s.replace(/-/g, '\\')
  if (/^[A-Za-z]\\/.test(s)) s = s[0] + ':' + s.slice(1)
  return s
}

/** Absolute paths of every workspace session folder that exists locally. */
export async function listWorkspaceDirs(home = dshHome()) {
  const root = join(home, 'sessions')
  let entries
  try {
    entries = await fsP.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith('--'))
    .map((e) => ({ key: e.name, dir: join(root, e.name) }))
}

/**
 * Profile names (`web`, `dsh-tui`, …) that are initialised under `profiles/`.
 * There is no enumeration API in the harness, so this walks the directory and
 * treats "has a package.json" as the test.
 */
export async function listProfiles(home = dshHome()) {
  const root = join(home, 'profiles')
  let entries
  try {
    entries = await fsP.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules') continue
    try {
      await fsP.access(join(root, e.name, 'package.json'))
      out.push(e.name)
    } catch {
      /* not an initialised profile */
    }
  }
  return out.sort()
}

/** Synchronous profile probe, used where the caller cannot await. */
export function profileExists(profile, home = dshHome()) {
  try {
    return fs.existsSync(join(home, 'profiles', profile, 'package.json'))
  } catch {
    return false
  }
}

/**
 * Files inside a session directory that are not part of the session: local
 * caches, locks and half-written temporaries. Everything else is copied
 * byte-for-byte, including older log generations.
 */
const SESSION_EXCLUDE_NAMES = new Set(['session.lock', 'session_projcache.json'])

export function isExcludedSessionFile(name) {
  if (SESSION_EXCLUDE_NAMES.has(name)) return true
  if (name.endsWith('.tmp')) return true
  if (name.startsWith('.dsh-mkdir')) return true
  return false
}

/**
 * Files that describe a profile's plugin set. `cordis.yml` is deliberately
 * absent: the launcher rewrites it on every boot. `node_modules/` is never
 * walked at all.
 */
export const PLUGIN_MANIFEST_FILES = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
