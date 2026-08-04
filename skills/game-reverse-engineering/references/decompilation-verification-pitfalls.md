# Decompilation Verification Pitfalls

## Pitfall: Function Name Lies — "SetViewportClip" Was Actually a Color Multiplier

`Graphics_SetViewportClip` (0x00401160) was named based on Ghidra's auto-analysis
of the callsite pattern (4 float params passed to a function that writes to gfx
struct fields). The name suggested viewport clipping. In reality, the function
sets a **4-component RGBA color multiplier matrix**:

```c
void Graphics_SetColorMultiplier(gfx, float R, float G, float B, float A) {
    gfx->field_0x7A8 = 1;  // enable flag
    Matrix_Scale4x4(&local, R, G, B, A);
    gfx->matrix_0x7B0 = local;
}
```

**How the error was caught:** Initial analysis of the magnifier heat system
claimed the ball "shrinks" when heated, because the decompiled code showed
`Graphics_SetViewportClip(gfx, 1.0, 1.0-heat, 1.0-heat, scale)` — interpreted
as reducing viewport bounds. The user pointed out the ball never shrinks at all
during heating. Decompiling the function revealed it sets a color multiplier
matrix, not a viewport. The `(1.0, 1.0-heat, 1.0-heat)` params are (R, G, B)
color multipliers — green and blue are reduced while red stays at 1.0, creating
a white→red color shift on the ball border sprite.

**Rule:** When a function name suggests a visual/spatial effect (viewport, clip,
scale, shrink) but the observed behavior doesn't match, decompile the function
itself and check what it actually writes to the struct. A `Matrix_Scale4x4` call
inside a "SetViewportClip" function is a color multiplier, not a geometry
operation. The 4 params are RGBA, not XYZ+W.

**Renamed in Ghidra** to `Graphics_SetColorMultiplier` (July 2026, sess8677).

## Pitfall: "int*"" Arithmetic Claims — Always Verify with Disassembly

Ghidra decompilation sometimes shows pointer arithmetic like `param_1 + 0x2e9` where
`param_1` is declared as `int` (not `int*`). This IS byte offset `0x2E9`, not
`0x2E9 * 4 = 0xBA4`. Previous analysis incorrectly assumed `int*` arithmetic and claimed
a field clear was writing to the wrong offset — but the actual disassembly confirmed
it was `MOV byte [ESI+0x2E9], 0` (correct offset).

**Rule:** When a decompilation shows `param_1 + 0xNNN` without an `(int)` cast, check
the function signature first. If `param_1` is declared as `int` (not `int*`), the
arithmetic is byte offset. If declared as `int*`, multiply by 4. Always verify the
actual bytes with `objdump` or GhidraMCP disassembly — the ModRM encoding tells you
the real register and displacement.

**Verification method:**
```python
# Read bytes at the address from disassembly
# C6 86 XX XX XX XX YY = MOV byte [ESI+disp32], imm8
# 88 9E XX XX XX XX    = MOV [ESI+disp32], BL (register source)
# The ModRM byte (86/9E) tells you the addressing mode and register
```

## Pitfall: Vtable Slot Callsite Verification — Dead Code Detection

When checking if a vtable function is actually called, search for `call [reg+offset]`
in the binary:

```bash
objdump -d -M intel --start=0x401000 --stop=0x4C0000 target_binary.exe \
  | grep "call.*\[.*\+0x104\]"
```

A vtable slot that has NO callsite dispatching to it is **dead code**. Example:
`Ball_FallUpdate` (vtable[65], offset 0x104) appeared to be "called when shrunk" but
the only `call [ecx+0x104]` sites were in D3D texture functions, not Ball vtables.
The function was never actually called — always verify vtable dispatch sites exist.

## Pitfall: Player Identification — ball+0x18 Is NOT a Reliable Player Slot

When writing CE scripts or DLL mods that need to identify Player 1's ball, do NOT
use `ball+0x18` as a player slot check. The ball constructor sets `+0x18` to
**-1** (0xFFFFFFFF), meaning "no player assigned." AI/BadBall objects also get -1.
Using `test eax,eax` to check for P1 will ALWAYS fail (non-zero → jumps to disabled).

**Correct method:** Compare ESI against the App's direct P1 ball pointer:
```asm
mov eax, [0x5341E0]       ; App (static global)
mov eax, [eax + 0x5DC]    ; P1 ball pointer (direct, always valid during gameplay)
cmp esi, eax              ; is current ball == P1?
jne NotPlayer1
```

Full details on ball-ball collision force application, the `Ball_ApplyForceV2`
function, and trampoline construction for hooking force magnitude PUSH instructions:
see `references/player-identification-and-force-tracing.md`

## Pitfall: Vtable Function Address Verification — ALWAYS Read the Vtable Entry

**Symptom:** You hook function `0x004016F0` (Ball_ApplyForceV2) but the game is
unaffected. The hook executes, players move, but the targeted behavior doesn't change.

**Root cause:** The ball's vtable at `0x4CF3A0` has `vtable[6]` (offset +0x18) =
`0x00402650`, NOT `0x004016F0`. These are **two identical copies** of the same
function at different addresses. The game calls `0x00402650` via `CALL [EDX+0x18]`,
never `0x004016F0`. Hooking the wrong copy has zero effect.

**Rule:** Before hooking ANY function that's called via vtable dispatch:
1. Read the vtable address from the ball/object constructor (look for `this->vtable = &PTR_xxx`)
2. `read_memory(vtable_addr, length=N*4)` to read all function pointers
3. Parse each DWORD as little-endian function pointer
4. The function at vtable+offset is the ACTUAL function being called — NOT necessarily
   the function you found via `get_function_by_address` or `decompile_function`

**Verification method:**
```python
import struct
# Read vtable entries (each is a 4-byte function pointer)
vtable_raw = [240, 39, 64, 0, ...]  # from read_memory
for i in range(0, len(vtable_raw), 4):
    ptr = struct.unpack('<I', bytes(vtable_raw[i:i+4]))[0]
    print(f"vtable[+0x{i:02X}] = 0x{ptr:08X}")
```

**Caught July 2026 (sess11570):** Spent 6 script versions trying to boost P1's bump
force. Hooked `0x4016F0` (Ball_ApplyForceV2) — but the ball vtable at `0x4CF3A0`
has `vtable[6] = 0x402650`, a duplicate copy. The actual collision code calls
`CALL [EDX+0x18]` which resolves to `0x402650`, never `0x4016F0`. Both functions
have identical bytecode (`56 8B F1 8A 86 F9 02 00 00 84 C0 0F 85 82 01 00`) —
the compiler or linker created a duplicate. Hooking the unused copy had zero effect.

**ALSO:** A 4-byte patch on the PUSH operand at `0x406D88` (changing 1.0 to 20.0)
froze ALL players because 20x force causes physics NaN/explosion — the collision
code runs every frame for every ball. Use moderate values (3.0-5.0) for testing.

## Pitfall: Hooking Function Entry vs Hooking Call Site — Different Risks

**Function entry hooks** (replacing the first 5 bytes with JMP):
- Pro: catches ALL calls regardless of caller
- Con: the function is called from N different sites with different contexts
- Risk: registers (like saved ESI) may not contain what you expect from all callers
- Example: Ball_ApplyForceV2 is called from 17 sites — only 1 is ball-ball collision

