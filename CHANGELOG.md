# pire v0.88.1 — Bug Fixes from E2E Analysis

Released: 2026-08-04

## Fixed

- **R2 null byte in output** — r2's `-q0` flag emits a leading null byte on startup that was leaking into `afl` and other command outputs. Now stripped in `R2Session.run()`.

- **`decompile` returns null byte for non-function addresses** — r2's `pdc` outputs `\0` when there's nothing to decompile at an address (data section, padding, invalid). Now detected and replaced with a helpful error message: `No decompilable function found at <address>...`

- **`decompile` accepts symbol names** — Previously only accepted hex addresses. Now resolves symbol names (e.g. `main`, `entry0`) via r2's `?v` command before seeking. Returns `Symbol "X" not found...` for invalid symbols instead of silently decompiling nothing.

- **`disasm_func` crashes on symbol names** — `parseInt("main", 16)` → `NaN`, producing `--start-address=0xmain --stop-address=0xNaN`. Now resolves symbolic addresses via r2 first, falls back to a clear error.

- **`tool.execute` not recorded in session history** — Tool executions via the MCP server were invisible in `session.history`. Now records each call (with `sessionId` param) as tool+assistant messages.

- **R2 `ensureProcess` race condition** — Was attaching a synchronous `data` listener during process creation that conflicted with `run()`'s per-command listener. Removed; `run()` now handles all I/O with marker-based framing.

## Verified

Full E2E test against `/usr/bin/rsync` (534KB, stripped ELF x86-64):
- 26 MCP calls, 0 annoyances
- R2 analysis caching works (aaa 4.8s → cached afl 0.003s)
- Symbol resolution works for both `decompile` and `disasm_func`
- Session history records 14 messages from 7 tool calls
- Validation catches missing params with clear errors
