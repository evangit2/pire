# pire Issues — Audit Findings & Fixes

## Summary

Audited the pire codebase by running the MCP server, executing RE tasks across all tool categories, and analyzing source code. Found and fixed 11 issues across 5 files. Added 68 new tests (42 bugfix + 26 MCP integration). All 501 tests pass.

---

## Issues Found & Fixed

### 1. High Token Usage: All 38 Tool Schemas Sent Every Turn (Critical)
**Files:** `mcp-server.ts`, `tui.ts`  
**Problem:** All 38 tool schemas (~15KB JSON) were sent to the LLM on every turn regardless of whether tools were actually available (e.g., Ghidra, Frida, angr not installed).  
**Fix:** Filter `RE_TOOLS` to only include tools where `session.tools[name] !== false` before mapping to function schemas. Applied to both MCP server and both TUI agent loops.  
**Impact:** ~52% token reduction when half the tools are unavailable.

### 2. No Context Window Trimming in MCP Server (Critical)
**Files:** `mcp-server.ts`  
**Problem:** The MCP server's `runAgentLoop` had no context trimming — messages accumulated indefinitely, eventually exceeding the model's context window and causing HTTP 400 errors.  
**Fix:** Added `trimContextMessages()` with two-stage compression:
- Stage 1: Truncate old tool results to head+tail (5% of context budget each)
- Stage 2: Stub old tool results to `[compressed]` if still over budget
- Always preserves the most recent 8 messages

### 3. Hardcoded Context Limits Instead of Percentage-Based (Critical)
**Files:** `mcp-server.ts`  
**Problem:** Tool output truncation was hardcoded to `100000` chars and `max_output` from settings. Context limit defaulted to `120000` when no config existed. These values don't scale for models with 2K or 2M context windows.  
**Fix:** All limits now computed as percentages of the configured model's `contextLength`:
- Context char budget: `contextLength × 4 × 0.75` (75% of window as chars)
- Tool output cap: 30% of context budget (min 1000)
- Tool result head/tail: 5% of context budget each
- Falls back to 32000 context if unconfigured

### 4. seenCalls Deduplication Was Per-Session Instead of Per-Turn (Bug)
**Files:** `mcp-server.ts`, `tui.ts` (2 locations)  
**Problem:** `seenCalls` was created once before the agent loop, preventing the same tool from being called with the same args in different turns. E.g., running `strings` on the same binary in turn 1 and turn 5 would be silently skipped on turn 5.  
**Fix:** Moved `const seenCalls = new Set()` inside the for-loop so it's fresh each turn. Same-tool-same-args is only deduplicated within a single turn.

### 5. turns Count Was Actually Tool Call Count (Bug)
**Files:** `mcp-server.ts`  
**Problem:** `runAgentLoop` returned `turns: toolCallLog.length` — the number of tool calls, not the number of LLM turns. A turn with 3 tool calls would report `turns: 3` instead of `turns: 1`.  
**Fix:** Track `turnCount` separately and return `turns: turnCount`.

### 6. session.load Didn't Call setGhidraTarget (Bug)
**Files:** `mcp-server.ts`  
**Problem:** When loading a binary via `session.load`, the target was stored in the session object but `setGhidraTarget()` was never called. Ghidra tools would operate on the wrong binary (or none).  
**Fix:** Call `setGhidraTarget(target)` in both `session.create` (when target provided) and `session.load`.

### 7. 4xx Errors Retried 3× with 2s/4s Delays (Bug)
**Files:** `llm.ts`  
**Problem:** All HTTP errors ≥500 were rejected, but the retry loop would retry any error 3 times. 4xx errors (400 Bad Request, 401 Unauthorized, 403 Forbidden) would never succeed but still wasted 6+ seconds retrying.  
**Fix:** 
- Now rejects on all HTTP ≥400 (not just ≥500)
- Reads the error response body for diagnostics
- Marks errors with `retriable: statusCode >= 500`
- Retry loop checks `retriable === false` and throws immediately

### 8. e2e Test Parsed `default:` Instead of `model:` (Bug)
**Files:** `test-e2e.cjs`  
**Problem:** `loadProvider()` extracted the model name using `cfg.match(/default:\s*(.+)/)` — but the config file uses `model:` not `default:`. The model was always `undefined`, causing all model inference tests to fail.  
**Fix:** Changed regex to `/(?:^|\n)\s*model:\s*(.+)/`.

### 9. test-models Test Didn't Support Flat Config Format (Bug)
**Files:** `test-models.cjs`  
**Problem:** `loadConfig()` only supported a multi-provider YAML format with nested `model:` and `providers:` sections. The actual `~/.pire/config.yaml` uses a flat format (`model: "..."`, `base_url: "..."`, `api_key: "..."`). No providers were ever detected.  
**Fix:** Added flat-format parsing: top-level `model:`, `base_url:`, and `api_key:` lines are now mapped to `model.model`, `model.default`, `model.base_url`, and `model.api_key` config keys. Multi-provider format still supported.

### 10. Unused Import: loadSettings (Cleanup)
**Files:** `mcp-server.ts`  
**Problem:** `loadSettings` was imported from `pire-config.js` but only used for `max_output`, which was replaced by percentage-based calculation.  
**Fix:** Removed the import.

### 11. Tool Schemas Not Filtered in TUI Agent Loops (Bug)
**Files:** `tui.ts`  
**Problem:** Both TUI agent loops (`PireTUI.runAgentLoop` and `PireCLI.runAgentLoop`) sent all tool schemas regardless of availability.  
**Fix:** Added `.filter((t) => this.tools[t.name] !== false)` before `.map(toolToFunction)` in both loops.

---

## Test Results

| Test Suite | Tests | Passed | Failed |
|---|---|---|---|
| test-suite.cjs | 393 | 393 | 0 |
| test-behavioral.cjs | 40 | 40 | 0 |
| test-bugfixes.cjs | 42 | 42 | 0 |
| test-mcp.cjs | 26 | 26 | 0 |
| **Total** | **501** | **501** | **0** |

---

## Files Modified

- `packages/re-agent/src/mcp-server.ts` — tool filtering, context trimming, percentage-based limits, setGhidraTarget, turns count, seenCalls per-turn
- `packages/re-agent/src/tui.ts` — tool filtering (2 loops), seenCalls per-turn (2 loops)
- `packages/re-agent/src/llm.ts` — 4xx error handling, retry logic
- `packages/re-agent/test/test-e2e.cjs` — model parsing fix
- `packages/re-agent/test/test-models.cjs` — flat config support
- `packages/re-agent/test/test-bugfixes.cjs` — new test suite (42 tests)
- `packages/re-agent/test/test-mcp.cjs` — new MCP integration test (26 tests)
- `packages/re-agent/package.json` — version bump
- `package.json` — version bump
- `packages/re-agent/src/pire-pi-tui.ts` — version bump
- `ISSUES.md` — this file
