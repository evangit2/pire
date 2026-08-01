# Ghidra DWORD Array Index vs Byte Offset — The #1 Offset Bug Pattern

## The Problem

When Ghidra decompiles a function that receives a pointer to a struct (e.g., `int *param_1`),
it shows struct field accesses as **array index** notation:

```c
param_1[0x10E3] = (int)((float)param_1[0x10E3] + fVar1);
```

This looks like "access element 0x10E3 of an int array" — but `param_1` is `int*`, so
`param_1[0x10E3]` is actually at **byte offset `0x10E3 * 4 = 0x438C`**.

If you copy these indices directly into C mod code as byte offsets:
```c
// WRONG — treating Ghidra's array index as a byte offset:
*(float *)((char *)board + 0x10E3) += 1.0f;
```
You read/write at 1/4 of the intended offset, landing in unrelated struct memory. The mod
**compiles fine and doesn't crash** (the wrong offset is still within the allocated struct),
but every feature block that reads these fields gets garbage values and silently does nothing.

## How to Detect It

### Pattern 1: `param_1[N]` where N > 0x100

Ghidra's `int *param_1` means every `param_1[N]` is a DWORD (4-byte) access at byte
offset `N * 4`. If N is in the range 0x1000–0x2000, the byte offset is 0x4000–0x8000.

### Pattern 2: `param_1 + N` passed to functions

```c
AthenaList_GetSize((int)(param_1 + 0xD8B));
```
This is `int*` arithmetic: `param_1 + 0xD8B` = byte address `param_1 + 0xD8B * 4`. The
byte offset is `0xD8B * 4 = 0x362C`.

### Pattern 3: `*(float *)(ptr + N)` where ptr is a direct pointer (NOT int*)

```c
fStack_ac = *(float *)(iVar4 + 0x10E0);
```
Here `iVar4` is declared as `int` (a raw pointer cast to int). `iVar4 + 0x10E0` is
**byte addition**, NOT int* arithmetic. The byte offset IS 0x10E0. This is correct as-is.

### Distinguishing Pattern 1/2 from Pattern 3

| Ghidra Syntax | Variable Type | Actual Byte Offset |
|---------------|--------------|-------------------|
| `param_1[0x10E3]` | `int *param_1` | `0x10E3 * 4 = 0x438C` |
| `param_1 + 0xD8B` | `int *param_1` | `0xD8B * 4 = 0x362C` |
| `*(float *)(iVar + 0x10E0)` | `int iVar` | `0x10E0` (already byte offset) |
| `*(int *)(iVar8 + 0x2CC)` | `int iVar8` | `0x2CC` (already byte offset) |

**Rule:** `ptr[N]` or `ptr + N` where ptr is `int*` → multiply N by 4.
`*(type *)(rawPtr + N)` where rawPtr is `int` or `void*` → N IS the byte offset.

## How to Verify

### Method 1: Cross-reference against known offsets

If you have any known byte offset in the same struct (e.g., `board+0x868` = board name
pointer), check if `N * 4` matches a known field. Example:

```
BRD_BRIDGE_RENDER was 0x10DB (Ghidra index)
0x10DB * 4 = 0x436C
Known: board+0x436C = BRIDGE_MESHWORLD (verified from mesh load table)
→ Confirmed: 0x10DB was a Ghidra index, actual byte offset is 0x436C
```

### Method 2: Check the x86 disassembly

The disassembly uses byte offsets directly:
```asm
FLD float ptr [ESI + 0x438c]    ; ← byte offset 0x438C
FSTP float ptr [ESI + 0x438c]   ; ← same byte offset
```

Compare to the Ghidra decompilation:
```c
param_1[0x10e3] = ...  ; ← 0x10E3 * 4 = 0x438C ← matches disasm
```

If the disasm shows `[ESI + 0x438C]` but your code uses `0x10E3`, you have the bug.

### Method 3: Float stride check

If consecutive float fields are at `+0`, `+1`, `+2` (1-byte strides), that's impossible —
floats are 4 bytes. The Ghidra indices are `+0`, `+1`, `+2` but actual byte offsets are
`+0`, `+4`, `+8`.

## The AthenaList Struct Layout (Critical Sub-Pitfall)

AthenaList is NOT a simple 16-byte struct. The internal layout is:

| Offset | Field | Size |
|--------|-------|------|
| +0x000 | GetIterator base | 4 bytes |
| +0x004 | count | 4 bytes |
| +0x008 | iterator array[0] | 4 bytes each |
| +0x40C | data array pointer | 4 bytes |

Total struct size: ~0x410 bytes.

**Bug pattern:** Code that assumes `list + 0xC` is the data array pointer. It's actually
at `list + 0x40C`. The original Ghidra code shows `param_1[0x11E1]` for the array pointer,
which is `0x11E1 * 4 = 0x4784`. If `list_base = 0x4378`, then `0x4784 - 0x4378 = 0x40C`.

## Case Study: LevelFeatures_Loader (sess14636)

30+ board field offsets were all Ghidra DWORD indices used as byte offsets. Every feature
block (bridge animation, swirl zones, windmill, badball spawner, bumper decay, neon camera,
sky popcylinder) was silently non-functional. The mod compiled, didn't crash, and passed
35-second Wine survival tests — but no game mechanics actually ran.

| Define | Old (index) | New (byte) | Verified Against |
|--------|-------------|------------|-----------------|
| BRD_BRIDGE_RENDER | 0x10DB | 0x436C | BRIDGE_MESHWORLD |
| BRD_BRIDGE_ANGLE | 0x10E0 | 0x4380 | BRIDGE_PARAM1 (45.0f) |
| BRD_SWIRL_MESH1 | 0x12EA | 0x4BA8 | WaterWheel mesh slot |
| BRD_SWIRL1_SPEED | 0x12F0 | 0x4BC0 | swirl state init |
| BRD_WM_ANGLE | 0x10E3 | 0x438C | Tower disasm [ESI+0x438C] |
| BRD_BB_FLAG | 0x10DC | 0x4370 | Odd disasm |
| Ball list base | 0xA75 | 0x29D4 | Dizzy decompilation |
| Ball list array | 0xB78 | 0x2DE0 | = 0x29D4 + 0x40C |
| Race ball list | 0xD8B | 0x362C | Different list from ball iteration |
| Particle list | 0xEC0 | 0x3B00 | AthenaList_Append target |

## Fix Checklist

1. Find every `param_1[N]` access in the Ghidra decompilation where N > 0x100
2. Multiply by 4 to get byte offset
3. Cross-reference against known offsets (mesh tables, verified fields)
4. Verify with x86 disassembly if available — `[ESI + offset]` in disasm = byte offset
5. Check for AthenaList iteration code — the array pointer is at `list + 0x40C`, NOT `list + 0xC`
6. Watch for `param_1 + N` passed to functions — this is also `int*` arithmetic (N × 4)
7. Do NOT convert `*(float*)(ptr + N)` where ptr is a direct pointer — N IS the byte offset there

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
calls, not a background thread.
