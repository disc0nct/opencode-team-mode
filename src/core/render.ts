import type { Envelope, Limits, Member, Task, Team } from "../types.ts"
import { safeTruncate, truncateTokens } from "./config.ts"

const CHARTS = 4

export function truncateChars(text: string, maxChars: number): string {
  return safeTruncate(text, maxChars)
}

function oneLine(text: string, maxChars: number): string {
  return truncateChars(text.replace(/\s+/g, " "), maxChars)
}

export function timeAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

export function formatCost(value: number | undefined): string {
  if (!value || value <= 0) return "$0"
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`
}

function statusRank(status: Task["status"]): number {
  switch (status) {
    case "in_progress":
      return 0
    case "blocked":
      return 1
    case "claimed":
      return 2
    case "review":
      return 3
    case "pending":
      return 4
    case "done":
      return 5
    case "cancelled":
      return 6
  }
}

function taskRank(task: Task): number {
  return statusRank(task.status)
}

function taskNumber(task: Task): number {
  return Number(task.id.replace(/^t_/, "")) || 0
}

export function renderCharter(team: Team, member: Member, members: Member[], charter: string, limits: Limits): string {
  const goal = truncateChars(team.goal, 320)
  const role = truncateChars(charter, 520)
  const peers = members
    .filter((m) => m.id !== member.id && m.status !== "stopped" && m.status !== "failed")
    .map((m) => `  ${m.id} (${m.role}) · ${m.agent}`)
    .join("\n")
  const lines = [
    `[team-mode] team=${team.id} member=${member.id} role=${member.role}`,
    `Team goal: ${goal}`,
    `Your role: ${role}`,
    `Identity: you are ${member.id}. Never claim to be another member; tools derive the sender from your session.`,
    peers.length
      ? `Your teammates:\n${peers}\nMessage any teammate directly with team_send(to="<their-id>", ...). Everyone on the team sees peer messages.`
      : "You are the only team member.",
    "Workflow: claim one task with team_task_claim, declare every path you will touch, do the work, then team_task_update status=review or done.",
    "Use team_send to report progress or ask the lead; use team_inbox to read messages.",
    "If blocked, set the task status=blocked with the reason and message the lead. Keep every report short and factual.",
    `Limits: one active task, ${limits.maxMemberTurns} turns, ${limits.maxMemberMinutes} minutes, ${limits.maxMessagesPerMemberPerMinute} messages/minute.`,
  ]
  return truncateTokens(lines.join("\n"), 400)
}

export function renderBoard(
  team: Team,
  members: Member[],
  tasks: Task[],
  viewer: Member,
  unread: number,
  maxTokens = 300,
): string {
  const active = tasks
    .filter((task) => task.status !== "done" && task.status !== "cancelled")
    .sort((a, b) => taskRank(a) - taskRank(b) || taskNumber(a) - taskNumber(b))
  const finished = tasks.filter((task) => task.status === "done" || task.status === "cancelled").length
  const shown = active.slice(0, 14)
  const lines = [
    `Team ${team.name} (${team.id}) board v${team.boardVersion} · ${members.length} members · ${tasks.length} tasks (${finished} closed)`,
  ]
  for (const task of shown) {
    const owner = task.owner ? ` · ${task.owner}` : ""
    const deps = task.dependsOn.length ? ` · after ${task.dependsOn.join(",")}` : ""
    const paths = task.paths.length ? ` · paths ${task.paths.slice(0, 3).join(",")}` : ""
    lines.push(`${task.id} [${task.status}] ${oneLine(task.title, 90)}${owner}${deps}${paths}`)
  }
  if (active.length > shown.length) lines.push(`… ${active.length - shown.length} more open tasks; use team_task_list`)
  lines.push(`You: ${viewer.id} (${viewer.role}) · unread: ${unread}`)
  return truncateTokens(lines.join("\n"), maxTokens)
}

export function renderMember(member: Member, now: number): string {
  const state = member.status === "working" ? `working ${timeAgo(member.lastActiveAt, now)}` : member.status
  const wait = member.waitingOn.length ? ` · waiting on ${member.waitingOn.join(",")}` : ""
  return `${member.id} [${state}] ${member.agent} · turns ${member.turns} · ${formatCost(member.costUSD)}${wait}`
}

export function renderStatus(team: Team, members: Member[], tasks: Task[], now: number): string {
  const open = tasks.filter((task) => task.status !== "done" && task.status !== "cancelled")
  const counts = new Map<string, number>()
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1)
  const countLine = [...counts.entries()]
    .sort((a, b) => statusRank(a[0] as Task["status"]) - statusRank(b[0] as Task["status"]))
    .map(([status, count]) => `${status}:${count}`)
    .join(" ")
  const lines = [
    `Team ${team.name} (${team.id}) · ${team.status} · topology ${team.topology}`,
    `Goal: ${truncateChars(team.goal, 400)}`,
    `Lead session: ${team.leadSessionID} · created ${timeAgo(team.createdAt, now)} ago · version ${team.version}`,
    `Tasks: ${tasks.length} total · ${countLine || "none"}`,
    "**Members:**",
    ...members.map((member) => `- ${renderMember(member, now)}`),
  ]
  if (team.stopReason) lines.push(`Stop reason: ${oneLine(team.stopReason, 200)}`)
  if (open.length) {
    lines.push("**Open tasks:**")
    for (const task of open.sort((a, b) => taskRank(a) - taskRank(b) || taskNumber(a) - taskNumber(b)).slice(0, 18)) {
      const owner = task.owner ? ` · ${task.owner}` : ""
      lines.push(`- ${task.id} [${task.status}] ${oneLine(task.title, 100)}${owner}`)
    }
  }
  return truncateTokens(lines.join("\n"), 900)
}

export function renderTask(task: Task): string {
  const lines = [
    `${task.id} [${task.status}] ${task.title}`,
    task.owner ? `owner: ${task.owner}` : "owner: unclaimed",
    `created by: ${task.createdBy} · version ${task.version}`,
  ]
  if (task.dependsOn.length) lines.push(`depends on: ${task.dependsOn.join(", ")}`)
  if (task.paths.length) lines.push(`paths: ${task.paths.join(", ")}`)
  if (task.handoffFrom) lines.push(`handoff from: ${task.handoffFrom}`)
  if (task.description) lines.push(`description: ${truncateChars(task.description, 1200)}`)
  if (task.result) lines.push(`result: ${truncateChars(task.result, 1600)}`)
  return truncateTokens(lines.join("\n"), 500)
}

export function renderDelivery(envelope: Envelope, fromLabel: string): string {
  const head = `[team] ${fromLabel} → you · ${envelope.type}/${envelope.priority} · ${envelope.id}`
  const subject = envelope.subject ? `\n${oneLine(envelope.subject, 120)}` : ""
  const body = truncateChars(envelope.body, 1000)
  const reply = envelope.requiresReply
    ? `\nReply with team_send(to="${envelope.from}", replyTo="${envelope.id}", ...).`
    : ""
  return truncateTokens(`${head}${subject}\n${body}${reply}`, 300)
}

export function renderEnvelope(envelope: Envelope, now: number, maxBody = 700): string {
  const flags = [
    envelope.priority === "urgent" ? "urgent" : "",
    envelope.deliveredAt ? "" : "undelivered",
    envelope.readAt ? "read" : "unread",
    envelope.expiresAt <= now ? "expired" : "",
  ]
    .filter(Boolean)
    .join(",")
  const subject = envelope.subject ? ` · ${oneLine(envelope.subject, 100)}` : ""
  return [
    `${envelope.id} · ${envelope.from} → ${envelope.to} · ${envelope.type}${subject} · ${flags}`,
    truncateChars(envelope.body, maxBody),
  ].join("\n")
}

export function renderInbox(envelopes: Envelope[], now: number): string {
  if (!envelopes.length) return "No unread messages."
  const blocks = envelopes.slice(0, 8).map((envelope) => renderEnvelope(envelope, now))
  const text = blocks.join("\n\n")
  return truncateTokens(text, 1200)
}

export function renderUsage(): string {
  return [
    "**Team Mode usage:**",
    '- `/team start "<goal>"` — create a team with this session as lead',
    "- `/team status` — show the board and members",
    "- `/team say <text>` — broadcast a message from the lead",
    "- `/team stop [member]` — stop the whole team or one member",
  ].join("\n")
}

export function estimateCharsForTokens(tokens: number): number {
  return tokens * CHARTS
}
