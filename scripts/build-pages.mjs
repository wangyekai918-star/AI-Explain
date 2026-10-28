import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = new URL('../', import.meta.url)
const site = new URL('docs/', root)
// docs/ is generated static output; keep source documentation at repository root.
await mkdir(site, { recursive: true })
for (const entry of await readdir(site)) await rm(new URL(entry, site), { recursive: true, force: true })
await cp(new URL('dist/', root), site, { recursive: true })
await writeFile(new URL('.nojekyll', site), '')
console.log(`GitHub Pages output: ${fileURLToPath(site)}`)
