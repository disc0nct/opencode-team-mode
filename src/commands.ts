import type { CommandDefinition, CommandInvocation, Host } from "./host.ts"
import { TeamError } from "./errors.ts"
import { renderUsage } from "./core/render.ts"
import type { TeamService } from "./core/team-service.ts"

function parseArgs(raw: string): { subCommand: string; rest: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { subCommand: "", rest: "" }
  const match = trimmed.match(/^([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s)
  if (!match) return { subCommand: trimmed, rest: "" }
  return {
    subCommand: (match[1] ?? "").toLowerCase(),
    rest: (match[2] ?? "").trim(),
  }
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

export function createCommand(service: TeamService, host: Host): CommandDefinition {
  return {
    name: "team",
    description: "Manage and coordinate agent teams (start, status, say, stop).",
    async execute(invocation: CommandInvocation): Promise<void> {
      const { subCommand, rest } = parseArgs(invocation.text)

      const reply = async (message: string) => {
        await host.sessions.synthesize(invocation.sessionID, {
          text: message,
          delivery: "queue",
          description: "team command reply",
        })
      }

      try {
        switch (subCommand) {
          case "start": {
            const goal = stripQuotes(rest)
            if (!goal) {
              await reply('Please provide a goal. Usage: /team start "<goal>"')
              return
            }
            const { team, lead } = await service.createTeam(invocation.sessionID, { goal })
            await reply(
              `Team "${team.name}" (${team.id}) started with you as ${lead.id}.\nGoal: ${team.goal}\nUse team_spawn to add teammates or team_task_add to create tasks.`,
            )
            break
          }

          case "status": {
            const result = await service.status(invocation.sessionID)
            await reply(result.rendered)
            break
          }

          case "say": {
            if (!rest) {
              await reply("Usage: /team say <message>")
              return
            }
            const outcome = await service.broadcast(invocation.sessionID, { body: rest })
            await reply(`Broadcast sent to ${outcome.count} team member(s).`)
            break
          }

          case "stop": {
            let memberID: string | undefined
            let reason: string | undefined
            if (rest) {
              const stripped = stripQuotes(rest)
              const parts = rest.split(/\s+/)
              const first = parts[0] ?? ""
              try {
                const status = await service.status(invocation.sessionID)
                const isMember = status.members.some((m) => m.id === first)
                if (isMember) {
                  memberID = first
                  reason = parts.slice(1).join(" ").trim() || undefined
                } else {
                  reason = stripped
                }
              } catch {
                memberID = first
                reason = parts.slice(1).join(" ").trim() || undefined
              }
            }
            const outcome = await service.stop(invocation.sessionID, { memberID, reason })
            await reply(`Stopped: ${outcome.stopped}${outcome.reason ? ` (${outcome.reason})` : ""}`)
            break
          }

          case "help":
          default: {
            await reply(renderUsage())
            break
          }
        }
      } catch (error) {
        if (error instanceof TeamError) {
          await reply(`[team-mode error] ${error.message}\n${error.guidance}`)
          return
        }
        const msg = error instanceof Error ? error.message : String(error)
        await reply(`[team-mode error] ${msg}`)
      }
    },
  }
}
