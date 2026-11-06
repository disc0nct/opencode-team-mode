export type Topology = "hub" | "mesh"
export type TeamStatus = "active" | "paused" | "stopping" | "stopped"
export type MemberStatus = "spawning" | "idle" | "working" | "blocked" | "done" | "failed" | "stopped"
export type TaskStatus = "pending" | "claimed" | "in_progress" | "blocked" | "review" | "done" | "cancelled"
export type EnvelopeType = "message" | "request" | "response" | "handoff" | "status" | "system" | "broadcast"
export type Priority = "normal" | "urgent"
export type Delivery = "steer" | "queue"

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface Limits {
  maxMembers: number
  maxDepth: number
  maxHopsPerThread: number
  maxMessagesPerMemberPerMinute: number
  maxExchangesPerThread: number
  ttlMs: number
  maxMemberMinutes: number
  maxMemberTurns: number
  maxTeamCostUSD: number
  heartbeatMs: number
  sweepMs: number
  peerWait: boolean
  waitTimeoutMs: number
  peerMessagesVisible: boolean
  maxBroadcastMembers: number
}

export interface RolePreset {
  agent?: string
  charter: string
  deny: string[]
}

export interface PermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

export interface TeamConfig {
  topology: Topology
  maxMembers: number
  roles: Record<string, RolePreset>
  defaultAgent: string
  defaultModel?: ModelRef
  isolateWithWorktrees: boolean
  humanApproval: "ask" | "auto"
  limits: Limits
  logLevel: "debug" | "info" | "warn" | "error" | "none"
}

export interface Team {
  id: string
  name: string
  goal: string
  leadSessionID: string
  projectID: string
  topology: Topology
  status: TeamStatus
  createdAt: number
  updatedAt: number
  version: number
  nextTask: number
  boardVersion: number
  pausedReason?: string
  instanceID: string
  killedAt?: number
  stopReason?: string
}

export interface Member {
  id: string
  teamID: string
  role: string
  depth: number
  sessionID: string
  agent: string
  model?: ModelRef
  status: MemberStatus
  brief: string
  worktree?: string
  createdAt: number
  lastActiveAt: number
  turns: number
  costUSD: number
  unread?: number
  waitingOn: string[]
  fingerprint?: string
  fingerprintAt?: number
}

export interface Envelope {
  id: string
  teamID: string
  from: string
  to: string
  type: EnvelopeType
  subject: string
  body: string
  replyTo?: string
  correlationID?: string
  priority: Priority
  hops: number
  ttlMs: number
  createdAt: number
  expiresAt: number
  deliveredAt?: number
  readAt?: number
  requiresReply?: boolean
}

export interface Task {
  id: string
  teamID: string
  title: string
  description: string
  status: TaskStatus
  owner?: string
  createdBy: string
  dependsOn: string[]
  paths: string[]
  result?: string
  handoffFrom?: string
  version: number
  createdAt: number
  updatedAt: number
}

export interface SessionRef {
  id: string
  parentID?: string
  title?: string
  agent?: string
  model?: ModelRef
  busy?: boolean
  costUSD?: number
  tokens?: number
  exists: boolean
}

export interface ToolCallContext {
  sessionID: string
  agent: string
  messageID: string
  id: string
  signal: AbortSignal
}

export interface AppError extends Error {
  guidance?: string
  toolError: true
}
