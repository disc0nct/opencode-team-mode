import test from "node:test"
import assert from "node:assert/strict"
import { validateConfig } from "../src/core/config.ts"
import { makeIds } from "../src/core/ids.ts"
import {
  clampInt,
  normalizePath,
  normalizePaths,
  pathsOverlap,
  pathConflict,
  waitCyclePath,
  fingerprint,
} from "../src/core/limits.ts"
import {
  renderCharter,
  renderBoard,
  renderStatus,
  renderTask,
  truncateChars,
  timeAgo,
} from "../src/core/render.ts"
import { permissionRules, rolePreset } from "../src/core/roles.ts"
import type { Member, Task, Team } from "../src/types.ts"

test("config validation: valid and invalid inputs", () => {
  const valid = validateConfig({
    topology: "mesh",
    maxMembers: 10,
    defaultAgent: "custom-agent",
    limits: {
      maxMessagesPerMemberPerMinute: 50,
      maxTeamCostUSD: 15.5,
    },
    roles: {
      custom: {
        agent: "explore",
        charter: "Custom charter",
        deny: ["edit"],
      },
    },
  })

  assert.equal(valid.topology, "mesh")
  assert.equal(valid.maxMembers, 10)
  assert.equal(valid.defaultAgent, "custom-agent")
  assert.equal(valid.limits.maxMessagesPerMemberPerMinute, 50)
  assert.equal(valid.limits.maxTeamCostUSD, 15.5)
  assert.ok(valid.roles.custom)
  assert.deepEqual(valid.roles.custom.deny, ["edit"])

  // Invalid topology throws
  assert.throws(() => validateConfig({ topology: "invalid" }), /topology must be "hub" or "mesh"/)
  // Non-integer maxMembers throws
  assert.throws(() => validateConfig({ maxMembers: "five" }), /maxMembers must be an integer/)
  // Negative cost throws
  assert.throws(() => validateConfig({ limits: { maxTeamCostUSD: -5 } }), /maxTeamCostUSD must be a non-negative number/)
})

test("limits: path normalization and overlap detection", () => {
  assert.equal(normalizePath("./src\\foo\\bar/"), "src/foo/bar")
  assert.equal(normalizePath("src/lib/**"), "src/lib")

  const normalized = normalizePaths(["./src/a", "src/b/", "src/a"])
  assert.deepEqual(normalized, ["src/a", "src/b"])

  assert.equal(pathsOverlap("src/auth.ts", "src/auth.ts"), true)
  assert.equal(pathsOverlap("src/components", "src/components/Button.tsx"), true)
  assert.equal(pathsOverlap("src/components/Button.tsx", "src/components"), true)
  assert.equal(pathsOverlap("src/components", "src/utils"), false)

  const conflict = pathConflict(["src/foo.ts", "src/bar"], ["src/bar/sub.ts"])
  assert.equal(conflict, "src/bar")
})

test("limits: wait-for cycle path calculation", () => {
  const edges = [
    { memberID: "A", targetID: "B", at: 1 },
    { memberID: "B", targetID: "C", at: 2 },
  ]

  // C -> A would close the loop A -> B -> C -> A
  const cycle = waitCyclePath(edges, "C", "A")
  assert.deepEqual(cycle, ["C", "A", "B", "C"])

  // D -> A has no cycle
  assert.equal(waitCyclePath(edges, "D", "A"), undefined)
})

test("limits: deterministic fingerprinting", () => {
  const fp1 = fingerprint(["sender", "recip", "body", "subject"])
  const fp2 = fingerprint(["sender", "recip", "body", "subject"])
  const fp3 = fingerprint(["sender", "recip", "other_body", "subject"])

  assert.equal(fp1, fp2)
  assert.notEqual(fp1, fp3)
})

test("render: charter, board, task, and status formatters", () => {
  const team: Team = {
    id: "tm_123",
    name: "Alpha",
    goal: "Ship V2",
    leadSessionID: "ses_lead",
    projectID: "p1",
    topology: "hub",
    status: "active",
    createdAt: 1000,
    updatedAt: 1000,
    version: 1,
    nextTask: 1,
    boardVersion: 1,
    instanceID: "inst_1",
  }

  const member: Member = {
    id: "implementer-1",
    teamID: team.id,
    role: "implementer",
    depth: 1,
    sessionID: "ses_1",
    agent: "build",
    status: "working",
    brief: "Do work",
    createdAt: 1000,
    lastActiveAt: 1500,
    turns: 3,
    costUSD: 0.05,
    waitingOn: [],
  }

  const task: Task = {
    id: "t_1",
    teamID: team.id,
    title: "Implement core",
    description: "Do the core work",
    status: "in_progress",
    owner: member.id,
    createdBy: "lead",
    dependsOn: [],
    paths: ["src/core.ts"],
    version: 1,
    createdAt: 1000,
    updatedAt: 1200,
  }

  const charter = renderCharter(team, member, [member], "Implement tasks.", {
    maxMembers: 5,
    maxDepth: 1,
    maxHopsPerThread: 6,
    maxMessagesPerMemberPerMinute: 20,
    maxExchangesPerThread: 6,
    ttlMs: 3600000,
    maxMemberMinutes: 30,
    maxMemberTurns: 40,
    maxTeamCostUSD: 10,
    heartbeatMs: 15000,
    sweepMs: 30000,
    peerWait: false,
    waitTimeoutMs: 30000,
  })
  assert.match(charter, /\[team-mode\] team=tm_123 member=implementer-1/)
  assert.match(charter, /Your role: Implement tasks/)

  const board = renderBoard(team, [member], [task], member, 0)
  assert.match(board, /t_1 \[in_progress\] Implement core · implementer-1/)

  const status = renderStatus(team, [member], [task], 2000)
  assert.match(status, /Team Alpha \(tm_123\) · active/)
  assert.match(status, /in_progress:1/)

  const taskRendered = renderTask(task)
  assert.match(taskRendered, /t_1 \[in_progress\] Implement core/)
  assert.match(taskRendered, /owner: implementer-1/)
})

test("roles: deny rules generation", () => {
  const config = validateConfig({})
  const preset = rolePreset(config, "architect")
  const rules = permissionRules(preset)

  assert.ok(rules.length > 0)
  for (const rule of rules) {
    assert.equal(rule.effect, "deny")
    assert.equal(rule.resource, "*")
  }
})
