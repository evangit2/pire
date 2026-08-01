---
name: loader-crash-analysis
description: Symbol-less crash analysis — Wine backtraces, Ghidra xrefs, null dereference tracing, and loader crash diagnosis.
---

# Loader Crash Analysis

> Adapted from the target-specific RE toolkit for general binary analysis.


# LevelFeatures_Loader Debugging

Debugging and fixing the LevelFeatures_Loader mod (target.dll proxy for
the target). This covers recurring bug classes found when replicating
the game's per-level board constructors in a universal constructor.

## Prerequisites

- Source: `~/the target-re/mods/_WIP 🔨 │ LevelFeatures_Loader/LevelFeatures.c`
- Compile: `cd "/home/evan/the target-re/mods/_WIP 🔨 │ LevelFeatures_Loader" && i686-w64-mingw32-gcc -shared -o target.dll LevelFeatures.c bass.def -lwinmm -lkernel32 -luser32 -O2 -Wall -Wno-unused-function -Wno-unused-variable -Wno-format -Wno-incompatible-pointer-types -std=gnu99`
  - bass.def is in the same directory (not in ~/the target-re/tools/)
  - Output is target.dll (target.dll proxy pattern, not LevelFeatures.dll)
- Test dir: `/tmp/hb-clean-test/` (clean Wine install with bass_real.dll)
- Ghidra: `bash /tmp/start-ghidra.sh` then `curl -s http://127.0.0.1:8089/health`
- Original EXE: `~/the target-re/originals/installed/extracted/target_binary.exe`

## Pitfall: Fresh Wine prefix crashes game at 2s — set Win XP mode first

If `~/.wine` is deleted and recreated with `wineboot --init`, the target
crashes at `RUNTIME: 00:00:02` in `ntdll.dll` with `CURRENTOBJECT: App`.
The default Wine prefix uses Windows 10+ mode, but the target requires
Windows XP compatibility for D3D8 initialization.

**Fix:** Set the app-specific Windows version to XP after creating a fresh prefix:
```bash
wine reg add "HKCU\Software\Wine\AppDefaults\target_binary.exe" \
    /v Version /t REG_SZ /d winxp /f
```

Without this, the game shows a crash dialog regardless of whether the mod
is installed. The crash is NOT mod-related — the vanilla game also crashes.
Verify by checking the crash dialog: if `MODULE: ntdll.dll` and
`RUNTIME: 00:00:02`, the Wine prefix needs the XP mode fix.

**If the game still shows a crash dialog after setting XP mode**, the
crash dialog may be stale from a previous run. Fully kill all Wine processes
(`pkill -9 wine`, `pkill -9 wineserver`, `pkill -9 Xvfb`), remove lock
files, then restart via `start_game(fps_mod=False)`.

## Bug: Wrong Vtable Called (TURRET handler)

The TURRET handler in `UniversalCreateDynamicObjects` called
`Stands vtable[2]` thinking it was `SetPosition`. It's actually
`SceneObject_BuildStrips` (0x00472770) — a mesh strip builder with
nested `while` loops that infinite-loop when mesh strip data isn't
fully initialized.

### Root Cause

The original `Tower_CreateDynamicObjects` (0x0040d7c0) does:

```c
Timer_Init(aiStack_50);                           // init Timer on stack
// Copy position from S1 data to stack struct
uStack_5c = *(param_5 + 4);  // x
uStack_58 = *(param_5 + 8);  // y
uStack_54 = *(param_5 + 0xc); // z
// Call TIMER vtable[2] — Gfx_SetPosition (0x00457B50)
(**(code **)(aiStack_50[0] + 8))(uStack_5c, uStack_58, uStack_54);
// Call STANDS vtable[0x15] (slot 21) with position struct pointer
(**(code **)(*piVar3 + 0x54))(&uStack_5c);
```

**Key:** SetPosition is called through the TIMER's vtable, not the
Stands' vtable. Timer and Stands have DIFFERENT vtables:

| Object | vtable[2] | Function |
|--------|-----------|----------|
| Timer  | 0x00457B50 | Gfx_SetPosition (safe) |
| Stands | 0x00472770 | SceneObject_BuildStrips (hangs!) |

### Fix

