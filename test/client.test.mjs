/**
 * Client-half contract tests.
 *
 * The bundle is evaluated the way the web shell evaluates it: a `window`
 * carrying `__ModuleLoader__`, whose `load()` captures the registration. That
 * proves the three things the shell actually checks — the registration id
 * equals the package name, the factory returns a plugin object, and `apply`
 * registers a `settings.section` inside a disposer.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const bundleSource = fs.readFileSync(new URL('../client/bundle.js', import.meta.url), 'utf8')

/** Evaluate the bundle and return `{ registrations, plugin, ctx }`. */
function loadClientBundle() {
  const registrations = []
  const fakeRequire = (spec) => {
    if (spec === 'react') return null // force the shim hooks
    throw new Error(`unexpected platform module in test: ${spec}`)
  }
  const context = {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
    require: fakeRequire,
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    document: undefined,
  }
  vm.createContext(context)
  vm.runInContext(bundleSource, context)

  const registration = registrations[0]
  const plugin = registration.factory(fakeRequire)

  const slots = []
  const locales = []
  const effects = []
  const ctx = {
    slots: {
      inject: (name, callback) => {
        slots.push({ kind: 'inject', name })
        const disposer = callback()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      register: (options, Component) => {
        slots.push({ kind: 'register', options, Component })
        return () => {}
      },
    },
    locale: {
      register: (ns, lang, dict) => {
        locales.push({ ns, lang, dict })
        return () => {}
      },
      bind: () => (key) => `t:${key}`,
    },
    effect: (fn, label) => {
      effects.push({ label, disposer: fn() })
      return () => {}
    },
  }
  return { registrations, plugin, ctx, slots, locales, effects }
}

test('the bundle registers under the package name, as the shell requires', () => {
  const { registrations } = loadClientBundle()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, pkg.name)
  assert.equal(typeof registrations[0].factory, 'function')
})

test('the client plugin exports the client-plane contract', () => {
  const { plugin } = loadClientBundle()
  assert.equal(plugin.name, pkg.name)
  assert.deepEqual([...plugin.inject], ['slots', 'locale'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers one settings section and both locales, inside effects', () => {
  const { plugin, ctx, slots, locales, effects } = loadClientBundle()
  plugin.apply(ctx)

  assert.deepEqual(locales.map((l) => `${l.ns}:${l.lang}`), ['dsh-github-sync:zh', 'dsh-github-sync:en'])
  assert.equal(Object.keys(locales[0].dict).length > 30, true, 'the zh dictionary is substantive')

  const injected = slots.find((s) => s.kind === 'inject')
  assert.equal(injected.name, 'settings.section')
  const registration = slots.find((s) => s.kind === 'register')
  assert.equal(registration.options.name, 'settings.section')
  assert.equal(registration.options.id, pkg.name, 'list-slot registrations collide by id, so it must be unique')
  assert.equal(registration.options.locale, 'dsh-github-sync')
  assert.equal(registration.options.label(), 't:title', 'the nav label is resolved through the bound translator')

  assert.equal(effects.length, 1, 'the registration is owned by an effect so unload removes it')
  assert.equal(typeof effects[0].disposer, 'function')
})

test('the settings surface renders without a DOM', () => {
  const { plugin, ctx, slots } = loadClientBundle()
  plugin.apply(ctx)
  const { Component } = slots.find((s) => s.kind === 'register')
  assert.equal(typeof Component, 'function')

  // Walk the same chain React would: slot component → section wrapper → page.
  const slotElement = Component()
  assert.equal(typeof slotElement.type, 'function')
  const wrapperElement = slotElement.type(slotElement.props)
  const page = wrapperElement.type(wrapperElement.props)

  assert.equal(page.type, 'div')
  assert.equal(page.props.className, 'dgs-root')
  assert.equal(Array.isArray(page.kids), true)
  assert.equal(page.kids.length > 4, true)
})