**Call site hooks** (replacing a PUSH/CALL at a specific address):
- Pro: only fires for the specific code path you want
- Con: requires careful trampoline construction (FPU state, etc.)
- Risk: clobbering registers used by the caller after the hook returns
- Example: Hooking PUSH at 0x406D87 only fires during ball-ball collision in Ball_Update

**Rule:** For P1-specific behavior, hook the CALL SITE (0x406D87), not the function
entry. The call site only fires during the specific collision code path, giving you
free context filtering. Function entry hooks require return-address checking which
is fragile and can clobber AL (causing the drowning guard to read garbage → all
players freeze).

## Pitfall: AI-Generated Documentation Is Hypothesis, Not Fact

Prior AI analysis sessions produce documentation (hbremap, SQUIBIT, docs/)
that describes what functions "do" based on pattern-matching heuristics.
These descriptions are HYPOTHESES, not verified facts. They can be wrong in:
- **Values**: Claiming `ball[0xA1] = 20.0` when the actual hex is `0x41D00000` = 26.0
- **Semantics**: Calling a radius write a "force" or "popout"
- **Effects**: Claiming a function "shrinks" when the value is ~normal size
- **Causation**: Claiming a trigger "transports the ball" when no transport code exists

**RULE:** Before trusting ANY AI-generated description of what a function does:
1. Decompile the actual function via GhidraMCP
2. Read the raw hex constants and convert to float/int yourself
3. Verify field offsets against the struct definition
4. Do NOT propagate descriptions from hbremap/docs without decompilation backing

**Caught July 2026:** The entire E:VACPOPOUT description was wrong across 3 docs.
Prior session wrote "sets ball[0xA1] = 20.0 (vacuum popout force)" — actual code
sets ball+0x284 (radius) to 26.0f. The "force" was fabricated, the value was wrong,
and the claimed transport mechanism (CollisionFaces guiding the ball) had zero
code backing. User caught it by questioning whether 26 was even different from
normal radius.

## Pitfall: Ghidra int* Array Index vs Byte Offset — The #1 Offset Bug

When Ghidra declares `int *param_1`, every `param_1[N]` access is at byte offset `N * 4`,
not `N`. Copying these indices directly into C mod code as byte offsets produces mods that
compile, don't crash, and pass 35-second survival tests — but every feature block silently
does nothing because it reads garbage from 1/4 of the intended offset.

**Full case study (30+ offsets in LevelFeatures_Loader v6, sess14636), disambiguation
table, AthenaList struct layout, and fix checklist:** see
`references/ghidra-dword-index-vs-byte-offset.md`.

**Quick detection:** If consecutive float fields appear at +0, +1, +2 (1-byte strides),
that's impossible — they're Ghidra indices, multiply by 4.

**BUT:** `*(float*)(iVar + N)` where `iVar` is declared as `int` (not `int*`) IS a byte
offset — don't multiply those.

**AthenaList sub-pitfall:** The data array pointer is at `list + 0x40C`, NOT `list + 0xC`.
The AthenaList struct is ~0x410 bytes, not 0x10.

## Pitfall: Ghidra `(int)((float)param_1[N])` Looks Like Int Storage — It's Actually Float

Ghidra's C decompilation can show code like:
```c
param_1[0x10e3] = (int)((float)param_1[0x10e3] + fVar1);
```

This looks like the field stores an **int** (the result is cast to int before storing). But the
actual x86 disassembly reveals:
```asm
FLD float ptr [ESI + 0x438c]    ; load as FLOAT
FADD float ptr [0x004cf310]     ; add constant
FSTP float ptr [ESI + 0x438c]  ; store as FLOAT
```

The field IS stored as float. Ghidra's `(int)` cast is an artifact of `param_1` being declared
as `int*` — every access through `param_1[N]` produces an `int` result that Ghidra casts.

**Rule:** When Ghidra shows `param_1[N] = (int)((float)param_1[N] + ...)`, check the
disassembly. If the disasm uses `FLD float ptr` / `FSTP float ptr`, the field is float.
The `(int)` cast is a Ghidra artifact, not the actual storage type.

**Sub-case: `__ftol2()` for modulo checks.** The same function may convert the float
to int via `CALL __ftol2` for a modulo check:
```asm
FLD float ptr [ESI + 0x438c]   ; load angle as float
CALL 0x004ba754                 ; __ftol2() — convert FPU to int
CDQ                             ; sign-extend
MOV ECX, 0x5A                   ; divisor (90)
IDIV ECX                       ; EDX = remainder
CMP EDX, 0x2D                  ; remainder == 45?
```
This converts the float to int ONLY for the modulo check. The stored value remains float.

**Caught July 2026 (sess14909):** The windmill angle field was initially "fixed" to
read/write as int because Ghidra's decompilation showed `(int)((float)param_1[0x10e3] + ...)`.
The disassembly proved it's stored as float. The modulo check on the integer-converted
value is correct — just don't change the storage type.

## Pitfall: Different AthenaLists at Different Offsets — Not All Ball Lists Are Equal

When iterating balls in a board struct, there are MULTIPLE AthenaLists that track
different subsets of balls:

| Ghidra Index | Byte Offset | Purpose |
|-------------|------------|---------|
| `param_1 + 0xA75` | 0x29D4 | Ball iteration list (all balls including badballs) |
| `param_1 + 0xD8B` | 0x362C | Race ball count list (active race balls only) |

The ball iteration list (0x29D4) is used for per-ball processing (swirl proximity, etc.).
The race ball count list (0x362C) is used for "is race ending?" checks (count == 1).

**Rule:** Don't assume all `param_1 + 0xNNN` ball list references point to the same
AthenaList. Cross-reference each one against the Ghidra decompilation to see which
function uses which list. Using the wrong list for a count check will give wrong results.

## Pitfall: Wine/Xvfb Cannot Test Per-Level Gameplay — DirectInput Limitation

target application imports `DINPUT8.dll` for ALL keyboard input, including menu navigation.
On Wine running on Xvfb (headless, no window manager), DirectInput receives zero
keyboard events. This makes automated per-level crash testing impossible.

**What doesn't work:**
- xdotool key/click — sends X11 events, DInput doesn't read them
- xte (xautomation) — same X11 limitation
- evdev raw events (/dev/input/event1) — Wine's DInput doesn't read from evdev
- uinput virtual keyboard — struct format issues
- Wine registry dinput8=native — crashes the game

**What does work:**
- 35-second startup crash test (catches stack corruption, bad hooks)
- Static verification via Ghidra decompilation cross-referencing
- Debug log verification (lfdebug.log confirms hook installation)

**What requires the user's Windows machine:**
- Per-level loading and gameplay testing
- Feature block verification (bridge animation, swirl, windmill, etc.)
- Config file override testing

**Alternative approach that failed:** Calling `App_StartPracticeRace` from a
background thread deadlocks because D3D8 resource creation must happen on
the main thread. Hooking `App_ResetFrame` to call it from the main thread
also failed because `App_ResetFrame` is NOT called on the title screen.

## Pitfall: Auto-Test Thread Deadlocks — D3D8 Requires Main-Thread Calls

When testing game function calls (e.g., `App_StartPracticeRace`) from a DLL mod,
calling them from a background `CreateThread` will deadlock. D3D8 device creation
and resource allocation must happen on the same thread that created the Direct3D
device — typically the main thread.

