import type { Context } from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import type { KVEntry, StorageLike } from "./core/store.ts"
import { TeamError } from "./errors.ts"
import type { ModelRef, SessionRef, ToolCallContext } from "./types.ts"

export { ToolError }

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

const LEVELS: Record<"debug" | "info" | "warn" | "error" | "none", number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  none: 100,
}

/**
 * OpenCode V2 has no plugin logger (S9). Keep output plain and off stdout so
 * the CLI and GUI surfaces render the same text and no TUI escapes leak in.
 */
export function createLogger(level: "debug" | "info" | "warn" | "error" | "none"): Logger {
  const threshold = LEVELS[level]
  const write = (at: number, target: "log" | "error", message: string, data?: Record<string, unknown>) => {
    if (at < threshold) return
    const line = data ? `team-mode: ${message} ${JSON.stringify(data)}` : `team-mode: ${message}`
    if (target === "error") console.error(line)
    else console.log(line)
  }
  return {
    debug: (message, data) => write(LEVELS.debug, "log", message, data),
    info: (message, data) => write(LEVELS.info, "log", message, data),
    warn: (message, data) => write(LEVELS.warn, "error", message, data),
    error: (message, data) => write(LEVELS.error, "error", message, data),
  }
}

export interface HostLoggerSink {
  error(message: string, data?: Record<string, unknown>): void
}

export type HostEventType =
  | "execution.started"
  | "execution.succeeded"
  | "execution.failed"
  | "execution.interrupted"
  | "session.idle"
  | "session.deleted"

export interface HostEvent {
  type: HostEventType
  sessionID: string
  reason?: string
}

export interface HostContextEvent {
  sessionID: string
  system: Array<{ type: "text"; text: string; cache?: unknown; metadata?: Record<string, unknown> }>
}

export interface ToolBeforeEvent {
  tool: string
  sessionID: string
  agent: string
  messageID: string
  id: string
  input: unknown
}

export interface ToolAfterEvent extends ToolBeforeEvent {
  status: "completed" | "error"
  error?: string
}

export interface CommandInvocation {
  sessionID: string
  text: string
  delivery: "steer" | "queue"
}

export interface CommandDefinition {
  name: string
  description: string
  execute(invocation: CommandInvocation): Promise<void>
}

export interface HostToolDefinition {
  name: string
  description: string
  input: Record<string, unknown>
  execute(input: unknown, context: ToolCallContext & { progress: (update: Record<string, unknown>) => Promise<void> }): Promise<{ content: string }>
}

export interface Host {
  readonly version: string
  readonly directory: string
  readonly projectID: string
  readonly storage: StorageLike
  readonly sessions: {
    create(input: {
      parentID?: string
      title: string
      agent?: string
      model?: ModelRef
      permissions?: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>
    }): Promise<SessionRef>
    get(sessionID: string): Promise<SessionRef | undefined>
    remove(sessionID: string): Promise<void>
    synthesize(
      sessionID: string,
      input: { text: string; description?: string; delivery?: "steer" | "queue" },
    ): Promise<void>
    prompt(sessionID: string, text: string, delivery?: "steer" | "queue"): Promise<void>
    interrupt(sessionID: string, resume?: boolean): Promise<void>
    switchAgent(sessionID: string, agent: string): Promise<void>
    switchModel(sessionID: string, model: ModelRef): Promise<void>
    update(
      sessionID: string,
      input: { title?: string; permissions?: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }> },
    ): Promise<void>
    putInstruction(sessionID: string, key: string, value: unknown): Promise<void>
    removeInstruction(sessionID: string, key: string): Promise<void>
    isBusy(sessionID: string): Promise<boolean>
  }
  listAgents(): Promise<string[]>
  assertPermission(input: {
    sessionID: string
    action: string
    resources: string[]
    source?: { type: "tool"; messageID: string; id: string }
    metadata?: Record<string, unknown>
  }): Promise<void>
  onEvent(handler: (event: HostEvent) => void | Promise<void>): Promise<() => Promise<void>>
  onContext(handler: (event: HostContextEvent) => Promise<void> | void): Promise<() => Promise<void>>
  onToolBefore(handler: (event: ToolBeforeEvent) => Promise<void>): Promise<() => Promise<void>>
  onToolAfter(handler: (event: ToolAfterEvent) => Promise<void>): Promise<() => Promise<void>>
  onSessionIdle(handler: (sessionID: string) => Promise<void>): Promise<() => Promise<void>>
  registerTools(tools: HostToolDefinition[]): Promise<() => Promise<void>>
  registerCommand(command: CommandDefinition): Promise<() => Promise<void>>
}

