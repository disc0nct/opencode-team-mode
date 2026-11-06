import type { Envelope, Member, Task, Team } from "../types.ts"
import type { Clock, IdSource } from "./ids.ts"
import { Mutex } from "./mutex.ts"

export interface KVEntry {
  key: string
  value: unknown
}

export interface StorageLike {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(prefix: string): Promise<KVEntry[]>
}

interface Snapshot {
  team: Team
  members: Map<string, Member>
  tasks: Map<string, Task>
  inbox: Map<string, Envelope[]>
  aux: Map<string, unknown>
}

const TEAM_ROOT = "team"

export function teamPrefix(teamID: string): string {
  return `${TEAM_ROOT}/${teamID}`
}

const TEAM_STATUS_RANK: Record<Team["status"], number> = {
  active: 0,
  paused: 1,
  stopping: 2,
  stopped: 3,
}

export class TeamStore {
  private readonly storage: StorageLike
  private readonly clock: Clock
  private readonly ids: IdSource
  private readonly mutex = new Mutex()
  private readonly cache = new Map<
    string,
    { at: number; team: Team; members: Map<string, Member>; tasks: Map<string, Task> }
  >()
  /**
   * Sessions probed and found to belong to no team. Tool and context hooks run
   * for every session in the instance; without this cache each non-team tool
   * call would rescan the whole team tree.
   */
  private readonly nonTeamSessions = new Set<string>()

  constructor(storage: StorageLike, clock: Clock, ids: IdSource) {
    this.storage = storage
    this.clock = clock
    this.ids = ids
  }

  async createTeam(team: Team, lead: Member): Promise<void> {
    await this.mutex.run(team.id, async () => {
      await this.storage.set(this.teamKey(team.id), team)
      await this.storage.set(this.memberKey(team.id, lead.id), lead)
      await this.writeIndex(lead.sessionID, { teamID: team.id, memberID: lead.id })
      this.invalidate(team.id)
    })
  }

  async getTeam(teamID: string): Promise<Team | undefined> {
    return this.storage.get<Team>(this.teamKey(teamID))
  }

  async getMember(teamID: string, memberID: string): Promise<Member | undefined> {
    return this.storage.get<Member>(this.memberKey(teamID, memberID))
  }

  async getTask(teamID: string, taskID: string): Promise<Task | undefined> {
    return this.storage.get<Task>(`${teamPrefix(teamID)}/tasks/${taskID}`)
  }

  async getEnvelope(teamID: string, memberID: string, envelopeID: string): Promise<Envelope | undefined> {
    return this.storage.get<Envelope>(`${teamPrefix(teamID)}/inbox/${memberID}/${envelopeID}`)
  }

  async removeEnvelope(teamID: string, memberID: string, envelopeID: string): Promise<void> {
    await this.storage.remove(`${teamPrefix(teamID)}/inbox/${memberID}/${envelopeID}`)
  }

  async findTeamForSession(sessionID: string): Promise<{ teamID: string; memberID: string } | undefined> {
    if (this.nonTeamSessions.has(sessionID)) return undefined
    const direct = await this.storage.get<{ teamID: string; memberID: string }>(this.indexKey(sessionID))
    if (direct) return direct
    // Prefer live teams so a recycled session ID binds to the team that is
    // actually running rather than an old stopped one.
    const teams = (await this.listTeams()).sort(
      (a, b) => TEAM_STATUS_RANK[a.status] - TEAM_STATUS_RANK[b.status] || a.createdAt - b.createdAt,
    )
    for (const team of teams) {
      for (const m of await this.members(team.id)) {
        if (m.sessionID === sessionID) {
          await this.writeIndex(sessionID, { teamID: team.id, memberID: m.id })
          return { teamID: team.id, memberID: m.id }
        }
      }
    }
    this.nonTeamSessions.add(sessionID)
    return undefined
  }

  async listTeams(): Promise<Team[]> {
    const teams: Team[] = []
    for (const entry of await this.storage.scan(`${TEAM_ROOT}/`)) {
      if (entry.key.endsWith("/meta") && entry.value) teams.push(entry.value as Team)
    }
    return teams.sort((a, b) => a.createdAt - b.createdAt)
  }

