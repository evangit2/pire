# pire v0.88.0 — MCP Server + Agent Loop Improvements

Released: 2026-08-04

## New Features

### `pire -mcp` — Programmatic MCP Server
New JSON-RPC 2.0 server enabling programmatic session control for agents and external tools.

**Transports:**
- `pire -mcp --stdio` — stdio (default, for agent/LLM integration)
- `pire -mcp --port 9191` — TCP
- `pire -mcp --http --port 9191` — HTTP

**Methods:**
- `initialize` — server info + full tool list (36 tools)
- `session.create` / `session.list` / `session.destroy` / `session.load`
- `session.prompt` — full agent loop with streaming callbacks (onContent, onToolCall, onToolResult, onTurn)
- `session.history` / `session.save`
- `tool.execute` — run a single tool with validation
- `tool.list` — list all RE tools
- `tools/list` + `tools/call` — MCP-compatible aliases

New file: `packages/re-agent/src/mcp-server.ts`

### Agent Loop Improvements

- **Tool parameter validation** — `validateToolParams()` checks required params before execution. Catches `shell()` with no args, `filetype()` with no path, etc. Returns clear `Missing required parameter "X" for tool "Y"` messages instead of wasting a turn.

- **Duplicate tool call deduplication** — Identical `(tool, params)` pairs within a single turn are detected and skipped. Stops the model from re-running `filetype` on the same file multiple times.

- **R2 analysis caching** — `aaa` (radare2 analysis) now runs once per file instead of on every `decompile` call. `R2Session` tracks analyzed files via `isAnalyzed()` Set. Major latency reduction on multi-function decompilation.

- **Turn counter** — CLI mode now displays `turn N/MAX` progress indicator.

- **Shell command display** — Full shell command arguments shown in transcript (not truncated). Generic tool output still truncated at 16000 chars.

## Tests

- 394 existing source-level tests pass (updated for `-mcp` flag)
- 72 new MCP + agent loop tests pass (including full E2E stdio JSON-RPC)
- TypeScript compiles clean (`tsc --noEmit --skipLibCheck`)
- E2E verified: `pire -mcp --stdio` handles initialize → session.create → tool.execute → validation errors → session.list

New test file: `packages/re-agent/test/test-mcp.cjs`

## Files Changed

- `packages/re-agent/src/mcp-server.ts` — **NEW** — MCP JSON-RPC server (512 lines)
- `packages/re-agent/src/index.ts` — Added `validateToolParams`, `isAnalyzed`, `analyzedFiles` tracking
- `packages/re-agent/src/tui.ts` — Agent loop: validation, deduplication, turn counter, shell display
- `packages/re-agent/src/cli.ts` — Wired `-mcp` / `--mcp` flag, imports `startMCPServer`
- `packages/re-agent/src/pire-pi-tui.ts` — Version bump
- `packages/re-agent/test/test-mcp.cjs` — **NEW** — 72 MCP + validation tests
- `packages/re-agent/test/test-suite.cjs` — Updated for `-mcp` flag, added agent loop improvement tests
- `package.json` — Version 0.88.0
- `packages/re-agent/package.json` — Version 0.88.0
