import type { Limits, ModelRef, RolePreset, TeamConfig } from "../types.ts"

export const DEFAULT_LIMITS: Limits = {
  maxMembers: 5,
  maxDepth: 1,
  maxHopsPerThread: 6,
  maxMessagesPerMemberPerMinute: 20,
  maxExchangesPerThread: 6,
  ttlMs: 2 * 60 * 60 * 1000,
  maxMemberMinutes: 30,
  maxMemberTurns: 40,
  maxTeamCostUSD: 0,
  heartbeatMs: 15_000,
  sweepMs: 30_000,
  peerWait: false,
  waitTimeoutMs: 30_000,
  peerMessagesVisible: false,
  maxBroadcastMembers: 50,
}

export const DEFAULT_ROLES: Record<string, RolePreset> = {
  lead: {
    charter:
      "You lead the team. Decompose the goal into small tasks, spawn only the roles you need, keep the board current, and unblock teammates. Prefer async messages over waiting.",
    deny: [],
  },
  architect: {
    agent: "plan",
    charter:
      "You are the architect. Read the code and produce a short design: interfaces, data flow, risks, and a task breakdown. Do not edit implementation files; write design notes as task results or messages.",
    deny: ["edit", "shell"],
  },
  implementer: {
    agent: "build",
    charter:
      "You implement tasks. Claim one task, declare every path you will touch, make the smallest correct change, run the relevant checks, then report the result and move the task to review.",
    deny: [],
  },
  reviewer: {
    agent: "general",
    charter:
      "You review. Check correctness, edge cases, tests, and the task's stated acceptance criteria. Report findings with file:line references. Do not edit; reject with concrete follow-ups or approve with a short summary.",
    deny: ["edit", "shell"],
  },
  researcher: {
    agent: "explore",
    charter:
      "You research. Answer the question with evidence: files, docs, or URLs. Return a compact brief with sources and implications. Do not edit.",
    deny: ["edit", "shell"],
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function integer(value: unknown, fallback: number, name: string, min: number, max: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`team-mode options: ${name} must be an integer`)
  }
  if (value < min || value > max) throw new Error(`team-mode options: ${name} must be between ${min} and ${max}`)
  return value
}

function boolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new Error(`team-mode options: ${name} must be a boolean`)
  return value
}

function string(value: unknown, fallback: string, name: string): string {
  if (value === undefined) return fallback
  if (typeof value !== "string" || !value.trim()) throw new Error(`team-mode options: ${name} must be a non-empty string`)
  return value
}

function model(value: unknown, name: string): ModelRef | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value) || typeof value.providerID !== "string" || typeof value.id !== "string") {
    throw new Error(`team-mode options: ${name} must be { providerID, id, variant? }`)
  }
  return {
    providerID: value.providerID,
    id: value.id,
    ...(typeof value.variant === "string" ? { variant: value.variant } : {}),
  }
}