function toModel(value: unknown): ModelRef | undefined {
  if (!value || typeof value !== "object") return undefined
  const model = value as { providerID?: unknown; id?: unknown; variant?: unknown }
  if (typeof model.providerID !== "string" || typeof model.id !== "string") return undefined
  return {
    providerID: model.providerID,
    id: model.id,
    ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
  }
}

function asSession(value: unknown): SessionRef | undefined {
  if (!value || typeof value !== "object") return undefined
  const session = value as {
    id?: unknown
    parentID?: unknown
    title?: unknown
    agent?: unknown
    model?: unknown
    cost?: unknown
    tokens?: unknown
    time?: { busy?: unknown; idle?: unknown }
  }
  if (typeof session.id !== "string") return undefined
  const busy = isBusySince(session.time?.busy, session.time?.idle)
  return {
    exists: true,
    id: session.id,
    parentID: typeof session.parentID === "string" ? session.parentID : undefined,
    title: typeof session.title === "string" ? session.title : undefined,
    agent: typeof session.agent === "string" ? session.agent : undefined,
    model: toModel(session.model),
    busy,
    costUSD: typeof session.cost === "number" ? session.cost : undefined,
    tokens:
      session.tokens && typeof session.tokens === "object"
        ? Number((session.tokens as { input?: number; output?: number }).input ?? 0) +
          Number((session.tokens as { output?: number }).output ?? 0)
        : undefined,
  }
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  if (value instanceof Date) return value.getTime()
  return undefined
}

function isBusySince(busy: unknown, idle: unknown): boolean {
  const started = timestamp(busy)
  if (started === undefined) return false
  const finished = timestamp(idle)
  return finished === undefined || started > finished
}

function mapEvent(type: string, data: unknown): HostEvent | undefined {
  const sessionID = (data as { sessionID?: unknown } | undefined)?.sessionID
  if (typeof sessionID !== "string") return undefined
  switch (type) {
    case "session.execution.started":
      return { type: "execution.started", sessionID }
    case "session.execution.succeeded":
      return { type: "execution.succeeded", sessionID }
    case "session.execution.failed":
      return { type: "execution.failed", sessionID, reason: "failed" }
    case "session.execution.interrupted":
      return {
        type: "execution.interrupted",
        sessionID,
        reason: (data as { reason?: unknown }).reason as string | undefined,
      }
    case "session.idle":
      return { type: "session.idle", sessionID }
    case "session.deleted":
      return { type: "session.deleted", sessionID }
    default:
      return undefined
  }
}

function instructionsKey(key: string): string {
  return key
}

