import type { KVEntry, StorageLike } from "../src/core/store.ts"
import { TeamError } from "../src/errors.ts"
import type {
  CommandDefinition,
  Host,
  HostContextEvent,
  HostEvent,
  HostToolDefinition,
  ToolAfterEvent,
  ToolBeforeEvent,
} from "../src/host.ts"
import type { ModelRef, SessionRef } from "../src/types.ts"

export interface FakeSessionData extends SessionRef {
  instructions: Map<string, unknown>
  permissions?: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>
}

export interface SyntheticCall {
  sessionID: string
  input: { text: string; description?: string; delivery?: "steer" | "queue" }
}

export class FakeHost implements Host {
  readonly version = "2.2.5"
  readonly directory = "/test/workspace"
  readonly projectID = "proj_test_123"

  private storageData = new Map<string, unknown>()
  readonly sessionsMap = new Map<string, FakeSessionData>()
  readonly syntheticCalls: SyntheticCall[] = []
  readonly interruptedSessions: string[] = []
  private sessionCounter = 0

  private eventHandlers: Array<(event: HostEvent) => void | Promise<void>> = []
  private contextHandlers: Array<(event: HostContextEvent) => Promise<void> | void> = []
  private toolBeforeHandlers: Array<(event: ToolBeforeEvent) => Promise<void>> = []
  private toolAfterHandlers: Array<(event: ToolAfterEvent) => Promise<void>> = []
  private idleHandlers: Array<(sessionID: string) => Promise<void>> = []

  readonly registeredTools = new Map<string, HostToolDefinition>()
  registeredCommand?: CommandDefinition

  constructor() {
    this.sessionsMap.set("ses_lead", {
      id: "ses_lead",
      title: "Lead Session",
      agent: "build",
      exists: true,
      busy: false,
      costUSD: 0,
      tokens: 0,
      instructions: new Map(),
    })
  }

  readonly storage: StorageLike = {
    get: async <T>(key: string): Promise<T | undefined> => {
      const val = this.storageData.get(key)
      if (val === undefined) return undefined
      return JSON.parse(JSON.stringify(val)) as T
    },
    set: async (key: string, value: unknown): Promise<void> => {
      this.storageData.set(key, JSON.parse(JSON.stringify(value)))
    },
    remove: async (key: string): Promise<void> => {
      this.storageData.delete(key)
    },
    scan: async (prefix: string): Promise<KVEntry[]> => {
      const results: KVEntry[] = []
      for (const [key, value] of this.storageData.entries()) {
        if (key.startsWith(prefix)) {
          results.push({ key, value: JSON.parse(JSON.stringify(value)) })
        }
      }
      return results.sort((a, b) => a.key.localeCompare(b.key))
    },
  }

  readonly sessions: Host["sessions"] = {
    create: async (input) => {
      this.sessionCounter++
      const id = `ses_fake_${this.sessionCounter}`
      const session: FakeSessionData = {
        id,
        parentID: input.parentID,
        title: input.title,
        agent: input.agent,
        model: input.model,
        busy: false,
        costUSD: 0,
        tokens: 0,
        exists: true,
        instructions: new Map(),
        permissions: input.permissions,
      }
      this.sessionsMap.set(id, session)
      return { ...session }
    },

    get: async (sessionID: string) => {
      const s = this.sessionsMap.get(sessionID)
      if (!s) return undefined
      return { ...s }
    },

    remove: async (sessionID: string) => {
      this.sessionsMap.delete(sessionID)
    },

    synthesize: async (sessionID, input) => {
      this.syntheticCalls.push({ sessionID, input })
    },

    prompt: async (sessionID, text, delivery) => {
      this.syntheticCalls.push({ sessionID, input: { text, delivery } })
    },

    interrupt: async (sessionID) => {
      this.interruptedSessions.push(sessionID)
      const s = this.sessionsMap.get(sessionID)
      if (s) s.busy = false
    },

    switchAgent: async (sessionID, agent) => {
      const s = this.sessionsMap.get(sessionID)
      if (s) s.agent = agent
    },

    switchModel: async (sessionID, model) => {
      const s = this.sessionsMap.get(sessionID)
      if (s) s.model = model
    },

    update: async (sessionID, input) => {
      const s = this.sessionsMap.get(sessionID)
      if (s) {
        if (input.title) s.title = input.title
        if (input.permissions) s.permissions = input.permissions
      }
    },

    putInstruction: async (sessionID, key, value) => {
      const s = this.sessionsMap.get(sessionID)
      if (s) s.instructions.set(key, value)
    },

    removeInstruction: async (sessionID, key) => {
      const s = this.sessionsMap.get(sessionID)
      if (s) s.instructions.delete(key)
    },

    isBusy: async (sessionID) => {
      return this.sessionsMap.get(sessionID)?.busy ?? false
    },
  }

