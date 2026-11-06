# opencode-team-mode (`team-mode`)

> Multi-agent team coordination plugin for OpenCode V2: shared task board, peer mailboxes, handoffs, file leases, loop limiters, and budget controls.

---

## Overview

`opencode-team-mode` is an official V2 plugin (`team-mode`) for OpenCode that enables multiple AI agents inside a single OpenCode workspace to coordinate effectively on complex engineering tasks.

Unlike naive multi-agent scripts that pollute context windows with full conversational history, `team-mode` establishes a lightweight, durable coordination protocol:
- **Shared Task Board**: Coarse-grained tasks (`pending`, `claimed`, `in_progress`, `blocked`, `review`, `done`) with dependency trees and declared file path leases.
- **Durable Mailbox**: Point-to-point and broadcast messaging with deduplication, priority steering (`steer` vs `queue`), and thread exchange caps.
- **Unforgeable Identity**: Sender identity is strictly derived from the session context (`context.sessionID`); agents cannot spoof each other.
- **File Lease Concurrency**: Dynamic path locks prevent concurrent edit collisions across workers.
- **Deadlock Cycle Detection**: Synchronous waits check the global wait-for graph for cycles before blocking.
- **Loop & Budget Guardrails**: Automated sweeps enforce turn limits, wall-clock time limits, message rate limits, and cost ceilings.
- **Seamless Recovery**: Persisted state survives host crashes and cleanly reconnects live sessions.

---

## CLI & GUI Compatibility

`opencode-team-mode` is engineered for **100% full compatibility across both the OpenCode CLI (terminal) and OpenCode GUI (desktop/web)**:

1. **Interface-Neutral Host APIs**:
   - Built entirely on standard OpenCode V2 host abstractions (`ctx.session`, `ctx.storage`, `ctx.tool`, `ctx.command`, `ctx.event`).
   - No direct TUI escape codes, raw terminal manipulation, or curses/blessed assumptions.
2. **Universal Chat Rendering**:
   - All tool responses, command outputs, and notifications render as clean, standard GitHub-flavored Markdown.
   - Text formats identically in terminal scrolling buffers and GUI chat bubbles.
3. **Cross-Surface Commands & Tools**:
   - The `/team` command and all 13 `team_*` tools are accessible identically in both the CLI and GUI command inputs.
4. **Consistent Prompt Ingestion**:
   - Message deliveries use synthetic prompts that wake idle models and integrate directly into the active session turn history on all surfaces.

---

## Installation

Add `opencode-team-mode` to your project's `opencode.json` (or global OpenCode configuration):

```json
{
  "plugins": [
    "opencode-team-mode"
  ]
}
```

Or reference a local tarball / path during development:

```json
{
  "plugins": [
    "./path/to/opencode-team-mode"
  ]
}
```

---

## Configuration

