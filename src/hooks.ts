import { fail } from "./errors.ts"
import type { Host } from "./host.ts"
import { fileLeaseViolation } from "./core/board.ts"
import { normalizePath } from "./core/limits.ts"
import type { TeamService } from "./core/team-service.ts"

const FILE_TOOLS = new Set([
  "write",
  "edit",
  "patch",
  "create_file",
  "delete_file",
])

function stripWorkspaceDir(value: string, workspaceDir: string): string {
  let path = value.trim().replace(/\\/g, "/")
  const base = workspaceDir.trim().replace(/\\/g, "/").replace(/\/+$/, "")
  if (base && path.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
    path = path.slice(base.length + 1)
  }
  return path
}

/**
 * Extracts candidate file paths from a tool input. Absolute paths are made
 * workspace-relative so they match leases declared as relative paths. Paths
 * that escape the workspace (`..`) are reported as violations instead of
 * being silently dropped (which would bypass lease enforcement).
 */
function extractPaths(
  tool: string,
  input: unknown,
  workspaceDir: string,
): { paths: string[]; escaped: string[] } {
  if (!FILE_TOOLS.has(tool) || !input || typeof input !== "object") {
    return { paths: [], escaped: [] }
  }
  const record = input as Record<string, unknown>
  const raw: string[] = []
  if (typeof record.path === "string") raw.push(record.path)
  if (typeof record.filePath === "string") raw.push(record.filePath)
  if (typeof record.file === "string") raw.push(record.file)
  if (Array.isArray(record.paths)) {
    for (const item of record.paths) {
      if (typeof item === "string") raw.push(item)
    }
  }

  const paths: string[] = []
  const escaped: string[] = []
  for (const value of raw) {
    const normalized = normalizePath(stripWorkspaceDir(value, workspaceDir))
    if (normalized) {
      if (!paths.includes(normalized)) paths.push(normalized)
    } else {
      escaped.push(value)
    }
  }
  return { paths, escaped }
}

export interface HookDisposables {
  dispose(): Promise<void>
}

export async function registerHooks(service: TeamService, host: Host): Promise<HookDisposables> {
  const disposers: Array<() => Promise<void>> = []

  // 1. Tool execution lease enforcement
  const unhookToolBefore = await host.onToolBefore(async (event) => {
    const { paths, escaped } = extractPaths(event.tool, event.input, host.directory)
    if (!paths.length && !escaped.length) return

    const mapping = await service.store.findTeamForSession(event.sessionID)
    if (!mapping) return

    const member = await service.store.getMember(mapping.teamID, mapping.memberID)
    if (!member || member.role === "lead") return

    if (escaped.length) {
      fail(
        `path ${escaped[0]} escapes the workspace and cannot be leased.`,
        "Edit files inside the project directory and declare them on your active task with team_task_update(paths: [...]).",
        "path_escape",
      )
    }

    const tasks = await service.store.tasks(mapping.teamID)
    const violation = fileLeaseViolation(tasks, member, paths)
    if (violation) {
      fail(
        `File lease violation: ${violation}.`,
        "Claim the task with team_task_claim or declare paths using team_task_update before editing.",
        "file_lease_conflict",
      )
    }
  })
  disposers.push(unhookToolBefore)

  // 2. Host event streaming
  const unhookEvent = await host.onEvent((event) => {
    // Return the promise so awaited dispatches (tests, orchestrators) observe
    // handler completion; errors are swallowed to protect the stream loop.
    return service.handleHostEvent(event).catch(() => undefined)
  })
  disposers.push(unhookEvent)

  // 3. Session idle detection (the event stream does not reliably emit
  // session.idle; this hook is the dependable fallback. Duplicate wake-ups are
  // deduped inside TeamService.handleHostEvent.)
  const unhookIdle = await host.onSessionIdle(async (sessionID) => {
    await service.handleHostEvent({ type: "session.idle", sessionID })
  })
  disposers.push(unhookIdle)

  // 4. Context injection hook
  const unhookContext = await host.onContext(async (event) => {
    const mapping = await service.store.findTeamForSession(event.sessionID)
    if (!mapping) return
    const team = await service.store.getTeam(mapping.teamID)
    if (!team || team.status !== "active") return

    // Ensure system parts have a brief team indicator line
    event.system.push({
      type: "text",
      text: `[team-mode] active: team=${team.id} member=${mapping.memberID} board_v=${team.boardVersion}`,
    })
  })
  disposers.push(unhookContext)

  return {
    async dispose() {
      for (const dispose of disposers.reverse()) {
        try {
          await dispose()
        } catch {
          // ignore cleanup errors
        }
      }
    },
  }
}
