import test from "node:test"
import assert from "node:assert/strict"
import { validateConfig } from "../src/core/config.ts"
import { makeIds } from "../src/core/ids.ts"
import { TeamStore } from "../src/core/store.ts"
import { TeamService } from "../src/core/team-service.ts"
import { registerHooks } from "../src/hooks.ts"
import { createTools } from "../src/tools.ts"
import { createCommand } from "../src/commands.ts"
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

test("Scenario 1: Identity never model-supplied - spoofing impossible by construction", async () => {
  const { host, service } = setupTestEnvironment()
  const leadSession = "ses_lead"
  const impostorSession = "ses_impostor"

  await service.createTeam(leadSession, { goal: "Build feature X" })
  const member = await service.spawn(leadSession, { role: "implementer" })

  // An unrecognized session cannot send messages or manipulate the team
  await assert.rejects(
    async () => {
      await service.send(impostorSession, {
        to: member.id,
        body: "Malicious payload pretending to be lead",
      })
    },
    /does not belong to an active team/,
  )

  // Legitimate member sends message - sender ID is derived strictly from session
  const outcome = await service.send(leadSession, {
    to: member.id,
    body: "Legitimate lead instruction",
  })
  assert.equal(outcome.envelope?.from, "lead")
  assert.equal(outcome.delivered, true)
})

test("Scenario 2: Duplicate message deduplication within time window", async () => {
  const { service } = setupTestEnvironment()
  const leadSession = "ses_lead"

  await service.createTeam(leadSession, { goal: "Dedupe test" })
  const member = await service.spawn(leadSession, { role: "implementer" })

  const first = await service.send(leadSession, {
    to: member.id,
    body: "Repeatable notification",
  })
  assert.equal(first.duplicate, false)
  assert.ok(first.envelope)

  // Immediate identical send is suppressed as duplicate
  const second = await service.send(leadSession, {
    to: member.id,
    body: "Repeatable notification",
  })
  assert.equal(second.duplicate, true)
  assert.equal(second.envelope, undefined)
})

test("Scenario 3: Task claim race and exclusive file path leasing", async () => {
  const { service } = setupTestEnvironment()
  const leadSession = "ses_lead"

  await service.createTeam(leadSession, { goal: "Claim race test" })
  const impl1 = await service.spawn(leadSession, { role: "implementer" })
  const impl2 = await service.spawn(leadSession, { role: "implementer" })

  const task1 = await service.addTask(leadSession, {
    title: "Edit auth",
    paths: ["src/auth.ts"],
  })
  const task2 = await service.addTask(leadSession, {
    title: "Edit auth duplicate",
    paths: ["src/auth.ts"],
  })

  // First implementer claims task1 with path lease
  const claimed1 = await service.claimTask(impl1.sessionID, task1.id, ["src/auth.ts"])
  assert.equal(claimed1.owner, impl1.id)

  // Second implementer attempting to claim overlapping path is rejected
  await assert.rejects(
    async () => {
      await service.claimTask(impl2.sessionID, task2.id, ["src/auth.ts"])
    },
    /is already leased by implementer-1/,
  )
})

test("Scenario 4: Ping-pong / exchange loop limiter pauses runaway pair", async () => {
  const { service } = setupTestEnvironment({
    topology: "mesh",
    limits: { maxExchangesPerThread: 3 },
  })
  const leadSession = "ses_lead"

  await service.createTeam(leadSession, { goal: "Ping pong test", topology: "mesh" })
  const a = await service.spawn(leadSession, { role: "implementer" })
  const b = await service.spawn(leadSession, { role: "implementer" })

  // Send 3 exchanges back and forth without board change
  await service.send(a.sessionID, { to: b.id, body: "ping 1" })
  await service.send(b.sessionID, { to: a.id, body: "pong 1" })
  await service.send(a.sessionID, { to: b.id, body: "ping 2" })

  // 4th exchange exceeds maxExchangesPerThread without board update and gets paused
  await assert.rejects(
    async () => {
      await service.send(b.sessionID, { to: a.id, body: "pong 2" })
    },
    /message exchange between .* is paused/,
  )
})

