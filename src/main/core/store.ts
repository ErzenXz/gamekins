import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
    let loaded: Partial<T> = {}
    try {
      if (existsSync(this.file)) loaded = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (err) {
      console.warn(`[store] ${name} is corrupt, starting fresh`, err)
    }
    this.value = { ...defaults, ...loaded }
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

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.value, null, 2))
    renameSync(tmp, this.file)
  }
}
