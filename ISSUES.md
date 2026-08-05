# pire Issues — Audit Findings & Fixes

## Summary

Audited the pire codebase across three passes. First pass found and fixed 11 issues. Second pass (advanced multi-turn RE tasks) found and fixed 5 more issues across 5 files. Third pass (deep tool + agent loop testing) found and fixed 3 critical issues. All 531 tests pass plus 38 integration tests.

---

## Pass 1: Initial Audit (v0.89.7)

### 1. High Token Usage: All 38 Tool Schemas Sent Every Turn (Critical)
**Files:** `mcp-server.ts`, `tui.ts`  
**Problem:** All 38 tool schemas (~15KB JSON) were sent to the LLM on every turn regardless of whether tools were actually available.  
**Fix:** Filter `RE_TOOLS` to only include tools where `session.tools[name] !== false` before mapping to function schemas. Applied to MCP server and both TUI agent loops.  
**Impact:** ~52% token reduction when half the tools are unavailable.

### 2. No Context Window Trimming in MCP Server (Critical)
**Files:** `mcp-server.ts`  
**Fix:** Added `trimContextMessages()` with two-stage compression: truncate old tool results to head+tail, then stub to `[compressed]`. Always preserves most recent 8 messages.

### 3. Hardcoded Context Limits Instead of Percentage-Based (Critical)
**Files:** `mcp-server.ts`  
**Fix:** All limits now computed as percentages of the configured model's `contextLength`.

### 4. seenCalls Deduplication Was Per-Session Instead of Per-Turn (Bug)
**Files:** `mcp-server.ts`, `tui.ts`  
**Fix:** Moved `const seenCalls = new Set()` inside the for-loop.

### 5. turns Count Was Actually Tool Call Count (Bug)
**Files:** `mcp-server.ts`  
**Fix:** Track `turnCount` separately and return `turns: turnCount`.

### 6. session.load Didn't Call setGhidraTarget (Bug)
**Files:** `mcp-server.ts`  
**Fix:** Call `setGhidraTarget(target)` in `session.create` and `session.load`.

### 7. 4xx Errors Retried 3× with Delays (Bug)
**Files:** `llm.ts`  
**Fix:** Mark errors with `retriable: statusCode >= 500`. Retry loop checks and throws immediately for 4xx.

### 8. e2e Test Parsed `default:` Instead of `model:` (Bug)
**Files:** `test-e2e.cjs`  
**Fix:** Changed regex to `/(?:^|\n)\s*model:\s*(.+)/`.

### 9. test-models Test Didn't Support Flat Config Format (Bug)
**Files:** `test-models.cjs`  
**Fix:** Added flat-format YAML parsing.

### 10. Unused Import: loadSettings (Cleanup)
**Files:** `mcp-server.ts`  
**Fix:** Removed the import.

### 11. Tool Schemas Not Filtered in TUI Agent Loops (Bug)
**Files:** `tui.ts`  
**Fix:** Added `.filter((t) => this.tools[t.name] !== false)` in both loops.

---

## Pass 2: Advanced Multi-Turn Testing (v0.89.8)

Ran complex multi-turn RE workflows (multi-stage analysis, error recovery, tool combinations, context stress test, session persistence, concurrent sessions, r2 integration) through the MCP server with a purpose-built binary containing XOR crypto, license validation, and obfuscated flag storage.

### 12. MAX_TOOL_OUTPUT Was 30% of Context Budget — Way Too High (Critical)
**Files:** `mcp-server.ts`, `tui.ts`, `pire-reimpl.ts`, `pire-pi-tui.ts`  
**Problem:** Per-tool-output cap was `contextLength * 4 * 0.75 * 0.3` = ~118K chars for GLM-5.2. A single `objdump -d` or `readelf -a` could dump 118K chars into context, consuming most of the budget. The stress test showed 157K chars in history with zero trimming triggered.  
**Fix:** Changed to 5% of context budget, capped at min 2000, max 20000 chars. Applied across all 4 files (mcp-server, tui, pire-reimpl, pire-pi-tui).

### 13. Context Trimming Triggered at 100% Instead of 60% (Critical)
**Files:** `mcp-server.ts`, `tui.ts`, `pire-pi-tui.ts`  
**Problem:** `trimContextMessages` only activated when total chars exceeded `CONTEXT_CHAR_LIMIT` (100% of budget). By then, the context was already full and the next LLM call would likely fail.  
**Fix:** Added `triggerLimit = Math.floor(CONTEXT_CHAR_LIMIT * 0.6)` — trimming now triggers at 60% of budget, proactively compressing old messages before the context fills. All 4 compression stages use `triggerLimit` instead of `CONTEXT_CHAR_LIMIT`.  
**Verification:** Stress test now shows 6 truncated messages; history dropped from 157K → 142K chars.

