/** All entry points share this synchronous installation-group exclusion. */
class OperationCoordinator {
  private readonly busy = new Map<string, string>()
  private readonly running = new Set<string>()
  groupFor: (key: string) => string = (key) => key
  private listeners = new Set<() => void>()
  onAvailable(fn: () => void): void { this.listeners.add(fn) }
  private notify(): void { for (const fn of this.listeners) fn() }
  blocked(key: string): boolean {
    const group = this.groupFor(key)
    return this.busy.has(group) || this.running.has(group)
  }
  acquire(key: string, action: string, allowRunning = false): () => void {
    const group = this.groupFor(key)
    if (this.busy.has(group)) throw new Error(`Wait for ${this.busy.get(group)} to finish`)
    if (!allowRunning && this.running.has(group)) throw new Error(`Close the game before ${action}`)
    this.busy.set(group, action)
    let released = false
    return () => {
      if (released) return
      released = true
      this.busy.delete(group)
      this.notify()
    }
  }
  setRunning(key: string, value: boolean): void {
    const group = this.groupFor(key)
    if (value) this.running.add(group)
    else this.running.delete(group)
    this.notify()
  }
}
export const operations = new OperationCoordinator()
