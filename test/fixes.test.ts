import test from "node:test"
import assert from "node:assert/strict"
import { validateConfig } from "../src/core/config.ts"
import { makeIds } from "../src/core/ids.ts"
import { TeamStore } from "../src/core/store.ts"
import { TeamService } from "../src/core/team-service.ts"
import { registerHooks } from "../src/hooks.ts"
import { estimateTokens, safeTruncate } from "../src/core/config.ts"
import { pathsOverlap } from "../src/core/limits.ts"
import { FakeHost } from "./fake-host.ts"

function setupTestEnvironment(overrides: Record<string, unknown> = {}) {
  let currentTime = 100_000
  const clock = {
    now: () => currentTime,
    advance: (ms: number) => {
      currentTime += ms
    },
    set: (t: number) => {
      currentTime = t
    },
  }

  const host = new FakeHost()
  const ids = makeIds(clock)
  const config = validateConfig({
    logLevel: "none",
    ...overrides,
  })
  const store = new TeamStore(host.storage, clock, ids)
  const service = new TeamService(host, store, clock, ids, config)

  return { host, store, service, clock, ids, config }
}

test("Fix SEC-01: path traversal escapes are rejected by the lease hook", async () => {
  const { host, service } = setupTestEnvironment()
  const hooks = await registerHooks(service, host)
  const leadSession = "ses_lead"

  await service.createTeam(leadSession, { goal: "Traversal test" })
  const impl = await service.spawn(leadSession, { role: "implementer" })

  const task = await service.addTask(leadSession, { title: "Lease test", paths: ["test"] })
  await service.claimTask(impl.sessionID, task.id, ["test"])

  // A parent-directory escape no longer rides the leased prefix: the path is
  // canonically resolved first, so `test/../src/host.ts` becomes
  // `src/host.ts` and fails the lease as an undeclared path.
  const pathRegex = process.platform === "win32" ? /path src\\host\.ts is not declared/ : /path src\/host\.ts is not declared/
  await assert.rejects(
    async () => {
      await host.emitToolBefore({
        tool: "write",
        sessionID: impl.sessionID,
        agent: "build",
        messageID: "msg_1",
        id: "call_1",
        input: { path: "test/../src/host.ts", content: "evil" },
      })
    },
    pathRegex,
  )

  // A path that escapes the workspace root entirely is rejected outright.
  await assert.rejects(
    async () => {
      await host.emitToolBefore({
        tool: "write",
        sessionID: impl.sessionID,
        agent: "build",
        messageID: "msg_1b",
        id: "call_1b",
        input: { path: "../outside-secret.env", content: "evil" },
      })
    },
    /escapes the workspace/,
  )

  // Declared paths still pass.
  await host.emitToolBefore({
    tool: "write",
    sessionID: impl.sessionID,
    agent: "build",
    messageID: "msg_2",
    id: "call_2",
    input: { path: "test/nested/file.ts", content: "ok" },
  })

  await hooks.dispose()
})

test("Fix SEC-02: task path additions respect other members' active leases", async () => {
  const { service } = setupTestEnvironment()
  const leadSession = "ses_lead"

  await service.createTeam(leadSession, { goal: "Update lease conflict test" })
  const impl1 = await service.spawn(leadSession, { role: "implementer" })
  const impl2 = await service.spawn(leadSession, { role: "implementer" })

  const t1 = await service.addTask(leadSession, { title: "First", paths: ["src/shared"] })
  const t2 = await service.addTask(leadSession, { title: "Second" })
  await service.claimTask(impl1.sessionID, t1.id, ["src/shared"])
  await service.claimTask(impl2.sessionID, t2.id)

  // Implementer-2 cannot extend their task into a path leased by implementer-1.
  await assert.rejects(
    async () => {
      await service.updateTask(impl2.sessionID, t2.id, { paths: ["src/shared/board.ts"] })
    },
    /already leased by implementer-1/,
  )

  // Non-conflicting additions still work.
  const updated = await service.updateTask(impl2.sessionID, t2.id, { paths: ["src/other.ts"] })
  const expectedPath = process.platform === "win32" ? "src\\other.ts" : "src/other.ts"
  assert.ok(updated.paths.includes(expectedPath))
})

test("Fix SEC-03: mesh spawn privilege escalation and depth limit enforced", async () => {
  // maxDepth 2 so the depth gate does not mask the privilege gate for a
  // depth-1 researcher spawning at depth 2.
  const { service } = setupTestEnvironment({
    limits: { maxDepth: 2 },
  })
  const leadSession = "ses_lead"

  await service.createTeam(leadSession, { goal: "Mesh spawn test", topology: "mesh" })
  const researcher = await service.spawn(leadSession, { role: "researcher" })

  // A sandboxed researcher (edit/shell denied) must not spawn an unrestricted
  // implementer to act through.
  await assert.rejects(
    async () => {
      await service.spawn(researcher.sessionID, { role: "implementer" })
    },
    /less restricted than your role/,
  )
})

