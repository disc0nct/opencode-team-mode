import { posix, win32 } from "node:path"
import type { Envelope, Limits, Member, Task, TeamConfig } from "../types.ts"

export interface RateState {
  hits: number[]
}

export interface PairState {
  count: number
  boardVersion: number
  updatedAt: number
  pausedUntil?: number
}

export interface WaitEdge {
  memberID: string
  targetID: string
  at: number
}

export const RATE_WINDOW_MS = 60_000
export const DUPLICATE_WINDOW_MS = 30_000
export const PAIR_PAUSE_MS = 10 * 60_000
export const MAX_TASKS = 200
export const MAX_BODY_CHARS = 8_000
export const MAX_BRIEF_CHARS = 1_200

export function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export function normalizePath(raw: string): string {
  let path = raw.trim().replace(/\\/g, "/")
  path = path.replace(/^\.\/+/, "")
  path = path.replace(/\/+$/, "")
  path = path.replace(/\/\*\*?$/, "")
  // Resolve parent segments canonically; a path that escapes the workspace
  // root (`..`) must never be leased or matched against a lease.
  const pathModule = process.platform === "win32" ? win32 : posix
  const resolved = pathModule.normalize(path)
  // Check for path escape on both Windows (..\) and POSIX (../)
  if (resolved === ".." || resolved.startsWith("../") || resolved.startsWith("..\\")) return ""
  return resolved
}

export function normalizePaths(raw: readonly string[]): string[] {
  const out: string[] = []
  for (const value of raw) {
    const path = normalizePath(value)
    if (path && !out.includes(path)) out.push(path)
  }
  return out
}

const CASE_INSENSITIVE_PATHS = process.platform === "win32"
const SEPARATOR = process.platform === "win32" ? "\\" : "/"

export function pathsOverlap(a: string, b: string): boolean {
  if (!a || !b) return false
  // Normalize separators to platform separator before comparing
  const normalizeSep = (p: string) => p.replace(/[\\/]/g, SEPARATOR)
  const x = CASE_INSENSITIVE_PATHS ? normalizeSep(a).toLowerCase() : normalizeSep(a)
  const y = CASE_INSENSITIVE_PATHS ? normalizeSep(b).toLowerCase() : normalizeSep(b)
  if (x === y) return true
  return x.startsWith(`${y}${SEPARATOR}`) || y.startsWith(`${x}${SEPARATOR}`)
}

export function pathConflict(paths: string[], other: string[]): string | undefined {
  for (const path of paths) {
    for (const candidate of other) {
      if (pathsOverlap(path, candidate)) return path
    }
  }
  return undefined
}

export function isTerminal(task: Task): boolean {
  return task.status === "done" || task.status === "cancelled"
}

export function isActiveTask(task: Task): boolean {
  return (
    task.status === "claimed" || task.status === "in_progress" || task.status === "review" || task.status === "blocked"
  )
}

export function checkRate(
  state: RateState | undefined,
  now: number,
  limit: number,
): { ok: boolean; state: RateState; retryAfterMs: number } {
  const hits = (state?.hits ?? []).filter((at) => at <= now && now - at < RATE_WINDOW_MS)
  if (hits.length >= limit) {
    const oldest = hits[0] ?? now
    return {
      ok: false,
      state: { hits },
      retryAfterMs: Math.max(1_000, RATE_WINDOW_MS - (now - oldest)),
    }
  }
  hits.push(now)
  return { ok: true, state: { hits }, retryAfterMs: 0 }
}

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join("__")
}

export function exchangeUpdate(
  previous: PairState | undefined,
  boardVersion: number,
  now: number,
  limit: number,
): { state: PairState; paused: boolean; reason?: string } {
  // A board change is the promised escape hatch from a paused pair: it resets
  // the exchange counter even while the cooldown would still be running.
  const boardChanged = previous !== undefined && previous.boardVersion !== boardVersion
  if (previous?.pausedUntil && previous.pausedUntil > now && !boardChanged) {
    return {
      state: previous,
      paused: true,
      reason: `the pair is paused until ${new Date(previous.pausedUntil).toISOString()}`,
    }
  }
  const pauseExpired = previous?.pausedUntil !== undefined && previous.pausedUntil <= now
  const base = !previous || pauseExpired || boardChanged ? 0 : previous.count
  const count = base + 1
  const state: PairState = { count, boardVersion, updatedAt: now }
  if (count > limit) {
    state.pausedUntil = now + PAIR_PAUSE_MS
    return {
      state,
      paused: true,
      reason: `${count} exchanges without any board change`,
    }
  }
  return { state, paused: false }
}

/**
 * The persisted wait graph has one edge per waiting member. Adding from -> to is
 * unsafe when a path already exists from to back to from.
 */
export function waitCyclePath(edges: WaitEdge[], from: string, to: string): string[] | undefined {
  if (from === to) return [from]
  const graph = new Map<string, string[]>()
  for (const edge of edges) {
    const list = graph.get(edge.memberID) ?? []
    list.push(edge.targetID)
    graph.set(edge.memberID, list)
  }
  const seen = new Set<string>()
  const visit = (current: string, path: string[]): string[] | undefined => {
    if (current === from) return [...path, current]
    if (seen.has(current)) return undefined
    seen.add(current)
    for (const next of graph.get(current) ?? []) {
      const found = visit(next, [...path, current])
      if (found) return found
    }
    return undefined
  }
  const path = visit(to, [])
  return path ? [from, ...path] : undefined
}

export function wouldCycle(edges: WaitEdge[], from: string, to: string): boolean {
  return waitCyclePath(edges, from, to) !== undefined
}

export function fingerprint(parts: readonly string[]): string {
  // Length-prefix each part so embedded delimiters cannot forge collisions.
  const text = parts.map((part) => `${part.length}:${part}`).join("|")
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

export function teamCost(members: readonly Member[]): number {
  return members.reduce((sum, member) => sum + (member.costUSD || 0), 0)
}

export function budgetViolation(
  member: Member,
  members: readonly Member[],
  config: TeamConfig,
  now: number,
): string | undefined {
  if (member.status === "stopped" || member.status === "failed" || member.status === "done") return undefined
  const limits = config.limits
  if (member.role !== "lead") {
    if (member.turns >= limits.maxMemberTurns) {
      return `member ${member.id} reached the turn budget (${limits.maxMemberTurns})`
    }
    const minutes = (now - member.createdAt) / 60_000
    if (minutes >= limits.maxMemberMinutes) {
      return `member ${member.id} reached the time budget (${limits.maxMemberMinutes} min)`
    }
  }
  // Team-cost budget is enforced once per sweep at the team level (see
  // TeamService.sweep) so exceeding it pauses the team instead of stopping
  // members one by one.
  void members
  return undefined
}

export function isExpired(envelope: Envelope, now: number): boolean {
  return envelope.expiresAt <= now
}

export function effectiveWaitTimeout(limits: Limits, requested: number | undefined): number {
  return clampInt(requested ?? limits.waitTimeoutMs, 1_000, 600_000)
}
