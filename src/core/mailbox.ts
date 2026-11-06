import { fail } from "../errors.ts"
import type { Delivery, Envelope, EnvelopeType, Member, Priority, Team, TeamConfig } from "../types.ts"
import type { Clock, IdSource } from "./ids.ts"
import {
  DUPLICATE_WINDOW_MS,
  MAX_BODY_CHARS,
  checkRate,
  exchangeUpdate,
  fingerprint,
  isExpired,
  pairKey,
} from "./limits.ts"
import { Mutex } from "./mutex.ts"
import type { PairState, RateState } from "./limits.ts"
import { renderDelivery, truncateChars } from "./render.ts"
import type { StoreError, TeamStore } from "./store.ts"

export interface MailboxPort {
  isBusy(member: Member): Promise<boolean>
  synthesize(member: Member, text: string, delivery: Delivery, description: string): Promise<void>
}

export interface SendInput {
  from: Member
  to: Member
  type?: EnvelopeType
  subject?: string
  body: string
  priority?: Priority
  replyTo?: string
  correlationID?: string
  requiresReply?: boolean
}

export interface PausedPair {
  a: string
  b: string
  reason: string
}

export interface SendOutcome {
  envelope?: Envelope
  delivered: boolean
  duplicate: boolean
  pausedPair?: PausedPair
}

export interface InboxOptions {
  unreadOnly?: boolean
  limit?: number
  markRead?: boolean
}

export class Mailbox {
  private readonly store: TeamStore
  private readonly clock: Clock
  private readonly ids: IdSource
  private readonly config: TeamConfig
  private readonly port: MailboxPort
  private readonly deliveryMutex = new Mutex()

  constructor(store: TeamStore, clock: Clock, ids: IdSource, config: TeamConfig, port: MailboxPort) {
    this.store = store
    this.clock = clock
    this.ids = ids
    this.config = config
    this.port = port
  }

  async send(team: Team, input: SendInput): Promise<SendOutcome> {
    const body = input.body.trim()
    if (!body) fail("message body is empty.", "Send a short, self-contained message with team_send.", "empty_message")
    if (body.length > MAX_BODY_CHARS) {
      fail(
        `message body is too long (${body.length} characters, limit ${MAX_BODY_CHARS}).`,
        "Summarize the content and put long details in a task description or result.",
        "message_too_long",
      )
    }
    const subject = (input.subject ?? "").trim().slice(0, 120)
    const type = input.type ?? "message"
    const priority = input.priority ?? "normal"
    const now = this.clock.now()
    const fp = fingerprint([input.from.id, input.to.id, type, subject, body, input.replyTo ?? ""])
    let pausedPair: PausedPair | undefined
    const envelope = await this.store.transact(team.id, async (tx) => {
      const from = tx.member(input.from.id)
      const to = tx.member(input.to.id)
      if (!from) fail(`sender ${input.from.id} is not a member of this team.`, "Recreate the team or ask the lead.", "unknown_member")
      if (!to) fail(`recipient ${input.to.id} is not a member of this team.`, "Use team_status to pick a teammate.", "unknown_member")
      if (to.status === "stopped" || to.status === "failed") {
        fail(`recipient ${to.id} is ${to.status}.`, "Pick an active teammate with team_status.", "member_unavailable")
      }
      if (from.fingerprint === fp && from.fingerprintAt !== undefined && now - from.fingerprintAt < DUPLICATE_WINDOW_MS) {
        return undefined
      }
      const rateKey = `rate.${from.id}`
      const rate = checkRate(tx.aux(rateKey) as RateState | undefined, now, this.config.limits.maxMessagesPerMemberPerMinute)
      if (!rate.ok) {
        fail(
          `send rate limit reached for ${from.id} (${this.config.limits.maxMessagesPerMemberPerMinute}/minute).`,
          `Wait ${Math.ceil(rate.retryAfterMs / 1000)}s, then send fewer, larger messages.`,
          "rate_limited",
        )
      }
      let parent: Envelope | undefined
      if (input.replyTo) {
        parent = tx.findEnvelope(input.replyTo)
        if (!parent) {
          fail(`replyTo envelope ${input.replyTo} was not found.`, "Reply without replyTo, or read team_inbox first.", "unknown_envelope")
        }
      }
      const hops = parent ? parent.hops + 1 : 0
      if (hops > this.config.limits.maxHopsPerThread) {
        fail(
          `thread reached the hop limit (${this.config.limits.maxHopsPerThread}).`,
          "Summarize the thread and ask the lead to make a decision instead of replying again.",
          "hop_limit",
        )
      }
      const pair = pairKey(from.id, to.id)
      const exchange = exchangeUpdate(
        tx.aux(`pairs.${pair}`) as PairState | undefined,
        tx.team().boardVersion,
        now,
        this.config.limits.maxExchangesPerThread,
      )
      tx.putAux(`pairs.${pair}`, exchange.state)
      if (exchange.paused) {
        pausedPair = { a: from.id, b: to.id, reason: exchange.reason ?? "exchange limit" }
        return undefined
      }
      const envelope: Envelope = {
        id: this.ids.envelopeId(),
        teamID: team.id,
        from: from.id,
        to: to.id,
        type,
        subject,
        body,
        replyTo: input.replyTo,
        correlationID: input.correlationID ?? parent?.correlationID ?? parent?.id,
        priority,
        hops,
        ttlMs: this.config.limits.ttlMs,
        createdAt: now,
        expiresAt: now + this.config.limits.ttlMs,
        requiresReply: input.requiresReply,
      }
      tx.putEnvelope(to.id, envelope)
      to.unread = (to.unread ?? 0) + 1
      tx.putMember(to)
      from.fingerprint = fp
      from.fingerprintAt = now
      from.lastActiveAt = now
      tx.putMember(from)
      tx.putAux(rateKey, rate.state)
      tx.touch()
      return envelope
    })
    if (!envelope) {
      return { delivered: false, duplicate: pausedPair === undefined, ...(pausedPair ? { pausedPair } : {}) }
    }
    let delivered = false
    try {
      delivered = await this.deliver(team, input.to, envelope)
    } catch {
      delivered = false
    }

    // Deliver a copy to the sender so both sides of peer conversations are visible.
    // Without this, only the recipient sees the message and the lead never sees
    // what teammates say to each other.
    if (input.from.id !== input.to.id && input.from.sessionID) {
      try {
        const toMember = input.to
        if (toMember.sessionID) {
          const subject = envelope.subject ? ` · ${envelope.subject}` : ""
          const bodyPreview = truncateChars(envelope.body, 120)
          const senderCopy =
            `[team] you → ${toMember.id}${subject}\n${bodyPreview}`
          await this.port.synthesize(input.from, senderCopy, "queue", `team ${team.id} sent message ${envelope.id}`)
        }
      } catch {
        // sender copy is best-effort; never block a send because of it
      }
    }

    return { envelope, delivered, duplicate: false }
  }

