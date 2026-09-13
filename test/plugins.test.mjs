import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { diffProfilePlugins, installCommand, readAllProfiles, readProfilePlugins } from '../src/plugins.js'

/** A profile directory with a manifest and (optionally) installed packages. */
async function makeProfile(home, profile, { dependencies = {}, bundles = [], installed = {} } = {}) {
  const dir = join(home, 'profiles', profile)
  await fsp.mkdir(join(dir, 'node_modules'), { recursive: true })
  await fsp.writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: `dsh-profile-${profile}`, private: true, dependencies, dsh: { profile: { bundles } } }),
  )
  for (const [name, version] of Object.entries(installed)) {
    const pkgDir = join(dir, 'node_modules', name)
    await fsp.mkdir(pkgDir, { recursive: true })
    await fsp.writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name, version }))
  }
  return dir
}

test('readProfilePlugins reports the spec, the installed version and bundle membership', async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'dshgs-plugins-'))
  await makeProfile(home, 'web', {
    dependencies: { 'dsh-browser': '^0.1.0', 'dsh-context': '^0.50.0' },
    bundles: ['dsh-browser'],
    installed: { 'dsh-browser': '0.1.0' },
  })

  const profile = await readProfilePlugins(home, 'web')
  assert.equal(profile.profile, 'web')
  assert.deepEqual(profile.bundles, ['dsh-browser'])
  const browser = profile.packages.find((p) => p.name === 'dsh-browser')
  assert.deepEqual(browser, { name: 'dsh-browser', spec: '^0.1.0', installedVersion: '0.1.0', bundle: true })
  const context = profile.packages.find((p) => p.name === 'dsh-context')
  assert.equal(context.installedVersion, undefined, 'not installed on disk')
  assert.equal(context.bundle, false)
})

test('readAllProfiles finds every initialised profile and survives a broken manifest', async () => {
  const home = await fsp.mkdtemp(join(tmpdir(), 'dshgs-profiles-'))
  await makeProfile(home, 'web', { dependencies: { a: '1.0.0' } })
  await makeProfile(home, 'tui', { dependencies: { b: '2.0.0' } })
  await fsp.writeFile(join(home, 'profiles', 'tui', 'package.json'), '{ broken')

  const profiles = await readAllProfiles(home)
  assert.deepEqual(profiles.map((p) => p.profile), ['tui', 'web'])
  assert.equal(profiles.find((p) => p.profile === 'tui').error !== undefined, true)
  assert.deepEqual(profiles.find((p) => p.profile === 'web').packages.map((p) => p.name), ['a'])
})

test('diffProfilePlugins separates "install this" from "push this"', () => {
  const local = [
    { profile: 'web', packages: [
      { name: 'keep', spec: '^1.0.0', installedVersion: '1.0.0', bundle: true },
      { name: 'local-only', spec: '^2.0.0', installedVersion: '2.0.0', bundle: false },
      { name: 'drifted', spec: '^1.0.0', installedVersion: '1.0.0', bundle: false },
    ] },
  ]
  const cloud = {
    web: { packages: [
      { name: 'keep', spec: '^1.0.0' },
      { name: 'from-the-other-machine', spec: '^3.1.0' },
      { name: 'drifted', spec: '^2.0.0' },
    ] },
  }

  const [{ profile, added, missing, changed, same }] = diffProfilePlugins(local, cloud).profiles
  assert.equal(profile, 'web')
  assert.deepEqual(added.map((p) => p.name), ['from-the-other-machine'])
  assert.deepEqual(missing.map((p) => p.name), ['local-only'])
  assert.deepEqual(changed, [{ name: 'drifted', localSpec: '^1.0.0', cloudSpec: '^2.0.0', installedVersion: '1.0.0' }])
  assert.equal(same, 1)
})

test('diffProfilePlugins reports a profile that exists on only one side', () => {
  const local = [{ profile: 'web', packages: [{ name: 'a', spec: '1.0.0', bundle: false }] }]
  const onlyCloud = diffProfilePlugins(local, { desktop: { packages: [{ name: 'z', spec: '^9.0.0' }] } })
  const desktop = onlyCloud.profiles.find((p) => p.profile === 'desktop')
  assert.deepEqual(desktop.added.map((p) => p.name), ['z'])
  assert.deepEqual(desktop.missing, [])
  const web = onlyCloud.profiles.find((p) => p.profile === 'web')
  assert.deepEqual(web.missing.map((p) => p.name), ['a'])
})

test('installCommand pins the version the backup recorded', () => {
  assert.equal(installCommand('web', { name: 'dsh-browser', spec: '^0.1.0' }), 'dsh plugin --profile web add dsh-browser@0.1.0')
  assert.equal(installCommand('web', { name: '@a9i5k4/dsh-auto-memory', spec: '~2.4.2' }), 'dsh plugin --profile web add @a9i5k4/dsh-auto-memory@2.4.2')
  // A git or path spec cannot be turned into a version — install it by name.
  assert.equal(installCommand('web', { name: 'x', spec: 'github:owner/x' }), 'dsh plugin --profile web add x')
  assert.equal(installCommand('tui', { name: 'y' }), 'dsh plugin --profile tui add y')
})
