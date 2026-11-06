import { fail } from "../errors.ts"
import type { Host, HostEvent } from "../host.ts"
import { scanRecovery } from "../recovery.ts"
import type {
  Delivery,
  Envelope,
  EnvelopeType,
  Member,
  ModelRef,
  Priority,
  Task,
  TaskStatus,
  Team,
  TeamConfig,
  Topology,
} from "../types.ts"
import {
  type AddTaskInput,
  type UpdateTaskInput,
  addTask,
  claimTask,
  handoffTask,
  releaseTasksOf,
  updateTask,
} from "./board.ts"
import type { Clock, IdSource } from "./ids.ts"
import {
  type PairState,
  type RateState,
  type WaitEdge,
  budgetViolation,
  effectiveWaitTimeout,
  normalizePaths,
  teamCost,
  waitCyclePath,
  wouldCycle,
} from "./limits.ts"
import { Mailbox, type MailboxPort, type SendOutcome } from "./mailbox.ts"
import { renderBoard, renderCharter, renderInbox, renderStatus, renderTask } from "./render.ts"
import { permissionRules, roleAgent, rolePreset } from "./roles.ts"
import type { TeamStore } from "./store.ts"

export interface CreateTeamInput {
  name?: string
  goal: string
  topology?: Topology
  defaultAgent?: string
  defaultModel?: ModelRef
}

export interface SpawnMemberInput {
  role: string
  brief?: string
  agent?: string
  model?: ModelRef
}

export interface SendMessageInput {
  to: string
  type?: EnvelopeType
  subject?: string
  body: string
  priority?: Priority
  replyTo?: string
  correlationID?: string
  requiresReply?: boolean
}

export interface BroadcastInput {
  subject?: string
  body: string
  priority?: Priority
}

export interface WaitInput {
  forMember?: string
  forTask?: string
  timeoutMs?: number
  reason?: string
}

export interface StopInput {
  memberID?: string
  reason?: string
}

const INSTRUCTION_KEY_CHARTER = "team.charter"
const INSTRUCTION_KEY_BOARD = "team.board"

function slugifyName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}

function teamNameFromGoal(goal: string): string {
  const slug = slugifyName(goal)
  if (slug.length >= 3) return slug
  return `team-${Math.random().toString(36).slice(2, 8)}`
}

export class TeamService {
  readonly host: Host
  readonly store: TeamStore
  readonly clock: Clock
  readonly ids: IdSource
  readonly config: TeamConfig
  readonly mailbox: Mailbox

  private sweepTimer?: ReturnType<typeof setInterval>
  private stopped = false
  private sweeping = false
  private readonly idleDeliveryInFlight = new Set<string>()

  constructor(host: Host, store: TeamStore, clock: Clock, ids: IdSource, config: TeamConfig) {
    this.host = host
    this.store = store
    this.clock = clock
    this.ids = ids
    this.config = config

    const port: MailboxPort = {
      isBusy: async (member) => {
        if (!member.sessionID) return false
        return this.host.sessions.isBusy(member.sessionID)
      },
      synthesize: async (member, text, delivery, description) => {
        if (!member.sessionID) return
        await this.host.sessions.synthesize(member.sessionID, {
          text,
          delivery,
          description,
        })
      },
    }

    this.mailbox = new Mailbox(store, clock, ids, config, port)
  }