test("Scenario 5: Wait-for graph circular deadlock detection", async () => {
  const { service } = setupTestEnvironment({
    limits: { peerWait: true },
  })
  const leadSession = "ses_lead"

  const { team } = await service.createTeam(leadSession, { goal: "Deadlock test" })
  const a = await service.spawn(leadSession, { role: "implementer" })
  const b = await service.spawn(leadSession, { role: "implementer" })

  // Write wait edge in the active team: a is waiting on b
  await service.store.writeAux(team.id, `wait.${a.id}`, {
    memberID: a.id,
    targetID: b.id,
    at: Date.now(),
  })

  // Now b attempts to wait on a -> creates cycle (b -> a -> b)
  await assert.rejects(
    async () => {
      await service.wait(b.sessionID, {
        forMember: a.id,
        timeoutMs: 1000,
      })
    },
    /would create a circular wait deadlock/,
  )
})

test("Scenario 6: File lease enforcement via execute.before hook", async () => {
  const { host, service } = setupTestEnvironment()
  const hooks = await registerHooks(service, host)
  const leadSession = "ses_lead"

  await service.createTeam(leadSession, { goal: "Lease hook test" })
  const impl = await service.spawn(leadSession, { role: "implementer" })

  // Implementer has not claimed any task, attempts to edit file
  await assert.rejects(
    async () => {
      await host.emitToolBefore({
        tool: "write",
        sessionID: impl.sessionID,
        agent: "build",
        messageID: "msg_1",
        id: "call_1",
        input: { path: "src/secret.ts", content: "data" },
      })
    },
    /File lease violation: you have no active task/,
  )

  // Now implementer claims task with path lease
  const task = await service.addTask(leadSession, { title: "Work on foo", paths: ["src/foo.ts"] })
  await service.claimTask(impl.sessionID, task.id, ["src/foo.ts"])

  // Modifying an undeclared file still fails
  await assert.rejects(
    async () => {
      await host.emitToolBefore({
        tool: "write",
        sessionID: impl.sessionID,
        agent: "build",
        messageID: "msg_2",
        id: "call_2",
        input: { path: "src/bar.ts", content: "data" },
      })
    },
    process.platform === "win32" ? /path src\\bar.ts is not declared/ : /path src\/bar.ts is not declared/,
  )

  // Modifying declared file succeeds without throwing
  await host.emitToolBefore({
    tool: "write",
    sessionID: impl.sessionID,
    agent: "build",
    messageID: "msg_3",
    id: "call_3",
    input: { path: "src/foo.ts", content: "clean" },
  })

  await hooks.dispose()
})

test("Scenario 7: Startup recovery redelivers undelivered inbox messages", async () => {
  const { host, service } = setupTestEnvironment()
  const leadSession = "ses_lead"

  await service.createTeam(leadSession, { goal: "Recovery test" })
  const impl = await service.spawn(leadSession, { role: "implementer" })

  // Set recipient as busy so normal messages remain queued undelivered for them
  host.setSessionBusy(impl.sessionID, true)

  const outcome = await service.send(leadSession, {
    to: impl.id,
    body: "Queued before restart",
    priority: "normal",
  })
  // Recipient is busy, so normal message stays queued undelivered for them.
  // (Sender gets an informational copy but that doesn't count as delivered.)
  assert.equal(outcome.delivered, false)

  // Recipient becomes idle after restart
  host.setSessionBusy(impl.sessionID, false)

  // Run recovery scan & application
  await service.recover()

  // Verify message has been delivered to the recipient's session
  const synth = host.syntheticCalls.find((c) => c.sessionID === impl.sessionID)
  assert.ok(synth, "Pending message should be delivered to recipient after recovery")
  assert.match(synth.input.text, /Queued before restart/)
})

