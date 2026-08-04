---
name: safe-function-detouring
description: Prevent crashes when hooking functions by detouring update routines and forcing safe return states.
---

# Safe Function Detouring

> Adapted from the target-specific RE toolkit for general binary analysis.


# Entity Safety Detours

Prevent crashes when game entities are spawned without required data (paths,
meshes, collision objects). Detour the entity's update function, check for
the dangerous condition before the original code runs, and force a safe state.

## When to Use

- An entity crashes when spawned without a required path/mesh/data pointer
- You can't guarantee the data exists at spawn time (e.g., custom level files)
- The entity has a "safe state" that skips the crashing code path

## Pattern

1. **Identify the crash**: Find the crash address, decompile the function,
   identify the null pointer dereference or invalid data access
2. **Find the safe state**: Look for a state/mode that skips the dangerous
   code path (e.g., "sleeping", "inactive", "disabled")
3. **Detour the update function**: Copy the prologue to a trampoline, patch
   the original with a JMP to your hook
4. **Check before calling original**: In your hook, check if the object
   matches the target type (vtable check) and has the dangerous condition
   (null pointer, invalid data). If so, force the safe state.
5. **Call original**: After the safety check, call the original function
   via the trampoline. Normal behavior continues for all other objects.

## the target Example: Blockdawg Pathless Crash (mkn_dawg_safety)

### Problem
`ArenaObject_Update` (0x0043C4E0) crashes when a Blockdawg has no DAWGPATH
(path pointer at +0x10F0 is NULL). The update calls `Path_GetPosition(NULL)`.

### Blockdawg Struct (0x1154 bytes, vtable=0x4D5638)
| Offset | Type | Field |
|--------|------|-------|
| +0x10F0 | ptr | path data (NULL = no path → CRASH) |
| +0x1150 | byte | state (0=active/crash, 1=sleeping/safe) |

### Detour Code
```c
#define ADDR_UPDATE        0x0043C4E0
#define BLOCKDAWG_VTABLE   0x004D5638

static void __fastcall Hooked_Update(DWORD *thisPtr, void *edx) {
    if (!IsBadReadPtr(thisPtr, 0x1154)) {
        if (*(DWORD *)thisPtr == BLOCKDAWG_VTABLE) {
            DWORD pathVal = *(DWORD *)((BYTE *)thisPtr + 0x10F0);
            if (pathVal == 0 || IsBadReadPtr((void *)pathVal, 8)) {
                if (*((BYTE *)thisPtr + 0x1150) == 0) {
                    *((BYTE *)thisPtr + 0x1150) = 1;  // Force sleeping
                }
            }
        }
    }
    if (g_orig_Update) g_orig_Update(thisPtr, edx);
}
```

### Prologue bytes
```
6A FF           PUSH -1           (2 bytes)
68 93 BB 4C 00  PUSH 0x004CBB93   (5 bytes)
```
7-byte trampoline: copy 7 bytes + JMP rel32 back.

### Build (MinGW)
```bash
i686-w64-mingw32-gcc -shared -o target.dll mod.c bass.def \
  -O2 -static -static-libgcc \
  -Wl,--enable-stdcall-fixup -Wl,--add-stdcall-alias -msse2 -mfpmath=sse
```

## D3D Render Context Thread Safety (v55m_7)

**Critical rule for target.dll proxy mods with background threads:** ANY code that
calls D3D/Gfx functions MUST run on the **main thread** (via Present hook or
another main-thread hook). The background thread (`entity_thread` / `patch_thread`)
must NEVER call render functions.

**Why:** D3DX internal functions (matrix multiply, vector transform) use SSE2
aligned-stack prologues and read matrix pointers from the D3D device state.
When called from the wrong thread, the device state is not set up → NULL matrix
pointer → crash in D3DX SSE2 code (e.g., `MOVSS XMM4, [EDX]` at 0x499D9D).

**Thread safety matrix:**
| Operation | Background thread | Present hook (main) |
|---|---|---|
| State machine updates | ✅ | ✅ |
| Position/proximity checks | ✅ | ✅ |
| Sound_Play3D | ✅ | ✅ |
| Timer_Init/Cleanup | ❌ | ✅ |
| Gfx_ScaleX/Y/Z | ❌ | ✅ |
| Gfx_SetPosition | ❌ | ✅ |
| mesh vtable[7] (render) | ❌ | ✅ |
| D3DX matrix functions | ❌ | ✅ |

**Diagnosis technique for D3DX crashes:**
1. Convert crash address: `0001:000XXXXX` → VA = 0x401000 + 0xXXXXX
2. Read bytes at crash address — SSE2 instructions (`F3 0F 10` = MOVSS) indicate D3DX
3. Search backwards for function prologue: `53 8B DC 83 EC 08 83 E4 F0` = D3DX SSE2 aligned-stack
4. Search for references to the function address in the binary — `C7 40 XX` = vtable slot construction
5. If no direct callers (E8/E9), it's called through a vtable at runtime → D3D internal

**Fix pattern:** Move the render call from `entity_thread` loop to
`gluebie_present_helper()` (or equivalent Present hook helper):
```c
static void __cdecl present_helper(void) {
    if (game_is_quitting()) return;
    DWORD board = get_board();
    // ... proximity checks (safe on any thread) ...
    // ... render calls (MUST be here, on main thread) ...
}
```

## Entity Animation — D3D SetTransform via vtable[18] hook (v55m_27+) — PREFERRED