export function validateConfig(raw: unknown): TeamConfig {
  if (raw !== undefined && !isRecord(raw)) throw new Error("team-mode options: expected an object")
  const input = (raw ?? {}) as Record<string, unknown>

  const topology = input.topology ?? "hub"
  if (topology !== "hub" && topology !== "mesh") {
    throw new Error('team-mode options: topology must be "hub" or "mesh"')
  }

  const limitsRaw = isRecord(input.limits) ? input.limits : {}
  const limits: Limits = {
    maxMembers: integer(input.maxMembers ?? limitsRaw.maxMembers, DEFAULT_LIMITS.maxMembers, "maxMembers", 2, 20),
    maxDepth: integer(limitsRaw.maxDepth, DEFAULT_LIMITS.maxDepth, "limits.maxDepth", 0, 2),
    maxHopsPerThread: integer(
      limitsRaw.maxHopsPerThread,
      DEFAULT_LIMITS.maxHopsPerThread,
      "limits.maxHopsPerThread",
      1,
      50,
    ),
    maxMessagesPerMemberPerMinute: integer(
      limitsRaw.maxMessagesPerMemberPerMinute,
      DEFAULT_LIMITS.maxMessagesPerMemberPerMinute,
      "limits.maxMessagesPerMemberPerMinute",
      1,
      500,
    ),
    maxExchangesPerThread: integer(
      limitsRaw.maxExchangesPerThread,
      DEFAULT_LIMITS.maxExchangesPerThread,
      "limits.maxExchangesPerThread",
      2,
      50,
    ),
    ttlMs: integer(limitsRaw.ttlMs, DEFAULT_LIMITS.ttlMs, "limits.ttlMs", 60_000, 7 * 24 * 60 * 60 * 1000),
    maxMemberMinutes: integer(limitsRaw.maxMemberMinutes, DEFAULT_LIMITS.maxMemberMinutes, "limits.maxMemberMinutes", 1, 1440),
    maxMemberTurns: integer(limitsRaw.maxMemberTurns, DEFAULT_LIMITS.maxMemberTurns, "limits.maxMemberTurns", 1, 1000),
    maxTeamCostUSD: Number(limitsRaw.maxTeamCostUSD ?? DEFAULT_LIMITS.maxTeamCostUSD),
    heartbeatMs: integer(limitsRaw.heartbeatMs, DEFAULT_LIMITS.heartbeatMs, "limits.heartbeatMs", 1000, 300_000),
    sweepMs: integer(limitsRaw.sweepMs, DEFAULT_LIMITS.sweepMs, "limits.sweepMs", 1000, 600_000),
    peerWait: boolean(limitsRaw.peerWait, DEFAULT_LIMITS.peerWait, "limits.peerWait"),
    waitTimeoutMs: integer(limitsRaw.waitTimeoutMs, DEFAULT_LIMITS.waitTimeoutMs, "limits.waitTimeoutMs", 1000, 600_000),
    peerMessagesVisible: boolean(limitsRaw.peerMessagesVisible, DEFAULT_LIMITS.peerMessagesVisible, "limits.peerMessagesVisible"),
    maxBroadcastMembers: integer(limitsRaw.maxBroadcastMembers, DEFAULT_LIMITS.maxBroadcastMembers, "limits.maxBroadcastMembers", 2, 200),
  }
  if (!Number.isFinite(limits.maxTeamCostUSD) || limits.maxTeamCostUSD < 0) {
    throw new Error("team-mode options: limits.maxTeamCostUSD must be a non-negative number")
  }

  const roles: Record<string, RolePreset> = {}
  for (const [name, preset] of Object.entries(DEFAULT_ROLES)) roles[name] = { ...preset, deny: [...preset.deny] }
  if (input.roles !== undefined) {
    if (!isRecord(input.roles)) throw new Error("team-mode options: roles must be an object")
    for (const [name, override] of Object.entries(input.roles)) {
      if (!isRecord(override)) throw new Error(`team-mode options: roles.${name} must be an object`)
      const base = roles[name] ?? { charter: `You are the ${name}.`, deny: [] }
      roles[name] = {
        agent: typeof override.agent === "string" ? override.agent : base.agent,
        charter: typeof override.charter === "string" ? override.charter : base.charter,
        deny: Array.isArray(override.deny)
          ? override.deny.filter((item): item is string => typeof item === "string")
          : [...base.deny],
      }
    }
  }

  const approval = input.humanApproval ?? "ask"
  if (approval !== "ask" && approval !== "auto") {
    throw new Error('team-mode options: humanApproval must be "ask" or "auto"')
  }

  const logLevel = input.logLevel ?? "warn"
  if (!["debug", "info", "warn", "error", "none"].includes(String(logLevel))) {
    throw new Error("team-mode options: logLevel must be debug, info, warn, error or none")
  }

  return {
    topology,
    maxMembers: limits.maxMembers,
    roles,
    defaultAgent: string(input.defaultAgent, "build", "defaultAgent"),
    defaultModel: model(input.defaultModel, "defaultModel"),
    isolateWithWorktrees: boolean(input.isolateWithWorktrees, false, "isolateWithWorktrees"),
    humanApproval: approval,
    limits,
    logLevel: logLevel as TeamConfig["logLevel"],
  }
}

const TRUNCATION_SUFFIX = "…[truncated]"

/**
 * Unicode-safe truncation: a naive `slice` can split a UTF-16 surrogate pair
 * and emit a lone high surrogate, which corrupts JSON payloads and is rejected
 * by LLM provider APIs. The cutoff is moved back one code unit when it would
 * land between the halves of a pair.
 */
export function safeTruncate(text: string, maxChars: number, suffix = TRUNCATION_SUFFIX): string {
  const clean = text.replace(/\r\n/g, "\n").trim()
  if (clean.length <= maxChars) return clean
  if (maxChars <= suffix.length) return suffix.slice(0, Math.max(0, maxChars))
  let cutoff = maxChars - suffix.length
  const previous = clean.charCodeAt(cutoff - 1)
  if (previous >= 0xd800 && previous <= 0xdbff) cutoff -= 1
  return `${clean.slice(0, cutoff)}${suffix}`
}

export function estimateTokens(text: string): number {
  // ~4 characters per token holds for Latin text only; CJK ideographs and
  // hangul average 1.5-2.5 tokens per character in modern tokenizers, so they
  // are weighted up to keep context budgets honest for non-English teams.
  let cjk = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff)) {
      cjk += 1
    }
  }
  const other = text.length - cjk
  return Math.ceil(other / 4 + cjk * 1.5)
}

export function truncateTokens(text: string, maxTokens: number): string {
  return safeTruncate(text, maxTokens * 4)
}