**Symptom:** The function call never returns. The game process stays alive
(99% CPU) but no further debug log entries appear. The main thread is blocked
waiting for a D3D resource that the background thread is trying to create.

**Rule:** Game function calls that involve scene creation, mesh loading, or
D3D resource allocation MUST be called from the main thread. Use a per-frame
hook (e.g., on the main loop function) with a state machine to sequence the
calls, not a background thread. Note: finding a function that IS called on
the title screen may be non-trivial — `App_ResetFrame` (0x46C200) is only
called during races, not on the title screen.

## Pitfall: Ghidra Double-as-Float Misread (QWORD vs DWORD)

Ghidra's decompiler shows `(float)` casts on values that are actually **8-byte doubles** in the x86 code. The giveaway is always in the disassembly: `fmul qword` / `fadd qword` / `fld qword` = 8-byte double, `fmul dword` / `fadd dword` / `fld dword` = 4-byte float.

**Rule**: When a physics constant from Ghidra's decompiler produces a nonsensical value (extremely large like 89128.96, or extremely tiny like 1e-23), ALWAYS check the x86 disassembly for `QWORD` vs `DWORD` qualifiers. Read 8 bytes and decode as `struct.unpack('<d', ...)` to get the true double value.

Known instances (all in target_binary.exe, as of July 2026):

| Address | Ghidra shows (4 bytes) | Actual (8 bytes) | Used by |
|---------|----------------------|-------------------|---------|
| 0x4D03B0 | 89128.96 | **0.16** | Board_GetInputForce3D — MouseSensitivityMultiplier |
| 0x4D03A8 | -1.08e-19 | **0.1** | Board_GetInputForce3D — MouseSensitivityOffset |
| 0x4CF308 | -1.59e-23 | **0.1** | OptionsMenu_AdjustSlider — SliderStepSize |
| 0x4CF4F8 | 0.0 | **2.0** | Ball_Update death distance check |
| 0x4CF3E0 | 0.0 | **0.01** | Ball_Update collision velocity factor |
| 0x4CF440 | ~0 | **0.01** | Ball_Update trail particle threshold |
| 0x4CF528 | 0.0 | **0.5** | Ball_Update Y offset |
| 0x4D03E0 | 89128.96 | **0.02** | Board_UpdateRaceState race timer decrement/frame |
| 0x4CF538 | 89128.96 | **0.01** | Board_UpdateRaceState countdown timer increment/frame |
| 0x4D03C8 | 0.0 | **3.0** | Board_UpdateRaceState countdown phase threshold (seconds) |
| 0x4CF4B8 | garbage | **1.1** | Magnifier heat explosion threshold (Ball death) |
| 0x4CF400 | garbage | **1.05** | Ball radius multiplier for sprite rendering (Ball_Render) |
| 0x4D5C30 | 0.0 | **3.25** | Fan wind force multiplier (Fan_Update) |
| 0x4CF3C8 | 0.0 | **1.0** | Fan wind force base (Fan_Update) |

**Two trap patterns to recognize:**
1. **Tiny denormalized values (~1e-19 to 1e-23)**: The low 4 bytes of a double that starts with zero bytes. E.g., 0x4CF308 reads as -1.59e-23 but is actually double 0.1.
2. **Large plausible-looking values (e.g., 89128.96)**: The low 4 bytes of a double whose high bytes form a large float. E.g., 0x4D03B0 reads as 89128.96 but is actually double 0.16. This is MORE dangerous than pattern 1 because the value looks like it could be a real game constant — it caused a major analysis error in July 2026 where mouse input force was initially reported as 89128.96 instead of 0.16.

**Verification method:**
```bash
# Check if the instruction uses QWORD (8 bytes) or DWORD (4 bytes)
r2 -q -e scr.color=0 -c 'aaa; s ADDR; pd 5' target_binary.exe
# Look for: fmul qword / fadd qword / fld qword = DOUBLE
#           fmul dword / fadd dword / fld dword = FLOAT
```

```python
import struct
# If QWORD, read 8 bytes and decode as double:
raw = bytes([...])  # 8 bytes from GhidraMCP read_memory
double_val = struct.unpack('<d', raw)[0]
```

For the full float-vs-double verification methodology (3 methods: byte inspection, Ghidra `_DAT` vs `__DAT` naming, x86 opcode verification), see `references/extracting-data-constants.md` § "Determining float vs double".
Full documentation: docs/agent-knowledge/INPUT_FORCE_SYSTEM.md § Ghidra Double-as-Float Pitfall

## Pitfall: Finding Per-Frame Update Functions via Vtable Discovery

When you need to find how an object is updated per-frame but can't find an update
function, the answer is often a **vtable-dispatched function that Ghidra missed**.

**Workflow (verified July 2026 — found CollisionFace_Update this way):**
1. Read the object's vtable address (from the constructor — look for `this->vtable = &PTR_xxx`)
2. `read_memory` at the vtable address, reading 16+ bytes (4 DWORD function pointers)
3. Parse each DWORD as a little-endian function pointer
4. For each pointer, call `get_function_by_address` — if "No function found", it's undiscovered
5. Call `create_function` for unknown addresses — this makes them decompilable
6. `decompile_function` on each newly created function
7. Look for state machine patterns (phase/timer fields, ball list iteration)

**Example:** CollisionFace (vtable 0x4D5768) had vtable[0] = 0x0043D160 which Ghidra
didn't recognize as a function. After `create_function` + `decompile_function`, it turned
out to be the 3-phase vacuum transport state machine (IDLE → SUCK → SHOOT → LAUNCH).
The entire vacuum tube mechanic was hiding in an undiscovered vtable slot.

**Key:** AthenaList-stored objects with vtables are ALWAYS updated per-frame via vtable[0].
If you see `AthenaList_Append(scene+0xNNNN, obj)` in setup code but can't find what reads
that list, look at the object's vtable — vtable[0] is the per-frame update.

## Pitfall: Unnamed Function Discovery — Prioritize by Xref Count

When asked to "find an unnamed function and identify it," don't just pick the first FUN_ you see. Use `search_functions_enhanced` with `has_custom_name=false`, `min_xrefs=3`, `sort_by=xrefs` to find the most impactful unnamed functions. Functions with 30+ xrefs are almost always core engine infrastructure.

**Workflow:**
1. Search for unnamed functions sorted by xref count (descending)
2. Skip trivial utility functions (Vec3_Copy, AthenaList_NextIndex — recognizable by tiny decompiled bodies)
3. Decompile the highest-xref non-trivial candidate
4. Get its callers via `get_function_callers` — caller names reveal the function's domain
5. If all callers are `*_Render` functions → it's a rendering helper
6. If callers include level/board update functions → it's game logic
7. Check for called functions that ARE named — they reveal what the unnamed function does
8. Rename + add plate comment documenting the full analysis

**Example:** FUN_0041B130 had 46 xrefs. Decompilation revealed it calls `WaterRipple_AdvancePhase`, `ScoreObject_ctor("RACE TIME:")`, `RaceResultPopup_ctor`, `Audio_PlayMusic("Game Over")`, and manages a countdown timer with phases. All callers were Board vtable methods. Conclusion: `Board_UpdateRaceState` — the main per-frame race state machine.

## Pitfall: "Patch Does Nothing" — Trace INSIDE the Target Function

