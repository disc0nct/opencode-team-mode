# Host assumptions (OpenCode V2)

Runtime probed: **OpenCode 2.2.5 / @opencode/plugin 2.2.5**, 2026-11-06.
Method: throwaway plugin (`spike-plugin/`) loaded from a temp project with
`opencode --standalone run`, tools executing every probe and writing JSON evidence to
`%TEMP%/team-mode-spike/results*.json`.

| # | Assumption | How tested | Result |
|---|------------|------------|--------|
| S1 | `session.create` accepts `parentID`, `agent`, `model`, `title`. Children appear as children of the lead. | Created a child with `parentID = tool context.sessionID`; read it back and via `session.list`. | **Confirmed.** Child has `parentID`, inherits directory, agent and model. `session.remove` removes it. `agent` is not stored on a normal session unless passed; `context.agent` is authoritative. |
| S2 | A plugin can register a new agent. | `agent.list()`; `agent.transform(editor)` shape inspection. | **No.** Editor exposes `list/get/default/update/remove`; `add` is `undefined`. `agent.list()` returns `{ location, data: AgentInfo[] }`. Roles must be presets over existing agents + `switchAgent` + instructions + session permissions. |
| S3 | `session.synthetic` wakes an idle session; `session.prompt` is a user turn. | Synthetic message to a fresh idle session, then `session.wait`; same with `prompt`. | **Synthetic wakes.** Returned message `type: "synthetic"`, `delivery: "steer"` by default, model replied in ~0.8 s, no `resume` needed. `prompt` produced `type: "user"` and a model turn. Use synthetic for peer messages. |
| S4 | `steer` vs `queue` mid-turn. | Queued a long answer, then sent one `steer` and one `queue` message while busy. | `steer` was admitted immediately as the next user turn (model restarted its answer); `queue` stayed behind it and was processed after. Delivery semantics are host-side and reliable. |
| S5 | Events for idle / completed / errored / interrupted. | Subscribed to the event stream during a child turn. | Saw `session.inbox.enqueued`, `session.execution.started`, `session.inbox.delivered`, `session.execution.succeeded`, step/text events. `session.execution.failed` / `.interrupted` and `session.idle` exist in `V2Event`. `session.idle` was not emitted within the 500 ms tail; the `experimental.idle` hook fired reliably for every finished turn. |
| S6 | Tool `context` fields; cross-session calls safe while own turn is in flight. | Inspected context; created/prompted/waited/removed child sessions from inside a tool. | Context keys: `sessionID, agent, messageID, id, progress, signal`. All cross-session calls worked from inside the parent turn, including `wait`. `signal` is an `AbortSignal`. |
| S7 | `instructions.entry` survives compaction and reload. | Put `team.charter`, checked via `entry.list`, a `context` hook, a turn, and a compaction. | **Survives.** Entry appeared in system instructions (context hook saw the marker) and persisted through a manual compaction. Key must match `^[a-z0-9][a-z0-9._-]*$` — slashes are rejected. Use `team.charter`, `team.board`. |
| S8 | A thrown `Tool.Error` reaches the model with its message. | A tool threw `new Tool.Error({ message: "SPIKE_ACTIONABLE: …" })`; model was asked to quote it. | **Confirmed.** The exact message crossed the Code Mode boundary and the model quoted it. Use `@opencode/plugin/promise/tool`'s `Error`. |
| S9 | Logging facility. | Inspected `ctx` keys / `ctx.log`. | **No plugin logger.** `ctx.log` is `undefined`. `ctx.app` only exposes `version`. Use a thin logger (default `console.error` for warn/error, silent info) that can be swapped. |
| S10 | Storage under concurrent writes; multiple instances. | 40 parallel `set`s; 30 concurrent read-modify-write increments; observed overlapping runs. | 40 distinct parallel writes all persisted. Read-modify-write **lost updates**: 30 increments produced **1**. No CAS. Serialize all team mutations with a process mutex and persist a version counter. Module state is shared across setup calls; setup must be idempotent and instance state must not live at module scope. Multiple instances are possible across overlapping servers; treat storage as shared, keep writes idempotent, and document single-server assumption. |

## Consequences baked into the design

- Peer messages use `session.synthetic`, not `prompt`.
- Identity comes from `context.sessionID`; `from` is never an input.
- Every team mutation runs through a per-team async mutex. Version is stored best-effort; tools expose
  `expectedVersion` for callers that need optimistic checks.
- Roles are presets: existing agent + keyed charter entry + session permission rules.
- Instruction keys are dotted, never slashed.
- Session status tracking uses `session.execution.*` events plus the `experimental.idle` hook as a fallback.
- Tool errors are `Tool.Error` with next-step guidance.
- Unload does not stop sessions; startup recovery rebinds by session ID.
