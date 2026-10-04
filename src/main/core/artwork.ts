import { net, protocol } from 'electron'
import { createHash } from 'node:crypto'
import { open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dataDir } from './store'
import { FsBoundary } from '../providers/epic/fsBoundary'

const MAX_BYTES = 12 * 1024 * 1024
protocol.registerSchemesAsPrivileged([{ scheme: 'gamekins-art', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

/** Read dimensions from headers. Bitmap decoding happens in Chromium's image decoder. */
function dimensions(data: Buffer): { width: number; height: number; extension: string } {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), extension: 'png' }
  }
  if (data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const type = data.toString('ascii', 12, 16)
    if (type === 'VP8X') return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3), extension: 'webp' }
    if (type === 'VP8L' && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, extension: 'webp' }
    }
    if (type === 'VP8 ' && data.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff, extension: 'webp' }
    }
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let pos = 2
    while (pos + 4 <= data.length) {
      if (data[pos++] !== 0xff) break
      while (data[pos] === 0xff) pos++
      const marker = data[pos++]
      if (marker === 0xd9 || marker === 0xda) break
      const size = data.readUInt16BE(pos)
      if (size < 2 || pos + size > data.length) break
      if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) {
        return { width: data.readUInt16BE(pos + 5), height: data.readUInt16BE(pos + 3), extension: 'jpg' }
      }
      pos += size
    }
  }
  throw new Error('Choose a PNG, JPEG or WebP image')
}

export async function cacheArtwork(data: Buffer): Promise<string> {
  if (data.length > MAX_BYTES) throw new Error('Artwork must be smaller than 12 MiB')
  const { width, height, extension } = dimensions(data)
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16_000_000) throw new Error('Artwork dimensions exceed the supported limit')
  const name = `${createHash('sha256').update(data).digest('hex')}.${extension}`
  const root = dataDir('artwork-files')
  const file = join(root, name)
  await (await FsBoundary.create(root)).check(file)
  try { await writeFile(file, data, { flag: 'wx' }) }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err }
  return `gamekins-art://image/${name}`
}

export async function artworkFromFile(file: string): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const size = await handle.stat()
    if (!size.isFile() || size.size > MAX_BYTES) throw new Error('Artwork must be a file smaller than 12 MiB')
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    return cacheArtwork(buffer.subarray(0, length))
  } finally { await handle.close() }
}

export function registerArtworkProtocol(): void {
  protocol.handle('gamekins-art', async (request) => {
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.hostname !== 'image' || url.search || !/^\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(url.pathname)) return new Response('Not found', { status: 404 })
    const root = dataDir('artwork-files')
    const file = join(root, url.pathname.slice(1))
    try {
      await (await FsBoundary.create(root)).check(file)
      return await net.fetch(pathToFileURL(file).href)
    } catch { return new Response('Not found', { status: 404 }) }
  })
}
