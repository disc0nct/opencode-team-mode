import type { HostToolDefinition } from "./host.ts"
import type { TeamService } from "./core/team-service.ts"
import { renderTask } from "./core/render.ts"
import type { EnvelopeType, Priority, TaskStatus, Topology } from "./types.ts"

function jsonResult(message: string): { content: string } {
  return { content: message }
}

export function createTools(service: TeamService): HostToolDefinition[] {
  const tools: HostToolDefinition[] = [
    {
      name: "team_create",
      description: "Create a new agent team with this session as the lead.",
      input: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "The overarching objective or goal for the team.",
          },
          name: {
            type: "string",
            description: "Optional human-readable name for the team.",
          },
          topology: {
            type: "string",
            enum: ["hub", "mesh"],
            description: "Team communication topology. Hub routes coordination through lead; mesh allows peer messaging.",
          },
        },
        required: ["goal"],
      },
      async execute(rawInput, context) {
        const input = (rawInput ?? {}) as {
          goal?: string
          name?: string
          topology?: Topology
        }
        const { team, lead } = await service.createTeam(context.sessionID, {
          goal: input.goal || "",
          name: input.name,
          topology: input.topology,
        })
        return jsonResult(
          `Created team "${team.name}" (${team.id}) with topology "${team.topology}". You are member "${lead.id}" (role: lead).\nGoal: ${team.goal}`,
        )
      },
    },

    {
      name: "team_spawn",
      description: "Spawn a new agent team member for a specific role (architect, implementer, reviewer, researcher, etc.).",
      input: {
        type: "object",
        properties: {
          role: {
            type: "string",
            description: "Role preset name (e.g. architect, implementer, reviewer, researcher).",
          },
          brief: {
            type: "string",
            description: "Short specific directive or initial focus for this member.",
          },
          agent: {
            type: "string",
            description: "Optional override of the underlying OpenCode agent.",
          },
        },
        required: ["role"],
      },
      async execute(rawInput, context) {
        const input = (rawInput ?? {}) as {
          role?: string
          brief?: string
          agent?: string
        }
        const member = await service.spawn(context.sessionID, {
          role: input.role || "",
          brief: input.brief,
          agent: input.agent,
        })
        return jsonResult(
          `Spawned team member "${member.id}" for role "${member.role}" with agent "${member.agent}". Session ID: ${member.sessionID}.`,
        )
      },
    },

    {
      name: "team_send",
      description: "Send a message or handoff request to another team member.",
      input: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "Recipient member ID (e.g. 'lead', 'implementer-1').",
          },
          body: {
            type: "string",
            description: "Message content. Keep it short, concrete and actionable.",
          },
          subject: {
            type: "string",
            description: "Optional subject line (up to 120 chars).",
          },
          priority: {
            type: "string",
            enum: ["normal", "urgent"],
            description: "Priority. Urgent messages interrupt busy teammates via steer.",
          },
          type: {
            type: "string",
            enum: ["message", "request", "response", "handoff", "status"],
            description: "Envelope type classification.",
          },
          replyTo: {
            type: "string",
            description: "ID of envelope this message is responding to.",
          },
          requiresReply: {
            type: "boolean",
            description: "Whether this message explicitly expects a response.",
          },
        },
        required: ["to", "body"],
      },
      async execute(rawInput, context) {
        const input = (rawInput ?? {}) as {
          to?: string
          body?: string
          subject?: string
          priority?: Priority
          type?: EnvelopeType
          replyTo?: string
          requiresReply?: boolean
        }
        const outcome = await service.send(context.sessionID, {
          to: input.to || "",
          body: input.body || "",
          subject: input.subject,
          priority: input.priority,
          type: input.type,
          replyTo: input.replyTo,
          requiresReply: input.requiresReply,
        })
        if (outcome.duplicate) {
          return jsonResult("Message suppressed as duplicate: identical content sent within duplicate window.")
        }
        const deliveryText = outcome.delivered ? "Delivered directly." : "Queued in recipient inbox."
        return jsonResult(`Message sent to ${input.to} (${outcome.envelope?.id ?? "unknown"}). ${deliveryText}`)
      },
    },

    {
      name: "team_broadcast",
      description: "Broadcast a message to all active teammates (lead-only in hub topology).",
      input: {
        type: "object",
        properties: {
          body: {
            type: "string",
            description: "Announcement text.",
          },
          subject: {
            type: "string",
            description: "Optional announcement subject.",
          },
          priority: {
            type: "string",
            enum: ["normal", "urgent"],
            description: "Message priority.",
          },
        },
        required: ["body"],
      },
      async execute(rawInput, context) {
        const input = (rawInput ?? {}) as {
          body?: string
          subject?: string
          priority?: Priority
        }
        const result = await service.broadcast(context.sessionID, {
          body: input.body || "",
          subject: input.subject,
          priority: input.priority,
        })
        return jsonResult(`Broadcast sent to ${result.count} team member(s).`)
      },
    },

    {
      name: "team_inbox",
      description: "Read received messages and announcements from your inbox.",
      input: {
        type: "object",
        properties: {
          unreadOnly: {
            type: "boolean",
            description: "Whether to return unread messages only (default true).",
          },
          limit: {
            type: "number",
            description: "Max number of messages to fetch (default 10).",
          },
          markRead: {
            type: "boolean",
            description: "Whether to mark returned messages as read (default true).",
          },
        },
      },
      async execute(rawInput, context) {
        const input = (rawInput ?? {}) as {
          unreadOnly?: boolean
          limit?: number
          markRead?: boolean
        }
        const result = await service.inbox(context.sessionID, input)
        return jsonResult(result.rendered)
      },
    },

    {
      name: "team_wait",
      description: "Wait synchronously for a member or a task with deadlock cycle detection and timeout.",
      input: {
        type: "object",
        properties: {
          forMember: {
            type: "string",
            description: "Member ID to wait for (e.g. 'implementer-1').",
          },
          forTask: {
            type: "string",
            description: "Task ID to wait for (e.g. 't_1').",
          },
          timeoutMs: {
            type: "number",
            description: "Timeout in milliseconds (capped by limits).",
          },
          reason: {
            type: "string",
            description: "Reason for waiting.",
          },
        },
      },
      async execute(rawInput, context) {
        const input = (rawInput ?? {}) as {
          forMember?: string
          forTask?: string
          timeoutMs?: number
          reason?: string
        }
        const outcome = await service.wait(context.sessionID, input)
        return jsonResult(
          outcome.completed
            ? `Wait completed: ${outcome.reason}`
            : `Wait finished: ${outcome.reason}`,
        )
      },
    },

    {
      name: "team_task_add",
      description: "Add a task to the shared team board.",
      input: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short concrete title of the task.",
          },
          description: {
            type: "string",
            description: "Detailed description and acceptance criteria.",
          },
          dependsOn: {
            type: "array",
            items: { type: "string" },
            description: "IDs of tasks that must be done before this can start.",
          },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "File or directory paths this task intends to modify.",
          },
          owner: {
            type: "string",
            description: "Optional initial owner (lead only).",
          },
        },
        required: ["title"],
      },
      async execute(rawInput, context) {
        const input = (rawInput ?? {}) as {
          title?: string
          description?: string
          dependsOn?: string[]
          paths?: string[]
          owner?: string
        }
        const task = await service.addTask(context.sessionID, {
          title: input.title || "",
          description: input.description,
          dependsOn: input.dependsOn,
          paths: input.paths,
          owner: input.owner,
        })
        return jsonResult(`Added task:\n${renderTask(task)}`)
      },
    },

    {
      name: "team_task_claim",
      description: "Claim an open task and declare file path leases.",
      input: {
        type: "object",
        properties: {
          taskID: {
            type: "string",
            description: "ID of the task to claim (e.g. 't_1').",
          },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "File paths to declare and lease for this task.",
          },
        },
        required: ["taskID"],
      },
      async execute(rawInput, context) {
        const input = (rawInput ?? {}) as {
          taskID?: string
          paths?: string[]
        }
        const task = await service.claimTask(context.sessionID, input.taskID || "", input.paths)
        return jsonResult(`Claimed task:\n${renderTask(task)}`)
      },
    },

    {
      name: "team_task_update",
      description: "Update the status, findings, or leased paths of an active task.",
      input: {
        type: "object",
        properties: {
          taskID: {
            type: "string",
            description: "ID of the task.",
          },
          status: {
            type: "string",
            enum: ["in_progress", "blocked", "review", "done", "cancelled"],
            description: "New status for the task.",
          },
          result: {
            type: "string",
            description: "Findings, review summary, or completion results.",
          },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Additional file paths touched.",
          },
        },
        required: ["taskID"],
      },
      async execute(rawInput, context) {
        const input = (rawInput ?? {}) as {
          taskID?: string
          status?: TaskStatus
          result?: string
          paths?: string[]
        }
        const task = await service.updateTask(context.sessionID, input.taskID || "", {
          status: input.status,
          result: input.result,
          paths: input.paths,
        })
        return jsonResult(`Updated task:\n${renderTask(task)}`)
      },
    },

    {
      name: "team_task_list",
      description: "List all tasks on the team board.",
      input: {
        type: "object",
        properties: {},
      },
      async execute(_rawInput, context) {
        const tasks = await service.listTasks(context.sessionID)
        if (!tasks.length) return jsonResult("No tasks on the board.")
        const lines = tasks.map((t) => renderTask(t))
        return jsonResult(lines.join("\n\n---\n\n"))
      },
    },

    {
      name: "team_handoff",
      description: "Hand off an owned task to another teammate with a required handoff summary.",
      input: {
        type: "object",
        properties: {
          taskID: {
            type: "string",
            description: "ID of task to hand off.",
          },
          to: {
            type: "string",
            description: "Recipient member ID.",
          },
          summary: {
            type: "string",
            description: "Context, progress made, and clear next steps.",
          },
        },
        required: ["taskID", "to", "summary"],
      },
      async execute(rawInput, context) {
        const input = (rawInput ?? {}) as {
          taskID?: string
          to?: string
          summary?: string
        }
        const task = await service.handoff(
          context.sessionID,
          input.taskID || "",
          input.to || "",
          input.summary || "",
        )
        return jsonResult(`Task ${task.id} handed off to ${input.to}:\n${renderTask(task)}`)
      },
    },

    {
      name: "team_status",
      description: "View the overall team status, member states, and board overview.",
      input: {
        type: "object",
        properties: {},
      },
      async execute(_rawInput, context) {
        const result = await service.status(context.sessionID)
        return jsonResult(result.rendered)
      },
    },

    {
      name: "team_stop",
      description: "Stop a teammate or terminate the entire team cleanly.",
      input: {
        type: "object",
        properties: {
          memberID: {
            type: "string",
            description: "Optional member ID to stop. If omitted, stops the whole team (lead only).",
          },
          reason: {
            type: "string",
            description: "Reason for stopping.",
          },
        },
      },
      async execute(rawInput, context) {
        const input = (rawInput ?? {}) as {
          memberID?: string
          reason?: string
        }
        const result = await service.stop(context.sessionID, input)
        return jsonResult(`Stopped ${result.stopped}: ${result.reason || "no reason specified"}`)
      },
    },
  ]

  return tools
}
