'use strict'
const { createReadStream } = require('node:fs')
const { readdir, writeFile } = require('node:fs/promises')
const { createHash } = require('node:crypto')
const { join } = require('node:path')

async function main() {
  const files = (await readdir('dist')).filter(name => /\.(dmg|exe|appx|msix|AppImage|deb|tar\.gz)$/.test(name)).sort()
  if (!files.length) throw new Error('No release artifacts found in dist.')
  const lines = []
  for (const file of files) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(join('dist', file))) hash.update(chunk)
    lines.push(`${hash.digest('hex')}  ${file}`)
  }
  await writeFile('dist/SHA256SUMS', lines.join('\n') + '\n')
  console.log(`Checksums written for ${files.length} artifact(s).`)
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
