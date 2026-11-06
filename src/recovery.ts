import type { Host } from "./host.ts"
import type { Envelope, Member, SessionRef, Team } from "./types.ts"
import type { TeamStore } from "./core/store.ts"

export interface RecoveryMember {
  member: Member
  session?: SessionRef
  undelivered: Envelope[]
}

export interface RecoveryPlan {
  team: Team
  lead?: SessionRef
  members: RecoveryMember[]
}

/**
 * Read-only scan used at setup. Applying the plan is TeamService's job so that
 * recovery uses the same delivery and instruction paths as normal operation.
 */
export async function scanRecovery(host: Host, store: TeamStore, projectID?: string): Promise<RecoveryPlan[]> {
  const plans: RecoveryPlan[] = []
  for (const team of await store.listTeams()) {
    if (team.status !== "active" && team.status !== "paused") continue
    if (projectID && team.projectID !== projectID) continue
    const lead = await safeSession(host, team.leadSessionID)
    const members: RecoveryMember[] = []
    for (const member of await store.members(team.id)) {
      const session = member.sessionID ? await safeSession(host, member.sessionID) : undefined
      const undelivered = (await store.inbox(team.id, member.id)).filter((envelope) => !envelope.deliveredAt)
      members.push({ member, session, undelivered })
    }
    plans.push({ team, lead, members })
  }
  return plans
}

async function safeSession(host: Host, sessionID: string): Promise<SessionRef | undefined> {
  try {
    return await host.sessions.get(sessionID)
  } catch {
    return undefined
  }
}
