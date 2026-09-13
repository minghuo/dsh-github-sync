/**
 * Build `client/bundle.js` from `client/index.js`.
 *
 * The static client bundle follows the client-modules protocol: the web shell
 * evaluates the file, which calls
 *
 *   window.__ModuleLoader__.load({ id, factory })
 *
 * registering a lazy CommonJS factory. `require` handed to the factory
 * resolves framework modules (`react`, `react-dom/client`,
 * `@deepseek-ai/dsh-client-ui-primitives`, …); everything else must be inlined
 * by hand — there is no bundler in this package.
 *
 * This script only adds the scaffolding: a `React` binding plus
 * `module`/`exports`. The `id` must equal the package name, because the shell
 * associates a client bundle with the plugin row by package name.
 *
 * Run: `npm run build:client`
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const sourcePath = join(root, 'client', 'index.js')
const bundlePath = join(root, 'client', 'bundle.js')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const source = readFileSync(sourcePath, 'utf8')

const banner = `/* Generated from client/index.js by scripts/build-client.mjs — do not edit by hand.
 * Regenerate with: npm run build:client
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    var React = require("react")
`

const footer = `
    return module.exports
  }
})
`

const indented = source
  .split('\n')
  .map((line) => (line.length === 0 ? line : '    ' + line))
  .join('\n')

writeFileSync(bundlePath, banner + indented + footer)
console.log(`built ${bundlePath}`)