When a patch to a dispatch condition (e.g., changing a JNZ to JMP in a
caller) has zero effect, the problem is INSIDE the function being called,
not in the dispatch logic. The called function may have its own internal
mode flags that change its behavior completely.

**Symptom:** You patch the caller to route entity balls to `Ball_Respawn`
instead of destroying them. The patch is correct (verified bytes, correct
jump target). But entity balls still "do nothing" — they don't respawn.

**Root cause:** `Ball_Respawn` itself checks `App+0x237` (arena flag) at
0x40580B and branches to a COMPLETELY DIFFERENT safespot search path:
- Race path (0x405811): nearest safespot via LGP — fast, reliable
- Arena path (0x405A80): random safespot + Mesh_FindClosestCollision
  validation — expensive, often fails → ball stays in place

The dispatch patch was redundant (entity balls already reached Ball_Respawn
via the arena flag check in the caller). The REAL fix was patching the
JNZ at 0x40580B INSIDE Ball_Respawn to NOP, forcing it to always use
the race path.

**Rule:** When a patch "does nothing":
1. Verify the target function is actually being called (check if the
   dispatch condition was already routing there via another path)
2. Decompile/disassemble the TARGET function, not just the caller
3. Look for internal mode checks (game mode flags, arena flags) that
   change the function's behavior
4. The real patch may be inside the target function, not in the caller

**Caught July 2026 (Arena Instant Respawn v1→v2→v3):** Two iterations
of patches to `Scene_UpdateBallsAndState` were no-ops because entity balls
already reached `Ball_Respawn` via the arena flag check at 0x41B5B9. The
actual problem was an internal branch in `Ball_Respawn` at 0x40580B that
picked a different (broken) search path in arena mode. Three script versions
were needed before tracing deep enough into the target function.

## Pitfall: ALWAYS Check ALL Callers Before Patching — Multi-Caller Functions

When patching a function's behavior, ALWAYS use `get_function_callers` first to find ALL call sites. A function may have multiple callers, each with different preconditions. Patching only one caller's dispatch path leaves the other callers' paths unpatched.

**Symptom:** You patch the dispatch in `Scene_UpdateBallsAndState` to route entity balls to `Ball_Respawn`. The patch is correct. But entity balls still don't respawn — or respawn incorrectly.

**Root cause:** `Ball_Respawn` has TWO callers:
1. `Scene_UpdateBallsAndState` (0x41B540) — checks `ball+0x2E8` (death_pending)
2. `ArenaBoard_Update` (0x420DA0) — checks `ball_Y < threshold` (Y-fall detection)

`ArenaBoard_Update` SKIPS entity balls entirely (`ball+0x18 >= 0` check). So even if you fix the dispatch in caller 1, entity balls never reach `Ball_Respawn` through caller 2.

**Rule:** Before patching any function's dispatch logic:
1. Call `get_function_callers` on the target function
2. Decompile EACH caller to understand its dispatch conditions
3. Check for caller-side filtering (e.g., `ball+0x18 >= 0` skips entity balls)
4. A patch to one caller may be a no-op if another caller already routes there
5. A patch to the target function itself (inside the function body) affects ALL callers

**Caught July 2026 (Arena Instant Respawn v1-v9):** Nine CEA versions failed because each version only addressed one aspect of a multi-system problem. The fix required patching the target function (Ball_Respawn) AND the SinkPlatform system (Scene_StartCountdown) simultaneously. Full iteration history: see `the target-re/references/arena-respawn-system.md`.

## Pitfall: Function Names Lie — Verify Which Level Board Actually Dispatches

Ghidra's auto-generated or prior-session function names can be misleading. A function
named `NeonCollisionEvents` (0x00410D00) handles `E:HEATON`/`E:HEATOFF` collision
strings — but it's the DispatchCollision vtable slot [29] for BOTH Neon AND Sky level
boards. The "Neon" prefix led to an initial wrong assumption that the magnifying glass
system was Neon-level content, when it's actually Sky Race (Level 9). The user corrected
this mid-session: "Actually, the magnifying glass and all related heating functions are
part of Sky race."

**Rule:** When a function name suggests a specific level/context, verify by checking
which level board vtables actually dispatch to it:
1. Read each level board's vtable (from its constructor's `this->vtable = &PTR_xxx`)
2. Check vtable slot 29 (DispatchCollision) — if multiple boards point to the same
   function, it's a shared handler, not level-specific
3. The actual level-specific setup (magnifier creation, mesh loading) is in the
   `Scene_SetupLevelN` function, NOT in the collision handler

Full magnifier/heat system analysis: see `references/pendulum-magnifier-object-analysis.md`

## Pitfall: D3D8 Render State Cache Defeats Hooks — Trace the Cache, Not Just the State

When hooking a D3D8 `SetRenderState` call (e.g., setting `D3DRS_FILLMODE` to wireframe),
the game may reset your state **during 3D rendering** via internal cache-guarded calls.
Multiple functions check a cached copy of the render state before calling `SetRenderState`;
if the cache says the state is already at the default value, they skip the call.

**Symptom:** Your hook at `Graphics_BeginFrame` sets FILLMODE=2 (wireframe), but 3D meshes
still render solid. The game resets FILLMODE to 1 (POINT) between your hook and the actual
mesh draw calls.

**Root cause:** Functions like `Ball_Render` (0x403DB8) and `FUN_00402860` check a cache
byte at `graphics+0x70D` before calling `SetRenderState(7, 1)`. If the cache already
equals 1, they skip the call — but your hook changed the actual state without updating the
cache, so they fire and override your setting.

**Fix:** After setting the real D3D8 state, also write the cache value that makes the game
think the state is already at its default. For FILLMODE: write `1` to `graphics+0x70D`
after `SetRenderState(7, 2)`. The game sees cache=1, skips the override, and your wireframe
setting persists on the GPU.

**General workflow for ANY cached render state:**
1. `search_byte_patterns` for the state constant (e.g., `6A 07` for FILLMODE=7)
2. Check each hit — is it inside a function that runs after your hook?
3. Decompile the containing function — look for `CMP byte ptr [gfx+offset], value; JZ skip`
4. Write that cache value in your hook after setting the real state
5. Verify with `search_byte_patterns` that you found ALL reset paths (different caches
   may guard different reset calls)

Full details + CEA template: `the target-dll-modding/references/d3d8-render-state-cache-trick.md`

## Pitfall: User Game Knowledge Exceeds Decompiled Code — Defer to User on Game Mechanics

Decompiled code shows WHAT the game does mechanically, but not WHY. The reason
for a design choice (like using vertex deformation vs matrix transforms) often
comes from game knowledge that isn't visible in the binary.

**Caught July 2026 (sess9975):** Analysis concluded that the Dizzy Swirl uses
matrix transforms because "it's a smooth cylinder" and recommended this approach
for a global ref mod. The user corrected: the Toob Spinny uses vertex deformation
because it has "a small asymmetric hole that goes through it that the ball has
to go through. The hole has to move." This design rationale was invisible in
the decompiled Rotator_Update — it only shows vertex copying, not WHY the
vertices need to be copied.

**Rule:** When a user explains the gameplay reason for a technical implementation
choice, encode it immediately. The user's game knowledge exceeds AI interpretation
of decompiled code. Don't just update memory — update the skill/reference doc so
future sessions start with the correct understanding.

