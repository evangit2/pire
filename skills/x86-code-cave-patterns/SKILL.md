---
name: x86-code-cave-patterns
description: Safe detour and code-cave patterns for x86 binary modification — when to use MinHook, manual trampolines, and crash diagnosis.
---

# x86 Code Cave Patterns

> Adapted from the target-specific RE toolkit for general binary analysis.


# the target Detour Patterns

## Quick Decision Tree

| Target function prologue | Safe manual trampoline? | Recommended |
|--------------------------|------------------------|-------------|
| Plain PUSH EBP / MOV EBP,ESP | Yes | 5-byte JMP + executable cave with original prologue + JMP back |
| `PUSH 0xFF; MOV EAX,FS:[0]` (SEH) | **No** | Use MinHook / a real detour library, or pick a different hook site |
| Function called from many places with short prologue | Maybe | Consider a code cave that preserves all overwritten bytes |

## The SEH Prologue Pitfall

Some the target functions set up a Windows structured-exception handler in their prologue:

```asm
PUSH 0xFF               ; 2 bytes
MOV EAX, FS:[0x0]       ; 6 bytes
PUSH EAX                ; often follows
MOV DWORD PTR FS:[0x0], ESP
```

Copying these bytes into a static trampoline and jumping back breaks the exception-handler chain. The game does not crash immediately; instead it crashes later during rendering or physics with an **EIP that lands mid-instruction**.

### Recognizing the crash signature

A crash report like:

```text
CRASH_ADDRESS: 0001:0005EB03
CURRENTOBJECT: Board (Warm-Up)
CURRENTOPERATION: Draw
```

converts to VA `0x45FB03` (`.text` base `0x401000` + offset `0x5EB03`).

If the instruction at that address is **not an instruction boundary** — i.e. capstone shows the byte as part of a previous multi-byte instruction — the real fault is **EIP corruption**, not the access violation that happened at that byte. Common root causes:

1. A vtable or function detour returned to a patched address instead of a trampoline.
2. A manual trampoline copied an SEH prologue and corrupted `FS:[0]`.
3. A calling-convention mismatch (`__fastcall` vs `__thiscall`) wrote the wrong `RET N`.
4. A stack buffer overflow in the hook overwrote a return address.

Always disassemble the bytes at the crash address first. If it is mid-instruction, look for a hook installed between the previous frame and the crash.

## Case Study: DispatchCollisionEvents (0x40C5D0)

`DispatchCollisionEvents` in `target_binary.exe` begins with the SEH prologue above. A manual trampoline that copies 8 bytes of original code and appends a `JMP` back will appear to work until the first exception is raised or until a later `Draw` call walks the exception chain, at which point the game crashes inside unrelated render code.

**Wrong pattern (v53g-2 and v55m_29):**

```c
memcpy(g_trampoline, g_dispatch_orig_bytes, 8);   // copies SEH bytes
...
VirtualProtect(g_trampoline, 13, PAGE_EXECUTE_READWRITE, &old);
```

**Crash signature:**

```text
CRASH_ADDRESS: 0001:0005EB03
CURRENTOBJECT: Board (Warm-Up)
CURRENTOPERATION: Draw
```

`0001:0005EB03` = `0x45FB03`, mid-instruction inside `VertexDecl_WriteBlendEffects`. The EIP was corrupted by the broken SEH chain, not by the draw function itself.

The correct choices are:

1. **Do not hook `DispatchCollisionEvents` at all.** Hook one of the non-SEH call sites (e.g. the `CALL [EAX+0x74]` at `0x40728F` or `0x408B85`) and apply the desired effect in a pure code cave.
2. **Use MinHook** (or another library that handles SEH-safe trampolines) if you must hook the function entry.
3. **Post-SEH hook (cleanest when you need full collision dispatch).** Hook at `0x40C5E5`, 21 bytes into the function, past the entire SEH prologue. The 5 bytes at this address are always `83 EC 30 53 55` (`sub esp,0x30; push ebx; push ebp`). Build a hardcoded trampoline replicating those 5 bytes and jump to `0x40C5EA`. This gives you the full `DispatchCollisionEvents` context (ball, collEntry, board as ECX) with no SEH corruption. Trade-off: the hook is 21B inside the function, missing any early-return paths — in practice `DispatchCollisionEvents` always reaches 0x40C5E5 before doing work.

Hooking the vtable dispatch sites is particularly useful because they are called for every per-level collision handler. The sites at `0x40728F` and `0x408B85` execute `PUSH EDX; PUSH ESI; CALL [EAX+0x74]` in exactly 5 bytes, so a plain 5-byte JMP with no NOP padding is sufficient. See `references/v55m30-seh-detour-crash.md` for the full register layout and cave design.

## Manual Trampoline Rules (for non-SEH targets)

When a manual trampoline is safe, build it like this:

1. Read at least 5 bytes of the original prologue (enough to cover complete instructions).
2. Allocate an executable buffer (e.g. `VirtualAlloc` with `PAGE_EXECUTE_READWRITE`).
3. Copy the original instructions verbatim into the buffer.
4. Append a 5-byte relative `JMP` back to `original + N`, where `N` is the number of copied bytes.
5. Patch the original address with a 5-byte relative `JMP` to your hook.
6. Only pad with `NOP` instructions if the copied instructions are longer than 5 bytes.

### NOP-after-JMP pitfall

If the original instruction is exactly 5 bytes, do not add a `NOP` after your `JMP`. The extra `NOP` overwrites the first byte of the next instruction. When control returns from the trampoline, EIP lands in the middle of that instruction and crashes. See `references/v55m30-seh-detour-crash.md`.