  async members(teamID: string): Promise<Member[]> {
    const prefix = `${teamPrefix(teamID)}/members/`
    const out: Member[] = []
    for (const entry of await this.storage.scan(prefix)) out.push(entry.value as Member)
    return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  async tasks(teamID: string): Promise<Task[]> {
    const prefix = `${teamPrefix(teamID)}/tasks/`
    const out: Task[] = []
    for (const entry of await this.storage.scan(prefix)) out.push(entry.value as Task)
    return out.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  }

  async snapshot(
    teamID: string,
    maxAgeMs = 500,
  ): Promise<{ team: Team; members: Member[]; tasks: Task[] } | undefined> {
    const cached = this.cache.get(teamID)
    const now = this.clock.now()
    if (cached && now - cached.at <= maxAgeMs) {
      return { team: cached.team, members: [...cached.members.values()], tasks: [...cached.tasks.values()] }
    }
    const team = await this.getTeam(teamID)
    if (!team) return undefined
    const members = await this.members(teamID)
    const tasks = await this.tasks(teamID)
    this.cache.set(teamID, {
      at: now,
      team,
      members: new Map(members.map((m) => [m.id, m])),
      tasks: new Map(tasks.map((t) => [t.id, t])),
    })
    return { team, members, tasks }
  }

  invalidate(teamID?: string): void {
    if (teamID) this.cache.delete(teamID)
    else this.cache.clear()
  }

  async transact<T>(teamID: string, fn: (tx: TeamTx) => Promise<T>): Promise<T> {
    return this.mutex.run(teamID, async () => {
      const snap = await this.load(teamID)
      const tx = new TeamTx(snap, this.storage, this.clock, this.ids, teamID)
      try {
        const result = await fn(tx)
        // Flush only after a successful operation. A thrown TeamError must not
        // persist a half-applied mutation (for example a claim that then fails
        // its lease check).
        await tx.flush()
        return result
      } finally {
        this.invalidate(teamID)
      }
    })
  }

  async inbox(teamID: string, memberID: string): Promise<Envelope[]> {
    const prefix = `${teamPrefix(teamID)}/inbox/${memberID}/`
    const out: Envelope[] = []
    for (const entry of await this.storage.scan(prefix)) out.push(entry.value as Envelope)
    return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  async appendEnvelope(teamID: string, memberID: string, envelope: Envelope): Promise<void> {
    await this.storage.set(`${teamPrefix(teamID)}/inbox/${memberID}/${envelope.id}`, envelope)
  }

  async saveEnvelope(teamID: string, memberID: string, envelope: Envelope): Promise<void> {
    await this.storage.set(`${teamPrefix(teamID)}/inbox/${memberID}/${envelope.id}`, envelope)
  }

  async appendLog(teamID: string, type: string, data: Record<string, unknown>, cap = 200): Promise<void> {
    const key = `${teamPrefix(teamID)}/log/${this.ids.ulid()}`
    await this.storage.set(key, { type, at: this.clock.now(), ...data })
    const entries = await this.storage.scan(`${teamPrefix(teamID)}/log/`)
    if (entries.length > cap) {
      for (const entry of entries.sort((a, b) => a.key.localeCompare(b.key)).slice(0, entries.length - cap)) {
        await this.storage.remove(entry.key)
      }
    }
  }

  async readAux<T>(teamID: string, name: string): Promise<T | undefined> {
    return this.storage.get<T>(`${teamPrefix(teamID)}/aux/${name}`)
  }

  async auxEntries(teamID: string): Promise<Array<{ name: string; value: unknown }>> {
    const prefix = `${teamPrefix(teamID)}/aux/`
    const entries = await this.storage.scan(prefix)
    return entries.map((entry) => ({ name: entry.key.slice(prefix.length), value: entry.value }))
  }

  async writeAux(teamID: string, name: string, value: unknown): Promise<void> {
    await this.storage.set(`${teamPrefix(teamID)}/aux/${name}`, value)
  }

  async removeAux(teamID: string, name: string): Promise<void> {
    await this.storage.remove(`${teamPrefix(teamID)}/aux/${name}`)
  }

  async writeIndex(sessionID: string, value: { teamID: string; memberID: string }): Promise<void> {
    this.nonTeamSessions.delete(sessionID)
    await this.storage.set(this.indexKey(sessionID), value)
  }

  async removeIndex(sessionID: string): Promise<void> {
    this.nonTeamSessions.add(sessionID)
    await this.storage.remove(this.indexKey(sessionID))
  }

  /**
   * Loads a team with targeted scans. The log tree is never read here — it is
   * audit-only data and previously made every transaction deserialize up to
   * 200 log entries.
   */
  private async load(teamID: string): Promise<Snapshot> {
    const prefix = teamPrefix(teamID)
    const team = await this.storage.get<Team>(`${prefix}/meta`)
    if (!team) throw new StoreError(`team ${teamID} not found`)

    const snap: Snapshot = {
      team,
      members: new Map(),
      tasks: new Map(),
      inbox: new Map(),
      aux: new Map(),
    }
    for (const entry of await this.storage.scan(`${prefix}/members/`)) {
      const member = entry.value as Member
      snap.members.set(member.id, member)
    }
    for (const entry of await this.storage.scan(`${prefix}/tasks/`)) {
      const task = entry.value as Task
      snap.tasks.set(task.id, task)
    }
    for (const entry of await this.storage.scan(`${prefix}/inbox/`)) {
      const parts = entry.key.slice(prefix.length + 1).split("/")
      const memberID = parts[1] ?? ""
      const list = snap.inbox.get(memberID) ?? []
      list.push(entry.value as Envelope)
      snap.inbox.set(memberID, list)
    }
    for (const entry of await this.storage.scan(`${prefix}/aux/`)) {
      snap.aux.set(entry.key.slice(prefix.length + 5), entry.value)
    }
    return snap
  }

  private teamKey(teamID: string): string {
    return `${teamPrefix(teamID)}/meta`
  }

  private memberKey(teamID: string, memberID: string): string {
    return `${teamPrefix(teamID)}/members/${memberID}`
  }

  private indexKey(sessionID: string): string {
    return `session/${sessionID}`
  }
}

export class StoreError extends Error {}

export class TeamTx {
  private readonly snap: Snapshot
  private readonly storage: StorageLike
  private readonly clock: Clock
  private readonly ids: IdSource
  private readonly teamID: string
  private readonly dirtyMembers = new Set<string>()
  private readonly dirtyTasks = new Set<string>()
  private readonly dirtyEnvelopes: Array<{ memberID: string; envelope: Envelope }> = []
  private readonly dirtyAux = new Set<string>()
  private teamDirty = false
  /**
   * Deep clone of the snapshot taken at transaction start. If storage fails
   * mid-flush, dirty keys are restored from here so a partially applied write
   * cannot become permanent state.
   */
  private readonly baseline: Snapshot

  constructor(snap: Snapshot, storage: StorageLike, clock: Clock, ids: IdSource, teamID: string) {
    this.snap = snap
    this.storage = storage
    this.clock = clock
    this.ids = ids
    this.teamID = teamID
    this.baseline = JSON.parse(JSON.stringify(snap)) as Snapshot
  }

  team(): Team {
    return this.snap.team
  }

  putTeam(team: Team): void {
    this.snap.team = team
    this.teamDirty = true
  }

  member(id: string): Member | undefined {
    return this.snap.members.get(id)
  }

  members(): Member[] {
    return [...this.snap.members.values()]
  }

  putMember(member: Member): void {
    this.snap.members.set(member.id, member)
    this.dirtyMembers.add(member.id)
    this.teamDirty = true
  }

  removeMember(id: string): void {
    this.snap.members.delete(id)
    this.dirtyMembers.add(id)
    this.teamDirty = true
  }

  task(id: string): Task | undefined {
    return this.snap.tasks.get(id)
  }

  tasks(): Task[] {
    return [...this.snap.tasks.values()]
  }

  putTask(task: Task): void {
    this.snap.tasks.set(task.id, task)
    this.dirtyTasks.add(task.id)
    this.teamDirty = true
  }

  removeTask(id: string): void {
    this.snap.tasks.delete(id)
    this.dirtyTasks.add(id)
    this.teamDirty = true
  }

  envelope(memberID: string, envelopeID: string): Envelope | undefined {
    return (this.snap.inbox.get(memberID) ?? []).find((envelope) => envelope.id === envelopeID)
  }

  envelopes(memberID: string): Envelope[] {
    return [...(this.snap.inbox.get(memberID) ?? [])]
  }

  findEnvelope(envelopeID: string): Envelope | undefined {
    for (const list of this.snap.inbox.values()) {
      const found = list.find((envelope) => envelope.id === envelopeID)
      if (found) return found
    }
    return undefined
  }

  putEnvelope(memberID: string, envelope: Envelope): void {
    const list = this.snap.inbox.get(memberID) ?? []
    const index = list.findIndex((item) => item.id === envelope.id)
    if (index >= 0) list[index] = envelope
    else list.push(envelope)
    this.snap.inbox.set(memberID, list)
    this.dirtyEnvelopes.push({ memberID, envelope })
  }

  auxEntries(): Array<{ name: string; value: unknown }> {
    return [...this.snap.aux.entries()].map(([name, value]) => ({ name, value }))
  }

  aux(name: string): unknown {
    return this.snap.aux.get(name)
  }

  putAux(name: string, value: unknown): void {
    this.snap.aux.set(name, value)
    this.dirtyAux.add(name)
  }

  removeAux(name: string): void {
    this.snap.aux.delete(name)
    this.dirtyAux.add(name)
  }

  nextTaskID(): string {
    const team = this.snap.team
    team.nextTask += 1
    this.teamDirty = true
    return this.ids.taskId(team.nextTask)
  }

  bumpBoard(): void {
    const team = this.snap.team
    team.boardVersion += 1
    this.teamDirty = true
  }

  touch(): void {
    this.teamDirty = true
  }

  async flush(): Promise<void> {
    const written: string[] = []
    try {
      for (const id of this.dirtyMembers) {
        const member = this.snap.members.get(id)
        const key = `${teamPrefix(this.teamID)}/members/${id}`
        if (member) await this.storage.set(key, member)
        else await this.storage.remove(key)
        written.push(key)
      }
      for (const id of this.dirtyTasks) {
        const task = this.snap.tasks.get(id)
        const key = `${teamPrefix(this.teamID)}/tasks/${id}`
        if (task) await this.storage.set(key, task)
        else await this.storage.remove(key)
        written.push(key)
      }
      for (const entry of this.dirtyEnvelopes) {
        const key = `${teamPrefix(this.teamID)}/inbox/${entry.memberID}/${entry.envelope.id}`
        await this.storage.set(key, entry.envelope)
        written.push(key)
      }
      for (const name of this.dirtyAux) {
        const value = this.snap.aux.get(name)
        const key = `${teamPrefix(this.teamID)}/aux/${name}`
        if (value === undefined) await this.storage.remove(key)
        else await this.storage.set(key, value)
        written.push(key)
      }
      if (this.teamDirty) {
        const team = this.snap.team
        team.version += 1
        team.updatedAt = this.clock.now()
        const key = `${teamPrefix(this.teamID)}/meta`
        await this.storage.set(key, team)
        written.push(key)
      }
    } catch (error) {
      // Best-effort compensating rollback: storage has no batch writes, so a
      // failure mid-flush would otherwise leave a permanently fractured team.
      await this.rollback(written)
      throw error
    }
  }

  private async rollback(written: string[]): Promise<void> {
    for (const key of written.reverse()) {
      try {
        const original = this.baselineValue(key)
        if (original === undefined) await this.storage.remove(key)
        else await this.storage.set(key, original)
      } catch {
        // Nothing more can be done without a storage-level journal; the cache
        // is invalidated by transact() so the next read reloads from storage.
      }
    }
  }

  private baselineValue(key: string): unknown {
    const prefix = `${teamPrefix(this.teamID)}/`
    const rest = key.slice(prefix.length)
    if (rest === "meta") return this.baseline.team
    if (rest.startsWith("members/")) return this.baseline.members.get(rest.slice(8))
    if (rest.startsWith("tasks/")) return this.baseline.tasks.get(rest.slice(6))
    if (rest.startsWith("aux/")) return this.baseline.aux.get(rest.slice(4))
    if (rest.startsWith("inbox/")) {
      const [, memberID, envelopeID] = rest.split("/")
      return (this.baseline.inbox.get(memberID ?? "") ?? []).find((env) => env.id === envelopeID)
    }
    return undefined
  }
}
