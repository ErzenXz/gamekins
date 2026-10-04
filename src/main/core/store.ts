import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { object, settingsSchema, upgradeStoreEntry, validStoreEntry } from './validation'

export function dataDir(...parts: string[]): string {
  const dir = join(app.getPath('userData'), ...parts)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Tiny JSON-file backed store. Writes are atomic (tmp + rename) and debounced
 * so hot paths like playtime ticks don't hammer the disk.
 */
export class JsonStore<T extends object> {
  private value: T
  private timer: NodeJS.Timeout | null = null
  readonly file: string

  constructor(name: string, defaults: T) {
    this.file = join(dataDir(), `${name}.json`)
    let loaded: unknown = {}
    let corrupt = false
    try {
      if (existsSync(this.file)) loaded = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (err) {
      corrupt = true
      console.warn(`[store] ${name} is corrupt, starting fresh`, err)
    }
    const merge = (fallback: unknown, value: unknown): unknown => {
      if (Array.isArray(fallback)) {
        if (!Array.isArray(value)) { corrupt = true; return structuredClone(fallback) }
        return value
          .map((entry) => upgradeStoreEntry(name, entry))
          .filter((entry) => { const ok = validStoreEntry(name, entry); if (!ok) corrupt = true; return ok })
      }
      if (object(fallback)) {
        if (!object(value)) { corrupt = true; return structuredClone(fallback) }
        if (!Object.keys(fallback).length) {
          return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, upgradeStoreEntry(name, entry)] as const).filter(([key, entry]) => {
            const ok = !['__proto__', 'constructor', 'prototype'].includes(key) && validStoreEntry(name, entry)
            if (!ok) corrupt = true
            return ok
          }))
        }
        return Object.fromEntries(Object.entries(fallback).map(([key, def]) => {
          const entry = value[key]
          if (entry === undefined) return [key, structuredClone(def)]
          if (name === 'settings' && !settingsSchema[key as keyof typeof settingsSchema]?.(entry)) {
            corrupt = true; return [key, def]
          }
          return [key, merge(def, entry)]
        }))
      }
      if (typeof value !== typeof fallback || (typeof value === 'number' && !Number.isFinite(value))) {
        corrupt = true; return fallback
      }
      return value
    }
    this.value = merge(defaults, loaded) as T
    if (corrupt && existsSync(this.file)) {
      try { renameSync(this.file, this.file.replace(/\.json$/, `.corrupt-${Date.now()}.json`)) }
      catch (err) { console.error('[store] quarantine failed', err) }
    }
  }

  get data(): T {
    return this.value
  }

  set(next: T): void {
    this.value = next
    this.save()
  }

  update(fn: (draft: T) => void): void {
    fn(this.value)
    this.save()
  }

  save(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 250)
  }

  flush(): boolean {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(this.value, null, 2))
      renameSync(tmp, this.file)
      return true
    } catch (err) {
      console.error(`[store] could not write ${this.file}; retrying`, err)
      this.timer = setTimeout(() => this.flush(), 5000)
      this.timer.unref()
      return false
    }
  }
}