```c
// WRONG — calls SceneObject_BuildStrips, infinite loops
DWORD *vtbl = *(DWORD **)stands;
fn8(stands, x, y, z);  // vtbl[2] = SceneObject_BuildStrips!

// CORRECT — call Timer vtable[2] for SetPosition
DWORD *timerVtbl = *(DWORD **)timerBuf;
void (*timerSetPos)(float, float, float) = timerVtbl[2];
timerSetPos(pos[0], pos[1], pos[2]);

// Then call Stands vtable[0x15] with position struct pointer
DWORD *standsVtbl = *(DWORD **)stands;
void (*fn54)(DWORD, float*) = standsVtbl[0x15];
fn54((DWORD)stands, pos);
```

### General Rule

When the original game creates multiple objects (Timer + Stands) and
calls vtable functions, verify WHICH object's vtable is being called.
Always decompile the original `*_CreateDynamicObjects` function to
confirm which vtable each call goes through.

## Bug: D3D8 Hang on Wine/llvmpipe

`Gfx_SetPosition` (0x00457B50) calls `D3DX_ShaderDispatch_4b` and
`Graphics_SetRenderState`. These D3D8 calls hang on Wine's llvmpipe
software renderer. The game process stays alive at ~70% CPU but
never returns from the call.

**Wine workaround:** Skip the `timerSetPos` call entirely. The position
is still stored via the Stands vtable[0x15] call which follows. The
render loop sets D3D state later anyway.

```c
/* Skip timerSetPos — hangs on Wine, not needed for position storage */
// if (timerSetPos) timerSetPos(pos[0], pos[1], pos[2]);
```

This is a Wine-only workaround. On real Windows D3D8, the call
completes normally. Always re-enable for production builds.

## Bug: Mesh Slot Deduplication

Previously all dynamic object types (Bridge, Tipper, Gluebie, Spinny,
Saw, Fallout, Looper, Gear, BigGear) shared two mesh slots:
`UNI_BONK_STORE (0x8620)` and `UNI_SAW1_OBJ (0x8628)`. This made it
impossible to have multiple object types active on the same level.

### Solution: Dedicated Offsets

| Object Type | Old Offset (shared) | New Offset (dedicated) |
|---|---|---|
| Bridge | 0x8620/0x8628 | **stays** (most common) |
| Tipper | 0x8620/0x8628 | **0x86C0/0x86C4** |
| Spinny | 0x8620 | **0x86C8** |
| Saw (Toob) | 0x8628 | **0x86CC** |
| Fallout | 0x862C | **0x86D0** |
| Gluebie | 0x862C | **0x86D4** |
| Looper | 0x8620 | **0x86D8** |
| Gear | 0x8628 | **0x86DC** |
| BigGear | 0x862C | **0x86E0** |

Offsets 0x86C0-0x86E0 are in the zero-fill range, guaranteed unused
by the base board struct.

### CRITICAL: After changing mesh offsets

After changing any LevelData mesh offset, verify that the corresponding
handler in `UniversalCreateDynamicObjects` reads from the SAME offset.
Grep for the `UNI_*_MESH` define used by the handler and compare
against the config's `meshes[]` entry.

## Technique: Level File Swap Testing

To test locked levels (Dizzy, Tower, etc.) without unlocking them:

1. Swap `g_levelData[1]` (Warm-Up) with the target level's data
   (board ctor address, vtable, mesh paths, special init fields)
2. Update `LevelFeatures.txt` to enable target level's objects and
   collision events for level 1
3. Navigate to **Time Trials → Warm-Up** (which now loads target level)
4. **Warm-Up is NOT in Party Race mode** — must use Time Trials
5. Always revert both g_levelData[1] and LevelFeatures.txt after testing

### Navigation (Wine/xdotool)

