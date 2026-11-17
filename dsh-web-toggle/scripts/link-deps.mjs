/**
 * Make the profile's packages resolvable beside the sources, so the offline tests can
 * import `index.js` exactly as the running profile does.
 *
 * The plugin's host half imports `@deepseek-ai/schemastery` (the schema library the
 * kernel itself uses). A source checkout has no `node_modules`, so this script points
 * the checkout's `node_modules` at the profile's with a directory junction — no copy,
 * no download, no lockfile change. Idempotent: an existing link is left alone.
 *
 *   node scripts/link-deps.mjs                 # default profile (~/.dsh/profiles/desktop)
 *   node scripts/link-deps.mjs --from D:/x     # another DSH home
 *   DSH_PROFILE_DIR=... node scripts/link-deps.mjs
 */

import { existsSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const args = process.argv.slice(2)
const fromIndex = args.indexOf('--from')
const home = fromIndex >= 0 && args[fromIndex + 1] !== undefined ? args[fromIndex + 1] : homedir()
const profile = process.env.DSH_PROFILE_DIR ?? join(home, '.dsh', 'profiles', 'desktop')
const source = join(profile, 'node_modules')
const target = join(root, 'node_modules')

if (!existsSync(join(source, '@deepseek-ai', 'schemastery', 'package.json'))) {
  console.error(`deps: no schemastery under ${source}`)
  console.error('deps: point at a real DSH profile with --from <DSH home> or DSH_PROFILE_DIR.')
  process.exitCode = 1
} else if (existsSync(target)) {
  const stat = lstatSync(target)
  const linked = stat.isSymbolicLink() ? readlinkSync(target) : undefined
  console.log(`deps: ${target} already exists${linked === undefined ? '' : ` -> ${linked}`}`)
  if (linked === undefined) console.log('deps: it is a real directory; tests resolve against it.')
} else {
  try {
    symlinkSync(source, target, 'junction')
    console.log(`deps: linked ${target} -> ${source}`)
  } catch (error) {
    console.error(`deps: could not link ${target}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

// A stale link to a profile that moved is worse than no link: report it instead of
// letting the tests fail with a confusing module-not-found.
if (existsSync(target) && !existsSync(join(target, '@deepseek-ai', 'schemastery', 'package.json'))) {
  console.error(`deps: ${target} does not resolve @deepseek-ai/schemastery; remove it and re-run.`)
  process.exitCode = 1
}
