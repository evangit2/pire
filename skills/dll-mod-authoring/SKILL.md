---
name: dll-mod-authoring
description: Full workflow for creating DLL proxy mods for binary targets — from C source to compiled proxy DLL to installation and testing.
tags: [reverse-engineering, dll-proxy, c, mingw, modding, build, testing]
---

# DLL Mod Authoring

> Adapted from the target-specific RE toolkit for general binary analysis.

Full end-to-end workflow for creating DLL proxy mods for any binary target that loads a known DLL at startup. Includes C source patterns, MinGW cross-compilation, addressing pitfalls, crash testing, and packaging.

## Prerequisites

- Cross-compiler: `i686-w64-mingw32-gcc` (for 32-bit PE32 targets) or `x86_64-w64-mingw32-gcc` (for 64-bit PE32+ targets).
- Disassembler/decompiler (Ghidra, IDA, Binary Ninja) with MCP or local access.
- Target binary path known.
- Valid Wine or Windows test environment for crash testing.

## Quick Start

**Option A — Shared header (preferred):**
1. Create a shared header with all target-library exports + utility functions (`patch_byte`, `install_jmp_hook`, `get_module_base`, etc.). Include via `#include "proxy_shared.h"` with `-I../shared`.
2. Build: `i686-w64-mingw32-gcc -shared -o target.dll <modname>.c -I../shared -lwinmm -Wl,--enable-stdcall-fixup -O2 -static -static-libgcc -Wl,--add-stdcall-alias -msse2 -mfpmath=sse`
3. Crash-test via headless test server (35s timeout).
4. Copy source + DLL to mod directory, update catalog.
5. Git add + commit + push.

**Option B — Inline template (for standalone mods):**
1. Create a standalone C file with inline export stubs.
2. Build without shared header dependency.
3. Same test/package workflow.

## Target-Library Proxy Pattern

The target binary imports functions from a known DLL (e.g. audio library, dinput, renderer helper). Your proxy DLL must export all imported functions (plus extras for safety) and forward calls to the real library (renamed to `<original>_real.dll`).

**Critical**: Init stubs must return success values when the real library is missing. Returning failure from init/loader functions can cascade into downstream crashes.

## Code Patching Approaches

### 1. Byte Patching — `PUSH imm32`
Simplest: overwrite the 4-byte immediate operand at `PUSH_addr + 1` via `VirtualProtect`. Only works when the instruction is `68 XX XX XX XX` (5-byte push imm32).

**Pitfall**: `PUSH imm8` (`6A 00`, 2 bytes) cannot hold a 4-byte value — use a code cave instead.

### 2. Code Caves — Standard PUSH imm32 in cave
Replace a sequence with JMP to an allocated executable page. Cave contains `PUSH imm32` for each value. Re-patch via VirtualProtect when config changes.

### 3. Runtime-Updatable Code Caves — PUSH [global] (FF 35)
Best for config-driven mods. Cave uses `PUSH dword ptr [global_float]` (6 bytes, `FF 35 <addr32>`) instead of `PUSH imm32` (5 bytes). Global variables live in `.data` (writable) — config thread updates them without VirtualProtect. Cave code never changes after install.

### 4. Function-Entry Detour + Struct Writes
Intercept a function, call original via trampoline, then overwrite struct fields it set up. Best when multiple subsystems need overriding or when code caves are impractical.

### 5. PUSH imm32 String Redirect
Redirect a string pointer push to point at your own string. Only a 4-byte data write per string — no code caves.

### 6. Multi-Hook Effect Mods (Overlay + State Machine)
For mods that need visual effects across multiple frames, use a 3-hook pattern:
1. Collision/trigger hook to initiate the effect.
2. Frame-update epilogue hook for per-frame state machine logic.
3. Graphics Present hook for screen overlay.

### 7. Non-Invasive Polling Thread (No Hooks, No Patches)
Safest approach for visual/transform mods. A background thread polls game memory via known struct offsets and writes directly to transform/position fields. Zero crash risk, but ~16ms latency. Cannot intercept function calls.

### 8. Raw Byte Stubs for Hooks
When the compiler rejects naked functions or inline asm, build executable byte stubs manually:
- Allocate executable memory.
- Write x86 opcodes as raw bytes.
- Install JMP to the stub.

The stub saves state, calls a C handler, restores state, executes original bytes, and returns. Advantages: assembler-independent, exact control over saved/restored state, works for any hook pattern.

**ESP offset calculation**: After `pushad` (32 bytes) + `pushfd` (4 bytes) = 36 bytes. Each additional push adds 4. Return address sits at ESP+total_pushed, first stack param at ESP+total_pushed+4.

**Sequential `push [esp+0xNN]` offset shift**: Each push decrements ESP by 4. When pushing multiple stack params, the second push's offset must be +4 higher than the first's to compensate. Using the original offset pushes the first param twice.