- `xdotool key --delay 200` required for all key presses
- Sequence: Enter (LET'S PLAY) → Down (TIME TRIALS) → Enter →
  Enter on Warm-Up (first in list, unlocked)
- Verify with screenshot before pressing Enter — pressing Down too many
  times lands on PARTY GAMES which has no Warm-Up option

## Bug: Vtable Slot 24 Calling Convention Mismatch (RET 0 vs RET 4)

**Symptoms:** Crash at `0x452783` (or similar address inside dead/unreachable
code) on ALL races when slot 24 is patched to a universal render function.
The crash address appears to be in the middle of a `PUSH imm32` instruction
— a classic sign of stack corruption.

**Root Cause:** The game has TWO call sites for vtable slot 24 (render):

1. **`0x0046C8C7`** — `ECX=board`, no stack params → expects `RET 0`
2. **`0x0046C9F0`** — `ECX=board`, `PUSH EDI` (gfx context) → expects `RET 4`

Call site #2 is the main per-frame render dispatch. The original per-level
render functions handle this correctly:

| Function | Address | Convention | RET |
|----------|---------|------------|-----|
| Level_RenderDynamicObjects | 0x0040B420 | `__fastcall(board)` | 0 |
| Scene_RenderReflectiveObjects7 | 0x00411380 | `__thiscall(board, param_2)` | 4 |
| Scene_RenderWithCamera | 0x0040DFA0 | `__thiscall(board, param_1)` | 4 |

9 of 15 levels use the 1-param function (RET 0). 6 levels (Beginner, Tower,
Toob, Glass, Sky, Master) use the 2-param function (RET 4).

When `UniversalRender` is declared `__fastcall(void *board)` (RET 0) and
replaces ALL 15 vtables, call site #2 pushes an extra param that
UniversalRender doesn't clean up. The stack is misaligned by 4 bytes →
corrupted return address → crash.

**Fix (CONFIRMED):** Do NOT patch all 15 vtables with a single RET 4
thunk. The RET 4 thunk crashes 1-param levels (Intermediate confirmed).
Only patch the 6 levels that use 2-param render (2, 5, 10, 12, 13, 14).
Leave the other 9 levels' slot 24 untouched — their original
`Level_RenderDynamicObjects` (RET 0) handles rendering natively.

```c
// In InstallVtablePatches, only patch 2-param levels:
int two_param_levels[] = {2, 5, 10, 12, 13, 14};
int is_two_param = 0;
for (int j = 0; j < 6; j++) {
    if (i == two_param_levels[j]) { is_two_param = 1; break; }
}
if (is_two_param) {
    DWORD *slot = (DWORD *)(vtableAddr + 0x60);
    VirtualProtect(slot, 4, PAGE_EXECUTE_READWRITE, &oldProtect);
    *slot = (DWORD)&UniversalRender;
    VirtualProtect(slot, 4, oldProtect, &oldProtect);
    FlushInstructionCache(GetCurrentProcess(), slot, 4);
}
```

**Current state:** Slot 24 is DISABLED (`#if 0` block) until per-level
render features are needed. Re-enable using the per-level approach above.

**How to diagnose:** The crash address will be inside dead code or the
middle of an instruction — this is the stack corruption signature. Search
for all `CALL [reg+0x60]` (vtable slot 24) call sites in the binary.
Check if any push an extra param before the call. If yes, the replacement
function must use `RET N` matching the number of pushed bytes.

### General Rule: Vtable Slot Replacement Calling Convention

Before replacing ANY vtable slot with a universal function:

1. Decompile the ORIGINAL function at that slot for each vtable
2. Check the `RET N` instruction at the end — `N` tells you how many
   stack params the function cleans
3. Find ALL call sites for that vtable slot in the binary
   (search for `CALL [reg+offset]` patterns)
4. Check if any call sites push extra params before the call
5. If different vtables use different conventions for the same slot,
   you may need separate replacement functions per convention
6. **Check if any level has a custom implementation** (not the shared
   function). If so, save and call the original from your universal
   replacement. Use the vtable address table to read slot[19] for each
   of the 15 levels and compare against the shared function address.

## Bug: Bridge Animation Offset Mismatches (Write ≠ Read)

**Symptoms:** Bridge on Intermediate doesn't animate. The 4-state machine
(countdown → tilt down → wait → tilt back) never visibly triggers because
`renderObj` is read as NULL, `pivot` is 0, and `angle`/`state` may be
corrupted by position writes.

**Root Cause:** Three separate offset mismatches:

1. **Render object read from wrong slot** — `BRD_BRIDGE_RENDER` was
   `UNI_MESH_0` (0x85E0) but meshWorld is stored at `UNI_BONK_STORE`
   (0x8620). Fix: point `BRD_BRIDGE_RENDER` to `UNI_BONK_STORE`.

2. **Vtable calls on wrong object** — Original game calls
   `meshWorld->vtable[0x16]` and `[0x15]`, but the mod was calling these
   on `renderObj` (Level_RenderCtor result) which has a different vtable.
   The render methods at slots 0x15/0x16 only exist on the meshWorld's
   vtable. Always verify which object's vtable the original calls.

3. **Pivot position overwrote state machine** — CreateDynamicObjects
   BRIDGE handler wrote position into `UNI_BRIDGE_ANGLE` and
   `UNI_BRIDGE_STATE`, overwriting the 45.0f/0/50 init values. The state
   machine then hit an unhandled state and did nothing silently. Fix:
   pivot now stored at `UNI_WINDMILL_X/Y/Z` (bridge & windmill never
   coexist on the same level).

**General rule:** When using unified offsets, verify THREE storage points
all match: (1) Write in ctor/CreateDynamicObjects, (2) Read in
Board_Update/Render, (3) Init in board constructor step 9f.

## Bug: Vtable Slot 19 (RaceState) Replacement Skips Per-Level Handlers

**Symptoms:** Up Race vacuum events (HELPINERTIA, UNHELPINERTIA, VACPOPOUT)
never fire. LIFTER objects spawn but are completely inert — no animation,
no ball entry processing. Beginner bumper timers don't decay. Neon camera
follow doesn't work.

**Root Cause:** The mod replaces ALL 15 vtable slot 19 (RaceState) entries
with `UniversalRaceState`, which calls only the shared
`g_BoardUpdateRaceState` (0x0041B130). But several levels have **custom
RaceState handlers** that perform per-level logic after calling the shared
function:

| Level | RaceState Addr | Custom Logic |
|-------|---------------|--------------|
| Beginner (2) | 0x00420240 | Decays 8 float timers at board+0x642C-0x6448 |
| Up (6) | 0x00420660 | Iterates AthenaList at board+0x436C, calls each Lifter's Update() |
| Neon (7) | 0x00424790 | Calls vtable[1] on render objects at board+0x436C/0x4370 with ball position |

The original code assumed all levels shared the same RaceState — they don't.
9 of 15 levels use the shared function; 3 have custom handlers.

**Fix (3 parts):**

1. **Save original vtable[19]** for each level into `g_origRaceState[16]`
   array during `InstallVtablePatches`:
```c
typedef void (__fastcall *RaceState_t)(void *board);
static RaceState_t g_origRaceState[16] = { NULL };

// In the vtable patching loop:
DWORD *slot = (DWORD *)(vtableAddr + 0x4C);
if (i >= 1 && i <= 15) {
    g_origRaceState[i] = (RaceState_t)*slot;  // save before overwriting
}
*slot = (DWORD)&UniversalRaceState;
```

2. **Call the saved original** from `UniversalRaceState` after the shared
   `g_BoardUpdateRaceState`:
```c
g_BoardUpdateRaceState(board);
int level = GetCurrentLevel(board);
if (level >= 1 && level <= 15 && g_origRaceState[level]) {
    g_origRaceState[level](board);
}
```

3. **Initialize legacy AthenaList for Up** — The mod's `memset(board+0x436C, 0, ...)`
   zeros the lifter list. Initialize it in `UniversalBoardCtorLogic`:
```c
if (raceIndex == 6 && g_AthenaListInit) {
    g_AthenaListInit((void *)((char *)mem + 0x436C), 0);
}
```

4. **Dual-append LIFTER objects** — In `UniversalCreateDynamicObjects`,
   append to both `UNI_OBJ_LIST` AND `board+0x436C` for Up:
```c
g_AthenaListAppend((void*)((char*)board + UNI_OBJ_LIST), (int)obj);
if (level == 6) {
    g_AthenaListAppend((void*)((char*)board + 0x436C), (int)obj);
}
```

**AthenaList structure** (0x410 bytes at board+0x436C):
- +0x000: vtable/heap
- +0x004: count (board+0x4370)
- +0x008: iterator scratch (board+0x4374)
- +0x40C: data pointer (board+0x4778)

`AthenaList_Init` at board+0x436C sets up ALL these fields including the
data pointer at board+0x4778. The original Up RaceState iterates this list
via `AthenaList_GetIterator` and calls each Lifter's `vtable[0]()` (Update).

**General Rule:** Before replacing ANY vtable slot with a universal function,
decompile the original function at that slot for EACH vtable. If any level
has a custom implementation (not the shared function), you MUST save and
call the original. The slot 19 discovery parallels the slot 24 calling
convention issue — same class of bug, different manifestation.

## Bug: DebugLog Does NOT Accept printf Format Strings

`DebugLog()` takes a single `const char*`. Extra args are silently
ignored — no formatting occurs.

```c
// WRONG — extra args ignored
DebugLog("TURRET: mesh=0x%08X", (unsigned)meshPtr);

// CORRECT — use wsprintfA into a buffer first
{ char _dbg[128];
  wsprintfA(_dbg, "TURRET: mesh=0x%08X name='%s'", (unsigned)meshPtr, name);
  DebugLog(_dbg);
}
```

## Debugging Workflow

1. **Decode the crash address** — `0001:000XXXXX` = `0x400000 + RVA`.
   Look up the function at that address in Ghidra. Check if the offset
   falls at an instruction boundary or mid-instruction:
   - **At boundary** → normal access violation (NULL deref, bad pointer)
   - **Mid-instruction** → EIP corruption from stack corruption (see
     "Mid-Instruction EIP" section above)
2. **Add debug logs** at each step of the handler (before and after
   each vtable call, each function pointer call)
3. **Compile clean** (exit 0 from gcc)
4. **Copy to test dir** + start game on `DISPLAY=:99`
5. **Navigate to Time Trials → Warm-Up** (or swapped level)
6. **Check lfdebug.log** for the last log line before hang/crash
7. **Decompile the hanging function** in Ghidra to understand what it does
8. **Compare with original** `*_CreateDynamicObjects` decompilation
9. **Fix** the calling convention / vtable / parameter mismatch
10. **Revert test swaps** and push clean

## Bug: DebugLog Written to Wrong Directory (Game CWD ≠ Expected)

**Symptoms:** `lfdebug.log` is not in the expected directory (e.g.
`/tmp/hb-clean-test/` or the extracted EXE directory). The mod's
`DebugLog` uses a relative path (`"lfdebug.log"`) which resolves to the
game process's current working directory, NOT the DLL's location.

**How to find the log:** Check the game process's CWD:
```bash
ls -la /proc/<PID>/cwd
# Example: /proc/132012/cwd -> /home/evan/the target-wasm/boxedwine-package/the target
```

The `hbtestd` game launcher starts the game from
`/home/evan/the target-wasm/boxedwine-package/the target/`, so
`lfdebug.log` appears there, NOT in `/tmp/hb-clean-test/` or the
mod source directory.

**DebugLog path resolution:**
1. If `g_configPath` is set (from `GetConfigPath`), log goes next to config
2. If `g_configPath` is empty (Wine/BoxedWine fallback), log goes to CWD
3. Under Wine, `GetConfigPath` uses `GetModuleHandleExA` which may return
   a `Z:\` path — the log is written there, accessible from Linux

**Fix:** Always check `/proc/<PID>/cwd` to find the actual log location
when the log isn't where you expect it.

## Bug: Multiple DLL Copies — Stale DLLs Cause Silent Failures

**Symptoms:** The mod compiles and copies to one directory, but the game
loads a DIFFERENT copy from another directory. Debug log shows old version
strings, new code doesn't take effect.

The `hbtestd` launcher's game CWD is:
`/home/evan/the target-wasm/boxedwine-package/the target/`

But the mod source and test copies are in:
- `~/the target-re/mods/_WIP 🔨 │ LevelFeatures_Loader/target.dll`
- `/tmp/hb-clean-test/target.dll`
- `/home/evan/the target-re/originals/installed/extracted/target.dll`

**Fix:** Always copy the freshly compiled DLL to ALL three locations:
```bash
cp target.dll /tmp/hb-clean-test/target.dll
cp target.dll /home/evan/the target-wasm/boxedwine-package/the target/target.dll
cp target.dll /home/evan/the target-re/originals/installed/extracted/target.dll
```

Also delete old `lfdebug.log` from the game's CWD before each test run
to avoid confusion with stale logs.

## Bug: X11 Keyboard Input Broken on Xvfb (No Window Manager)

**Symptoms:** `xdotool key` and `hbtestd send_key` return success but
keys never reach the game. `XGetInputFocus returned the focused window
of 1` appears in stderr. The game stays on the title screen indefinitely.

**Root Cause:** Without a window manager on the Xvfb display, Wine windows
cannot receive keyboard focus. `xdotool key` sends to the focused window
(window 1 = root = no focus), not the Wine window.

**Attempted fixes (none fully work):**
- Starting `openbox` as background WM — window appears but focus still broken
- `xdotool windowactivate --sync` — XGetInputFocus still returns 1
- `xdotool key --window <ID>` (XSendEvent) — Wine ignores XSendEvent keys
- Wine virtual desktop mode — creates a managed window but keys still fail
- `ydotool` (uinput) — crashes on this system

**Mouse clicks sometimes work** via `xdotool click --window <ID>`, but
keyboard input is completely non-functional.

**Implication:** Level navigation that requires keyboard (Enter, Down,
Space) cannot be automated on this Xvfb setup. Visual verification of
level features must be done on the user's Windows machine. Crash testing
Crash testing (title screen survival) still works since it doesn't require navigation.

## Bug: PatchThread Sleep Timing — Vtable Patches Applied Mid-Frame

**Symptoms:** Crash at `0001:0006333F` (= `0x46333F` = `0x400000 + 0x6333F`),
runtime 00:00:06, `CURRENTOBJECT: Board (Warm-Up)`, `CURRENTOPERATION: Update`,
`EXTENDED_INFO: FinishLoad(OK)`. The crash address falls inside
`SpatialTree_ctor` at `0x463330`, specifically at byte 2 of the 7-byte
`MOV FS:[0], ESP` instruction (offset 0xE into the function). This is a
**mid-instruction EIP** — the CPU cannot naturally land there during
normal execution.

**Root Cause:** `PatchThread` used `Sleep(5000)` before applying vtable
patches. The game loads levels in ~3-4 seconds from DLL load. With a 5s
delay, the level finishes loading and starts its first `Board_Update`
frame BEFORE patches apply. At t=5s, `InstallVtablePatches` overwrites
vtable slots 1, 19, 29, 33 while `Board_Update` is executing through
the ORIGINAL vtable. This corrupts the return address on the stack →
EIP lands at a mid-instruction address → crash.

With `Sleep(2000)`, patches apply at 2s — before most level loads — so
the race never starts mid-patch.

**Fix:** Keep `Sleep(2000)`. The delay must be short enough that patches
apply before any level loading begins. If a longer delay is needed (e.g.,
to ensure BASS audio init completes), use a game-state check instead of
a fixed sleep — wait until the main menu appears, then patch.

### Diagnostic: Mid-Instruction EIP = Stack Corruption

When a crash address falls inside a multi-byte instruction (not at an
instruction boundary), it means EIP was corrupted — typically by a
bad return address on the stack. This is distinct from an access
violation (which would report the START of the faulting instruction).

**How to recognize:**
1. Decompile/disassemble the function at the crash address
2. Check if the crash offset falls at byte N>0 of a multi-byte instruction
3. If yes → EIP corruption from stack corruption, NOT a normal crash
4. Look for: vtable patches applied mid-frame, calling convention
   mismatches (wrong RET N), or buffer overflows overwriting return
   addresses

**Contrast with access violation crashes:** If the crash address IS at
an instruction boundary, it's a normal access violation — the instruction
itself faulted (NULL deref, bad pointer). The faulting address is EIP.

**Second root cause — patch byte overflow:** Mid-instruction EIP can
ALSO mean a CEA NOP after a JMP overwrote the next instruction. If the
crash address is `hook_addr + 6` (one byte past the NOP), check whether
an extra NOP was written after a 5-byte JMP that replaced a 5-byte
instruction. See `references/cea-code-cave-nop-padding-bug.md`.

## References

- `references/multi-hook-system-merging.md` — architecture for merging 3+ mods
  with different hook types (detour hooks, code caves, DCE hooks, frame epilogue
  hooks, background threads) into a single target.dll proxy. Covers shared frame
  epilogue dispatch, inline asm wrappers, thread safety, subsystem interaction
  (Ghost 2 on same-level warp), TT recording NOP patch, and verification checklist
- `references/vtable-slot19-racestate-replacement.md` — full decompilation of
  Up/Beginner/Neon custom RaceState handlers, Lifter_ctor analysis, AthenaList
  structure, and how to check for custom RaceState handlers per level
- `references/cea-code-cave-nop-padding-bug.md` — CEA JMP+NOP padding
  bug: when JMP (5 bytes) replaces a 5-byte instruction, extra NOP
  overwrites next instruction → mid-instruction crash. Includes patch
  size calculation rule and second root cause for mid-instruction EIP
- `references/vtable-slot24-calling-convention.md` — full analysis of the
  RET 0 vs RET 4 crash at 0x452783, call site disassembly, original
  function conventions per level, and additional fixes (Dizzy dual-write
  offsets, Expert BRIDGE handler AthenaList corruption)
- `references/tower-create-dynamic-objects.md` — Tower TURRET handler
  decompilation, Timer vs Stands vtable analysis
- `the target-dll-modding/references/universal-level-constructor.md` —
  full architecture of the universal constructor
- `the target-dll-modding/references/c-code-review-bug-patterns.md` —
  45+ bug patterns from code review sessions
- `ghidra-mcp-headless` skill — start Ghidra for decompilation
- `hbtestd-dll-mod-testing` skill — crash test DLL mods on Wine
