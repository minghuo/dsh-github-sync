/**
 * dsh-github-sync — plugin manifests.
 *
 * What this plugin mirrors is a profile's *declaration*: its `dependencies`
 * and the `dsh.profile.bundles` layer list. Giving those two documents a
 * readable diff is what turns "the backup ran" into "these three plugins are
 * missing on this machine, install them with this command".
 *
 * A profile is initialised per dsh installation, so the inventory is read
 * straight off disk rather than through any service.
 */

import fsP from 'node:fs/promises'
import { join } from 'node:path'

import { listProfiles } from './paths.js'

/** The manifest fields a profile's plugin set is declared in. */
const MANIFEST_FILES = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']

/**
 * Installed version of one package inside a profile.
 *
 * pnpm's `nodeLinker: hoisted` puts direct dependencies in the profile's own
 * `node_modules`, but a linked or hoisted package can live one level up, so
 * both locations are consulted.
 */
async function installedVersion(home, profile, name) {
  const roots = [join(home, 'profiles', profile, 'node_modules', name), join(home, 'profiles', 'node_modules', name)]
  for (const root of roots) {
    const raw = await fsP.readFile(join(root, 'package.json'), 'utf8').catch(() => null)
    if (!raw) continue
    try {
      const manifest = JSON.parse(raw)
      if (typeof manifest.version === 'string') return manifest.version
    } catch {
      /* unreadable manifest — treat as not installed */
    }
  }
  return undefined
}

/**
 * One profile's declared plugins, with what is actually installed.
 * @returns `{ profile, packages: Array<{name, spec, installedVersion, bundle}>, bundles }`
 */
export async function readProfilePlugins(home, profile) {
  const raw = await fsP.readFile(join(home, 'profiles', profile, 'package.json'), 'utf8').catch(() => null)
  if (!raw) return { profile, packages: [], bundles: [] }
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch {
    return { profile, packages: [], bundles: [], error: 'package.json 不是合法 JSON' }
  }
  const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || []
  const dependencies = manifest.dependencies || {}
  const packages = []
  for (const [name, spec] of Object.entries(dependencies)) {
    packages.push({
      name,
      spec: String(spec),
      installedVersion: await installedVersion(home, profile, name),
      bundle: Array.isArray(bundles) && bundles.includes(name),
    })
  }
  packages.sort((a, b) => a.name.localeCompare(b.name))
  return { profile, packages, bundles: Array.isArray(bundles) ? bundles : [] }
}

/** Every initialised profile on this machine. */
export async function readAllProfiles(home) {
  const profiles = await listProfiles(home)
  const out = []
  for (const profile of profiles) out.push(await readProfilePlugins(home, profile))
  return out
}

/** The manifest file names a profile backup contains, for a UI to name them. */
export const PROFILE_MANIFEST_FILES = MANIFEST_FILES

/**
 * Compare what this machine declares against what a backup declares.
 *
 * @param {Array} local   `readAllProfiles()` output
 * @param {object} cloud  `{ [profile]: { packages: Array<{name, spec}> } }`
 * @returns `{ profiles: Array<{profile, added, missing, changed, same}> }` where
 *   `added` is "in the backup, not here" (something to install) and `missing`
 *   is "here, not in the backup" (something to push).
 */
export function diffProfilePlugins(local, cloud = {}) {
  const profiles = new Set([...local.map((p) => p.profile), ...Object.keys(cloud)])
  const result = []
  for (const profile of [...profiles].sort()) {
    const mine = new Map((local.find((p) => p.profile === profile)?.packages || []).map((p) => [p.name, p]))
    const theirs = new Map(((cloud[profile] && cloud[profile].packages) || []).map((p) => [p.name, p]))

    const added = []
    const missing = []
    const changed = []
    const same = []
    for (const [name, pkg] of theirs) {
      if (!mine.has(name)) {
        added.push({ name, spec: pkg.spec, installedVersion: pkg.installedVersion })
        continue
      }
      const local_ = mine.get(name)
      if (local_.spec !== pkg.spec) changed.push({ name, localSpec: local_.spec, cloudSpec: pkg.spec, installedVersion: local_.installedVersion })
      else same.push(name)
    }
    for (const [name, pkg] of mine) if (!theirs.has(name)) missing.push({ name, spec: pkg.spec, installedVersion: pkg.installedVersion })

    result.push({
      profile,
      added: added.sort((a, b) => a.name.localeCompare(b.name)),
      missing: missing.sort((a, b) => a.name.localeCompare(b.name)),
      changed: changed.sort((a, b) => a.name.localeCompare(b.name)),
      same: same.length,
    })
  }
  return { profiles: result }
}