For entity rotation/animation (Chomper jaw, Waterwheel spin, custom rotators),
hook **vtable[18]** (D3DXSkinMesh_CopyStripData at 0x45E0E0) and apply rotation
via **direct D3D SetTransform** on the world matrix. This is the ONLY approach
that works for PopCylinder-spawned entities.

**Why EntityTransform doesn't work for PopCylinder:** EntityTransform
(binary data+0x28) is read by the native render pipeline for native entities, but
PopCylinder's render path (vtable[18]) does NOT read EntityTransform. Writing to
it has zero effect — the entity stays static.

**D3D SetTransform pattern (working):**
```c
static void __thiscall custom_render(DWORD this_, char p1, int p2) {
    // Find our state for this object
    MyState* st = find_state(this_);
    if (!st || !st->orig_vtable18) { call_original(this_, p1, p2); return; }
    // Get D3D device: g_App → +0x174 (gfx) → +0x154 (device)
    DWORD app = *(DWORD*)0x005341E0;
    DWORD gfx = *(DWORD*)((char*)app + 0x174);
    DWORD device = *(DWORD*)((char*)gfx + 0x154);
    DWORD* dev_vtable = *(DWORD**)device;
    // vtable[36]=GetTransform(0x90), vtable[37]=SetTransform(0x94)
    typedef void (__stdcall *GetTransform_t)(DWORD, DWORD, void*);
    typedef void (__stdcall *SetTransform_t)(DWORD, DWORD, void*);
    GetTransform_t pfn_Get = (GetTransform_t)dev_vtable[36];
    SetTransform_t pfn_Set = (SetTransform_t)dev_vtable[37];
    float saveMatrix[16];
    pfn_Get(device, 256 /* D3DTS_WORLD */, saveMatrix);
    // Build rotation matrix, set it, render, restore
    float rotMatrix[16] = { /* row-major Z or Y rotation */ };
    pfn_Set(device, 256, rotMatrix);
    ((render_t)st->orig_vtable18)(this_, p1, p2);
    pfn_Set(device, 256, saveMatrix);
}
```

**Vtable hook registration:** Clone the object's vtable (256 bytes via operator_new),
replace slot 18 with your function, write the clone back to obj+0x00.

**Do NOT use** these approaches (all crash, corrupt, or have no effect):
- EntityTransform writes (binary data+0x28) → **no effect on PopCylinder** (v55m_25)
- `Gfx_ScaleZ` in vtable[18] hook → stale Z-scale → crash 0x499D9D (v55m_24)
- `vtable[22]/[21]` from Present hook → vertex buffer corruption → invisible mesh
- Matrix write to `obj+0x10E0` → heap overflow (PopCylinder is only 0x10D0 bytes)
- `Timer_Init`/`Timer_Cleanup` with Gfx_Scale → wrong pointers crash or stale state

**Full details + all failed approaches**: `references/entitytransform-animation-pattern.md` (updated with D3D SetTransform as the working solution)

## Key Considerations

- **Vtable check**: Always verify the object's vtable matches the target type.
  Update functions are often shared across multiple object types.
- **IsBadReadPtr**: Use for both the path pointer and the object itself. Game
  memory can be in transition states during level loading.
- **One-shot guard**: Only write the safe state if it's not already set
  (state == 0 check). Avoids redundant writes every frame.
- **Crash address format**: the target crash reports use `0001:000XXXXX`
  where XXXXX is the RVA from image base (0x400000). So 0001:00078EDD =
  0x00478EDD, NOT section-relative.

## Mesh File Loading — Two Pipelines

The game has TWO mesh loading systems. Using the wrong one crashes or produces invisible objects.

- **.DATA_FILE → `Level_binary dataCtor` (0x461510)**: Creates 0x10D0-byte Level with SceneObject, collision, AthenaLists. Crashes (`MessageBoxA + exit`) if file not found.
- **.MESH → `MeshNode_ctor` (0x471C20)**: Creates 0x18-byte MeshNode wrapper with inner binary data at +0x08. Handles .mesh binary format.

**binary data Swap Pattern** — when you need a .MESH visual on a spawned game object:
1. Load .MESH via MeshNode_ctor → extract binary data* from MeshNode+0x08
2. Load .DATA_FILE placeholder (e.g. Swirl) for PopCylinder_ctor
3. Create PopCylinder with placeholder (gets vtable, position, collision)
4. Swap obj+0x08 (binary data*) → .MESH binary data (render reads this; collision at +0x10E0 unchanged)

**Pitfall (v53 invisible bug):** Registering a MeshNode directly on the render list is invisible — the render list calls vtable[3] (render slot) which doesn't exist on MeshNode's vtable. Must create a proper PopCylinder first, then swap.

**Full details:** `references/mesh-file-loading-pipeline.md`

## References

- Blockdawg field layout: see the target-dll-modding skill
- Bass.dll proxy pattern: see the target-dll-modding skill
- hbtestd crash testing: use `test_dll_mod` tool (10s timeout sufficient)
- Mesh file loading pipelines: `references/mesh-file-loading-pipeline.md` (.MESH vs .DATA_FILE, binary data swap)
- Custom entities AI list (v53b): `references/custom-entities-ai-list-v53b.md` — Full entity→constructor mapping, all 14 constructor types, collision offsets, _default.DATA_FILE pattern
- Full decompilation findings: see `entity-constructor-discovery` skill `references/create-dynamic-objects-decompilation.md`
- Catapult timing, sound, and arm rotation: `references/catapult-rotation-and-sound-timing.md` (native 50-frame windup, `BASS_SamplePlay`, D3D SetTransform vtable[18] hook)

