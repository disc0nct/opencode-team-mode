/**
 * Per-key async mutex. Storage has no compare-and-swap, so every mutation of a
 * team is serialized. Keys are normally team IDs; the map grows with teams only.
 */
export class Mutex {
  private tails = new Map<string, Promise<unknown>>()

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(fn)
    const tail = result.catch(() => undefined)
    this.tails.set(key, tail)
    try {
      return await result
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }

  get size(): number {
    return this.tails.size
  }
}
