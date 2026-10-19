/**
 * Append one bundle name to a DSH profile's `dsh.profile.bundles` list.
 *
 * The DSH plugin manager would do this for us, but a manual install runs plain
 * `pnpm add`; this helper keeps the manifest edit lossless (UTF-8, no BOM) so the
 * profile loads the plugin on its next start.
 *
 * Usage:
 *   node scripts/install-bundle-entry.mjs <path-to-profile-package.json> [bundle-name]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const manifestPath = process.argv[2]
if (manifestPath === undefined) {
  console.error('usage: node scripts/install-bundle-entry.mjs <path-to-profile-package.json> [bundle-name]')
  process.exit(1)
}

const bundleName = process.argv[3] ?? JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
).name

const target = resolve(manifestPath)
const manifest = JSON.parse(readFileSync(target, 'utf8'))
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
if (!bundles.includes(bundleName)) bundles.push(bundleName)
manifest.dsh.profile.bundles = bundles
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`profile bundles: ${bundles.join(', ')}`)