export function createHost(ctx: Context, sink: HostLoggerSink): Host {
  const storage: StorageLike = {
    async get<T>(key: string): Promise<T | undefined> {
      return (await ctx.storage.get(key)) as T | undefined
    },
    async set(key: string, value: unknown): Promise<void> {
      await ctx.storage.set(key, value as never)
    },
    async remove(key: string): Promise<void> {
      await ctx.storage.remove(key)
    },
    async scan(prefix: string): Promise<KVEntry[]> {
      const out: KVEntry[] = []
      let after: string | undefined
      do {
        const page = await ctx.storage.scan({ prefix, ...(after ? { after } : {}), limit: 200 })
        for (const entry of page.entries) out.push({ key: entry.key, value: entry.value })
        after = page.next
      } while (after)
      return out
    },
  }

  const sessions: Host["sessions"] = {
    async create(input) {
      const created = await ctx.session.create({
        parentID: input.parentID,
        title: input.title,
        agent: input.agent,
        model: input.model,
        ...(input.permissions ? { permissions: input.permissions } : {}),
      })
      const session = asSession(created)
      if (!session) throw new Error("team-mode: session.create returned an unexpected payload")
      return session
    },
    async get(sessionID) {
      try {
        return asSession(await ctx.session.get({ sessionID }))
      } catch {
        return undefined
      }
    },
    async remove(sessionID) {
      await ctx.session.remove({ sessionID })
    },
    async synthesize(sessionID, input) {
      await ctx.session.synthetic({
        sessionID,
        text: input.text,
        ...(input.description ? { description: input.description } : {}),
        ...(input.delivery ? { delivery: input.delivery } : {}),
      })
    },
    async prompt(sessionID, text, delivery = "queue") {
      await ctx.session.prompt({ sessionID, text, delivery })
    },
    async interrupt(sessionID, resume = false) {
      await ctx.session.interrupt({ sessionID, resume })
    },
    async switchAgent(sessionID, agent) {
      await ctx.session.switchAgent({ sessionID, agent })
    },
    async switchModel(sessionID, model) {
      await ctx.session.switchModel({ sessionID, model })
    },
    async update(sessionID, input) {
      await ctx.session.update({ sessionID, ...input })
    },
    async putInstruction(sessionID, key, value) {
      await ctx.session.instructions.entry.put({ sessionID, key: instructionsKey(key), value: value as never })
    },
    async removeInstruction(sessionID, key) {
      await ctx.session.instructions.entry.remove({ sessionID, key: instructionsKey(key) })
    },
    async isBusy(sessionID) {
      const session = await this.get(sessionID)
      return session?.busy === true
    },
  }

  return {
    version: ctx.app.version,
    directory: ctx.location.directory,
    projectID: ctx.location.project.id,
    storage,
    sessions,
    async listAgents() {
      const output = (await ctx.agent.list()) as unknown as { data?: Array<{ id?: string }> }
      return (output.data ?? []).map((agent) => agent.id).filter((id): id is string => typeof id === "string")
    },
    async assertPermission(input) {
      await ctx.permission.assert({
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        ...(input.source ? { source: input.source } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
    },
    async onEvent(handler) {
      const controller = new AbortController()
      const consume = async () => {
        let delay = 1_000
        // A transient stream failure must not permanently detach the plugin
        // from lifecycle events; reconnect with capped exponential backoff.
        while (!controller.signal.aborted) {
          try {
            for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
              delay = 1_000
              const mapped = mapEvent(event.type, event.data)
              if (mapped) {
                try {
                  await handler(mapped)
                } catch (error) {
                  sink.error("team-mode event handler failed", {
                    error: error instanceof Error ? error.message : String(error),
                  })
                }
              }
            }
            if (controller.signal.aborted) break
            sink.error("team-mode event stream ended, reconnecting", {})
          } catch (error) {
            if (controller.signal.aborted) break
            sink.error("team-mode event stream failed, reconnecting", {
              error: error instanceof Error ? error.message : String(error),
            })
          }
          await new Promise((resolve) => setTimeout(resolve, delay))
          delay = Math.min(delay * 2, 30_000)
        }
      }
      void consume()
      return async () => controller.abort()
    },
    async onContext(handler) {
      const registration: Registration = await ctx.session.hook("context", async (event) => {
        await handler({
          sessionID: event.sessionID,
          system: event.system,
        })
      })
      return async () => registration.dispose()
    },
    async onToolBefore(handler) {
      const registration: Registration = await ctx.tool.hook("execute.before", async (event) => {
        await handler({
          tool: event.tool,
          sessionID: event.sessionID,
          agent: event.agent,
          messageID: event.messageID,
          id: event.id,
          input: event.input,
        })
      })
      return async () => registration.dispose()
    },
    async onToolAfter(handler) {
      const registration: Registration = await ctx.tool.hook("execute.after", async (event) => {
        await handler({
          tool: event.tool,
          sessionID: event.sessionID,
          agent: event.agent,
          messageID: event.messageID,
          id: event.id,
          input: event.input,
          status: event.status,
          ...(event.status === "error" ? { error: event.error.message } : {}),
        })
      })
      return async () => registration.dispose()
    },
    async onSessionIdle(handler) {
      const registration: Registration = await ctx.session.hook("experimental.idle", async (event) => {
        await handler(event.sessionID)
      })
      return async () => registration.dispose()
    },
    async registerTools(tools) {
      const registration = await ctx.tool.transform((editor) => {
        editor.namespace({ name: "team", description: "Team Mode: coordinate a team of agents on a shared board." })
        for (const tool of tools) {
          editor.add({
            name: tool.name,
            description: tool.description,
            input: tool.input as never,
            execute: async (input, context) => {
              try {
                return await tool.execute(input, {
                  sessionID: context.sessionID,
                  agent: context.agent,
                  messageID: context.messageID,
                  id: context.id,
                  signal: context.signal,
                  progress: async (update) => {
                    await context.progress(update)
                  },
                })
              } catch (error) {
                if (error instanceof TeamError) {
                  throw new ToolError({ message: `${error.message}\n${error.guidance}` })
                }
                if (error instanceof TeamToolError) {
                  throw new ToolError({ message: error.message })
                }
                if (error instanceof Error) throw new ToolError({ message: `team-mode: ${error.message}` })
                throw new ToolError({ message: "team-mode: unexpected tool failure" })
              }
            },
          })
        }
      })
      return async () => registration.dispose()
    },
    async registerCommand(command) {
      const registration = await ctx.command.transform((editor) => {
        editor.add({
          name: command.name,
          description: command.description,
          execute: async ({ sessionID, prompt, delivery }) => {
            await command.execute({ sessionID, text: prompt.text, delivery })
          },
        })
      })
      return async () => registration.dispose()
    },
  }
}

export class TeamToolError extends Error {
  readonly toolError = true

  constructor(message: string) {
    super(message)
    this.name = "TeamToolError"
  }
}