  startSweeper(): void {
    if (this.sweepTimer || this.stopped) return
    const interval = Math.max(2_000, this.config.limits.sweepMs)
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch(() => undefined)
    }, interval)
  }

  stopSweeper(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
    }
    this.stopped = true
  }

  async resolveActor(sessionID: string): Promise<{ team: Team; member: Member }> {
    const mapping = await this.store.findTeamForSession(sessionID)
    if (!mapping) {
      fail(
        "this session does not belong to an active team.",
        'Start a team with /team start "<goal>" or use team_create.',
        "not_in_team",
      )
    }
    const team = await this.store.getTeam(mapping.teamID)
    if (!team) {
      fail(
        `team ${mapping.teamID} does not exist or has been deleted.`,
        'Start a new team with /team start "<goal>".',
        "team_not_found",
      )
    }
    const member = await this.store.getMember(team.id, mapping.memberID)
    if (!member) {
      fail(
        `member ${mapping.memberID} not found in team ${team.id}.`,
        "Rejoin the team or ask the lead to recreate the session.",
        "member_not_found",
      )
    }
    return { team, member }
  }

  async createTeam(actorSessionID: string, input: CreateTeamInput): Promise<{ team: Team; lead: Member }> {
    const existing = await this.store.findTeamForSession(actorSessionID)
    if (existing) {
      const activeTeam = await this.store.getTeam(existing.teamID)
      if (activeTeam && (activeTeam.status === "active" || activeTeam.status === "paused")) {
        fail(
          `session is already part of team ${activeTeam.name} (${activeTeam.id}).`,
          "Stop the current team with /team stop before creating a new one.",
          "team_already_exists",
        )
      }
    }

    const goal = input.goal.trim()
    if (!goal) {
      fail("a team goal is required.", 'Provide a clear, high-level goal: team_create(goal: "...")', "invalid_goal")
    }

    const teamID = this.ids.teamId()
    const now = this.clock.now()
    const name = (input.name?.trim() || teamNameFromGoal(goal)).slice(0, 60)
    const topology = input.topology ?? this.config.topology

    const team: Team = {
      id: teamID,
      name,
      goal,
      leadSessionID: actorSessionID,
      projectID: this.host.projectID,
      topology,
      status: "active",
      createdAt: now,
      updatedAt: now,
      version: 1,
      nextTask: 0,
      boardVersion: 1,
      instanceID: this.ids.ulid(),
    }

    const leadPreset = rolePreset(this.config, "lead")
    const leadSession = await this.host.sessions.get(actorSessionID)

    const lead: Member = {
      id: "lead",
      teamID,
      role: "lead",
      depth: 0,
      sessionID: actorSessionID,
      agent: leadSession?.agent ?? roleAgent(this.config, leadPreset),
      model: input.defaultModel ?? this.config.defaultModel,
      status: "working",
      brief: "Team lead session",
      createdAt: now,
      lastActiveAt: now,
      turns: 0,
      costUSD: leadSession?.costUSD ?? 0,
      unread: 0,
      waitingOn: [],
    }

    await this.store.createTeam(team, lead)
    await this.store.appendLog(team.id, "team.created", { goal, leadSessionID: actorSessionID })

    await this.refreshMemberInstructions(team, lead, [lead], [], true)
    return { team, lead }
  }

  async spawn(actorSessionID: string, input: SpawnMemberInput): Promise<Member> {
    const { team, member: actor } = await this.resolveActor(actorSessionID)
    if (team.status !== "active") {
      fail(`team ${team.id} is ${team.status}.`, "Resume or recreate the team first.", "team_not_active")
    }

    if (team.topology === "hub" && actor.role !== "lead") {
      fail("only the lead can spawn new team members in hub topology.", "Ask the lead to spawn teammates.", "not_lead")
    }

    const role = input.role.trim()
    const preset = rolePreset(this.config, role)
    const agent = input.agent?.trim() || roleAgent(this.config, preset)
    const model = input.model ?? this.config.defaultModel

    // Depth budget: children can never nest deeper than the configured limit.
    if ((actor.depth ?? 0) + 1 > this.config.limits.maxDepth) {
      fail(
        `spawning exceeds the team depth limit (${this.config.limits.maxDepth}).`,
        "Coordinate with existing teammates instead of nesting sub-teams.",
        "depth_limit_exceeded",
      )
    }

    // Privilege parity in mesh topology: a restricted role (for example one
    // with edit/shell denied) must not be able to spawn a less restricted
    // role and act through it.
    if (team.topology === "mesh" && actor.role !== "lead") {
      const actorPreset = this.config.roles[actor.role]
      const actorDeny = actorPreset?.deny ?? []
      const targetDeny = new Set(preset.deny)
      const escalated = actorDeny.filter((action) => !targetDeny.has(action))
      if (escalated.length) {
        fail(
          `role "${role}" is less restricted than your role (${escalated.join(", ")} not denied for it).`,
          "Ask the lead to spawn this member, or choose a role whose deny list includes all of your restrictions.",
          "spawn_privilege_escalation",
        )
      }
    }

    const members = await this.store.members(team.id)
    if (members.length >= this.config.limits.maxMembers) {
      fail(
        `team member limit reached (${this.config.limits.maxMembers}).`,
        "Stop finished members before spawning new ones.",
        "member_limit_reached",
      )
    }

    if (this.config.humanApproval === "ask") {
      await this.host.assertPermission({
        sessionID: actorSessionID,
        action: "team.spawn",
        resources: [role],
        metadata: { role, agent },
      })
    }

    const roleMembers = members.filter((m) => m.role === role)
    const memberIndex = roleMembers.length + 1
    const memberID = this.ids.memberId(role, memberIndex)
    const now = this.clock.now()

    const permissions = permissionRules(preset)

    const session = await this.host.sessions.create({
      parentID: team.leadSessionID,
      title: `${team.name} / ${memberID}`,
      agent,
      model,
      permissions,
    })

    const newMember: Member = {
      id: memberID,
      teamID: team.id,
      role,
      depth: (actor.depth ?? 0) + 1,
      sessionID: session.id,
      agent,
      model,
      status: "idle",
      brief: input.brief?.trim().slice(0, 1200) || `${role} agent`,
      createdAt: now,
      lastActiveAt: now,
      turns: 0,
      costUSD: 0,
      unread: 0,
      waitingOn: [],
    }

    try {
      // Re-validate cap and uniqueness inside the transaction so two
      // concurrent spawns cannot both commit (session.create is async and
      // outside the per-team mutex).
      await this.store.transact(team.id, async (tx) => {
        if (tx.members().length >= this.config.limits.maxMembers) {
          fail(
            `team member limit reached (${this.config.limits.maxMembers}).`,
            "Stop finished members before spawning new ones.",
            "member_limit_reached",
          )
        }
        if (tx.member(memberID)) {
          fail(
            `member ID ${memberID} already exists.`,
            "Retry the spawn; a concurrent spawn claimed this ID.",
            "member_id_collision",
          )
        }
        if (tx.members().some((m) => m.sessionID === session.id)) {
          fail(
            `session ${session.id} is already bound to a member.`,
            "Retry the spawn; a concurrent spawn claimed this session.",
            "session_collision",
          )
        }
        tx.putMember(newMember)
        tx.bumpBoard()
      })
    } catch (error) {
      // Roll the orphan session back so a failed spawn never leaks a running
      // session in the background.
      try {
        await this.host.sessions.remove(session.id)
      } catch {
        // ignore cleanup errors
      }
      throw error
    }
    await this.store.writeIndex(session.id, { teamID: team.id, memberID })
    await this.store.appendLog(team.id, "member.spawned", { memberID, role, sessionID: session.id })

    await this.refreshBoardInstructions(team.id, { includeCharter: true })
    return newMember
  }

  async send(actorSessionID: string, input: SendMessageInput): Promise<SendOutcome> {
    const { team, member: from } = await this.resolveActor(actorSessionID)
    if (team.status !== "active") {
      fail(`team ${team.id} is ${team.status}.`, "Resume the team before sending messages.", "team_not_active")
    }

    const to = await this.store.getMember(team.id, input.to)
    if (!to) {
      fail(`recipient ${input.to} does not exist in this team.`, "Check team_status for member IDs.", "unknown_member")
    }

    if (team.topology === "hub" && from.role !== "lead" && to.role !== "lead") {
      fail(
        "direct peer-to-peer messages are disabled in hub topology.",
        "Send your message or update to the lead instead.",
        "topology_disallowed",
      )
    }

    const outcome = await this.mailbox.send(team, {
      from,
      to,
      type: input.type,
      subject: input.subject,
      body: input.body,
      priority: input.priority,
      replyTo: input.replyTo,
      correlationID: input.correlationID,
      requiresReply: input.requiresReply,
    })

    if (outcome.pausedPair) {
      await this.store.appendLog(team.id, "pair.paused", {
        a: outcome.pausedPair.a,
        b: outcome.pausedPair.b,
        reason: outcome.pausedPair.reason,
      })
      fail(
        `message exchange between ${outcome.pausedPair.a} and ${outcome.pausedPair.b} is paused: ${outcome.pausedPair.reason}.`,
        "Update the task board or ask the lead to review before messaging again.",
        "pair_paused",
      )
    }

    // lastActiveAt is stamped inside the mailbox send transaction; no second
    // transaction is needed here.
    return outcome
  }

  async broadcast(actorSessionID: string, input: BroadcastInput): Promise<{ count: number }> {
    const { team, member: from } = await this.resolveActor(actorSessionID)
    if (from.role !== "lead" && team.topology === "hub") {
      fail("only the lead can broadcast to the entire team in hub topology.", "Send to the lead instead.", "not_lead")
    }

    const members = await this.store.members(team.id)
    const targets = members.filter((m) => m.id !== from.id && m.status !== "stopped" && m.status !== "failed")
    let count = 0

    for (const target of targets) {
      try {
        await this.mailbox.send(team, {
          from,
          to: target,
          type: "message",
          subject: input.subject,
          body: input.body,
          priority: input.priority ?? "normal",
        })
        count++
      } catch {
        // Individual failure shouldn't abort the broadcast to remaining members
      }
    }

    return { count }
  }

  async inbox(
    actorSessionID: string,
    options: { unreadOnly?: boolean; limit?: number; markRead?: boolean } = {},
  ): Promise<{ envelopes: Envelope[]; rendered: string }> {
    const { team, member } = await this.resolveActor(actorSessionID)
    const envelopes = await this.mailbox.receive(team, member, options)
    const rendered = renderInbox(envelopes, this.clock.now())
    return { envelopes, rendered }
  }

  async wait(actorSessionID: string, input: WaitInput): Promise<{ completed: boolean; reason: string }> {
    const { team, member } = await this.resolveActor(actorSessionID)

    if (member.role !== "lead" && !this.config.limits.peerWait) {
      fail(
        "peer waiting is disabled by configuration.",
        "Teammates should run asynchronously: do your work or exit your turn. The lead coordinates dependencies.",
        "wait_disabled",
      )
    }

    if (!input.forMember && !input.forTask) {
      fail(
        "must specify forMember or forTask to wait on.",
        "Pass forMember: '<id>' or forTask: '<id>' with an optional timeoutMs.",
        "invalid_wait_target",
      )
    }

    const timeoutMs = effectiveWaitTimeout(this.config.limits, input.timeoutMs)
    const targetID = input.forMember ?? input.forTask!

    await this.store.transact(team.id, async (tx) => {
      if (input.forMember) {
        const auxEdges: WaitEdge[] = tx
          .auxEntries()
          .filter((entry) => entry.name.startsWith("wait."))
          .map((entry) => entry.value as WaitEdge)

        if (wouldCycle(auxEdges, member.id, input.forMember)) {
          const cycle = waitCyclePath(auxEdges, member.id, input.forMember)
          fail(
            `waiting on ${input.forMember} would create a circular wait deadlock (${cycle?.join(" -> ")}).`,
            "Break the cycle by reassigning tasks or resolving dependencies directly.",
            "wait_cycle",
          )
        }

        tx.putAux(`wait.${member.id}`, {
          memberID: member.id,
          targetID: input.forMember,
          at: this.clock.now(),
        })
      }

      const current = tx.member(member.id)
      if (current) {
        current.status = "blocked"
        current.waitingOn = [targetID]
        tx.putMember(current)
        tx.bumpBoard()
      }
    })

    const startWallTime = Date.now()
    const checkInterval = 1_000
    let completed = false
    let reason = "timeout"

    try {
      while (Date.now() - startWallTime < timeoutMs) {
        if (input.forMember) {
          const target = await this.store.getMember(team.id, input.forMember)
          const finished =
            !target ||
            target.status === "done" ||
            target.status === "stopped" ||
            target.status === "failed" ||
            target.status === "idle"
          if (finished) {
            completed = true
            reason = `target member ${input.forMember} reached state ${target?.status ?? "removed"}`
            break
          }
        }

        if (input.forTask) {
          const task = await this.store.getTask(team.id, input.forTask)
          if (!task || task.status === "done" || task.status === "cancelled" || task.status === "review") {
            completed = true
            reason = `target task ${input.forTask} is ${task?.status ?? "removed"}`
            break
          }
        }

        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }
    } finally {
      await this.store.transact(team.id, async (tx) => {
        if (input.forMember) {
          tx.removeAux(`wait.${member.id}`)
        }
        const current = tx.member(member.id)
        if (current) {
          current.status = "working"
          current.waitingOn = []
          tx.putMember(current)
          tx.bumpBoard()
        }
      })
    }

    return { completed, reason }
  }

  async addTask(actorSessionID: string, input: AddTaskInput): Promise<Task> {
    const { team, member: actor } = await this.resolveActor(actorSessionID)
    const task = await this.store.transact(team.id, async (tx) => {
      return addTask(tx, team, actor, input, this.clock.now())
    })
    await this.store.appendLog(team.id, "task.added", { taskID: task.id, title: task.title, createdBy: actor.id })
    await this.refreshBoardInstructions(team.id)
    return task
  }

  async claimTask(actorSessionID: string, taskID: string, paths: string[] = []): Promise<Task> {
    const { team, member } = await this.resolveActor(actorSessionID)
    const task = await this.store.transact(team.id, async (tx) => {
      return claimTask(tx, team, member, taskID, paths, this.clock.now())
    })
    await this.store.appendLog(team.id, "task.claimed", { taskID: task.id, memberID: member.id })
    await this.refreshBoardInstructions(team.id)
    return task
  }

  async updateTask(actorSessionID: string, taskID: string, input: UpdateTaskInput): Promise<Task> {
    const { team, member: actor } = await this.resolveActor(actorSessionID)
    const outcome = await this.store.transact(team.id, async (tx) => {
      return updateTask(tx, team, actor, taskID, input, this.clock.now())
    })

    if (outcome.notifyOwner) {
      const owner = await this.store.getMember(team.id, outcome.notifyOwner.ownerID)
      if (owner) {
        await this.mailbox.system(
          team,
          owner,
          `Task ${taskID} review findings`,
          outcome.notifyOwner.body,
          "urgent",
        )
      }
    }

    await this.store.appendLog(team.id, "task.updated", {
      taskID,
      status: outcome.task.status,
      actorID: actor.id,
    })
    await this.refreshBoardInstructions(team.id)
    return outcome.task
  }

  async listTasks(actorSessionID: string): Promise<Task[]> {
    const { team } = await this.resolveActor(actorSessionID)
    return this.store.tasks(team.id)
  }

  async handoff(actorSessionID: string, taskID: string, toMemberID: string, summary: string): Promise<Task> {
    const { team, member: from } = await this.resolveActor(actorSessionID)
    const to = await this.store.getMember(team.id, toMemberID)
    if (!to) {
      fail(`recipient member ${toMemberID} does not exist.`, "Check team_status for active members.", "unknown_member")
    }

    const task = await this.store.transact(team.id, async (tx) => {
      return handoffTask(tx, team, from, to, taskID, summary, this.clock.now())
    })

    await this.mailbox.send(team, {
      from,
      to,
      type: "handoff",
      subject: `Handoff of ${task.id}: ${task.title}`,
      body: summary,
      priority: "urgent",
      requiresReply: true,
    })

    await this.store.appendLog(team.id, "task.handoff", {
      taskID: task.id,
      from: from.id,
      to: to.id,
    })
    await this.refreshBoardInstructions(team.id)
    return task
  }

  async status(actorSessionID: string): Promise<{ team: Team; members: Member[]; tasks: Task[]; rendered: string }> {
    const { team } = await this.resolveActor(actorSessionID)
    const members = await this.store.members(team.id)
    const tasks = await this.store.tasks(team.id)
    const rendered = renderStatus(team, members, tasks, this.clock.now())
    return { team, members, tasks, rendered }
  }

  async stop(actorSessionID: string, input: StopInput = {}): Promise<{ stopped: string; reason?: string }> {
    const { team, member: actor } = await this.resolveActor(actorSessionID)

    if (input.memberID) {
      if (actor.role !== "lead" && actor.id !== input.memberID) {
        fail("only the lead can stop other team members.", "You can stop yourself, or ask the lead.", "not_lead")
      }

      const target = await this.store.getMember(team.id, input.memberID)
      if (!target) {
        fail(`member ${input.memberID} not found.`, "Check team_status.", "unknown_member")
      }

      await this.store.transact(team.id, async (tx) => {
        const m = tx.member(target.id)
        if (m) {
          m.status = "stopped"
          tx.putMember(m)
        }
        releaseTasksOf(tx, target.id, input.reason || "Member stopped", this.clock.now())
        tx.bumpBoard()
      })

      if (target.sessionID && target.sessionID !== actorSessionID) {
        try {
          await this.host.sessions.interrupt(target.sessionID)
        } catch {
          // ignore interrupt errors on stopped sessions
        }
      }

      await this.store.appendLog(team.id, "member.stopped", { memberID: target.id, reason: input.reason })
      await this.refreshBoardInstructions(team.id)
      return { stopped: target.id, reason: input.reason }
    }

    if (actor.role !== "lead") {
      fail("only the lead can stop the whole team.", "Ask the lead to stop the team.", "not_lead")
    }

    const members = await this.store.members(team.id)
    await this.store.transact(team.id, async (tx) => {
      const t = tx.team()
      t.status = "stopped"
      t.stopReason = input.reason || "Stopped by lead"
      t.killedAt = this.clock.now()
      tx.putTeam(t)

      for (const m of tx.members()) {
        if (m.status !== "stopped") {
          m.status = "stopped"
          tx.putMember(m)
        }
        releaseTasksOf(tx, m.id, "Team stopped", this.clock.now())
      }
      tx.bumpBoard()
    })

    for (const m of members) {
      if (m.sessionID && m.sessionID !== actorSessionID) {
        try {
          await this.host.sessions.interrupt(m.sessionID)
        } catch {
          // ignore interrupt errors
        }
      }
    }

    await this.store.appendLog(team.id, "team.stopped", { reason: input.reason })
    await this.refreshBoardInstructions(team.id)
    return { stopped: team.id, reason: input.reason }
  }

  async refreshBoardInstructions(
    teamID: string,
    options: { includeCharter?: boolean } = {},
  ): Promise<void> {
    const snap = await this.store.snapshot(teamID, 0)
    if (!snap) return
    const { team, members, tasks } = snap

    for (const member of members) {
      if (!member.sessionID) continue
      try {
        await this.refreshMemberInstructions(team, member, members, tasks, options.includeCharter ?? false)
      } catch {
        // Continue to other members even if one session fails
      }
    }
  }

  private async refreshMemberInstructions(
    team: Team,
    member: Member,
    members: Member[],
    tasks: Task[],
    includeCharter = false,
  ): Promise<void> {
    if (!member.sessionID) return
    const preset = this.config.roles[member.role] ?? {
      charter: `You are ${member.id} (${member.role}).`,
      deny: [],
    }

    // The charter is static per member; rewriting it on every board change
    // generated redundant host traffic. It is only (re)written at spawn,
    // team creation and recovery.
    if (includeCharter) {
      const charterText = renderCharter(team, member, members, preset.charter, this.config.limits)
      await this.host.sessions.putInstruction(member.sessionID, INSTRUCTION_KEY_CHARTER, charterText)
    }

    const unread = member.unread ?? 0
    const boardText = renderBoard(team, members, tasks, member, unread)
    await this.host.sessions.putInstruction(member.sessionID, INSTRUCTION_KEY_BOARD, boardText)
  }

  async handleHostEvent(event: HostEvent): Promise<void> {
    const mapping = await this.store.findTeamForSession(event.sessionID)
    if (!mapping) return

    const { teamID, memberID } = mapping
    const team = await this.store.getTeam(teamID)
    if (!team || team.status !== "active") return

    const member = await this.store.getMember(teamID, memberID)
    if (!member) return

    const now = this.clock.now()

    if (event.type === "execution.started") {
      await this.store.transact(teamID, async (tx) => {
        const m = tx.member(memberID)
        if (m) {
          m.status = "working"
          m.lastActiveAt = now
          m.turns += 1
          tx.putMember(m)
        }
      })
    } else if (
      event.type === "execution.succeeded" ||
      event.type === "execution.interrupted" ||
      event.type === "session.idle"
    ) {
      await this.store.transact(teamID, async (tx) => {
        const m = tx.member(memberID)
        if (m && m.status === "working") {
          m.status = "idle"
          m.lastActiveAt = now
          tx.putMember(m)
        }
      })
      // The event stream and the experimental idle hook can both report the
      // same idle transition; only one delivery pass may run at a time per
      // member.
      if (!this.idleDeliveryInFlight.has(memberID)) {
        this.idleDeliveryInFlight.add(memberID)
        try {
          await this.mailbox.deliverPending(team, member)
        } finally {
          this.idleDeliveryInFlight.delete(memberID)
        }
      }
    } else if (event.type === "execution.failed") {
      await this.store.transact(teamID, async (tx) => {
        const m = tx.member(memberID)
        if (m && m.role !== "lead") {
          m.status = "failed"
          tx.putMember(m)
          releaseTasksOf(tx, memberID, "Session execution failed", now)
          tx.bumpBoard()
        }
      })
      await this.refreshBoardInstructions(teamID)
    } else if (event.type === "session.deleted") {
      await this.store.transact(teamID, async (tx) => {
        const m = tx.member(memberID)
        if (m) {
          m.status = "stopped"
          tx.putMember(m)
          releaseTasksOf(tx, memberID, "Session deleted", now)
        }
        if (m?.role === "lead") {
          const t = tx.team()
          t.status = "stopped"
          t.stopReason = "Lead session deleted"
          t.killedAt = now
          tx.putTeam(t)
          for (const other of tx.members()) {
            if (other.status !== "stopped") {
              other.status = "stopped"
              tx.putMember(other)
            }
            releaseTasksOf(tx, other.id, "Lead session deleted", now)
          }
        }
        tx.bumpBoard()
      })
      await this.store.removeIndex(event.sessionID)
      await this.refreshBoardInstructions(teamID)
    }
  }

  async sweep(): Promise<void> {
    // Overlapping sweeps race on member state and duplicate deliveries when a
    // pass takes longer than the interval.
    if (this.sweeping || this.stopped) return
    this.sweeping = true
    try {
      await this.runSweep()
    } finally {
      this.sweeping = false
    }
  }

  private async runSweep(): Promise<void> {
    const now = this.clock.now()
    for (const team of await this.store.listTeams()) {
      if (team.status !== "active") continue
      const members = await this.store.members(team.id)

      // Team budget is enforced exactly once per sweep: exceeding it pauses
      // the whole team instead of terminating members one by one.
      if (this.config.limits.maxTeamCostUSD > 0) {
        const cost = teamCost(members)
        if (cost >= this.config.limits.maxTeamCostUSD) {
          const reason = `team cost ${cost.toFixed(4)} reached the budget ${this.config.limits.maxTeamCostUSD}`
          await this.store.transact(team.id, async (tx) => {
            const t = tx.team()
            t.status = "paused"
            t.pausedReason = reason
            tx.putTeam(t)
          })
          for (const member of members) {
            if (member.sessionID) {
              try {
                await this.host.sessions.interrupt(member.sessionID)
              } catch {
                // ignore interrupt errors
              }
            }
          }
          await this.store.appendLog(team.id, "budget.violation", { reason })
          continue
        }
      }

      let boardChanged = false
      for (const member of members) {
        if (!member.sessionID || member.status === "stopped" || member.status === "failed") continue

        const violation = budgetViolation(member, members, this.config, now)
        if (violation) {
          await this.store.transact(team.id, async (tx) => {
            const m = tx.member(member.id)
            if (m) {
              m.status = "stopped"
              tx.putMember(m)
              releaseTasksOf(tx, m.id, violation, now)
            }
            tx.bumpBoard()
          })
          // A budget-stopped member must actually stop running; otherwise the
          // session keeps burning turns and cost in the background.
          if (member.sessionID) {
            try {
              await this.host.sessions.interrupt(member.sessionID)
            } catch {
              // ignore interrupt errors
            }
          }
          await this.store.appendLog(team.id, "budget.violation", { memberID: member.id, reason: violation })
          boardChanged = true
          continue
        }

        let session
        try {
          session = await this.host.sessions.get(member.sessionID)
        } catch {
          continue
        }
        if (session?.costUSD !== undefined && session.costUSD !== member.costUSD) {
          const costUSD = session.costUSD
          await this.store.transact(team.id, async (tx) => {
            const m = tx.member(member.id)
            if (m) {
              m.costUSD = costUSD
              tx.putMember(m)
            }
          })
        }

        const busy = session?.busy ?? false
        if (!busy) {
          await this.mailbox.deliverPending(team, member)
        }
      }

      const pruned = await this.pruneTeam(team.id, now)
      if (boardChanged || pruned) {
        await this.refreshBoardInstructions(team.id)
      }
    }
  }

  /**
   * Bounds storage growth: expired envelopes and long-idle rate/pair state
   * would otherwise be scanned by every transaction forever.
   */
  private async pruneTeam(teamID: string, now: number): Promise<boolean> {
    let pruned = false
    const envelopeCutoff = now - 60 * 60 * 1_000
    for (const member of await this.store.members(teamID)) {
      for (const envelope of await this.store.inbox(teamID, member.id)) {
        if (envelope.expiresAt < envelopeCutoff) {
          await this.store.removeEnvelope(teamID, member.id, envelope.id)
          pruned = true
        }
      }
    }

    const staleAuxCutoff = 30 * 60 * 1_000
    for (const entry of await this.store.auxEntries(teamID)) {
      if (entry.name.startsWith("wait.")) {
        const edge = entry.value as WaitEdge
        if (typeof edge?.at === "number" && now - edge.at > 10 * 60 * 1_000) {
          await this.store.removeAux(teamID, entry.name)
          pruned = true
        }
        continue
      }
      if (entry.name.startsWith("pairs.")) {
        const pair = entry.value as PairState
        const expiredPause = !pair?.pausedUntil || pair.pausedUntil <= now
        if (typeof pair?.updatedAt === "number" && now - pair.updatedAt > staleAuxCutoff && expiredPause) {
          await this.store.removeAux(teamID, entry.name)
          pruned = true
        }
        continue
      }
      if (entry.name.startsWith("rate.")) {
        const rate = entry.value as RateState
        const latest = Math.max(0, ...(rate?.hits ?? []))
        if (latest > 0 && now - latest > staleAuxCutoff) {
          await this.store.removeAux(teamID, entry.name)
          pruned = true
        }
      }
    }
    return pruned
  }

  async recover(): Promise<void> {
    const plans = await scanRecovery(this.host, this.store, this.host.projectID)
    for (const plan of plans) {
      const { team, members, lead } = plan
      if (!lead || !lead.exists) {
        await this.store.transact(team.id, async (tx) => {
          const t = tx.team()
          t.status = "stopped"
          t.stopReason = "Lead session disappeared across restart"
          t.killedAt = this.clock.now()
          tx.putTeam(t)

          for (const m of tx.members()) {
            if (m.status !== "stopped") {
              m.status = "stopped"
              tx.putMember(m)
            }
            releaseTasksOf(tx, m.id, "Lead session disappeared across restart", this.clock.now())
          }
          tx.bumpBoard()
        })
        await this.store.appendLog(team.id, "team.stopped", { reason: "Lead session disappeared across restart" })
        continue
      }

      // A crash during team_wait leaves ghost wait edges and members frozen in
      // "blocked"; both must be cleared or future waits falsely report
      // deadlocks.
      await this.store.transact(team.id, async (tx) => {
        for (const entry of tx.auxEntries()) {
          if (entry.name.startsWith("wait.")) tx.removeAux(entry.name)
        }
        for (const m of tx.members()) {
          if (m.status === "blocked") {
            m.status = "idle"
            m.waitingOn = []
            tx.putMember(m)
          }
        }
        tx.bumpBoard()
      })

      for (const item of members) {
        const { member, session, undelivered } = item
        if (!session || !session.exists) {
          await this.store.transact(team.id, async (tx) => {
            const m = tx.member(member.id)
            if (m) {
              m.status = "stopped"
              tx.putMember(m)
              releaseTasksOf(tx, m.id, "Session disappeared across restart", this.clock.now())
              tx.bumpBoard()
            }
          })
          continue
        }

        if (session.costUSD !== undefined && session.costUSD !== member.costUSD) {
          const costUSD = session.costUSD
          await this.store.transact(team.id, async (tx) => {
            const m = tx.member(member.id)
            if (m) {
              m.costUSD = costUSD
              tx.putMember(m)
            }
          })
        }

        if (undelivered.length > 0) {
          await this.mailbox.deliverPending(team, member)
        }
      }
      // Charters can be lost with the host process; re-establish them once at
      // startup alongside the fresh board state.
      await this.refreshBoardInstructions(team.id, { includeCharter: true })
    }
  }
}