## Pitfall: Vtable Block Dump Misread — Verify Slot Values via Direct 4-Byte Reads

When mapping which function each level board's vtable dispatches (e.g., vtable[33] = dynamic object creation), do NOT read large vtable blocks (e.g., 144 bytes) and compute slot offsets from the raw dump. This leads to **misidentification of shared functions** across levels.

**Symptom (caught July 2026, sess9975):** Initial analysis read 144-byte vtable blocks and computed `vtable+0x84` (slot 33) for 15 level boards. The result showed 3 functions "shared" across multiple levels (e.g., one function for "WarmUp/Beginner/Glass", another for "Dizzy/Sky/Neon"). The user challenged this — "Are you sure this is used by Sky and Neon? This *only* references objects from Dizzy Race."

**Root cause:** Reading a 144-byte block and parsing it as an array of DWORDs is error-prone — the starting offset within the block may be miscalculated, or the vtable start address itself may be wrong. This produced wrong function pointers for most levels.

**Correct method:** For each vtable, read exactly 4 bytes at `vtable_address + slot_offset`:
```python
# vtable[33] = offset 0x84 (33 * 4 = 132 = 0x84)
read_memory(vtable_addr + 0x84, length=4)
# Parse as little-endian DWORD → function pointer
```

**Verification method — xref uniqueness:** After identifying a function pointer from a vtable slot, call `get_xrefs_to(address=function_addr)` on it. If the function is level-specific, it will have exactly ONE xref — from its vtable's data address. If multiple xrefs exist, the function IS shared across vtables.

**Result:** When re-verified this way, ALL 15 level boards turned out to have unique vtable[33] functions — zero sharing (except WarmUp/Beginner which genuinely share the same no-op stub). The original "3 shared functions" claim was completely wrong.

**Rule:** Never trust computed offsets from block dumps for vtable slot resolution. Read the exact 4 bytes at `vtable_addr + (slot * 4)` for each slot, and verify uniqueness via xrefs.

## Pitfall: False "Render Code Reads This Offset" Claim — VERIFY Reads via Binary Search

**CORRECTED (sess15293):** An earlier version of this pitfall (sess280) claimed that
bumper lit flags at board+0x53FC were "WRITE-ONLY decay timers — NO render function
reads them" and that "the visual lit effect comes from the mesh's own collision vtable
dispatch, not from polling these float values."

**This was WRONG.** Decompilation of `Scene_RenderReflectiveObjects4` (0x00412DC0)
revealed it DOES read board+0x53FC every frame. For each of 4 bumpers (loop count=4,
bumper objects at board+0x439C with stride 0x418), it checks `if (lit_value != 0.0)`
and when lit, creates a RenderContext override with:
- Emissive = (1.0, 1.0, 1.0, 1.0) — pure white emission
- Diffuse/Ambient alpha = lit_value (fades 1.0→0.0 over 20 frames)
- Sets gfx+0x7C0 = &RenderContext (material override pointer)

The decay rate is 0.05/frame (double at 0x4CF428), giving a 20-frame (~0.33s at 60fps)
flash duration. When lit_value < 1.0, the render path enables ALPHATESTENABLE with
ALPHAOP=MODULATE for the fade-out effect.

The original objdump search found only the collision WRITE because it searched for
the literal hex offset 0x6428 — but `Scene_RenderReflectiveObjects4` accesses the
flags via a pointer (`LEA EBX, [EDI+0x53FC]` then `FLD [EBX]` in a loop), which
objdump grep for the raw constant wouldn't match as a simple offset reference.

**Root cause of the error:** The original search used `objdump | grep 0x6428` which
only catches direct absolute addressing. The render function uses register-relative
addressing (`[EDI+0x53FC]`, `[EBX]` after LEA), which requires disassembly analysis
to find, not a simple grep.

**Rule:** Before claiming "no render function reads offset X":
1. Use GhidraMCP `search_byte_patterns` for the offset bytes (e.g., `FC 53 00 00`)
2. Check EACH hit — use `get_function_by_address` to see what function it's in
3. Look for `FLD`/`FCOMP`/`FSTP` instructions (float read/compare/store) in the hits
4. Do NOT rely solely on `objdump | grep <hex>` — it misses register-relative addressing
5. The search must cover BOTH direct (`MOV reg, [base+0xNNNN]`) and indirect
   (`LEA reg, [base+0xNNNN]; FLD [reg]`) access patterns

**User preference:** When there IS a genuine read/write mismatch,
the user prefers HOOKING THE READER to redirect it to the unified
offset — NOT writing to the original per-level offset. Unified offsets
exist to make features work on ALL levels, not just the original ones.
Writing to per-level offsets defeats the purpose of unification.

## Pitfall: Fabricated Field Semantics — Trace the Readers/Writers BEFORE Naming

When decompiling a constructor that writes values to struct fields, NEVER name
or describe those fields based on the values alone. You MUST trace what actually
reads the field at runtime before assigning a semantic meaning. Plausible-sounding
guesses are the #1 source of propagated documentation errors.

**Three corrections in a single session (sess10923):**

1. **board+0x1508 (Vec3 RGBA)** — Initially called "gravity vectors" because the
   values looked like directional components (1.0, 0.0, 1.0). User corrected:
   "Levels all have the same gravity. It's always down on the Y axis." The values
   are actually per-level **RGBA color values** (R, G, B floats with A=1.0 hardcoded
   by Vec3_Init). They're used for timer blot colors — WarmUp=(1,0,1)=magenta,
   Dizzy=(0,1,0)=green, Expert=(1,0,0)=red. The user identified the pattern from
   the color values matching level themes.

2. **Beginner's 8 AthenaLists at board+0x436C** — Initially called "cascade water
   animation vertex lists" because the `_eh_vector_constructor_iterator_` call
   allocated 8 elements of 0x418 bytes. User corrected: "there's no water animation
   used anywhere in the game." Tracing the vtable[18] function (`Beginner_SetupScene`)
   revealed it loops 8 times calling `Scene_CollectByNameFilter("N:BUMPER%d")` —
   the lists collect BUMPER1-BUMPER8 mesh objects. Completely fabricated the
   "water animation" description with zero evidence.

3. **App+0x85X flags** — Initially called "difficulty flags" because they were set
   conditionally based on App+0x23C (difficulty field). User corrected: "Difficulty
   isn't set by the individual level." Decompiling `App_SaveSettings` revealed they're
   **race unlock flags** persisted to the Windows Registry (DizzyRace, TowerRace,
   etc.) and read by PracticeMenu_ctor to show "LOCKED DIZZY" in the menu.

**Root cause pattern:** In all three cases, I looked at the WRITE side (constructor
code that sets the values) and guessed the semantic meaning from the values themselves,
without tracing the READ side (what code consumes those values at runtime). The
"gravity" guess came from 3 float values that looked like a direction vector. The
"water animation" guess came from an array allocation with no trace of what fills
it. The "difficulty flags" guess came from a conditional check on the difficulty field.

**Rule: NEVER name a struct field based on the values written to it. ALWAYS:**
1. Decompile the constructor to see what values are written
2. `search_byte_patterns` for reads of that offset (e.g., `8A ?? 51 08 00 00` for byte reads of offset 0x851)
3. Decompile the functions that READ the field — their behavior reveals the true meaning
4. Only name the field after you've seen both the writer AND the reader
5. If you can't find readers, say "unknown purpose" — do NOT guess

