---
name: multi-phase-patch-architecture
description: Organize binary patches into init, runtime, and cleanup phases to prevent conflicts between multiple mods.
tags: [reverse-engineering, code-cave, patching, architecture, modding, hooks]
---

# Multi-Phase Patch Architecture

> Adapted from the target-specific RE toolkit for general binary analysis.

Organize binary patches (code caves, detours, data table overrides) into discrete phases: initialization, runtime, and cleanup. This prevents conflicts between multiple mods and ensures proper state management across the application lifecycle.

## When to use this skill

- A mod installs 2+ hooks of different types.
- Multiple mods may coexist in a single proxy DLL.
- You need to cleanly uninstall hooks on DLL detach.
- Runtime state machines need per-frame updates separate from one-time initialization.

## Phase Organization

### Phase 1: Init (one-time at startup)
- Resolve base addresses and module handles.
- Read config files.
- Allocate executable memory for stubs/caves.
- Install hooks (patch bytes, write JMPs, override vtable slots).
- Set up background threads (if any).

**Critical ordering**:
- `load_real_library()` MUST run before `CreateThread(init_thread)`.
- Initialize synchronization primitives (critical sections, mutexes) before any thread access.

### Phase 2: Runtime (per-frame or event-driven)
- Frame epilogue hook dispatches to all active subsystems.
- Collision/trigger hooks process events and set deferred flags.
- Background polling threads read game state and write to safe memory.
- Config re-read threads check for live file updates.

**Shared frame epilogue architecture**:
Only ONE hook can occupy a given frame epilogue address. All per-frame subsystems must dispatch from a single shared handler:

```
frame_epilogue_handler()
  ├── 1. Update game clock (pause-aware)
  ├── 2. Subsystem A: pending loads, playback advance, cleanup
  ├── 3. Subsystem B: per-frame state machine
  ├── 4. Subsystem C: collision event checks
  └── 5. Subsystem D: scan for trigger nodes
```

The stub is standard: `pushad`/`pushfd` → call handler → `popfd`/`popad` → original bytes → `ret`. All registers preserved.

**Critical rule**: Only ONE hook can occupy the frame epilogue at a given address. All per-frame subsystems must dispatch from a single shared handler.

### Phase 3: Cleanup (on DLL detach or exit)
- Restore all patched bytes to original values.
- Free allocated memory (stubs, caves, buffers).
- Destroy created threads.
- Close handles, free library references.
- Delete critical sections.

**Required restores**:
- JMP detour hooks → restore original bytes.
- Code-cave hooks → restore original bytes at patch address.
- Frame hooks → restore patched epilogue bytes.

Missing restores leave JMPs pointing at freed stubs when the DLL unloads → crash.

## Multi-Mod Conflict Prevention

When merging mods that use different hook mechanisms into one DLL:

### Hook coexistence table

| Hook Type | Address | Mechanism | Can coexist? |
|-----------|---------|-----------|--------------|
| Frame epilogue | `0xDEADBEEF` | 5-byte JMP to stub | Only ONE — must be shared |
| Function detour | `sub_XXXXXX` | 7-byte detour + trampoline | Yes, separate functions |
| DCE hook | `sub_YYYYYY` | 8-byte JMP to stub | Yes, separate functions |
| Timer code caves | `0xAAAAAA`, `0xBBBBBB` | JMP to VirtualAlloc'd cave | Yes, separate addresses |
| Byte patches | various | 1-byte patches | Yes, separate addresses |
| NOP patches | various | Multi-byte NOPs | Yes, separate addresses |

### Shared state protection

When a proxy DLL has both detour hooks (main thread) and background monitor threads sharing state, a `CRITICAL_SECTION` must protect all shared variables.

**Pattern**:
- `InitializeCriticalSection(&g_cs)` in init before thread launch.
- `EnterCriticalSection` / `LeaveCriticalSection` in both the hook function and the monitor thread.
- Release the lock during long game calls (trampoline to original) — hold it only for shared-state reads/writes.

### InitThread installation sequence

All hooks installed from a background thread with a short initial delay (to let the target fully initialize):

```
1. patch_level_update_and_render()  — NOP checks as needed
2. install_collision_hook()         — intercept dispatch
3. install_detour_hook()            — function replacement
4. install_timer_caves()            — per-level timing adjustments
5. install_frame_hook()             — shared frame epilogue
6. CreateThread(monitor_thread)     — background state monitor
```

## Code Cave Safety

1. **NEVER CALL C from hand-assembled caves INSIDE a function.** Exception: function-ENTRY hooks CAN safely CALL C.
2. **PUSH patching**: check opcode at addr-1. `0x68` = `push imm32` (5-byte, safe). `0x6A` = `push imm8` (2-byte, CANNOT patch — use cave).
3. **Always guard struct dereferences** in caves with NULL check + range check.
4. **Multi-path caves** need split targets to avoid double-POP stack corruption.
5. **FPU state**: `PUSHFD` does NOT save x87 FPU registers. Caves calling C float math must save/restore FPU state via `FNSAVE`/`FRSTOR` (or compile with `-msse2 -mfpmath=sse` to use SSE instead).
6. **Stack imbalance**: ANY cave that PUSHES data MUST pop it (or `ADD ESP`) on **ALL exit paths**.
7. **Instruction patch timing**: If a target instruction executes during early initialization, a background thread that sleeps before patching is too late. Use runtime API calls instead of patching for values that can be set after initialization.
8. **Entry vs epilogue hook timing**: Hook the **epilogue** for scene-graph-modifying actions (level loading, object construction). Hooking the entry modifies state mid-frame → crash. Use entry hooks only for read-only actions.
9. **Success flags on failure**: Only set "done" flags when the operation actually succeeded — otherwise the mod never retries on failure.
10. **JZ-to-JMP displacement adjustment**: Converting a 6-byte `JZ rel32` to a 5-byte `JMP rel32` requires displacement +1. Using the same displacement lands one byte short.

## Background Thread Rules

1. **NEVER call game-state-modifying functions** from a background polling thread. The main thread may be mid-draw → use-after-free crash. Instead, set flags consumed by a main-thread hook.
2. **Thread synchronization**: Use critical sections for all shared state between hooks and monitor threads.
3. **Sleep timing**: Keep delays short enough that patches apply before any critical initialization. If longer delays are needed, use state checks instead of fixed sleeps.

## Verification Checklist for Multi-Hook Mods

After writing the merged source, verify:
1. Compile: zero warnings/errors.
2. Exports: all required target library exports present.
3. No TODOs/FIXMEs/PLACEHOLDERs in source.
4. Pointer safety: use `(char*)ptr + offset` for ALL pointer arithmetic.
5. Memory guards: `IsBadReadPtr` / `IsBadWritePtr` checks present.
6. Critical section: Init/Enter/Leave all present.
7. DllMain order: `load_real_library` before `CreateThread`.

## See Also

- `dll-proxy-injection` — DLL proxy pattern basics
- `dll-mod-authoring` — full C source → proxy DLL workflow
- `headless-mod-testing` — automated crash testing for multi-hook mods
- `loader-crash-analysis` — debugging crashes from hook conflicts
