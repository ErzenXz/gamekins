// Valve KeyValues ("VDF") text format: libraryfolders.vdf, appmanifest_*.acf, loginusers.vdf...
//
//   "AppState"            // comment
//   {
//     "appid"   "730"
//     "path"    "C:\\Program Files (x86)\\Steam"
//     Unquoted  token [$WIN32]
//   }
//
// Keys and values are quoted (with \\ \" \n \t escapes) or bare tokens; `{ ... }` opens a
// nested section. `//` starts a comment, `[$CONDITION]` suffixes are ignored, and `#include` /
// `#base` directives are skipped. Duplicate keys: sections merge, the last string wins.
// Pure and synchronous; throws VdfError on malformed input.

export interface VdfObject {
  [key: string]: VdfValue
}
export type VdfValue = string | VdfObject

export class VdfError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} at offset ${offset}`)
    this.name = 'VdfError'
  }
}

type Token = { kind: 'string'; value: string; at: number } | { kind: 'open' | 'close'; at: number }

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"' }

function* tokens(text: string): Generator<Token> {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++
      continue
    }
    if (c === '{') { yield { kind: 'open', at: i++ }; continue }
    if (c === '}') { yield { kind: 'close', at: i++ }; continue }
    if (c === '[') {
      // Platform conditional such as [$WIN32] or [!$X360]: not part of the data.
      const end = text.indexOf(']', i)
      if (end < 0) throw new VdfError('Unterminated conditional', i)
      i = end + 1
      continue
    }
    if (c === '"') {
      const at = i++
      let value = ''
      let closed = false
      while (i < n) {
        const ch = text[i]
        if (ch === '\\' && i + 1 < n) {
          const esc = ESCAPES[text[i + 1]]
          // Unknown escapes (a lone backslash in a hand-written path) are kept literally.
          value += esc ?? '\\' + text[i + 1]
          i += 2
          continue
        }
        if (ch === '"') { closed = true; i++; break }
        value += ch
        i++
      }
      if (!closed) throw new VdfError('Unterminated string', at)
      yield { kind: 'string', value, at }
      continue
    }
    // Bare token: runs until whitespace, a brace or a quote.
    const at = i
    while (i < n && !/[\s{}"]/.test(text[i])) {
      if (text[i] === '/' && text[i + 1] === '/') break
      i++
    }
    yield { kind: 'string', value: text.slice(at, i), at }
  }
}

function assign(target: VdfObject, key: string, value: VdfValue): void {
  const existing = Object.prototype.hasOwnProperty.call(target, key) ? target[key] : undefined
  if (existing && typeof existing === 'object' && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assign(existing, k, v)
    return
  }
  // defineProperty: a key named "__proto__" becomes plain data, never the prototype.
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

/** Parse KeyValues text into nested plain objects of strings. */
export function parseVdf(text: string): VdfObject {
  const root: VdfObject = {}
  const stack: VdfObject[] = [root]
  let key: string | null = null
  let keyAt = 0
  for (const t of tokens(text)) {
    const top = stack[stack.length - 1]
    if (t.kind === 'string') {
      if (key === null) {
        if (t.value === '#include' || t.value === '#base') { key = '\0directive'; keyAt = t.at; continue }
        key = t.value
        keyAt = t.at
      } else {
        if (key !== '\0directive') assign(top, key, t.value)
        key = null
      }
    } else if (t.kind === 'open') {
      if (key === null || key === '\0directive') throw new VdfError('Section without a name', t.at)
      const section: VdfObject = {}
      assign(top, key, section)
      // After merging duplicates, keep writing into the section that actually lives in the tree.
      const live = top[key]
      stack.push(typeof live === 'object' ? live : section)
      key = null
    } else {
      if (key !== null) throw new VdfError(`Key "${key}" has no value`, keyAt)
      if (stack.length === 1) throw new VdfError('Unexpected }', t.at)
      stack.pop()
    }
  }
  if (key !== null && key !== '\0directive') throw new VdfError(`Key "${key}" has no value`, keyAt)
  if (stack.length !== 1) throw new VdfError('Unclosed section', text.length)
  return root
}

/** Case-insensitive lookup (KeyValues keys are case-insensitive: "AppState" vs "appstate"). */
export function vdfGet(obj: VdfValue | undefined, key: string): VdfValue | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key]
  const lower = key.toLowerCase()
  for (const k of Object.keys(obj)) if (k.toLowerCase() === lower) return obj[k]
  return undefined
}

export function vdfString(obj: VdfValue | undefined, key: string): string | undefined {
  const v = vdfGet(obj, key)
  return typeof v === 'string' ? v : undefined
}

export function vdfObject(obj: VdfValue | undefined, key: string): VdfObject | undefined {
  const v = vdfGet(obj, key)
  return v && typeof v === 'object' ? v : undefined
}
