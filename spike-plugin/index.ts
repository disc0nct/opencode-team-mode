import { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { writeFile } from "node:fs/promises"

const OUT = "C:/Users/disc0nect/AppData/Local/Temp/team-mode-spike/results.json"
const log: Record<string, unknown> = { started: new Date().toISOString() }

function safe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

function record(key: string, value: unknown) {
  log[key] = safe(value)
}

async function flush() {
  log.finished = new Date().toISOString()
  await writeFile(OUT, JSON.stringify(log, null, 2), "utf8")
}

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    record(`${name}.ok`, true)
  } catch (e) {
    record(`${name}.error`, e instanceof Error ? { message: e.message, stack: e.stack?.slice(0, 800) } : String(e))
  }
  await flush()
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | string> {
  return Promise.race([
    p,
    new Promise<string>((resolve) => setTimeout(() => resolve(`TIMEOUT(${label},${ms}ms)`), ms)),
  ])
}

function lastAssistantText(messages: readonly any[]): string {
  const assistants = messages.filter((m) => m.type === "assistant")
  const last = assistants.at(-1)
  if (!last) return ""
  const parts = Array.isArray(last.content) ? last.content : []
  return parts
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("\n")
    .slice(0, 500)
}

function messageSummary(messages: readonly any[]) {
  return messages.map((m) => ({
    type: m.type,
    id: m.id,
    text:
      typeof m.text === "string"
        ? m.text.slice(0, 100)
        : Array.isArray(m.content)
          ? m.content
              .filter((p: any) => p.type === "text")
              .map((p: any) => p.text)
              .join(" ")
              .slice(0, 100)
          : undefined,
  }))
}

async function captureEvents(ctx: any, run: () => Promise<void>): Promise<string[]> {
  const types: string[] = []
  const ac = new AbortController()
  const consumer = (async () => {
    for await (const e of ctx.event.subscribe({ signal: ac.signal })) types.push(e.type)
  })().catch(() => {})
  try {
    await run()
  } finally {
    await new Promise((r) => setTimeout(r, 500))
    ac.abort()
    await consumer
  }
  return [...new Set(types)]
}