test("Scenario 8: Team stop releases tasks and cleans up", async () => {
  const { host, service } = setupTestEnvironment()
  const leadSession = "ses_lead"

  await service.createTeam(leadSession, { goal: "Stop cleanup test" })
  const impl = await service.spawn(leadSession, { role: "implementer" })

  const task = await service.addTask(leadSession, { title: "Active task" })
  await service.claimTask(impl.sessionID, task.id)

  const stopResult = await service.stop(leadSession, { reason: "Work finished" })
  assert.equal(stopResult.reason, "Work finished")

  // Check that task was released back to pending
  const tasks = await service.listTasks(leadSession)
  const stoppedTask = tasks.find((t) => t.id === task.id)
  assert.equal(stoppedTask?.status, "pending")
  assert.equal(stoppedTask?.owner, undefined)

  // Check child session was interrupted
  assert.ok(host.interruptedSessions.includes(impl.sessionID))
})

test("Scenario 9: Over-limit spawn and send rate refusal", async () => {
  const { service, clock } = setupTestEnvironment({
    limits: {
      maxMembers: 3,
      maxMessagesPerMemberPerMinute: 2,
    },
  })
  const leadSession = "ses_lead"

  await service.createTeam(leadSession, { goal: "Limits test" })
  const m1 = await service.spawn(leadSession, { role: "implementer" })
  const m2 = await service.spawn(leadSession, { role: "reviewer" })

  // 3 members (lead, m1, m2) reached maxMembers (3)
  await assert.rejects(
    async () => {
      await service.spawn(leadSession, { role: "researcher" })
    },
    /team member limit reached \(3\)/,
  )

  // Rate limit: 2 messages per minute
  await service.send(leadSession, { to: m1.id, body: "msg 1" })
  await service.send(leadSession, { to: m1.id, body: "msg 2" })

  // 3rd message within same minute is rejected
  await assert.rejects(
    async () => {
      await service.send(leadSession, { to: m1.id, body: "msg 3" })
    },
    /send rate limit reached/,
  )

  // Advance clock beyond rate window (60s)
  clock.advance(65_000)

  // Should succeed again
  const afterWindow = await service.send(leadSession, { to: m1.id, body: "msg 3" })
  assert.equal(afterWindow.delivered, true)
})

test("Scenario 10: 3-Member End-to-End Workflow with Review Rejection & Done", async () => {
  const { host, service } = setupTestEnvironment()
  const tools = createTools(service)
  await host.registerTools(tools)
  const command = createCommand(service, host)
  await host.registerCommand(command)

  const leadSession = "ses_lead"

  // 1. Lead creates team via /team command
  await host.registeredCommand?.execute({
    sessionID: leadSession,
    text: 'start "Build authentication module"',
    delivery: "queue",
  })
  const startReply = host.syntheticCalls.find((c) => c.sessionID === leadSession)
  assert.ok(startReply)
  assert.match(startReply.input.text, /started with you as lead/)

  // 2. Lead spawns implementer and reviewer via team_spawn tool
  const spawnImplRes = await host.executeTool(
    "team_spawn",
    { role: "implementer", brief: "Write auth handler" },
    leadSession,
  )
  assert.match(spawnImplRes.content, /implementer-1/)

  const spawnReviewRes = await host.executeTool(
    "team_spawn",
    { role: "reviewer", brief: "Review auth correctness" },
    leadSession,
  )
  assert.match(spawnReviewRes.content, /reviewer-1/)

  const implSession = "ses_fake_1"
  const reviewerSession = "ses_fake_2"

  // 3. Lead adds task t_1
  const addTaskRes = await host.executeTool(
    "team_task_add",
    { title: "Implement JWT validation", paths: ["src/jwt.ts"] },
    leadSession,
  )
  assert.match(addTaskRes.content, /t_1/)

  // 4. Implementer claims t_1
  const claimRes = await host.executeTool(
    "team_task_claim",
    { taskID: "t_1", paths: ["src/jwt.ts"] },
    implSession,
  )
  assert.match(claimRes.content, /claimed/)

  // 5. Implementer updates status to review
  const updateReviewRes = await host.executeTool(
    "team_task_update",
    { taskID: "t_1", status: "review", result: "JWT logic completed with tests" },
    implSession,
  )
  assert.match(updateReviewRes.content, /review/)

  // 6. Reviewer inspects and rejects task back to in_progress with required fixes
  const rejectRes = await host.executeTool(
    "team_task_update",
    {
      taskID: "t_1",
      status: "in_progress",
      result: "src/jwt.ts:42 missing expiration check on token timestamp",
    },
    reviewerSession,
  )
  assert.match(rejectRes.content, /in_progress/)

  // Verify implementer received urgent system notification with reviewer findings
  const implNotification = host.syntheticCalls.find((c) =>
    c.sessionID === implSession && c.input.text.includes("missing expiration check"),
  )
  assert.ok(implNotification, "Implementer should be notified of rejection findings")

  // 7. Implementer addresses fix and hands off or sets back to review
  await host.executeTool(
    "team_task_update",
    {
      taskID: "t_1",
      status: "review",
      result: "Added expiration validation test to src/jwt.ts",
    },
    implSession,
  )

  // 8. Reviewer approves task to done
  const approveRes = await host.executeTool(
    "team_task_update",
    { taskID: "t_1", status: "done", result: "Approved - all checks passed" },
    reviewerSession,
  )
  assert.match(approveRes.content, /done/)

  // 9. Lead checks overall status
  const statusRes = await host.executeTool("team_status", {}, leadSession)
  assert.match(statusRes.content, /done:1/)
  assert.match(statusRes.content, /implementer-1/)
  assert.match(statusRes.content, /reviewer-1/)
})