## Vtable Slot Replacement: Update vs Draw Phase

When you replace a vtable slot that is called during **both the Update phase and the Draw phase**, the original function may be a **D3D render function** that corrupts data structures if called during Update.

### Symptoms

- Crash at `0001:00078EDD` (RVA 0x78EDD = VA 0x00478EDD = `MeshArchive_ctor` offset 0x6D, REP MOVSD with corrupted size from bad EBP)
- OR crash at `0002:00009E75` (inside the target.dll proxy, at an odd/mid-instruction address = stack corruption)
- Both happen during `CURRENTOPERATION: Update`, runtime ~6-8s after level load
- `EXTENDED_INFO: FinishLoad(OK)` — the level loaded fine, then the first Update cycle corrupted something

### Root cause

The original Stands vtable[18] slot contains `0x0045E0E0 = D3DXSkinMesh_CopyStripData`. This function reads mesh vertex data and copies it to D3D vertex buffers. It is **only safe during the Draw phase** when the D3D device is in a render state. Called during Update, it reads corrupted mesh data or writes to uninitialized D3D buffers → heap corruption → crash in the next mesh allocation (`MeshArchive_ctor`).

### Fix

During the Update phase, **do not call the original vtable function at all**. Just return:

```c
static void __thiscall cEnt_catapult_render(DWORD this_, char param_1, int param_2) {
    /* Skip during Update phase — original is a D3D render function (0x0045E0E0)
     * that corrupts mesh data if called during Update. */
    if (!g_in_draw_phase) {
        return;
    }

    /* During Draw phase: apply D3D transforms, then call original */
    // ... D3D GetTransform/SetTransform for rotation ...
    // ... call orig_vtable18(this_, param_1, param_2) ...
    // ... restore transform ...
}
```

### Why `g_in_draw_phase` guard with `orig_vtable18` doesn't work

The `g_in_draw_phase` guard introduced in earlier versions tried to call `cs->orig_vtable18` during Update instead of hardcoded `0x0045E0E0`. This is a **no-op** — `orig_vtable18` IS `0x0045E0E0` (the same function). The original Stands vtable[18] IS `D3DXSkinMesh_CopyStripData`. There is no separate "safe Update function" to call.

### Which vtable slots are phase-sensitive

| Slot | Object | Original Function | Called During | Safe? |
|------|--------|-------------------|---------------|-------|
| 18 | Stands | D3DXSkinMesh_CopyStripData (0x0045E0E0) | Update + Draw | **Draw only** |
| 1 | Stands | Ball_Update-styled physics | Update only | Safe |
| 2 | Various | SetPosition/BuildStrips | Draw only | Safe |

**How to check:** Search the binary for `CALL [reg+0x48]` (vtable slot 18) and check the call sites. If some are inside `Scene_Update` and some inside `Scene_Render`, the slot is called during both phases.

### Detection at a glance

- `0001:00078EDD` crash + `CURRENTOPERATION: Update` = vtable[18] original called during Update
- `0002:mid_instruction` crash + `CURRENTOPERATION: Update` = **stack corruption from the vtable hook installation itself** (not the routed function). The vtable copy over-reads into garbage bytes beyond the actual vtable size.
- The crash manifests as a `REP MOVSD` with corrupted size inside `MeshArchive_ctor` because the preceding D3D call corrupted the mesh's internal data structures

### General rule

When replacing a vtable slot:
1. Decompile the *original* function at that slot
2. Check if it makes D3D device calls (SetTransform, SetRenderState, CopyStripData, etc.)
3. Find ALL call sites for that slot in the binary
4. If any call site is inside an Update loop, you must either:
   - Skip the original call during Update (return early), or
   - Provide a different function during Update that doesn't do D3D work

## Code-Cave Style (pure assembly)

For simple intercepts, a code cave is often safer than a trampoline:

```asm
PUSHAD
PUSHFD
; ... minimal logic, save registers and ECX if __thiscall ...
CALL [g_helper_ptr]
POPFD
POPAD
; original overwritten instruction(s)
JMP back
```

Keep cave logic minimal. Do not call complex game functions from inside a hook that may be re-entered.

## References

- `references/v55m30-seh-detour-crash.md` — full v55m_29 `E:CATAPULTBOTTOM` crash diagnosis, bytes at `0x45FB03`, and why the `DispatchCollisionEvents` trampoline failed.
- `references/v55m30-ballupdate-vtable29-cave.md` — safe cross-level collision hook inside `Ball_Update`, exact cave bytes and register layout for hooking the per-level vtable[29] call sites.
- `references/cea-code-cave-pitfalls-bridge-session.md` — CEA-specific crash patterns from the global bridge spawner/loader session: FPU stack overflow, `alloc()` sizing, hook conflicts, and PopCylinder spawn list insertion.
- `references/vtable-slot18-update-crash.md` — Stands vtable[18] called during Update phase: D3DXSkinMesh_CopyStripData (0x0045E0E0) corrupts MeshArchive data, crash at 0x00478EDD, and why the `g_in_draw_phase` guard with `orig_vtable18` is a no-op.
- `references/v55m43-vtable-hook-stack-corruption.md` — Stands vtable[18] hook **installation** causes stack corruption (`0002:00009E75` in module 0002/target.dll) on real Windows hardware even when the Update guard works. Root cause: vtable copy over-read (0x50 bytes on a 0x44-byte vtable) introduces garbage slot entries. Fix: remove the vtable hook entirely.