  async listAgents(): Promise<string[]> {
    return ["build", "plan", "general", "explore"]
  }

  async assertPermission(_input: {
    sessionID: string
    action: string
    resources: string[]
  }): Promise<void> {
    // Allows permission assertion in test environment
  }

  async onEvent(handler: (event: HostEvent) => void | Promise<void>): Promise<() => Promise<void>> {
    this.eventHandlers.push(handler)
    return async () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler)
    }
  }

  async onContext(handler: (event: HostContextEvent) => Promise<void> | void): Promise<() => Promise<void>> {
    this.contextHandlers.push(handler)
    return async () => {
      this.contextHandlers = this.contextHandlers.filter((h) => h !== handler)
    }
  }

  async onToolBefore(handler: (event: ToolBeforeEvent) => Promise<void>): Promise<() => Promise<void>> {
    this.toolBeforeHandlers.push(handler)
    return async () => {
      this.toolBeforeHandlers = this.toolBeforeHandlers.filter((h) => h !== handler)
    }
  }

  async onToolAfter(handler: (event: ToolAfterEvent) => Promise<void>): Promise<() => Promise<void>> {
    this.toolAfterHandlers.push(handler)
    return async () => {
      this.toolAfterHandlers = this.toolAfterHandlers.filter((h) => h !== handler)
    }
  }

  async onSessionIdle(handler: (sessionID: string) => Promise<void>): Promise<() => Promise<void>> {
    this.idleHandlers.push(handler)
    return async () => {
      this.idleHandlers = this.idleHandlers.filter((h) => h !== handler)
    }
  }

  async registerTools(tools: HostToolDefinition[]): Promise<() => Promise<void>> {
    for (const tool of tools) {
      this.registeredTools.set(tool.name, tool)
    }
    return async () => {
      for (const tool of tools) {
        this.registeredTools.delete(tool.name)
      }
    }
  }

  async registerCommand(command: CommandDefinition): Promise<() => Promise<void>> {
    this.registeredCommand = command
    return async () => {
      if (this.registeredCommand === command) this.registeredCommand = undefined
    }
  }

  // --- Test Simulation Helpers ---

  async emitEvent(event: HostEvent): Promise<void> {
    for (const h of this.eventHandlers) await h(event)
  }

  async emitIdle(sessionID: string): Promise<void> {
    for (const h of this.idleHandlers) await h(sessionID)
  }

  async emitContext(event: HostContextEvent): Promise<void> {
    for (const h of this.contextHandlers) await h(event)
  }

  async emitToolBefore(event: ToolBeforeEvent): Promise<void> {
    for (const h of this.toolBeforeHandlers) await h(event)
  }

  setSessionBusy(sessionID: string, busy: boolean): void {
    const s = this.sessionsMap.get(sessionID)
    if (s) s.busy = busy
  }

  setSessionCost(sessionID: string, costUSD: number): void {
    const s = this.sessionsMap.get(sessionID)
    if (s) s.costUSD = costUSD
  }

  async executeTool(name: string, input: unknown, sessionID: string): Promise<{ content: string }> {
    const tool = this.registeredTools.get(name)
    if (!tool) throw new Error(`Tool ${name} not found`)

    // Simulate execute.before hooks
    const beforeEvent: ToolBeforeEvent = {
      tool: name,
      sessionID,
      agent: "build",
      messageID: "msg_fake",
      id: "call_fake",
      input,
    }
    for (const h of this.toolBeforeHandlers) {
      await h(beforeEvent)
    }

    try {
      const result = await tool.execute(input, {
        sessionID,
        agent: "build",
        messageID: "msg_fake",
        id: "call_fake",
        signal: new AbortController().signal,
        progress: async () => {},
      })
      return result
    } catch (error) {
      if (error instanceof TeamError) {
        throw new Error(`${error.message}\n${error.guidance}`)
      }
      throw error
    }
  }
}