Plugin options are passed through the standard OpenCode V2 `plugins` array. Each
entry takes `{ "package": ..., "options": { ... } }` — do **not** nest options
under a plugin-name key at the config root; OpenCode only forwards the
`options` object to `Plugin.setup`.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-team-mode",
      "options": {
        // Team topology: "hub" (default: coordination routes through lead) or "mesh" (peer-to-peer)
        "topology": "hub",

        // Maximum concurrent members in the team (2 to 20, default 5)
        "maxMembers": 5,

        // Default underlying OpenCode agent when not specified by a role preset
        "defaultAgent": "build",

        // Human approval mode for spawning new child sessions: "ask" or "auto" (default: "ask")
        "humanApproval": "ask",

        // Logging level: "debug", "info", "warn", "error", or "none" (default: "warn")
        "logLevel": "warn",

        // Safety and resource limits
        "limits": {
          "maxDepth": 1,
          "maxHopsPerThread": 6,
          "maxMessagesPerMemberPerMinute": 20,
          "maxExchangesPerThread": 6,
          "maxMemberTurns": 40,
          "maxMemberMinutes": 30,
          "maxTeamCostUSD": 0, // 0 = unlimited
          "peerWait": false,   // Only lead can wait by default
          "waitTimeoutMs": 30000
        },

        // Role presets (can override defaults or define custom roles)
        "roles": {
          "architect": {
            "agent": "plan",
            "charter": "Read code, design interfaces, risks, and task breakdowns. Do not edit implementation files.",
            "deny": ["edit", "shell"]
          },
          "implementer": {
            "agent": "build",
            "charter": "Claim one task, lease paths, apply minimal correct changes, verify, and move to review.",
            "deny": []
          },
          "reviewer": {
            "agent": "general",
            "charter": "Review correctness, edge cases, tests, and criteria. Report with file:line. Reject or approve.",
            "deny": ["edit", "shell"]
          },
          "researcher": {
            "agent": "explore",
            "charter": "Research questions with evidence from code, docs, or URLs. Return concise briefs.",
            "deny": ["edit", "shell"]
          }
        }
      }
    }
  ]
}
```

---

## Commands

Use the `/team` command in either CLI or GUI chat:

| Command | Description | Example |
| :--- | :--- | :--- |
| `/team start "<goal>"` | Create a new team with the current session as the lead. | `/team start "Refactor auth module"` |
| `/team status` | Display the current team board, member states, and open tasks. | `/team status` |
| `/team say <message>` | Broadcast a message from the lead to all active team members. | `/team say "Sync checkpoint: please submit tasks for review"` |
| `/team stop [member]` | Stop a specific team member or terminate the entire team. | `/team stop implementer-1` or `/team stop` |
| `/team help` | Print usage guidance. | `/team help` |

---

## Coordination Tools

Team Mode registers 13 host tools for programmatic agent use:

### Lifecycle & Team Structure
- `team_create(goal, name?, topology?)`: Initialize a new team with the invoking session as lead.
- `team_spawn(role, brief?, agent?)`: Spawn a new teammate with an assigned role preset and deny-only permissions.
- `team_status()`: Render the full team status, board state, member turn/cost stats, and open tasks.
- `team_stop(memberID?, reason?)`: Stop an individual member (releasing their tasks) or shut down the entire team cleanly.

### Task Board & Leases
- `team_task_add(title, description?, dependsOn?, paths?, owner?)`: Add a task to the shared board.
- `team_task_claim(taskID, paths?)`: Claim an open task and lease exclusive file paths.
- `team_task_update(taskID, status?, result?, paths?)`: Update status (`in_progress`, `blocked`, `review`, `done`, `cancelled`), findings, or paths. Rejection by a reviewer automatically notifies the task owner.
- `team_task_list()`: List all tasks on the board with status and owners.
- `team_handoff(taskID, to, summary)`: Hand off an active task to another member with a required transition summary.

### Messaging & Synchronization
- `team_send(to, body, subject?, priority?, type?, replyTo?, requiresReply?)`: Send a point-to-point message.
- `team_broadcast(body, subject?, priority?)`: Broadcast an announcement to all active teammates (lead-only in hub).
- `team_inbox(unreadOnly?, limit?, markRead?)`: Read incoming messages and notifications.
- `team_wait(forMember?, forTask?, timeoutMs?, reason?)`: Synchronously wait for a task or teammate with circular deadlock detection.

---

## Safety & Concurrency Architecture

### File Lease Enforcement
When an agent attempts to invoke a file-writing tool (`write`, `edit`, `patch`), the `execute.before` hook verifies:
1. The agent owns an active task on the board.
2. The target path matches the declared lease paths for that task.
3. No other active task holds an overlapping path lease.
Violations reject execution immediately with clear guidance to claim or update task leases.

### Loop & Pair Throttling
- **Rapid Duplicates**: Messages with identical content sent to the same recipient within 30 seconds are deduplicated.
- **Pair Ping-Pong**: Exceeding exchange caps between two agents without any intervening task board update triggers an automatic 10-minute pair cooldown.
- **Rate Refusal**: Members exceeding configured message rates (`maxMessagesPerMemberPerMinute`) receive an actionable backoff error.

### Deadlock Cycle Prevention
Synchronous waits inspect the live wait graph across all active sessions. If agent A waits on agent B while agent B is directly or transitively waiting on agent A, the wait is rejected immediately with code `wait_cycle` and the full cycle path.

---

## License

MIT © OpenCode Contributors