test("Fix SEC-03b: nesting beyond maxDepth is rejected", async () => {
  const { service } = setupTestEnvironment()
  const leadSession = "ses_lead"

  await service.createTeam(leadSession, { goal: "Depth limit test", topology: "mesh" })
  const implementer = await service.spawn(leadSession, { role: "implementer" })

  await assert.rejects(
    async () => {
      await service.spawn(implementer.sessionID, { role: "researcher" })
    },
    /depth limit/,
  )
})

test("Fix LOGIC-05: board update releases a paused message pair immediately", async () => {
  const { service } = setupTestEnvironment({
    limits: { maxExchangesPerThread: 2 },
  })
  const leadSession = "ses_lead"

  await service.createTeam(leadSession, { goal: "Pause release test", topology: "mesh" })
  const a = await service.spawn(leadSession, { role: "implementer" })
  const b = await service.spawn(leadSession, { role: "implementer" })

  await service.send(a.sessionID, { to: b.id, body: "ping 1" })
  await service.send(b.sessionID, { to: a.id, body: "pong 1" })
  await assert.rejects(
    async () => {
      await service.send(a.sessionID, { to: b.id, body: "ping 2" })
    },
    /is paused/,
  )

  // Updating the board is the escape hatch: the pair unblocks immediately
  // instead of waiting out the full cooldown.
  await service.addTask(leadSession, { title: "Progress on the board" })
  const outcome = await service.send(a.sessionID, { to: b.id, body: "ping 2 after board update" })
  assert.equal(outcome.duplicate, false)
  assert.ok(outcome.envelope)
})

test("Fix LOGIC-03: recovery clears ghost wait edges and unblocks members", async () => {
  const { service } = setupTestEnvironment()
  const leadSession = "ses_lead"

  const { team } = await service.createTeam(leadSession, { goal: "Ghost wait test" })
  const a = await service.spawn(leadSession, { role: "implementer" })
  const b = await service.spawn(leadSession, { role: "implementer" })

  // Simulate a crash mid-wait: orphaned edge and a member frozen in blocked.
  await service.store.writeAux(team.id, `wait.${a.id}`, {
    memberID: a.id,
    targetID: b.id,
    at: Date.now(),
  })
  await service.store.transact(team.id, async (tx) => {
    const m = tx.member(a.id)
    if (m) {
      m.status = "blocked"
      m.waitingOn = [b.id]
      tx.putMember(m)
    }
  })

  await service.recover()

  const edges = await service.store.auxEntries(team.id)
  assert.equal(edges.find((entry) => entry.name.startsWith("wait.")), undefined)

  const memberA = await service.store.getMember(team.id, a.id)
  assert.equal(memberA?.status, "idle")
  assert.deepEqual(memberA?.waitingOn, [])
})

test("Fix LOGIC-11: waiting on an idle member completes immediately", async () => {
  const { service } = setupTestEnvironment()
  const leadSession = "ses_lead"

  await service.createTeam(leadSession, { goal: "Idle wait test" })
  const impl = await service.spawn(leadSession, { role: "implementer" })

  const started = Date.now()
  const result = await service.wait(leadSession, { forMember: impl.id, timeoutMs: 5_000 })
  const elapsed = Date.now() - started

  assert.equal(result.completed, true)
  assert.match(result.reason, /idle/)
  assert.ok(elapsed < 3_000, `wait should return immediately, took ${elapsed}ms`)
})

test("Fix PERF-02: truncation never splits UTF-16 surrogate pairs", () => {
  const text = `${"x".repeat(19)}😀${"y".repeat(50)}`
  const truncated = safeTruncate(text, 10 * 4)

  // No lone high surrogate may remain in the output.
  for (let i = 0; i < truncated.length; i++) {
    const code = truncated.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = truncated.charCodeAt(i + 1)
      assert.ok(next >= 0xdc00 && next <= 0xdfff, `lone high surrogate at index ${i}`)
    }
  }
  assert.ok(truncated.includes("[truncated]"))
})

test("Fix PERF: CJK text is not underestimated by the token estimator", () => {
  const cjk = "这是一个关于团队协作的多智能体测试用例，包含复杂的业务逻辑和状态机。"
  const estimate = estimateTokens(cjk)
  assert.ok(estimate > cjk.length, `expected CJK weighting, got ${estimate} for ${cjk.length} chars`)

  const latin = "a".repeat(40)
  assert.equal(estimateTokens(latin), 10)
})

test("Fix SEC-07: path overlap matching is case-insensitive on Windows", () => {
  if (process.platform !== "win32") return
  assert.equal(pathsOverlap("SRC/Auth.ts", "src/auth.ts"), true)
  assert.equal(pathsOverlap("Src/Components", "src/components/Button.tsx"), true)
})
