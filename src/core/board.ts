import { fail } from "../errors.ts"
import type { Member, Task, TaskStatus, Team } from "../types.ts"
import { MAX_TASKS, isActiveTask, normalizePaths, pathConflict, pathsOverlap } from "./limits.ts"
import type { TeamTx } from "./store.ts"

export interface AddTaskInput {
  title: string
  description?: string
  dependsOn?: string[]
  paths?: string[]
  owner?: string
}

export interface UpdateTaskInput {
  status?: TaskStatus
  result?: string
  paths?: string[]
}

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["claimed", "cancelled"],
  claimed: ["in_progress", "blocked", "review", "done", "cancelled"],
  in_progress: ["review", "blocked", "done", "cancelled"],
  blocked: ["in_progress", "claimed", "cancelled"],
  review: ["done", "in_progress", "blocked", "cancelled"],
  done: [],
  cancelled: [],
}

function cleanTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function assertTitle(title: string): string {
  const clean = cleanTitle(title)
  if (!clean) fail("task title is required.", "Pass a short, concrete title for the task.", "invalid_task")
  if (clean.length > 200) fail("task title is too long (max 200 characters).", "Shorten the title.", "invalid_task")
  return clean
}

export function addTask(
  tx: TeamTx,
  team: Team,
  actor: Member,
  input: AddTaskInput,
  now = Date.now(),
): Task {
  if (tx.tasks().length >= MAX_TASKS) {
    fail(
      `the board already has ${MAX_TASKS} tasks.`,
      "Close or cancel old tasks before adding more, or ask the lead to split the goal.",
      "board_full",
    )
  }
  const title = assertTitle(input.title)
  const dependsOn = [...new Set(input.dependsOn ?? [])]
  for (const id of dependsOn) {
    if (!tx.task(id)) fail(`dependency ${id} does not exist.`, "Use team_task_list to find the correct task IDs.", "invalid_dependency")
  }
  if (input.owner !== undefined && input.owner !== actor.id && actor.role !== "lead") {
    fail("only the lead can assign a task to another member.", "Create the task unassigned and let that member claim it.", "not_lead")
  }
  const task: Task = {
    id: tx.nextTaskID(),
    teamID: team.id,
    title,
    description: (input.description ?? "").slice(0, 4_000),
    status: "pending",
    createdBy: actor.id,
    dependsOn,
    paths: normalizePaths(input.paths ?? []),
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
  tx.putTask(task)
  tx.bumpBoard()
  if (input.owner) {
    const owner = tx.member(input.owner)
    if (!owner) fail(`member ${input.owner} does not exist.`, "Use team_status to see member IDs.", "unknown_member")
    return claimTask(tx, team, owner, task.id, task.paths, now)
  }
  return task
}

export function claimTask(
  tx: TeamTx,
  team: Team,
  member: Member,
  taskID: string,
  paths: string[] = [],
  now = Date.now(),
): Task {
  const task = tx.task(taskID)
  if (!task) fail(`task ${taskID} does not exist.`, "Use team_task_list to find an open task.", "unknown_task")
  if (task.status === "done" || task.status === "cancelled") {
    fail(`task ${taskID} is already ${task.status}.`, "Pick another open task with team_task_list.", "task_closed")
  }
  if (task.owner && task.owner !== member.id) {
    fail(
      `task ${taskID} is owned by ${task.owner} (${task.status}).`,
      `Ask ${task.owner} for a handoff with team_handoff, or claim a different task.`,
      "task_owned",
    )
  }
  if (task.owner === member.id && (task.status === "claimed" || task.status === "in_progress")) {
    return task
  }
  if (task.status === "review") {
    fail(`task ${taskID} is in review.`, "Wait for the reviewer's result or ask the lead to assign a different task.", "in_review")
  }
  const openDependency = task.dependsOn.find((id) => tx.task(id)?.status !== "done")
  if (openDependency) {
    const dependency = tx.task(openDependency)
    fail(
      `task ${taskID} is blocked by ${openDependency} (${dependency?.status ?? "missing"}).`,
      "Finish the dependency first, or ask the lead to change the plan.",
      "dependency_open",
    )
  }
  const current = tx.tasks().find(
    (candidate) => candidate.id !== task.id && candidate.owner === member.id && isActiveTask(candidate),
  )
  if (current) {
    fail(
      `you already own ${current.id} (${current.status}).`,
      `Finish or hand off ${current.id} before claiming another task.`,
      "one_task",
    )
  }
  const declared = normalizePaths([...task.paths, ...paths])
  for (const other of tx.tasks()) {
    if (other.id === task.id || !isActiveTask(other) || other.owner === member.id) continue
    if (!other.owner) continue
    const conflict = pathConflict(declared, other.paths)
    if (conflict) {
      fail(
        `path ${conflict} is already leased by ${other.owner} on ${other.id}.`,
        `Coordinate with ${other.owner}, choose non-overlapping paths, or ask the lead to sequence the work.`,
        "path_leased",
      )
    }
  }
  task.owner = member.id
  task.status = "claimed"
  task.paths = declared
  task.version += 1
  task.updatedAt = now
  tx.putTask(task)
  tx.bumpBoard()
  return task
}

export function updateTask(
  tx: TeamTx,
  team: Team,
  actor: Member,
  taskID: string,
  input: UpdateTaskInput,
  now = Date.now(),
): { task: Task; notifyOwner?: { ownerID: string; body: string } } {
  const task = tx.task(taskID)
  if (!task) fail(`task ${taskID} does not exist.`, "Use team_task_list to find the task.", "unknown_task")
  const isLead = actor.role === "lead"
  const isOwner = task.owner === actor.id
  const isReviewer = actor.role === "reviewer" && task.status === "review"
  if (!isLead && !isOwner && !isReviewer) {
    fail(
      `you cannot update ${taskID}; it is owned by ${task.owner ?? "nobody"}.`,
      "Only the owner, a reviewer during review, or the lead can update this task.",
      "not_owner",
    )
  }
  if (input.status && input.status !== task.status) {
    const allowed = TRANSITIONS[task.status]
    if (!allowed.includes(input.status)) {
      fail(
        `invalid transition ${task.status} → ${input.status} for ${taskID}.`,
        `Allowed next states: ${allowed.length ? allowed.join(", ") : "none (terminal task)"}.`,
        "invalid_transition",
      )
    }
    if (isReviewer && !isLead && input.status !== "done" && input.status !== "in_progress" && input.status !== "blocked") {
      fail("a reviewer can only approve, reject or block a task in review.", "Use status done, in_progress or blocked.", "not_owner")
    }
    if (isReviewer && !isLead && input.status === "in_progress" && !input.result?.trim()) {
      fail(
        "rejecting a task requires a concrete reason.",
        "Pass result with the exact fixes needed so the owner can act on it.",
        "missing_result",
      )
    }
    task.status = input.status
  }
  if (input.result !== undefined) task.result = input.result.slice(0, 4_000)
  if (input.paths !== undefined) {
    if (!isLead && !isOwner) {
      fail("only the owner or the lead may declare paths.", "Ask the owner to add the paths to the task.", "not_owner")
    }
    const candidate = normalizePaths([...task.paths, ...input.paths])
    // Path additions must respect leases already held by other active tasks,
    // exactly like an initial claim does; otherwise two members end up
    // holding overlapping leases and lock each other out.
    for (const other of tx.tasks()) {
      if (other.id === task.id || !isActiveTask(other) || !other.owner || other.owner === actor.id) continue
      const conflict = pathConflict(candidate, other.paths)
      if (conflict) {
        fail(
          `path ${conflict} is already leased by ${other.owner} on ${other.id}.`,
          `Coordinate with ${other.owner}, choose non-overlapping paths, or ask the lead to sequence the work.`,
          "path_leased",
        )
      }
    }
    task.paths = candidate
  }
  task.version += 1
  task.updatedAt = now
  tx.putTask(task)
  tx.bumpBoard()
  // Reviewers and the lead both send rejection findings back to the owner;
  // only the owner editing their own task skips the notification.
  const notifyOwner =
    !isOwner && task.owner && input.status === "in_progress" && input.result
      ? { ownerID: task.owner, body: input.result }
      : undefined
  return { task, ...(notifyOwner ? { notifyOwner } : {}) }
}

export function handoffTask(
  tx: TeamTx,
  team: Team,
  from: Member,
  to: Member,
  taskID: string,
  summary: string,
  now = Date.now(),
): Task {
  const task = tx.task(taskID)
  if (!task) fail(`task ${taskID} does not exist.`, "Use team_task_list to find the task.", "unknown_task")
  if (task.status === "done" || task.status === "cancelled") {
    fail(`task ${taskID} is already ${task.status}.`, "Pick an open task to hand off.", "task_closed")
  }
  if (from.role !== "lead" && task.owner !== from.id) {
    fail(
      `task ${taskID} is owned by ${task.owner ?? "nobody"}, not you.`,
      "Only the owner or the lead can hand a task off.",
      "not_owner",
    )
  }
  if (to.id === from.id) fail("you cannot hand a task to yourself.", "Choose another member.", "self_handoff")
  const current = tx
    .tasks()
    .find((candidate) => candidate.id !== task.id && candidate.owner === to.id && isActiveTask(candidate))
  if (current) {
    fail(
      `${to.id} already owns ${current.id} (${current.status}).`,
      `Ask ${to.id} to finish that task first, or hand this task to another member.`,
      "recipient_busy",
    )
  }
  if (!summary.trim()) {
    fail("a handoff summary is required.", "Include current state, decisions, and the next concrete step.", "missing_summary")
  }
  task.owner = to.id
  task.status = "claimed"
  task.handoffFrom = from.id
  task.result = summary.slice(0, 4_000)
  task.version += 1
  task.updatedAt = now
  tx.putTask(task)
  tx.bumpBoard()
  return task
}

export function releaseTasksOf(tx: TeamTx, memberID: string, reason: string, now = Date.now()): Task[] {
  const released: Task[] = []
  for (const task of tx.tasks()) {
    if (task.owner !== memberID) continue
    if (task.status === "done" || task.status === "cancelled" || task.status === "pending") continue
    task.owner = undefined
    task.status = "pending"
    task.result = [task.result, `Released: ${reason}`].filter(Boolean).join("\n").slice(0, 4_000)
    task.version += 1
    task.updatedAt = now
    tx.putTask(task)
    tx.bumpBoard()
    released.push(task)
  }
  return released
}

export function activeTaskOf(tasks: readonly Task[], memberID: string): Task | undefined {
  return tasks.find((task) => task.owner === memberID && isActiveTask(task))
}

export function declaredPaths(tasks: readonly Task[], memberID: string): string[] {
  return tasks
    .filter((task) => task.owner === memberID && isActiveTask(task))
    .flatMap((task) => task.paths)
}

export function fileLeaseViolation(tasks: readonly Task[], member: Member, paths: string[]): string | undefined {
  if (!paths.length || member.role === "lead") return undefined
  const active = tasks.filter((task) => task.owner === member.id && isActiveTask(task))
  if (!active.length) {
    return `you have no active task; claim one with team_task_claim before editing ${paths.join(", ")}`
  }
  const declared = active.flatMap((task) => task.paths)
  if (!declared.length) {
    return `your task has no declared paths; add them with team_task_update(paths: [...]) before editing ${paths.join(", ")}`
  }
  for (const path of paths) {
    if (!declared.some((candidate) => pathsOverlap(path, candidate))) {
      return `path ${path} is not declared on your active task (${active.map((task) => task.id).join(", ")})`
    }
    for (const other of tasks) {
      if (other.owner === member.id || !other.owner || !isActiveTask(other)) continue
      if (other.paths.some((candidate) => pathsOverlap(path, candidate))) {
        return `path ${path} is leased by ${other.owner} on ${other.id}`
      }
    }
  }
  return undefined
}