  async system(team: Team, to: Member, subject: string, body: string, priority: Priority = "normal"): Promise<boolean> {
    const now = this.clock.now()
    const envelope: Envelope = {
      id: this.ids.envelopeId(),
      teamID: team.id,
      from: "system",
      to: to.id,
      type: "system",
      subject: subject.slice(0, 120),
      body: body.slice(0, MAX_BODY_CHARS),
      priority,
      hops: 0,
      ttlMs: this.config.limits.ttlMs,
      createdAt: now,
      expiresAt: now + this.config.limits.ttlMs,
    }
    try {
      await this.store.transact(team.id, async (tx) => {
        const recipient = tx.member(to.id)
        if (!recipient) return
        tx.putEnvelope(recipient.id, envelope)
        recipient.unread = (recipient.unread ?? 0) + 1
        tx.putMember(recipient)
        tx.touch()
      })
      return await this.deliver(team, to, envelope)
    } catch {
      return false
    }
  }

  async receive(team: Team, member: Member, options: InboxOptions = {}): Promise<Envelope[]> {
    const unreadOnly = options.unreadOnly ?? true
    const limit = Math.max(1, Math.min(20, options.limit ?? 10))
    const markRead = options.markRead ?? true
    if (!markRead) {
      const inbox = await this.store.inbox(team.id, member.id)
      return inbox
        .filter((envelope) => !unreadOnly || !envelope.readAt)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .slice(0, limit)
    }
    const now = this.clock.now()
    return this.store.transact(team.id, async (tx) => {
      const current = tx.member(member.id)
      if (!current) return []
      const inbox = tx.envelopes(member.id).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      const selected = inbox.filter((envelope) => !unreadOnly || !envelope.readAt).slice(0, limit)
      for (const envelope of selected) {
        envelope.readAt = envelope.readAt ?? now
        tx.putEnvelope(member.id, envelope)
      }
      current.unread = inbox.filter((envelope) => !envelope.readAt).length
      tx.putMember(current)
      return selected
    })
  }

  async countUnread(team: Team, member: Member): Promise<number> {
    const inbox = await this.store.inbox(team.id, member.id)
    const count = inbox.filter((envelope) => !envelope.readAt).length
    if ((member.unread ?? 0) !== count) {
      await this.store.transact(team.id, async (tx) => {
        const current = tx.member(member.id)
        if (!current) return
        current.unread = count
        tx.putMember(current)
      })
    }
    return count
  }

  async syncUnread(team: Team, member: Member): Promise<number> {
    return this.countUnread(team, member)
  }

  async deliver(team: Team, member: Member, envelope: Envelope): Promise<boolean> {
    return this.deliveryMutex.run(`${team.id}:${member.id}`, async () => {
      const current = await this.store.getEnvelope(team.id, member.id, envelope.id)
      if (!current || current.deliveredAt !== undefined) return false
      if (isExpired(current, this.clock.now())) return false
      const fresh = await this.store.getMember(team.id, member.id)
      if (!fresh || !fresh.sessionID) return false
      if (fresh.status === "stopped" || fresh.status === "failed" || fresh.status === "done") return false
      const busy = await this.port.isBusy(fresh)
      if (busy && current.priority !== "urgent") return false
      const delivery: Delivery = busy ? "steer" : "queue"
      await this.port.synthesize(fresh, renderDelivery(current, current.from), delivery, `team ${team.id} message ${current.id}`)
      await this.store.transact(team.id, async (tx) => {
        const stored = tx.envelope(member.id, current.id)
        if (!stored) return
        stored.deliveredAt = this.clock.now()
        tx.putEnvelope(member.id, stored)
      })
      return true
    })
  }

  async deliverPending(team: Team, member: Member, options: { urgentOnly?: boolean } = {}): Promise<number> {
    if (!member.sessionID) return 0
    const inbox = await this.store.inbox(team.id, member.id)
    const candidates = inbox
      .filter((envelope) => !envelope.deliveredAt && !isExpired(envelope, this.clock.now()))
      .filter((envelope) => !options.urgentOnly || envelope.priority === "urgent")
      .slice(0, 10)
    let delivered = 0
    for (const envelope of candidates) {
      try {
        if (await this.deliver(team, member, envelope)) delivered += 1
      } catch {
        break
      }
    }
    return delivered
  }
}

export function isMissingTeam(error: unknown): error is StoreError {
  return error instanceof Error && error.message.startsWith("team ") && error.message.endsWith(" not found")
}