test("Scenario 11: Host event lifecycle transitions member states and handles session deletion", async () => {
  const { host, service } = setupTestEnvironment()
  const hooks = await registerHooks(service, host)
  const leadSession = "ses_lead"

  await service.createTeam(leadSession, { goal: "Event lifecycle test" })
  const impl = await service.spawn(leadSession, { role: "implementer" })

  // Member starts idle
  let member = (await service.status(leadSession)).members.find((m) => m.id === impl.id)
  assert.equal(member?.status, "idle")

  // execution.started -> status working, turns incremented
  await host.emitEvent({ type: "execution.started", sessionID: impl.sessionID })
  member = (await service.status(leadSession)).members.find((m) => m.id === impl.id)
  assert.equal(member?.status, "working")
  assert.equal(member?.turns, 1)

  // execution.succeeded -> status idle
  await host.emitEvent({ type: "execution.succeeded", sessionID: impl.sessionID })
  member = (await service.status(leadSession)).members.find((m) => m.id === impl.id)
  assert.equal(member?.status, "idle")

  // execution.failed -> non-lead member status failed, releases tasks
  const task = await service.addTask(leadSession, { title: "Failing task" })
  await service.claimTask(impl.sessionID, task.id)
  await host.emitEvent({ type: "execution.failed", sessionID: impl.sessionID })
  member = (await service.status(leadSession)).members.find((m) => m.id === impl.id)
  assert.equal(member?.status, "failed")
  const taskAfterFail = (await service.listTasks(leadSession)).find((t) => t.id === task.id)
  assert.equal(taskAfterFail?.status, "pending")
  assert.equal(taskAfterFail?.owner, undefined)

  // session.deleted on lead -> stops team
  await host.emitEvent({ type: "session.deleted", sessionID: leadSession })
  const team = await service.store.getTeam(impl.teamID)
  assert.equal(team?.status, "stopped")
  assert.equal(team?.stopReason, "Lead session deleted")

  await hooks.dispose()
})

test("Scenario 12: Sweeper budget violation stops member and synchronizes session cost", async () => {
  const { host, service } = setupTestEnvironment({
    limits: {
      maxMemberTurns: 2,
      maxMemberMinutes: 10,
      maxTeamCostUSD: 5,
    },
  })
  const leadSession = "ses_lead"

  const { team } = await service.createTeam(leadSession, { goal: "Budget sweeper test" })
  const impl = await service.spawn(leadSession, { role: "implementer" })
  const task = await service.addTask(leadSession, { title: "Swept task" })
  await service.claimTask(impl.sessionID, task.id)

  // Set session cost in host
  host.setSessionCost(impl.sessionID, 1.25)

  // Run sweeper -> synchronizes cost to store
  await service.sweep()
  let member = await service.store.getMember(team.id, impl.id)
  assert.equal(member?.costUSD, 1.25)

  // Advance turns beyond maxMemberTurns (2)
  await service.store.transact(team.id, async (tx) => {
    const m = tx.member(impl.id)
    if (m) {
      m.turns = 3
      tx.putMember(m)
    }
  })

  // Sweep detects turn budget violation
  await service.sweep()
  member = await service.store.getMember(team.id, impl.id)
  assert.equal(member?.status, "stopped")

  // Task released
  const taskAfterSweep = await service.store.getTask(team.id, task.id)
  assert.equal(taskAfterSweep?.status, "pending")
  assert.equal(taskAfterSweep?.owner, undefined)
})

