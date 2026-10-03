// Parser for Epic's build manifests (binary and legacy JSON) and chunk files.
// Format notes are based on the community reverse-engineering done for Legendary.

import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'

const MANIFEST_MAGIC = 0x44bec00c
const CHUNK_MAGIC = 0xb1fe3aa2

export const FILE_FLAG_READONLY = 1
export const FILE_FLAG_COMPRESSED = 2
export const FILE_FLAG_EXECUTABLE = 4

export interface ChunkInfo {
  /** 32 upper-case hex chars. */
  guid: string
  hash: bigint
  groupNum: number
  windowSize: number
  fileSize: number
}

export interface ChunkPart {
  guid: string
  offset: number
  size: number
}

export interface FileEntry {
  filename: string
  symlinkTarget: string
  /** SHA-1 of the complete file. */
  sha1: Buffer
  flags: number
  installTags: string[]
  parts: ChunkPart[]
  size: number
}

export interface Manifest {
  featureLevel: number
  appName: string
  buildVersion: string
  launchExe: string
  launchCommand: string
  prereqPath: string
  prereqArgs: string
  chunks: Map<string, ChunkInfo>
  files: FileEntry[]
}

class Reader {
  pos = 0
  constructor(readonly buf: Buffer) {}

  u8(): number {
    return this.buf.readUInt8(this.pos++)
  }
  u32(): number {
    const v = this.buf.readUInt32LE(this.pos)
    this.pos += 4
    return v
  }
  i32(): number {
    const v = this.buf.readInt32LE(this.pos)
    this.pos += 4
    return v
  }
  u64(): bigint {
    const v = this.buf.readBigUInt64LE(this.pos)
    this.pos += 8
    return v
  }
  i64(): number {
    const v = Number(this.buf.readBigInt64LE(this.pos))
    this.pos += 8
    return v
  }
  bytes(n: number): Buffer {
    const v = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return v
  }
  guid(): string {
    let s = ''
    for (let i = 0; i < 4; i++) s += this.u32().toString(16).padStart(8, '0')
    return s.toUpperCase()
  }
  /** Unreal FString: length-prefixed, negative length = UTF-16, both null-terminated. */
  fstring(): string {
    const len = this.i32()
    if (len === 0) return ''
    if (len < 0) {
      const n = -len * 2
      const s = this.buf.toString('utf16le', this.pos, this.pos + n - 2)
      this.pos += n
      return s
    }
    const s = this.buf.toString('utf8', this.pos, this.pos + len - 1)
    this.pos += len
    return s
  }
  list<T>(count: number, fn: () => T): T[] {
    const out: T[] = new Array(count)
    for (let i = 0; i < count; i++) out[i] = fn()
    return out
  }
}

export function parseManifest(data: Buffer): Manifest {
  if (data[0] === 0x7b /* { */) return parseJsonManifest(JSON.parse(data.toString('utf8')))
  return parseBinaryManifest(data)
}

function parseBinaryManifest(data: Buffer): Manifest {
  const head = new Reader(data)
  if (head.u32() !== MANIFEST_MAGIC) throw new Error('Not an Epic manifest (bad magic)')
  const headerSize = head.u32()
  const sizeUncompressed = head.u32()
  const sizeCompressed = head.u32()
  const sha = head.bytes(20)
  const storedAs = head.u8()
  if (storedAs & 0x2) throw new Error('Encrypted manifests are not supported')

  let body = data.subarray(headerSize)
  if (storedAs & 0x1) body = inflateSync(data.subarray(headerSize, headerSize + sizeCompressed))
  if (body.length !== sizeUncompressed) throw new Error('Manifest size mismatch')
  if (!createHash('sha1').update(body).digest().equals(sha)) throw new Error('Manifest hash mismatch')

  const r = new Reader(body)

  // --- Meta
  let start = r.pos
  const metaSize = r.u32()
  const dataVersion = r.u8()
  const featureLevel = r.u32()
  r.u8() // is_file_data
  r.u32() // app_id
  const appName = r.fstring()
  const buildVersion = r.fstring()
  const launchExe = r.fstring()
  const launchCommand = r.fstring()
  r.list(r.u32(), () => r.fstring()) // prereq ids
  r.fstring() // prereq name
  const prereqPath = r.fstring()
  const prereqArgs = r.fstring()
  if (dataVersion >= 1) r.fstring() // build id
  r.pos = start + metaSize

  // --- Chunk data list (column-major)
  start = r.pos
  const cdlSize = r.u32()
  r.u8() // version
  const chunkCount = r.u32()
  const guids = r.list(chunkCount, () => r.guid())
  const hashes = r.list(chunkCount, () => r.u64())
  r.pos += 20 * chunkCount // sha1 per chunk
  const groups = r.list(chunkCount, () => r.u8())
  const windows = r.list(chunkCount, () => r.u32())
  const fileSizes = r.list(chunkCount, () => r.i64())
  r.pos = start + cdlSize

  const chunks = new Map<string, ChunkInfo>()
  for (let i = 0; i < chunkCount; i++) {
    chunks.set(guids[i], {
      guid: guids[i],
      hash: hashes[i],
      groupNum: groups[i],
      windowSize: windows[i],
      fileSize: fileSizes[i]
    })
  }

  // --- File manifest list (column-major)
  start = r.pos
  const fmlSize = r.u32()
  r.u8() // version
  const fileCount = r.u32()
  const filenames = r.list(fileCount, () => r.fstring())
  const symlinks = r.list(fileCount, () => r.fstring())
  const shas = r.list(fileCount, () => Buffer.from(r.bytes(20)))
  const flags = r.list(fileCount, () => r.u8())
  const tags = r.list(fileCount, () => r.list(r.u32(), () => r.fstring()))
  const parts = r.list(fileCount, () =>
    r.list(r.u32(), () => {
      const partStart = r.pos
      const partSize = r.u32()
      const guid = r.guid()
      const offset = r.u32()
      const size = r.u32()
      r.pos = partStart + partSize
      return { guid, offset, size }
    })
  )
  r.pos = start + fmlSize

  const files: FileEntry[] = filenames.map((filename, i) => ({
    filename,
    symlinkTarget: symlinks[i],
    sha1: shas[i],
    flags: flags[i],
    installTags: tags[i],
    parts: parts[i],
    size: parts[i].reduce((n, p) => n + p.size, 0)
  }))

  return {
    featureLevel,
    appName,
    buildVersion,
    launchExe,
    launchCommand,
    prereqPath,
    prereqArgs,
    chunks,
    files
  }
}

