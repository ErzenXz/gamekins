// Parser for Epic's build manifests (binary and legacy JSON) and chunk files.
// Format notes are based on the community reverse-engineering done for Legendary.

import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'

const MANIFEST_MAGIC = 0x44bec00c
const CHUNK_MAGIC = 0xb1fe3aa2
const MAX_MANIFEST_BYTES = 128 * 1024 * 1024
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024
export const MAX_CHUNK_FILE_BYTES = MAX_CHUNK_BYTES + 1024 * 1024
const MAX_ENTRIES = 1_000_000

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
  sha1?: Buffer
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

  get remaining(): number {
    return this.buf.length - this.pos
  }

  private require(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.remaining) throw new Error('Truncated or invalid binary input')
  }

  count(count: number, minimumBytes = 1): number {
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_ENTRIES || count > this.remaining / minimumBytes) {
      throw new Error('Invalid binary entry count')
    }
    return count
  }

  block(): Reader {
    const size = this.u32()
    if (size < 4) throw new Error('Invalid binary block size')
    return new Reader(this.bytes(size - 4))
  }

  u8(): number {
    this.require(1)
    return this.buf.readUInt8(this.pos++)
  }
  u32(): number {
    this.require(4)
    const v = this.buf.readUInt32LE(this.pos)
    this.pos += 4
    return v
  }
  i32(): number {
    this.require(4)
    const v = this.buf.readInt32LE(this.pos)
    this.pos += 4
    return v
  }
  u64(): bigint {
    this.require(8)
    const v = this.buf.readBigUInt64LE(this.pos)
    this.pos += 8
    return v
  }
  i64(): number {
    this.require(8)
    const v = Number(this.buf.readBigInt64LE(this.pos))
    this.pos += 8
    if (!Number.isSafeInteger(v) || v < 0) throw new Error('Invalid binary size')
    return v
  }
  bytes(n: number): Buffer {
    this.require(n)
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
      const bytes = this.bytes(n)
      if (bytes.readUInt16LE(n - 2) !== 0) throw new Error('Unterminated FString')
      return bytes.toString('utf16le', 0, n - 2)
    }
    const bytes = this.bytes(len)
    if (bytes[len - 1] !== 0) throw new Error('Unterminated FString')
    return bytes.toString('utf8', 0, len - 1)
  }
  list<T>(count: number, fn: () => T): T[] {
    this.count(count)
    const out: T[] = new Array(count)
    for (let i = 0; i < count; i++) out[i] = fn()
    return out
  }
}