/** The version a range spec points at (`^2.4.2` → `2.4.2`), or undefined. */
export function versionFromSpec(spec) {
  const version = String(spec || '').replace(/^[\^~>=<\s]+/, '')
  return /^\d/.test(version) ? version : undefined
}

/**
 * The command that brings one backup-declared plugin onto this machine.
 * Versions are pinned to what the backup recorded, so a restore reproduces the
 * machine it came from rather than drifting to the latest release.
 */
export function installCommand(profile, pkg) {
  const version = versionFromSpec(pkg.spec)
  return `dsh plugin --profile ${profile} add ${version ? `${pkg.name}@${version}` : pkg.name}`
}

/** Numeric parts of a version, so `1.10.0` compares greater than `1.9.9`. */
function versionParts(value) {
  return String(value || '')
    .replace(/^[^\d]*/, '')
    .split(/[.+-]/)
    .slice(0, 4)
    .map((part) => Number.parseInt(part, 10) || 0)
}

/** `1` when `a` is newer than `b`, `-1` when older, `0` when equal. */
export function compareVersions(a, b) {
  const left = versionParts(a)
  const right = versionParts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] || 0
    const r = right[i] || 0
    if (l !== r) return l > r ? 1 : -1
  }
  return 0
}

/** Package names a command may be built from. */
const SAFE_NAME = /^[@a-zA-Z0-9][\w@/.-]*$/

/**
 * The single argument `add` receives.
 *
 * A version range becomes `name@version`; a git, url or path specification is
 * passed through as-is (that *is* the source); anything else falls back to the
 * bare name.
 */
export function packageSpecArg({ name, spec } = {}) {
  const version = versionFromSpec(spec)
  if (version) return `${name}@${version}`
  const raw = String(spec || '')
  if (/^(github:|git\+|https?:|file:|link:|\.{1,2}\/)/.test(raw)) return raw
  return name
}

/**
 * What to do about the plugins another machine declares.
 *
 * `install` is a package this machine does not have; `update` is one it has at
 * a **lower** version than the backup declares. A package this machine already
 * matches — or leads — is left alone: the goal is to reach the other machine's
 * state, not to downgrade to it.
 *
 * @param {Array} local  `readAllProfiles()` output
 * @param {object} cloud `{ [profile]: { packages } }` union across other machines
 * @returns `{ actions }`, each `{ profile, name, kind, from, to, spec, command }`
 */
export function planPluginActions(local, cloud = {}) {
  const actions = []
  for (const row of diffProfilePlugins(local, cloud).profiles) {
    for (const pkg of row.added) {
      if (!SAFE_NAME.test(pkg.name)) continue
      actions.push({
        profile: row.profile,
        name: pkg.name,
        kind: 'install',
        to: versionFromSpec(pkg.spec),
        spec: pkg.spec,
        arg: packageSpecArg(pkg),
        command: installCommand(row.profile, pkg),
      })
    }
    for (const pkg of row.changed) {
      if (!SAFE_NAME.test(pkg.name)) continue
      const target = versionFromSpec(pkg.cloudSpec)
      if (!target || !pkg.installedVersion) continue
      if (compareVersions(target, pkg.installedVersion) <= 0) continue
      actions.push({
        profile: row.profile,
        name: pkg.name,
        kind: 'update',
        from: pkg.installedVersion,
        to: target,
        spec: pkg.cloudSpec,
        arg: packageSpecArg({ name: pkg.name, spec: pkg.cloudSpec }),
        command: installCommand(row.profile, { name: pkg.name, spec: pkg.cloudSpec }),
      })
    }
  }
  return { actions: actions.sort((a, b) => `${a.profile}/${a.name}`.localeCompare(`${b.profile}/${b.name}`)) }
}
