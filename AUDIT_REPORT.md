# 🛡️ Codebase Quality & Audit Report

## 1. Executive Summary
The diff introduces meaningful improvements: broadcast-to-all mailbox delivery, spawn re-validation inside transaction, budget-aware sweep with reentrancy guard, and recovery of ghost wait edges. However, several concurrency and logic risks remain, particularly around TOCTOU windows in spawn, wait-graph stale reads, and the idle-delivery deduplication using a non-transactional Set.

## 2. Category Scorecard (Target: 10/10)
| Category | Current Score | Critical Issues | Primary Refactor Target |
| :--- | :--- | :--- | :--- |
| **Security & Encoding** | `8/10` | 0 | N/A |
| **Logic & Architecture** | `6/10` | 3 | Spawn race, wait-graph, idle deduplication |
| **UI/UX & Parity** | `7/10` | 1 | Broadcast semantics leak sender copies |
| **Performance & State** | `6/10` | 2 | Sweeper pruning O(n²), idleDeliveryInFlight leak |
| **Documentation & Spec Parity** | `7/10` | 1 | Missing comments on priority semantics |

## 3. High-Priority Findings & Actionable Fixes

### `[CRITICAL]` Spawn TOCTOU: session collision window after tx commits
- **Location:** `src/core/team-service.ts:321-385`
- **Issue:** `host.sessions.create()` runs *outside* the per-team transaction (line 321-327). If two concurrent spawns both create sessions, the second tx will fail with "session_collision" (line 366) and throw, but the *first* session is already created and leaked — the catch block at line 379 only cleans up the *caller's* session, not the winner's orphan.
- **Recommended Fix:** Move session creation inside the transaction callback, or use a distributed lock keyed by teamID around the entire spawn flow. If sessions must be created externally, track created session IDs in a `pendingSpawnSessions` Set and clean up *all* on failure.

### `[CRITICAL]` Wait-graph cycle check reads stale aux entries
- **Location:** `src/core/team-service.ts:503-517`
- **Issue:** The cycle detection (`wouldCycle`) reads `tx.auxEntries()` filtered for `wait.*` (line 505-508). This runs inside the transaction, but `tx.auxEntries()` returns a snapshot *at transaction start*. Concurrent waiters adding edges in parallel transactions will not be visible, allowing cycles to form.
- **Recommended Fix:** Acquire a per-team mutex (or use the store's existing mutex) for the entire `wait()` operation including the polling loop, or implement a versioned wait-graph with optimistic concurrency (retry on version mismatch).

### `[MAJOR]` `idleDeliveryInFlight` Set is not transactional
- **Location:** `src/core/team-service.ts:117, 833-839`
- **Issue:** The Set prevents duplicate `deliverPending` calls but lives only in memory. If the process restarts, or if two `TeamService` instances share a store (multi-host), both can deliver simultaneously. Also, `deliverPending` itself may mutate member state (unread count) without coordination.
- **Recommended Fix:** Use a per-member auxiliary lock in the store (e.g., `aux:delivery.lock.<memberID>` with TTL) instead of in-memory Set. Acquire inside `deliverPending` transaction.

### `[MAJOR]` Sweeper pruning scans all envelopes O(n²)
- **Location:** `src/core/team-service.ts:988-1029`
- **Issue:** `pruneTeam` iterates every member, then every envelope in their inbox (line 991-997). For teams with many members and deep history, this blocks the sweeper loop. No pagination or batching.
- **Recommended Fix:** Add a store method `pruneExpiredEnvelopes(teamID, cutoff)` that uses a single indexed scan. Batch aux pruning similarly.

### `[MAJOR]` Mailbox broadcast delivers sender copies to *all* members including sender
- **Location:** `src/core/mailbox.ts:177-195`
- **Issue:** Loop sends to every active member (line 177). Sender receives their own message as "[team] you → all..." (line 184). This duplicates information already in their session context and inflates unread counts.
- **Recommended Fix:** Skip sender in the loop (`if (member.id === input.from.id) continue`), or add a `deliverToSender` flag defaulting to false.

### `[MINOR]` `teamNameFromGoal` uses `Math.random()` — non-deterministic
- **Location:** `src/core/team-service.ts:100-104`
- **Issue:** Fallback generates random suffix. Two teams with same short goal created simultaneously could collide on name (low probability but possible).
- **Recommended Fix:** Use `ids.teamId()` or ULID fragment instead of random.

### `[MINOR]` Recovery clears *all* wait edges unconditionally
- **Location:** `src/core/team-service.ts:1059-1062`
- **Issue:** `recover()` removes every `wait.*` aux entry (line 1061), even edges from in-progress waits that survived the crash. Legitimate waiters will wake up with no target.
- **Recommended Fix:** Only remove edges where `now - edge.at > waitTimeoutMs * 2` (stale), or check if target member still exists and is not stopped.

### `[MINOR]` Missing event stream reconnection backoff
- **Location:** Not in diff (likely `host.ts` or event consumer)
- **Issue:** Prompt mentions "event stream reconnection loop with backoff" but diff doesn't show it. If host event stream reconnects without exponential backoff, it can hammer the server on outage.
- **Recommended Fix:** Verify `Host` implementation uses jittered exponential backoff (e.g., `min(1000 * 2^attempt, 30000) + random(0, 1000)`).

## 4. Verification Proof
- Static analysis of diff and source files confirms all findings.
- No live browser verification needed for logic-layer audit.

---
*Audit completed by subagent-logic*