test("Scenario 13: Recovery stops team when lead session disappeared", async () => {
  const { host, service } = setupTestEnvironment()
  const leadSession = "ses_lead_temp"
  host.sessionsMap.set(leadSession, {
    id: leadSession,
    title: "Lead",
    exists: true,
    busy: false,
    costUSD: 0,
    tokens: 0,
    instructions: new Map(),
  })

  const { team } = await service.createTeam(leadSession, { goal: "Disappearing lead test" })
  const impl = await service.spawn(leadSession, { role: "implementer" })

  // Simulate lead session disappeared across restart
  host.sessionsMap.delete(leadSession)

  // Run recovery
  await service.recover()

  // Team should be stopped
  const teamAfter = await service.store.getTeam(team.id)
  assert.equal(teamAfter?.status, "stopped")
  assert.equal(teamAfter?.stopReason, "Lead session disappeared across restart")

  // Member should also be stopped
  const implAfter = await service.store.getMember(team.id, impl.id)
  assert.equal(implAfter?.status, "stopped")
})

test("Scenario 14: Task handoff workflow and validations", async () => {
  const { service } = setupTestEnvironment()
  const leadSession = "ses_lead"

  await service.createTeam(leadSession, { goal: "Handoff test" })
  const dev1 = await service.spawn(leadSession, { role: "implementer" })
  const dev2 = await service.spawn(leadSession, { role: "implementer" })

  const task = await service.addTask(leadSession, { title: "Feature work" })
  await service.claimTask(dev1.sessionID, task.id)

  // Cannot hand off to oneself
  await assert.rejects(
    async () => {
      await service.handoff(dev1.sessionID, task.id, dev1.id, "Self handoff")
    },
    /cannot hand a task to yourself/,
  )

  // Empty summary is rejected
  await assert.rejects(
    async () => {
      await service.handoff(dev1.sessionID, task.id, dev2.id, "   ")
    },
    /handoff summary is required/,
  )

  // Successful handoff
  const handed = await service.handoff(
    dev1.sessionID,
    task.id,
    dev2.id,
    "Initial scaffold done, please implement DB queries",
  )
  assert.equal(handed.owner, dev2.id)
  assert.equal(handed.handoffFrom, dev1.id)
  assert.match(handed.result ?? "", /Initial scaffold done/)

  // Recipient inbox received handoff message
  const inbox = await service.inbox(dev2.sessionID)
  assert.equal(inbox.envelopes.length, 1)
  assert.equal(inbox.envelopes[0]?.type, "handoff")
  assert.equal(inbox.envelopes[0]?.priority, "urgent")
})

test("Scenario 15: Command /team stop parsing with reason and member ID", async () => {
  const { host, service } = setupTestEnvironment()
  const command = createCommand(service, host)
  await host.registerCommand(command)

  const leadSession = "ses_lead"
  await host.registeredCommand?.execute({
    sessionID: leadSession,
    text: 'start "Stop command parsing test"',
    delivery: "queue",
  })
  const member = await service.spawn(leadSession, { role: "implementer" })

  // Stop single member with reason
  await host.registeredCommand?.execute({
    sessionID: leadSession,
    text: `stop ${member.id} Task completed early`,
    delivery: "queue",
  })
  let m = (await service.status(leadSession)).members.find((x) => x.id === member.id)
  assert.equal(m?.status, "stopped")

  // Stop entire team with reason in quotes
  await host.registeredCommand?.execute({
    sessionID: leadSession,
    text: 'stop "Sprint finished successfully"',
    delivery: "queue",
  })
  const st = await service.status(leadSession)
  assert.equal(st.team.status, "stopped")
  assert.equal(st.team.stopReason, "Sprint finished successfully")
})