// Legacy JSON manifests store numbers as "blobs": 3 decimal digits per byte, little-endian.
function blobToBytes(blob: string): Buffer {
  const out = Buffer.alloc(blob.length / 3)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(blob.slice(i * 3, i * 3 + 3), 10)
  return out
}
function blobToBigInt(blob: string): bigint {
  let n = 0n
  const bytes = blobToBytes(blob)
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i])
  return n
}
const blobToNum = (blob: string): number => Number(blobToBigInt(blob))

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseJsonManifest(j: any): Manifest {
  const chunks = new Map<string, ChunkInfo>()
  for (const [rawGuid, hashBlob] of Object.entries<string>(j.ChunkHashList ?? {})) {
    const guid = rawGuid.toUpperCase()
    chunks.set(guid, {
      guid,
      hash: blobToBigInt(hashBlob),
      groupNum: blobToNum(j.DataGroupList[rawGuid]),
      windowSize: 1024 * 1024,
      fileSize: blobToNum(j.ChunkFilesizeList[rawGuid])
    })
  }
  const files: FileEntry[] = (j.FileManifestList ?? []).map((f: any) => {
    const parts: ChunkPart[] = (f.FileChunkParts ?? []).map((p: any) => ({
      guid: String(p.Guid).toUpperCase(),
      offset: blobToNum(p.Offset),
      size: blobToNum(p.Size)
    }))
    return {
      filename: f.Filename,
      symlinkTarget: f.SymlinkTarget ?? '',
      sha1: blobToBytes(f.FileHash),
      flags:
        (f.bIsReadOnly ? FILE_FLAG_READONLY : 0) |
        (f.bIsCompressed ? FILE_FLAG_COMPRESSED : 0) |
        (f.bIsUnixExecutable ? FILE_FLAG_EXECUTABLE : 0),
      installTags: f.InstallTags ?? [],
      parts,
      size: parts.reduce((n, p) => n + p.size, 0)
    }
  })
  return {
    featureLevel: blobToNum(j.ManifestFileVersion ?? '000000000000'),
    appName: j.AppNameString ?? '',
    buildVersion: j.BuildVersionString ?? '',
    launchExe: j.LaunchExeString ?? '',
    launchCommand: j.LaunchCommand ?? '',
    prereqPath: j.PrereqPath ?? '',
    prereqArgs: j.PrereqArgs ?? '',
    chunks,
    files
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function chunkDir(featureLevel: number): string {
  if (featureLevel >= 15) return 'ChunksV4'
  if (featureLevel >= 6) return 'ChunksV3'
  if (featureLevel >= 3) return 'ChunksV2'
  return 'Chunks'
}

/** Path of a chunk relative to the CDN base URL. */
export function chunkPath(manifest: Manifest, chunk: ChunkInfo): string {
  const group = String(chunk.groupNum).padStart(2, '0')
  const hash = chunk.hash.toString(16).toUpperCase().padStart(16, '0')
  return `${chunkDir(manifest.featureLevel)}/${group}/${hash}_${chunk.guid}.chunk`
}

/** Decode a downloaded .chunk file into its raw (uncompressed) payload. */
export function decodeChunk(data: Buffer): Buffer {
  const r = new Reader(data)
  if (r.u32() !== CHUNK_MAGIC) throw new Error('Bad chunk magic')
  r.u32() // header version
  const headerSize = r.u32()
  const compressedSize = r.u32()
  r.guid()
  r.u64() // rolling hash
  const storedAs = r.u8()
  if (storedAs & 0x2) throw new Error('Encrypted chunks are not supported')
  const payload = data.subarray(headerSize, headerSize + compressedSize)
  return storedAs & 0x1 ? inflateSync(payload) : payload
}