export function parseManifest(data: Buffer): Manifest {
  if (data.length > MAX_MANIFEST_BYTES) throw new Error('Manifest exceeds supported size')
  let start = data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0
  while (start < data.length && (data[start] === 32 || (data[start] >= 9 && data[start] <= 13))) start++
  const manifest = data[start] === 0x7b ? parseJsonManifest(JSON.parse(data.toString('utf8', start))) : parseBinaryManifest(data)
  validateManifest(manifest)
  return manifest
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

  if (headerSize < head.pos || headerSize > data.length || sizeCompressed > data.length - headerSize ||
      sizeUncompressed === 0 || sizeUncompressed > MAX_MANIFEST_BYTES) throw new Error('Invalid manifest header sizes')
  let body = data.subarray(headerSize, headerSize + sizeCompressed)
  if (storedAs & 0x1) body = inflateSync(body, { maxOutputLength: sizeUncompressed })
  if (body.length !== sizeUncompressed) throw new Error('Manifest size mismatch')
  if (!createHash('sha1').update(body).digest().equals(sha)) throw new Error('Manifest hash mismatch')

  const bodyReader = new Reader(body)

  // --- Meta
  let r = bodyReader.block()
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

  // --- Chunk data list (column-major)
  r = bodyReader.block()
  r.u8() // version
  const chunkCount = r.count(r.u32(), 57)
  const guids = r.list(chunkCount, () => r.guid())
  const hashes = r.list(chunkCount, () => r.u64())
  const chunkShas = r.list(chunkCount, () => Buffer.from(r.bytes(20)))
  const groups = r.list(chunkCount, () => r.u8())
  const windows = r.list(chunkCount, () => r.u32())
  const fileSizes = r.list(chunkCount, () => r.i64())

  const chunks = new Map<string, ChunkInfo>()
  for (let i = 0; i < chunkCount; i++) {
    if (chunks.has(guids[i])) throw new Error('Duplicate manifest chunk')
    chunks.set(guids[i], {
      guid: guids[i],
      hash: hashes[i],
      groupNum: groups[i],
      windowSize: windows[i],
      fileSize: fileSizes[i],
      sha1: chunkShas[i]
    })
  }

  // --- File manifest list (column-major)
  r = bodyReader.block()
  r.u8() // version
  const fileCount = r.count(r.u32(), 37)
  const filenames = r.list(fileCount, () => r.fstring())
  const symlinks = r.list(fileCount, () => r.fstring())
  const shas = r.list(fileCount, () => Buffer.from(r.bytes(20)))
  const flags = r.list(fileCount, () => r.u8())
  const tags = r.list(fileCount, () => r.list(r.count(r.u32(), 4), () => r.fstring()))
  const parts = r.list(fileCount, () =>
    r.list(r.count(r.u32(), 28), () => {
      const part = r.block()
      const guid = part.guid()
      const offset = part.u32()
      const size = part.u32()
      return { guid, offset, size }
    })
  )

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
  if (typeof blob !== 'string' || blob.length > 60 || blob.length % 3 || !/^\d*$/.test(blob)) throw new Error('Invalid numeric blob')
  const out = Buffer.alloc(blob.length / 3)
  for (let i = 0; i < out.length; i++) {
    const value = Number(blob.slice(i * 3, i * 3 + 3))
    if (value > 255) throw new Error('Invalid numeric blob byte')
    out[i] = value
  }
  return out
}
function blobToBigInt(blob: string): bigint {
  let n = 0n
  const bytes = blobToBytes(blob)
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i])
  return n
}
const blobToNum = (blob: string): number => {
  const n = Number(blobToBigInt(blob))
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid numeric size')
  return n
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseJsonManifest(j: any): Manifest {
  if (!j || typeof j !== 'object' || Array.isArray(j) || !Array.isArray(j.FileManifestList ?? [])) throw new Error('Invalid JSON manifest')
  const hashEntries = Object.entries<string>(j.ChunkHashList ?? {})
  if (hashEntries.length > MAX_ENTRIES || (j.FileManifestList ?? []).length > MAX_ENTRIES) throw new Error('Too many manifest entries')
  const chunks = new Map<string, ChunkInfo>()
  for (const [rawGuid, hashBlob] of hashEntries) {
    const guid = rawGuid.toUpperCase()
    if (chunks.has(guid)) throw new Error('Duplicate manifest chunk')
    chunks.set(guid, {
      guid,
      hash: blobToBigInt(hashBlob),
      groupNum: blobToNum(j.DataGroupList[rawGuid]),
      windowSize: 1024 * 1024,
      fileSize: blobToNum(j.ChunkFilesizeList[rawGuid])
    })
  }
  const files: FileEntry[] = (j.FileManifestList ?? []).map((f: any) => {
    if (!f || !Array.isArray(f.FileChunkParts ?? []) || (f.FileChunkParts ?? []).length > MAX_ENTRIES) throw new Error('Invalid JSON chunk parts')
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

function validateManifest(m: Manifest): void {
  if (m.files.length > MAX_ENTRIES || m.chunks.size > MAX_ENTRIES) throw new Error('Too many manifest entries')
  for (const [guid, chunk] of m.chunks) {
    if (!/^[A-F0-9]{32}$/.test(guid) || !Number.isSafeInteger(chunk.windowSize) || chunk.windowSize <= 0 ||
        chunk.windowSize > MAX_CHUNK_BYTES || !Number.isSafeInteger(chunk.fileSize) || chunk.fileSize < 41 ||
        chunk.fileSize > MAX_CHUNK_FILE_BYTES || chunk.groupNum < 0 || chunk.groupNum > 255) {
      throw new Error('Invalid manifest chunk')
    }
    if (chunk.hash < 0n || chunk.hash > 0xffffffffffffffffn) throw new Error('Invalid chunk hash')
  }
  for (const f of m.files) {
    if (typeof f.filename !== 'string' || typeof f.symlinkTarget !== 'string' || f.sha1.length !== 20 ||
        !Number.isSafeInteger(f.size) || f.size < 0 || f.parts.length > MAX_ENTRIES ||
        !Array.isArray(f.installTags) || f.installTags.some((tag) => typeof tag !== 'string')) throw new Error('Invalid manifest file')
    for (const p of f.parts) {
      const chunk = m.chunks.get(p.guid)
      if (!chunk || !Number.isSafeInteger(p.offset) || p.offset < 0 || !Number.isSafeInteger(p.size) || p.size < 0 ||
          p.offset + p.size > chunk.windowSize) throw new Error('Invalid manifest chunk part')
    }
  }
}

/** Path of a chunk relative to the CDN base URL. */
export function chunkPath(manifest: Manifest, chunk: ChunkInfo): string {
  const group = String(chunk.groupNum).padStart(2, '0')
  const hash = chunk.hash.toString(16).toUpperCase().padStart(16, '0')
  return `${chunkDir(manifest.featureLevel)}/${group}/${hash}_${chunk.guid}.chunk`
}

/** Decode a downloaded .chunk file into its raw (uncompressed) payload. */
export function decodeChunk(data: Buffer, expected?: ChunkInfo): Buffer {
  if (data.length > MAX_CHUNK_FILE_BYTES) throw new Error('Chunk exceeds supported size')
  const r = new Reader(data)
  if (r.u32() !== CHUNK_MAGIC) throw new Error('Bad chunk magic')
  const version = r.u32()
  const headerSize = r.u32()
  const compressedSize = r.u32()
  const guid = r.guid()
  const hash = r.u64()
  const storedAs = r.u8()
  if (storedAs & 0x2) throw new Error('Encrypted chunks are not supported')
  const sha = version >= 2 ? r.bytes(20) : null
  const hashType = version >= 2 ? r.u8() : 0
  const uncompressedSize = version >= 3 ? r.u32() : (expected?.windowSize ?? 1024 * 1024)
  if (headerSize < r.pos || headerSize > data.length || compressedSize !== data.length - headerSize ||
      uncompressedSize <= 0 || uncompressedSize > MAX_CHUNK_BYTES ||
      (expected && (guid !== expected.guid || hash !== expected.hash || data.length !== expected.fileSize ||
        uncompressedSize !== expected.windowSize))) throw new Error('Invalid chunk header or identity')
  const payload = data.subarray(headerSize, headerSize + compressedSize)
  const decoded = storedAs & 0x1 ? inflateSync(payload, { maxOutputLength: uncompressedSize }) : payload
  if (decoded.length !== uncompressedSize) throw new Error('Chunk size mismatch')
  const digest = createHash('sha1').update(decoded).digest()
  if ((sha && (hashType & 2) && !digest.equals(sha)) ||
      (expected?.sha1 && !expected.sha1.equals(Buffer.alloc(20)) && !digest.equals(expected.sha1))) {
    throw new Error('Chunk hash mismatch')
  }
  return decoded
}