**The user's domain knowledge exceeds AI pattern-matching.** In case 1, the user
identified the values as RGB colors by matching them to level themes. In case 2,
the user knew there's no water in the game. In case 3, the user knew difficulty
isn't per-level. Always defer to user game knowledge when your decompilation-based
guess conflicts with what the user says about the game.

## Pitfall: Game Function Side Effects (Sound, State)

When you want the physics effects of a game function but not its side effects
(e.g., `Ball_Shrink` sets radius + physics_scale + plays a sound), **inline the
specific field writes** instead of calling the function:

```c
// Instead of: Ball_Shrink(ball);  ← plays Sound_Play3D
// Do:
ball[0x284] = 0x41500000;  // radius = 13.0
ball[0x188] = 0x40200000;  // physics_scale = 2.5
ball[0xC4C] = 1;           // is_shrunk
```

This avoids side effects you don't want while getting the exact same state changes.

## Pitfall: NEVER Guess Function RVAs — Always Look Up in Ghidra

When adding new function pointers to a mod, NEVER guess the RVA (address - 0x400000).
Always use Ghidra's `search_functions?name_pattern=...` to find the correct address.
Guessing leads to calling the wrong function or random bytes.

**Caught July 2026 (sess13734):** Three AthenaList function RVAs were guessed
instead of looked up. ALL THREE were wrong:

| Function | Guessed RVA | Actual function at guessed addr | Correct RVA |
|----------|------------|--------------------------------|-------------|
| AthenaList_Append | 0x53100 | `Rect_ContainsPoint` (!!) | 0x53810 |
| AthenaList_GetSize | 0x53080 | No function (random bytes) | 0x536A0 |
| AthenaList_GetIterator | 0x530A0 | No function (random bytes) | 0x532B0 |

`AthenaList_Append` at the wrong address was `Rect_ContainsPoint` — calling it
with AthenaList arguments would silently corrupt state (wrong parameter count,
wrong return type, wrong struct offsets). The other two pointed to random
code/data — calling them would crash immediately.

**Additional gotcha: function overloads.** Ghidra often lists multiple functions
with the same name at different addresses (e.g., `AthenaList_Append` at both
0x453780 and 0x453810). To determine which one the original game code calls,
disassemble the original call site (e.g., `disassemble_function` on the Dizzy
scene loader) and check the `CALL` target address.

**Correct workflow:**
1. `search_functions?name_pattern=FunctionName` in Ghidra
2. If multiple results, disassemble the original call site to determine which
3. RVA = address - 0x400000
4. Verify by decompiling the function at that address — check the signature matches

## Pitfall: (int)float Cast Loses IEEE 754 Bits — Use memcpy for Bit-Exact Storage

When storing float values into int arrays (common when writing to game struct
fields via `int*` pointers), NEVER use `(int)floatVar` — this converts the
float to an integer (e.g. `100.0f → 100 = 0x64`), losing the IEEE 754 bit
pattern. When the game reads the field back as a float, it gets `1.4e-43 ≈ 0`
instead of the intended value.

**Caught in LevelFeatures_Loader v6 code review (sess15323):**
```c
// WRONG — converts float to int, loses bit pattern:
bb[0x59] = (int)spawnX;       // 100.0f → 100 → game reads 1.4e-43
bb[0x5A] = (int)(spawnY + 24.0f);

// CORRECT — memcpy preserves IEEE 754 bits:
memcpy(&bb[0x59], &spawnX, sizeof(int));
float spawnYPlus24 = spawnY + 24.0f;
memcpy(&bb[0x5A], &spawnYPlus24, sizeof(int));
```

**Alternative:** `bb[0x59] = *(int *)&spawnX;` also works but triggers
`-Wstrict-aliasing` warnings. Use `memcpy` for warning-free portable code.

**General rule:** ANY time you write a float value to a struct field that
the game reads as a float (position, velocity, radius, angle), you MUST
preserve the IEEE 754 bit pattern. The only correct methods are:
- `memcpy(&intArray[N], &floatVar, sizeof(int))`
- `*(int *)&floatVar` (with strict-aliasing warning)
- Union type punning

**Never use `(int)floatVar`** for struct field writes — it's a value
conversion, not a bit copy.

## Pitfall: Calling Convention Verification via Disassembly

When a game function is used via a typedef'd function pointer in mod code,
ALWAYS verify the calling convention by disassembling the first few
instructions of the actual function. The wrong convention silently corrupts
the stack or clobbers the `this` pointer.

**This bug has three manifestations** (all found in LevelFeatures_Loader
code reviews across sess52, sess15323, sess237):

1. **Function pointer typedefs** — `__fastcall` on a 2+ param typedef
   causes EDX to steal the 2nd param and stack cleanup mismatch.
   Fix: use `__thiscall` for member functions, `__stdcall` for non-member,
   `__cdecl` for variadic.

2. **Inline vtable casts** — `(void (__fastcall *)(DWORD, float, ...))vtbl[N]`
   has the same EDX/stack problem. Fix: use `__thiscall` in the cast.

3. **Missing `this` pointer** — Some `__thiscall` functions need a `this`
   pointer that the typedef completely omits. Gfx functions
   (`Gfx_ScaleX/Y/Z`, `Gfx_SetPosition`) are `__thiscall` with ECX=gfx
   pointer, but the original typedefs had no `void *gfx` param:
   ```c
   // WRONG — missing gfx this-pointer
   typedef void (__fastcall *Gfx_ScaleFn_t)(float val);
   // CORRECT — gfx as first param (this pointer)
   typedef void (__thiscall *Gfx_ScaleFn_t)(void *gfx, float val);
   ```
   Gfx pointer: `void *gfx = *(void **)(app + 0x174);`

**Verification method (no Ghidra needed):**
```python
import struct
with open('target_binary.exe', 'rb') as f:
    f.seek(rva)  # file offset = RVA for this binary
    bytes_hex = f.read(16).hex(' ')
# Look for: MOV ESI, ECX (8B F1) = __thiscall
#           MOV EDX, [ESP+4] early = __fastcall (EDX = 1st param)
#           No ECX/EDX setup = __cdecl
```

**Full details on all three patterns:**
`the target-dll-modding/references/c-code-review-bug-patterns.md` §2

## Pitfall: __fastcall vs __thiscall for Vtable Slot Replacements (CRITICAL)

When replacing C++ virtual function (vtable) slots in a `__thiscall`-based game,
declaring the replacement function as `__fastcall` causes silent parameter
corruption and stack imbalance for ANY function with 2+ parameters.

**Root cause:** The game dispatches vtable calls using `__thiscall`:
- ECX = `this`, remaining params on stack, callee cleans ALL stack params

MinGW `__fastcall` with 2+ params puts the 2nd param in EDX (not on stack),
and cleans fewer bytes from the stack. The game caller doesn't know this —
it pushed all params on stack expecting the callee to read them there.

**The 1-param exception:** For functions taking only `(void *this)`, `__fastcall`
and `__thiscall` are identical (ECX=param, `ret $0`). This is why some vtable
replacements appear to work — they have only 1 parameter.