export default Plugin.define({
  id: "spike",
  async setup(ctx) {
    record("app", { version: ctx.app.version })
    record("location", ctx.location)
    record("options", ctx.options)
    record("ctxKeys", Object.keys(ctx))
    record("hasLog", typeof (ctx as any).log)
    await flush()

    const registrations: any[] = []
    let idleReg: any
    try {
      idleReg = await ctx.session.hook("experimental.idle", (event: any) => {
        const arr = (log.idleHook as any[]) ?? []
        arr.push({ sessionID: event.sessionID, background: event.background?.length ?? 0 })
        log.idleHook = arr
      })
      record("idleHook.registered", true)
    } catch (e) {
      record("idleHook.error", String(e))
    }
    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.namespace({ name: "spike", description: "Host API probes" })
        editor.add({
          name: "probe",
          description: "Run host API probes.",
          input: {
            type: "object",
            properties: { case: { type: "string" } },
            required: [],
            additionalProperties: false,
          },
          options: { namespace: "spike" },
          execute: async (raw, context) => {
            const which = (raw as { case?: string })?.case ?? process.env.SPIKE_CASE ?? "quick"
            const lead = await ctx.session.get({ sessionID: context.sessionID })
            const childAgent = context.agent
            const model = lead.model

            if (which === "quick") {
              await step("S6", async () => {
                record("S6", {
                  contextKeys: Object.keys(context),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  messageID: context.messageID,
                  id: context.id,
                  signalIsAbortSignal: context.signal instanceof AbortSignal,
                  progressType: typeof context.progress,
                  leadAgentField: lead.agent,
                })
              })

              let childID = ""
              await step("S1", async () => {
                const child = await ctx.session.create({
                  parentID: context.sessionID,
                  title: "spike child",
                  agent: childAgent,
                  model,
                })
                childID = child.id
                const got = await ctx.session.get({ sessionID: child.id })
                record("S1.child", {
                  id: child.id,
                  parentID: got.parentID,
                  agent: got.agent,
                  model: got.model,
                  location: got.location,
                  title: got.title,
                })
                const orphan = await ctx.session.create({ title: "spike orphan" })
                record("S1.orphan", { parentID: (await ctx.session.get({ sessionID: orphan.id })).parentID })
                await ctx.session.remove({ sessionID: orphan.id })
              })

              await step("S2", async () => {
                const agentList = (await ctx.agent.list()) as any
                record("S2.agentsRaw", {
                  isArray: Array.isArray(agentList),
                  keys: Object.keys(agentList ?? {}),
                  json: JSON.stringify(agentList).slice(0, 800),
                })
                const shape: Record<string, unknown> = {}
                const reg = await ctx.agent.transform((agentEditor) => {
                  shape.keys = Object.keys(agentEditor)
                  shape.add = typeof (agentEditor as any).add
                  shape.update = typeof (agentEditor as any).update
                  shape.listLength = agentEditor.list().length
                  shape.ids = agentEditor.list().map((a: any) => a.id)
                })
                record("S2.editor", shape)
                await reg.dispose()
              })

              await step("S10", async () => {
                const N = 40
                await Promise.all(Array.from({ length: N }, (_, i) => ctx.storage.set(`spike/parallel/${i}`, { i })))
                const scanned = await ctx.storage.scan({ prefix: "spike/parallel/" })
                await ctx.storage.set("spike/counter", 0)
                await Promise.all(
                  Array.from({ length: 30 }, async () => {
                    const v = ((await ctx.storage.get("spike/counter")) as number) ?? 0
                    await new Promise((r) => setTimeout(r, 1))
                    await ctx.storage.set("spike/counter", v + 1)
                  }),
                )
                record("S10", {
                  scanned: scanned.entries.length,
                  expected: N,
                  counter: await ctx.storage.get("spike/counter"),
                  expectedCounter: 30,
                })
              })

              await step("S3.prompt", async () => {
                const child = await ctx.session.create({ parentID: context.sessionID, title: "spike prompt", agent: childAgent, model })
                const admitted = await ctx.session.prompt({ sessionID: child.id, text: "Reply with exactly: CHILD-OK", delivery: "queue" })
                record("S3.promptAdmitted", admitted)
                const waited = await withTimeout(ctx.session.wait({ sessionID: child.id }), 90_000, "child-wait")
                record("S3.waitResult", waited)
                const messages = await ctx.session.context({ sessionID: child.id })
                record("S3.promptMessages", messageSummary(messages))
                record("S3.promptLastAssistant", lastAssistantText(messages))
              })

              await step("S3.synthetic", async () => {
                const synth = await ctx.session.create({ parentID: context.sessionID, title: "spike synth", agent: childAgent, model })
                const t0 = Date.now()
                const admitted = await ctx.session.synthetic({
                  sessionID: synth.id,
                  text: "SPIKE_SYNTHETIC: reply with exactly SYNTH-OK and nothing else.",
                  description: "spike synthetic wake",
                })
                const wake = await withTimeout(ctx.session.wait({ sessionID: synth.id }), 45_000, "synth-wait")
                const messages = await ctx.session.context({ sessionID: synth.id })
                record("S3.synthetic", {
                  admitted,
                  wait: wake,
                  elapsedMs: Date.now() - t0,
                  messages: messageSummary(messages),
                  lastAssistant: lastAssistantText(messages),
                })
              })

              await step("S3.syntheticResume", async () => {
                const synth = await ctx.session.create({ parentID: context.sessionID, title: "spike synth resume", agent: childAgent, model })
                const t0 = Date.now()
                const admitted = await ctx.session.synthetic({
                  sessionID: synth.id,
                  text: "SPIKE_SYNTHETIC_RESUME: reply with exactly SYNTH2-OK and nothing else.",
                  description: "spike synthetic resume wake",
                  resume: true,
                })
                const wake = await withTimeout(ctx.session.wait({ sessionID: synth.id }), 45_000, "synth2-wait")
                const messages = await ctx.session.context({ sessionID: synth.id })
                record("S3.syntheticResume", {
                  admitted,
                  wait: wake,
                  elapsedMs: Date.now() - t0,
                  messages: messageSummary(messages),
                  lastAssistant: lastAssistantText(messages),
                })
              })

              await step("S5.events", async () => {
                const child = await ctx.session.create({ parentID: context.sessionID, title: "spike events", agent: childAgent, model })
                let types: string[] = []
                await captureEvents(ctx, async () => {
                  await ctx.session.prompt({ sessionID: child.id, text: "Reply with exactly: EV-OK" })
                  await withTimeout(ctx.session.wait({ sessionID: child.id }), 60_000, "ev-wait")
                }).then((t) => (types = t))
                record("S5.events", {
                  types,
                  execution: types.filter((t) => t.includes("execution") || t.includes("idle") || t.includes("inbox")),
                })
              })

              await step("S7", async () => {
                if (!childID) throw new Error("no child")
                await ctx.session.instructions.entry.put({
                  sessionID: childID,
                  key: "team.charter",
                  value: { text: "SPIKE_CHARTER_ALPHA", n: 1 },
                })
                record("S7.afterPut", await ctx.session.instructions.entry.list({ sessionID: childID }))
                let ctxHookSaw = ""
                const reg = await ctx.session.hook("context", (event) => {
                  const s = JSON.stringify(event.system)
                  if (s.includes("SPIKE_CHARTER_ALPHA")) ctxHookSaw = "SPIKE_CHARTER_ALPHA"
                })
                await ctx.session.prompt({ sessionID: childID, text: "Reply with exactly: ENTRY-OK" })
                await withTimeout(ctx.session.wait({ sessionID: childID }), 60_000, "entry-wait")
                await reg.dispose()
                record("S7.afterPrompt", {
                  entries: await ctx.session.instructions.entry.list({ sessionID: childID }),
                  ctxHookSaw,
                })
              })

              await step("cleanup", async () => {
                const sessions = await ctx.session.list({ directory: ctx.location.directory, limit: 100 })
                const data = (sessions as any).data ?? (sessions as any)
                const arr = Array.isArray(data) ? data : []
                for (const s of arr) {
                  if (s.id !== context.sessionID && s.title?.startsWith("spike")) {
                    await ctx.session.remove({ sessionID: s.id }).catch(() => {})
                  }
                }
              })
            }

            if (which === "delivery") {
              await step("S4", async () => {
                const d = await ctx.session.create({ parentID: context.sessionID, title: "spike delivery", agent: childAgent, model })
                let types: string[] = []
                await captureEvents(ctx, async () => {
                  const first = await ctx.session.prompt({
                    sessionID: d.id,
                    text: "Write 8 short numbered lines (1. to 8.) about software testing. No tools.",
                    delivery: "queue",
                  })
                  await new Promise((r) => setTimeout(r, 800))
                  const steer = await ctx.session.prompt({
                    sessionID: d.id,
                    text: "SPIKE_STEER: add a line exactly STEER-MARK.",
                    delivery: "steer",
                  })
                  const queue = await ctx.session.prompt({
                    sessionID: d.id,
                    text: "SPIKE_QUEUE: after finishing, reply exactly QUEUE-MARK.",
                    delivery: "queue",
                  })
                  const waited = await withTimeout(ctx.session.wait({ sessionID: d.id }), 120_000, "delivery-wait")
                  record("S4.admissions", { first, steer, queue, waited })
                  await new Promise((r) => setTimeout(r, 500))
                }).then((t) => (types = t))
                const messages = await ctx.session.context({ sessionID: d.id })
                record("S4.messages", messageSummary(messages))
                record("S4.lastAssistant", lastAssistantText(messages))
                record("S4.events", types.filter((t) => t.includes("execution") || t.includes("inbox") || t.includes("idle")))
                await ctx.session.remove({ sessionID: d.id }).catch(() => {})
              })
            }

            if (which === "compact") {
              await step("S7.compact", async () => {
                const c = await ctx.session.create({ parentID: context.sessionID, title: "spike compact", agent: childAgent, model })
                await ctx.session.instructions.entry.put({ sessionID: c.id, key: "team.charter", value: { text: "SPIKE_CHARTER_BETA" } })
                await ctx.session.prompt({ sessionID: c.id, text: "Reply with exactly: ONE" })
                await withTimeout(ctx.session.wait({ sessionID: c.id }), 60_000, "compact-1")
                await ctx.session.prompt({ sessionID: c.id, text: "Reply with exactly: TWO" })
                await withTimeout(ctx.session.wait({ sessionID: c.id }), 60_000, "compact-2")
                const admitted = await ctx.session.compact({ sessionID: c.id })
                const waited = await withTimeout(ctx.session.wait({ sessionID: c.id }), 120_000, "compact-3")
                const entries = await ctx.session.instructions.entry.list({ sessionID: c.id })
                const messages = await ctx.session.context({ sessionID: c.id })
                record("S7.compact", {
                  admitted,
                  waited,
                  entries,
                  messageTypes: messages.map((m) => m.type),
                  hasCompaction: messages.some((m) => m.type === "compaction"),
                })
                await ctx.session.remove({ sessionID: c.id }).catch(() => {})
              })
            }

            return { content: `probe ${which} complete` }
          },
        })

        editor.add({
          name: "fail",
          description: "Throw a Tool.Error with actionable guidance.",
          input: { type: "object", properties: {}, additionalProperties: false },
          options: { namespace: "spike" },
          execute: async () => {
            record("S8.thrown", true)
            await flush()
            throw new ToolError({
              message: "SPIKE_ACTIONABLE: task t_42 is owned by reviewer. Message them with team_send or pick another task.",
            })
          },
        })
      }),
    )

    return async () => {
      for (const r of registrations) await r.dispose?.()
      await idleReg?.dispose?.()
      record("disposed", new Date().toISOString())
      await flush()
    }
  },
})
