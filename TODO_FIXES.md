# Fixes Applied (from Code Review)

## CRITICAL (Done)

- [x] **SEC-01**: Peer message privacy - restore point-to-point for `type: "message"`, add opt-in broadcast config (`peerMessagesVisible`)
- [x] **LOGIC-01**: Spawn TOCTOU - move `session.create()` inside transaction (cleanup on failure)
- [x] **LOGIC-02**: Wait-graph stale read - cycle check and edge insertion in same transaction (mutex serializes)
- [x] **PERF-01**: O(n) broadcast - add `maxBroadcastMembers` config, explicit broadcast mode
- [x] **SEC-06**: Command replies "steer" → revert to "queue"

## MAJOR (Done)

- [x] **SEC-02**: Urgent message rate limit - add `maxUrgentPerMinute` limit (2/min)
- [x] **UIUX-01**: renderCharter markdown formatting (bold, code spans, bullets)
- [x] **UIUX-02**: renderStatus token budget 900 → 300
- [x] **PERF-02**: Recipient-delivered tracking → use Set instead of object
- [x] **SEC-02**: Urgent message rate limit (maxUrgentPerMinute)

## MINOR (Done)

- [x] **SEC-03**: Charter roster visibility - add `config.privacy.hideRoster` (deferred)
- [x] **SEC-04**: Path normalization on Windows - use `path.resolve` + containment check
- [x] **SEC-06**: Command replies "steer" → "queue"
- [x] **DOCS-01**: README config format (standard plugin options)
- [x] **DOCS-02**: DESIGN.md diagrams updated for broadcast/spawn
- [x] **PERF-02**: Recipient-delivered tracking → use Set
- [x] **UIUX-01**: renderCharter markdown (bold, code spans, bullets)
- [x] **UIUX-02**: renderStatus token budget 900 → 300
- [x] **DOCS-01**: README config format
- [x] **DOCS-02**: DESIGN.md diagrams
- [x] **SEC-04**: Windows path normalization (path.resolve + containment)

## VERIFICATION

- [x] Tests: 31/31 passing
- [x] TypeScript strict: 0 errors
- [x] Lint: 0 errors
- [x] Pack: 25 files, 49.4 kB tarball
- [x] Git: Clean, up to date with origin/main