**Verification via compiler disassembly:**
```bash
# __thiscall with 3 params: 2nd param from [ESP+4], ret $8
i686-w64-mingw32-gcc -O0 -c -o test.o test.c
i686-w64-mingw32-objdump -d test.o
# __thiscall: mov 0x8(%ebp),%eax  ; ret $0x8
# __fastcall: mov %edx,-0x18(%ebp) ; ret $0x4  ← EDX read (WRONG for vtable)

# __thiscall with 5 params: 2nd param from [ESP+4], ret $16
# __fastcall with 5 params: 2nd param from EDX, ret $12  ← WRONG
```

**Fix:** Use `__thiscall` instead of `__fastcall` for vtable replacement
functions with 2+ params. MinGW supports `__thiscall` as a function attribute:
```c
// WRONG — 2nd param read from EDX (garbage), stack cleanup wrong
void __fastcall UniversalDispatchCollision(void *board, int *ball, int *collPair) {
// CORRECT — 2nd param read from stack, correct ret $8
void __thiscall UniversalDispatchCollision(void *board, int *ball, int *collPair) {
```

**Detection rule:** For every vtable slot replacement:
1. Does the original game function take 2+ params?
2. Is the replacement declared `__fastcall`?
3. If both → BUG. Change to `__thiscall`.

**Quick scan command:**
```bash
grep -n "void __fastcall.*Universal\|void __fastcall.*Hook_" mod.c | grep -v ', \*board)'
# Any result with 2+ params in the signature is a potential bug
```

**Caught in LevelFeatures_Loader v7 code review (sess52):**
- Slot 29 (DispatchCollision): `__fastcall(board, ball, collPair)` — ball from EDX (garbage), ret $4 instead of $8
- Slot 33 (CreateDynamicObjects): `__fastcall(board, name, out1, out2, s1data)` — name from EDX (garbage), ret $12 instead of $16
- Slots 1 and 19 (1-param functions) were SAFE — `__fastcall` == `__thiscall` for single-param functions.

## Pitfall: Vtable Slot With Mixed Param Counts — Two Call Sites, Different RET N (sess858)

When replacing a vtable slot that the game calls from MULTIPLE call sites with
different parameter counts, the replacement function MUST match the call site
that pushes the MOST params. A function with too few params leaves extra bytes
on the stack, corrupting the caller's return address.

**Symptom:** Crash at an address inside dead code (no callers, no xrefs, not
in any vtable). The dead-code address is a symptom of a garbage return address
from stack misalignment. Example: crash at 0x452783 (inside a `PUSH $0x3F800000`
instruction in an unreachable tournament-results function) was actually caused
by a 4-byte stack imbalance in the vtable slot 24 replacement.

**How to detect:** Search the binary for ALL `call [reg+0xNN]` instructions
that match the vtable slot offset. Compare how many params each call site pushes:

```python
# Find all call sites for vtable slot 24 (offset 0x60)
import struct
with open('target_binary.exe', 'rb') as f:
    f.seek(0x1000)  # .text section
    text = f.read(0xcd58a)

text_vma = 0x401000
for i in range(len(text) - 3):
    if text[i] == 0xFF and (text[i+1] & 0xC0) == 0x40 and \
       ((text[i+1] >> 3) & 7) == 2 and text[i+2] == 0x60:
        call_addr = text_vma + i
        # Check if there's a PUSH before the call (extra param)
        has_push = text[i-1] in [0x50,0x51,0x52,0x53,0x56,0x57] or text[i-2] == 0x6A
        print(f"0x{call_addr:08X}: call [reg+0x60]  push_before={has_push}")
```

**Case study (target application vtable slot 24, sess858):**

The game has two call sites for vtable[24] (offset +0x60):
1. `0x0046C8C7` — `ECX=board`, no stack params → expects `RET 0`
2. `0x0046C9F0` — `ECX=board`, `PUSH EDI` → expects `RET 4`

Original per-level render functions handle both:
- `Level_RenderDynamicObjects` (0x40B420): `__fastcall(board)` → `RET 0` (1 param)
- `Scene_RenderReflectiveObjects7` (0x411380): `__thiscall(board, param_2)` → `RET 4` (2 params)
- `Scene_RenderWithCamera` (0x40DFA0): `__thiscall(board, param_2)` → `RET 4` (2 params)

UniversalRender was declared `__fastcall(board)` → `RET 0`. When call site #2
pushed EDI and called UniversalRender, the 4 extra bytes were never cleaned.
The caller's `RET $0x4` popped a corrupted return address → EIP landed in dead code.

**Fix:** The replacement function must accept the MAXIMUM param count and do
`RET N` for the largest N. Use a naked wrapper:

```c
__attribute__((naked)) static void UniversalRenderEntry(void) {
    __asm__ __volatile__(
        "pushl %%ebp\n\t"
        "movl %%esp, %%ebp\n\t"
        "pushl %%ecx\n\t"
        "call _UniversalRenderImpl\n\t"
        "popl %%ecx\n\t"
        "popl %%ebp\n\t"
        "ret $4\n\t"  // clean the extra param from call site #2
        :: : "eax", "edx", "memory"
    );
}
```

**Rule:** Before replacing ANY vtable slot, scan ALL call sites for that slot
offset. If different call sites push different numbers of params, the
replacement MUST match the highest param count. A 1-param replacement for
a slot that some callers invoke with 2 params will corrupt the stack for
those callers.

**Previous wrong diagnosis:** An earlier session (sess374) blamed a `memset`
for zeroing Board_ctor data. While the memset was harmful, it was NOT the
crash cause. The crash ONLY occurred when slot 24 was patched to
UniversalRender. With slot 24 disabled, the memset caused visual bugs but
no crash. Always test with and without the vtable patch to isolate the
true cause.

## Pitfall: MWParser_ReadTag Tag Destructor — Double Dereference (sess492)

When porting Ghidra decompiled code that calls `MWParser_ReadTag`, the
returned tag object's destructor must be called with a **double
dereference**, not a single one.

**Ghidra shows:** `(**(code **)*puVar4)(1);`
This means: `puVar4[0]` is a pointer to a vtable, and `vtable[0]` is the
destructor function. Two dereferences are needed.

**Wrong port (single dereference):**
```c
// Executes the vtable pointer itself as code → crash in bass.dll
((void (__thiscall *)(DWORD))tag[0])(1);
```

**Correct port (double dereference):**
```c
DWORD *vtable = *(DWORD **)tag[0];
if (vtable) {
    void (__thiscall *dtor)(DWORD) = (void (__thiscall *)(DWORD))vtable[0];
    if (dtor) dtor(1);
}
```

**Detection:** Search for `tag[0](` or `puVar4[0](` in ported code.
Any direct function call on `tag[N]` without double-dereferencing is
this bug. Cross-reference with Ghidra's `(**(code **)` pattern.

**Found in:** E:GRAVITY collision handler in UniversalDispatchCollision.
The crash appeared as `bass.dll+0xA1B8` (inside our DLL) when touching
a gravity plane in Odd Race.

## Pitfall: Unified Offset Zone Isolation — Verify NO Unreplaced Function Reads Unified Data

When a mod replaces per-level board data with a unified offset zone (e.g.,
0x6500-0xAB00), you MUST verify that NO unreplaced game function reads from
or writes to the unified zone. If any do, they'll read the mod's data instead
of expected per-level data — silent corruption, not a crash.

**Verification procedure (sess440, LevelFeatures_Loader):**