### 9. Data Table Pointer Override
Simplest and safest for swapping behavior. The binary stores function pointers in `.data` tables. Overwrite the DWORD pointer directly at DllMain time. Zero crash risk, no timing concerns, config-driven.

**Limitation**: Can only swap between existing binary functions. The swapped function must be compatible with the target's data.

### 10. Pre-Factory Entity Name Overwrite
Hook the master dispatch that calls all entity factories. Before calling the original via trampoline, iterate the entity list and overwrite name pointers. This replaces/removes entities without hooking each factory individually.

**Pitfalls**:
- Calling convention of the hook must match the target.
- Use stable buffers for name pointers (static arrays, not stack locals).
- Track modified state to avoid re-modifying the same data.

## MinGW Compilation Pitfalls

- `__attribute__((naked))` with Intel asm **fails** on MinGW (AT&T assembler). Use AT&T syntax inline asm, or raw byte stubs.
- `fopen()` → C4996 error. Use `fopen_s` or Win32 `CreateFileA`.
- `__try/__except` → MSVC-only. Use `IsBadReadPtr(addr, len)` before `memcpy`.
- Compile with 32-bit `i686-w64-mingw32-gcc` for PE32 targets.
- Always use `-Wl,--enable-stdcall-fixup -Wl,--add-stdcall-alias`.
- `.def` export definition file **must** be a positional argument, NOT `-Wl,--def=...`.
- **NEVER use `wsprintfA` with `%f`** — it silently skips float args. Use `snprintf`.
- `byte` type not declared. Use `unsigned char`.
- If the binary will later free an object via its destructor, use the binary's `operator_new` (not `malloc`) to avoid heap corruption.
- Lambda as `LPTHREAD_START_ROUTINE` fails. Use a named `DWORD WINAPI func(LPVOID)`.
- `__asm { }` blocks not supported. Use `__thiscall` typedef function pointers or `__asm__ volatile()`.
- Inline asm clobber list MUST include `"eax", "ecx", "edx", "memory"` for `__thiscall` calls.
- **Hook calling convention**: Verify via decompiler before writing hooks. `__fastcall` vs `__thiscall` mismatches cause silent failures or crashes.
- **Calling `__thiscall` with stack params**: Use inline asm (`push param; mov ecx, this; call func`) because `__fastcall` typedefs put the second arg in EDX instead of the stack.
- Integer overflow in `IsBadReadPtr` size argument: add a sanity upper bound on count before multiplying.
- `-o /dev/null` fails with MinGW linker. Use a temp file for warning-check compiles.
- `strrchr` double-call bug: after truncating a path, call `strrchr` again on the modified buffer and it finds the trailing separator of the subdirectory, not the original directory.

## Logging

Do NOT add logs inside proxy-forwarding functions. Log only mod-specific events (hooks, state changes, etc.).

**File-based diagnostic logging** (write to `.txt` next to proxy DLL):
```c
static char g_logPath[MAX_PATH];
static void diag_log(const char *msg) {
    HANDLE hFile = CreateFileA(g_logPath, FILE_APPEND_DATA,
        FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS,
        FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile != INVALID_HANDLE_VALUE) {
        DWORD written; SetFilePointer(hFile, 0, NULL, FILE_END);
        WriteFile(hFile, msg, strlen(msg), &written, NULL);
        WriteFile(hFile, "\r\n", 2, &written, NULL);
        CloseHandle(hFile);
    }
}
```

`wvsprintfA` does NOT support `%f` — use `snprintf` for float formatting.

## Config File Pattern

Read a `.txt` file from the DLL's directory for user-customizable mods.

**Pitfall**: If markers start with `#`, check for markers BEFORE comment-skip logic, or the marker is never matched.

**Pitfall**: `strstr` matching documentation text before the actual marker — require the marker to start at line beginning (`line[0] == '#'`).

**Verify config-driven swaps at runtime**: dump table state BEFORE and AFTER applying config changes to the log, with expected vs actual values.

## Crash Testing

All new/updated DLL mods must be crash-tested before delivery:
1. Launch target binary with modded DLL via headless test server (35s timeout).
2. Check verdict: OK and no crash.
3. Rebuild the zip after any source change.
4. Verify embedded version string with `strings proxy.dll | grep "Mod Version"`.

**Mod Delivery Checklist**:
- [ ] Source `.c` file in mod directory
- [ ] Compiled proxy DLL (recompiled after every source change)
- [ ] Renamed original library included in ZIP
- [ ] Config `.txt` (if applicable)
- [ ] `README.md`
- [ ] Crash-tested
- [ ] Git commit + push immediately after compile

## See Also

- `dll-proxy-injection` — DLL proxy pattern specifics
- `headless-mod-testing` — automated crash testing server
- `multi-phase-patch-architecture` — organizing multiple hooks into phases
