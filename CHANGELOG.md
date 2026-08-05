# pire v0.88.6 — Fix transient screen doubling during streaming

Released: 2026-08-04

## Fixed

- **Transient screen doubling** (sidebar, banner, status bar appearing twice during rapid streaming). Root cause: when the TUI framework's screen buffer length didn't match the terminal height, the differential renderer left stale rows from the previous frame. Fixed by:
  - Padding/clipping the screen array to exactly `height` lines before differential rendering
  - Clearing stale rows from previous taller screens that fall outside the current viewport

---

# pire v0.88.5 — Ctrl+C raw mode fix, status bar layout

Released: 2026-08-04

## Fixed

- **Ctrl+C now actually works.** Root cause: TUI runs in raw mode where Ctrl+C arrives as byte `0x03` in stdin, not as SIGINT. The `Input` component silently dropped control chars, and `process.on("SIGINT")` never fired. Now an `addInputListener` intercepts `0x03` before it reaches Input: first press aborts the LLM request via AbortController, second press within 5s exits, if not processing then first press exits immediately.
- **Status bar doubling (transient).** Removed unnecessary `Box(0,0)` wrapper around StatusBar that could cause layout measurement to allocate extra rows during rapid streaming updates. StatusBar is now a direct child of the VStack with `basis: 1, maxSize: 1`.
- **SIGTERM handler simplified.** No longer pretends to handle SIGINT (which never fires in raw mode).

---

# pire v0.88.4 — Ctrl+C abort, macOS installer fixes, TUI build fix

Released: 2026-08-04

## Fixed

- **Ctrl+C now aborts the agent immediately.** Previously required double Ctrl+C with a 15s window; first press was invisible because the agent kept rendering. Now: first Ctrl+C aborts the current LLM HTTP request via AbortController, second Ctrl+C within 5s exits pire.
- **Status bar doubling.** Box(1,0) padding around the status bar rendered an extra blank line. Fixed to Box(0,0).
- **macOS installer hang during `brew install`.** Three root causes fixed:
  - 180s timeout too short for `brew install node` (compiles from source) → bumped to 600s
  - `coreutils` (provides `gtimeout`) installed after core packages that needed it → installed first
  - `HOMEBREW_NO_AUTO_UPDATE` not set globally → exported at script top
- **TUI build failure on macOS.** `tsconfig.build.json` targeted ES2022 but TUI uses `/v` regex flag requiring ES2024. Overrode in TUI's tsconfig.
- **Brew lock contention.** `pkg_install` serialized all package managers with a lock, but macOS lacks `flock` so the `mkdir` fallback caused 5-min hangs when parallel brew installs collided. Lock is now skipped for brew.
- **Wrapper script quoting bug.** `sudo sh -c "...\"` produced literal `\"` in the generated `/usr/local/bin/pire` wrapper. Replaced with `printf` + `sudo install`.
- **Unknown subcommands silently launched TUI.** `pire uninstall` would open the TUI instead of erroring. Added explicit unknown-command guard.
- **Update failures from monorepo-wide `tsc --noEmit`.** `npm install` and TUI build errors are now non-fatal; only `git pull` failures trigger rollback.

## Added

- **`--debug` flag for installer.** `curl -fsSL .../install.sh | sh -s -- --debug` shows full command output, no suppression, inline parallel install logs with component prefix.

---

# pire v0.88.3 — Multi-Toolchain E2E Verification

Released: 2026-08-04

## Verified

E2E analysis across 9 binaries spanning 5 toolchains (C/C++, Go, Rust, static, large C):

| Binary | Size | Toolchain | Functions | Good | Partial | Annoyances |
|--------|------|-----------|-----------|------|---------|------------|
| gawk | 740KB | C | 705 | 2 | 8 | 0 |
| ssh | 847KB | C | 907 | 5 | 5 | 0 |
| nginx | 1.3MB | C | 1193 | 7 | 3 | 0 |
| bash | 1.4MB | C | 2292 | 9 | 0 | 0 |
| docker-proxy | 2.3MB | Go | 1842 | 10 | 0 | 0 |
| rg | 5.3MB | Rust | 4755 | 7 | 3 | 0 |
| busybox | 2.1MB | static C | 2905 | 9 | 1 | 0 |
| git | 4.1MB | C | 3274 | 8 | 2 | 0 |
| python3.12 | 8MB | C | 4111 | 5 | 5 | 0 |

**Total: 0 annoyances, 0 crashes, 0 empty decompilations across all 9 binaries.**

All "partial" ratings are r2 `pdc` limitations (loc_ labels, no function signatures, very long functions) — not pire bugs.

## Fixed

- **Harness quality scoring false positive** — Rust decompilation output containing the substring "not found" in pseudo-C body was misclassified as an error. Changed to check if output *starts with* error messages rather than contains them.

---

# pire v0.88.2 — Large Binary Analysis Improvements

Released: 2026-08-04

## Fixed

- **Output truncation too aggressive** — `textResult()` was capping at 50KB, cutting off large decompilations and objdump output mid-function. Raised to 200KB with a visible `[... output truncated ...]` marker showing original length.

- **`objdump` ENOBUFS on large binaries** — `execSync` maxBuffer was 10MB, not enough for 1MB+ binaries' full disassembly. Raised to 100MB for objdump, 50MB default.

- **R2 `aaa` timeout on complex binaries** — SSH (847KB) and other binaries could hang indefinitely during `aaa` analysis. Now: 5-minute timeout for analysis commands, automatic fallback from `aaa` to `aa` (lighter analysis) on timeout, with a note in output.

## Added

- **`decompile` format parameter** — New optional `format` param: `"pdc"` (pseudo-C, default) or `"pdf"` (annotated disassembly with type info and variable names). When `pdc` returns empty, automatically falls back to `pdf`.

- **`endbr` cleanup in decompile output** — CET instructions (`endbr64`, `endbr`) are stripped from pseudo-C output. Removes noise that was causing quality degradation on nginx (0 good → 7 good out of 10 functions).

## Verified

E2E analysis across 4 binaries of increasing complexity:

| Binary | Size | Functions | Quality (good/partial) | Annoyances |
|--------|------|-----------|------------------------|------------|
| gawk | 740KB | 705 | 2/8 | 0 |
| ssh | 847KB | 907 | 5/5 | 0 |
| nginx | 1.3MB | 1193 | 7/3 | 0 |
| bash | 1.4MB | 2292 | 9/0 | 0 |

All rounds: 0 annoyances, 0 crashes, 0 empty decompilations.

---

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