1. Read all 15 level vtables via `read_memory` (each is ~0x90 bytes, 36 slots)
2. Identify which slots the mod replaces (e.g., 1, 19, 29, 33)
3. Batch-decompile ALL unreplaced slot functions + Board_Setup callees:
   - Board_ctor, Board_Setup, Board_UpdateRaceState, Scene_Update
   - Level_InitScene, DispatchCollisionEvents
   - CreateBadBalls, CreateMouseTrap, CreateSecretObjects
   - Scene_CreateDynamicObjects, Scene_CreateFlags, Scene_CreateSigns
4. For each decompiled function, use Python regex to find references in
   the unified zone range:
   - `param_1[0xN]` where N*4 falls in [unified_lo, unified_hi]
   - `param_1 + 0xN` where N falls in [unified_lo, unified_hi]
5. Any hit = that function needs a hook or the offset needs redirection

**Python batch check:**
```python
import re
unified_lo, unified_hi = 0x6500, 0xAB00
for m in re.finditer(r'param_1\[0x([0-9a-f]+)\]', code):
    byte_off = int(m.group(1), 16) * 4
    if unified_lo <= byte_off <= unified_hi:
        print(f"  UNIFIED REF: param_1[0x{m.group(1)}] = board+0x{byte_off:X}")
for m in re.finditer(r'param_1 \+ (0x[0-9a-f]+)', code):
    byte_off = int(m.group(1), 16)
    if unified_lo <= byte_off <= unified_hi:
        print(f"  UNIFIED REF: param_1 + {m.group(1)}")
```

**Result for LevelFeatures_Loader (sess440):** All 14 functions verified
clean — zero references to the unified zone. Board_Setup only uses base
board offsets (0x8B8, 0xCD4, 0x10EC — all below 0x4000) initialized by
Board_ctor. The functions Board_Setup calls iterate the meshworld object
database and append to board lists at base offsets — also safe.

**Key insight:** The unified zone is completely isolated from original
game code. No offset redirection is needed when the mod replaces ALL
code paths that would read/write per-level data (vtable slots 1, 19, 29, 33).

## Pitfall: MeshNode_ctor vs Level_MeshWorldCtor — .MESH vs .MESHWORLD Loading

The game has TWO completely different mesh loading pipelines. Using the wrong one
for .MESH files causes `MessageBoxA("COULD NOT LOAD") + exit()` — an instant crash.

**`Level_MeshWorldCtor` (0x461510)** — loads `.MESHWORLD` (binary) and `.ASE` (text):
- Creates a 0x10D0-byte Level struct with AthenaLists, SceneObject, spatial trees
- Calls `LoadMeshWorld` which checks `path.meshworld` existence via `_check_file_access` (0x4C8FF7)
- If file missing: tries ASE text parse → fails → `MessageBoxA + exit()` → CRASH
- Use this for all `levels\*.MESHWORLD` files

**`MeshNode_ctor` (0x471C20)** — loads `.MESH` (D3DX binary):
- Creates a 0x18-byte MeshNode wrapper (vtable 0x4D614C)
- Internally allocates 0x488-byte MeshWorld via `MeshWorld_ctor` (0x4706E0)
- Formats `path.mesh`, checks existence, loads via `meshworld->vtable[1](path)`
- MeshNode layout: +0x04 gfx_device, +0x08 MeshWorld*, +0x0D has_mesh flag
- Use this for all `meshes\*.MESH` files (8Ball, Bell, Chomper, Fan, etc.)

**MeshWorld swap technique (for .MESH entities with collision):**
1. Load Swirl .MESHWORLD as placeholder via `Level_MeshWorldCtor`
2. Create PopCylinder with Swirl (gets proper vtable, position, collision)
3. Swap `obj+0x08` (MeshWorld\*) → point to .MESH MeshWorld from MeshNode
4. Render function reads .MESH MeshBuffers (correct model), collision stays Swirl

**Why direct MeshNode registration fails:** MeshNode (0x18 bytes) is too small
for the render list — `Stands_ctor` reads Level offsets (+0x430, +0x480, +0x18)
beyond MeshNode's allocation. The render loop expects PopCylinder vtable (0x4D58F0),
not MeshNode vtable (0x4D614C).

**File existence check pattern:** ALWAYS call `_check_file_access(path, 0)` before
`Level_MeshWorldCtor` — returns 0 if exists, 0xFFFFFFFF if not. Prevents crash.

## Pitfall: Color_RandomRGBA Is NOT Random — Misnamed Float-to-D3DCOLOR Converter

`Color_RandomRGBA` (0x0040A050) sounds like it generates random RGBA
colors. It does NOT. It converts a float[4] color struct to a packed
D3DCOLOR (uint32 ARGB). The function is `__thiscall(ECX = color_struct_ptr)`
and reads R,G,B,A floats at ECX+0x4/+0x8/+0xC/+0x10, multiplies each by
255.0, and packs via `__ftol2`.

**How the error manifested:** An earlier session claimed the original game
uses a "hardcoded blue-tinted D3DRS_AMBIENT (~0.35, 0.39, 0.55)". This was
actually the reimplementation's approximation for Wine/llvmpipe. The
original game reads per-level ambient from the MESHWORLD file via
`Level_InitScene` (0x0040B090) → `Color_RandomRGBA` → `Gfx_SetAmbient`
(0x00453BA0). The name "RandomRGBA" misled analysis into thinking the
ambient was either random or a fixed constant.

**Rule:** When a function name suggests randomness or generation, verify
by decompiling — it may be a converter/formatter. Full chain documented in
`references/ambient-fog-lighting-chain.md`.

## Pitfall: "Dead Code" Misdiagnosis — Search for Collision Activators Before Declaring Dead

**CORRECTED (sess2662):** An earlier version of this pitfall declared the
NeonPlatform update function "dead code." This was WRONG. The user corrected:
"they *do* move down and then back up whenever the ball touches them."
The N:NEONPLATFORM collision event (in Neon board vtable[29] at 0x416C9A)
calls FUN_00437300 which sets `active=1`, `direction=1`, `tick=300`.
The update function DOES run after collision triggers it.

**Lesson:** When you find an `active=0` gate in a constructor:
1. Search for static writes to the offset (byte pattern search)
2. ALSO decompile the level collision handler (vtable[29]) — collision events
   can set flags at runtime that aren't visible in constructor writes
3. ALSO check Board_UpdateRaceState for per-frame conditional activations
4. If the user says the behavior happens, TRUST THEM — search harder

**Corrected analysis:** see `references/arena-stands-appear-disappear-system.md`

## Pitfall: LoadConfig Zeroing Before File-Open Check

When a config parser zeroes global state before checking if the config file
exists, a transient file-open failure (file locked, permissions, timing)
silently disables ALL features. Always open the file FIRST, then zero state
only after confirming the file is readable.

**Caught in LevelFeatures_Loader v6 code review (sess15323):**
```c
// WRONG — zeroes state before checking file:
memset(g_objectEnabled, 0, sizeof(g_objectEnabled));
HANDLE hFile = CreateFileA(...);
if (hFile == INVALID_HANDLE_VALUE) return; // state already zeroed!

// CORRECT — check file first, then zero:
HANDLE hFile = CreateFileA(...);
if (hFile == INVALID_HANDLE_VALUE) return;
memset(g_objectEnabled, 0, sizeof(g_objectEnabled));
```
