import { createHash } from 'node:crypto'

const TTL_MS = 10 * 60 * 1000 // 10 minutes

interface CacheEntry {
  compiledJson: unknown
  cachedAt: number
}

const cache = new Map<string, CacheEntry>()

function key(dsl: string): string {
  return createHash('sha256').update(dsl).digest('hex')
}

export function getCachedCompile(dsl: string): unknown | null {
  const entry = cache.get(key(dsl))
  if (!entry) return null
  if (Date.now() - entry.cachedAt > TTL_MS) {
    cache.delete(key(dsl))
    return null
  }
  return entry.compiledJson
}

export function setCachedCompile(dsl: string, compiledJson: unknown): void {
  cache.set(key(dsl), { compiledJson, cachedAt: Date.now() })
}
