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

/**
 * The command that brings one backup-declared plugin onto this machine.
 * Versions are pinned to what the backup recorded, so a restore reproduces the
 * machine it came from rather than drifting to the latest release.
 */
export function installCommand(profile, pkg) {
  const version = String(pkg.spec || '').replace(/^[\^~>=<\s]+/, '')
  const spec = version && /^\d/.test(version) ? `${pkg.name}@${version}` : pkg.name
  return `dsh plugin --profile ${profile} add ${spec}`
}