### 14. hash Tool Returns Raw Hashes Without Algorithm Labels (Bug)
**Files:** `index.ts`  
**Problem:** `hash` tool ran `md5sum`, `sha1sum`, `sha256sum` and returned their raw output (`hash  filename`). The output didn't include the algorithm name, making it ambiguous which hash was which.  
**Fix:** Added algorithm label prefix: `md5: hash  filename`, `sha1: ...`, `sha256: ...`.

### 15. pire-pi-tui.ts Had Hardcoded 120000 Context Limit (Bug)
**Files:** `pire-pi-tui.ts`  
**Problem:** `CONTEXT_CHAR_LIMIT` defaulted to `120000` — a hardcoded value that doesn't scale for models with different context windows.  
**Fix:** Added `getContextCharLimit()` function that reads from `loadLLMConfig().contextLength`, same as mcp-server and tui.

### 16. pire-pi-tui.ts Had 100K MAX_OUTPUT (Bug)
**Files:** `pire-pi-tui.ts`  
**Problem:** `MAX_OUTPUT` (used for tool result truncation) was `100000` chars — same excessive limit as the old `MAX_TOOL_OUTPUT`.  
**Fix:** Changed to `MAX_TOOL_OUTPUT` (5% of context budget, max 20K). Also removed unused `loadSettings` import from `tui.ts` and `pire-reimpl.ts`.

---

## Test Results

| Test Suite | Tests | Passed | Failed |
|---|---|---|---|
| test-suite.cjs | 393 | 393 | 0 |
| test-behavioral.cjs | 40 | 40 | 0 |
| test-bugfixes.cjs | 42 | 42 | 0 |
| test-mcp.cjs | 26 | 26 | 0 |
| Advanced integration (external) | 46 | 46 | 0 |
| **Total** | **547** | **547** | **0** |

---

## Files Modified

- `packages/re-agent/src/mcp-server.ts` — MAX_TOOL_OUTPUT cap, 60% trigger limit
- `packages/re-agent/src/tui.ts` — MAX_TOOL_OUTPUT cap, 60% trigger limit, removed loadSettings
- `packages/re-agent/src/pire-pi-tui.ts` — getContextCharLimit, MAX_OUTPUT cap, 60% trigger limit
- `packages/re-agent/src/pire-reimpl.ts` — getContextCharLimit, MAX_TOOL_OUTPUT cap, removed loadSettings
- `packages/re-agent/src/index.ts` — hash tool algorithm labels
- `packages/re-agent/test/test-suite.cjs` — version assertions updated

---

## Pass 3: Deep Tool + Agent Loop Testing (v0.89.9)

Built a test binary with license validation + XOR-encoded flag, ran 38 integration tests covering patch/diff, search (text+hex), read_file/write_file, shell, hash, entropy, YARA, capstone, nm, size, disasm_func, and multi-turn agent conversations.

### Issue #17: Agent loop duplicated user messages and dropped last tool result (CRITICAL)

**File:** `packages/re-agent/src/mcp-server.ts`

**Problem:** The agent loop used `session.messages.slice(0, -1)` to "exclude the just-added user message" then re-appended `{ role: "user", content: userMessage }` to the `messages` array. After turn 1, `session.messages` ends with tool results (not the user message), so `slice(0, -1)` dropped the last tool result from the previous turn. The user message was also duplicated in the array.

**Impact:** Model couldn't see the result of the last tool call from the previous turn. User message appeared twice. Wasted tokens on duplicate context.

**Fix:** Use `session.messages` directly (already contains the user message from the one-time push). No slicing, no re-appending.

### Issue #18: finalContent accumulated across all turns (MODERATE)

**File:** `packages/re-agent/src/mcp-server.ts`

**Problem:** `finalContent` was initialized once before the loop and accumulated via `+=` across all turns. The returned content included intermediate reasoning from tool-call turns ("Let me check...") concatenated with the final answer.

**Impact:** Returned content was noisy and unnecessarily long.

**Fix:** Reset `finalContent = ""` at the start of each turn. Only the last turn's content is returned.

### Issue #19: pire-pi-tui hardcoded 120000 context limit (TOKEN WASTE)

**File:** `packages/re-agent/src/pire-pi-tui.ts`

**Problem:** `CONTEXT_CHAR_LIMIT` fell back to hardcoded `120000` instead of reading from model config. With GLM-5.2's 131072 context, this was close but wrong for other models. Also had `MAX_OUTPUT = 100000` (100K chars per tool output).

**Fix:** Added `getContextCharLimit()` function (matching tui.ts and mcp-server.ts). Capped `MAX_OUTPUT` at 20K (5% of context budget).

### Files Modified (Pass 3)

- `packages/re-agent/src/mcp-server.ts` — agent loop fix (no duplicate user msg, no dropped tool result), finalContent reset per turn
- `packages/re-agent/src/pire-pi-tui.ts` — getContextCharLimit, MAX_OUTPUT cap, 60% trigger
- `packages/re-agent/test/test-pass3.cjs` — 30 unit tests for agent loop + context fixes
- `/tmp/pire-pass3-test.py` — 38 integration tests (not committed, external test script)
