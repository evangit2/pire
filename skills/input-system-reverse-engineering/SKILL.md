---
name: input-system-reverse-engineering
description: Reverse-engineer input/control systems — key remapping, input device structs, and control flow from hardware to application.
---

# Input System Reverse Engineering

> Adapted from the target-specific RE toolkit for general binary analysis.


# the target Input System Reverse Engineering

## Goal
Compile a comprehensive document on the original game's input system, primarily control remapping. Produce concrete function addresses, struct layouts, and actionable modding info, then commit to git.

## Important Pitfalls
- The reimplementation code claims `KeyboardDevice+0x143-0x148` holds 6 keys (up/down/left/right/action1/action2). **Do NOT trust reimpl offsets.**
- Live Ghidra decompilation of the original EXE shows **only 4 directional keys** in `Ball_GetInputForce` (`InputDevice+0x50C..0x518`). No brake, no action/jump key — jumping is purely collision-driven (`E:JUMP` objects).
- Always decompile the **original EXE**, not the reimplementation, when documenting the original game's behavior.
- **Do NOT use a separate thread for input polling.** The game is single-threaded; a background `GetAsyncKeyState` loop will race with physics. Always hook `InputDevice_PollAndRelease` and sample custom keys from the same DI8 buffer the game just polled.
- **Ghidra double-as-float misread**: Multiple `_DAT_` constants are 8-byte doubles but Ghidra shows them as 4-byte floats producing garbage values (89128.96, -1.59e-23, etc). The giveaway is always in x86 disasm: `fmul qword`/`fadd qword`/`fld qword` = DOUBLE (8 bytes), `fmul dword`/`fadd dword`/`fld dword` = FLOAT (4 bytes). Known instances: 0x4D03B0=0.16, 0x4D03A8=0.1, 0x4D03E0=0.02, 0x4CF308=0.1, 0x4CF538=0.01, 0x4CF4F8=2.0, 0x4D03C8=3.0, 0x4CF3E0=0.01, 0x4CF440=0.25, 0x4CF458=1.5, 0x4CF4D0=1.25, 0x4CF528=0.5. Full table in `game-reverse-engineering` skill `references/decompilation-verification-pitfalls.md`. Verify: read 8 bytes via GhidraMCP, unpack with `struct.unpack('<d', raw)`.

## When Ghidra Is Unavailable: Reuse Existing Decompilations
If GhidraMCP is timing out and the headless project is locked by another process, check `analysis/ghidra/decompilations/` and `docs/` first.  Many functions were already decompiled in prior sessions.  Search the local repo:
```bash
# Find existing decompilation files
grep -rl "0x46EC30\|Ball_GetInputForce" analysis/ghidra/decompilations/

# Search docs for function names/addresses
grep -n "OptionsMenu_Render\|InputDevice_Poll" docs/*.md
```
If the artifact exists, read it directly instead of waiting on Ghidra.  This often lets you proceed immediately.

## Batch Headless Script (Multi-Address)
For decompiling several functions in one pass without repeatedly locking the project:
```java
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import java.io.File;
import java.io.FileWriter;

public class DecompileMultiAddresses extends GhidraScript {
    public void run() throws Exception {
        // args: "addr1,addr2,..." output_dir
        String[] addrs = getScriptArgs()[0].split(",");
        String outDir = getScriptArgs()[1];
        DecompInterface di = new DecompInterface();
        di.openProgram(currentProgram);
        for (String a : addrs) {
            Address addr = currentProgram.parseAddress(a.trim());
            Function fn = getFunctionAt(addr);
            DecompileResults r = di.decompileFunction(fn, 300, null);
            String c = r.getDecompiledFunction().getC();
            FileWriter fw = new FileWriter(new File(outDir, "decomp_"+a.trim()+".c"));
            fw.write(c); fw.close();
        }
        di.dispose();
    }
}
```

## Reusable Headless Ghidra Script
Because GhidraMCP can timeout, use a direct headless script for reliable single-address decompilation. Create `analysis/ghidra/scripts/DecompileByAddress.java`:
```java
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import java.io.File;
import java.io.FileWriter;

public class DecompileByAddress extends GhidraScript {
    public void run() throws Exception {
        String addrStr = getScriptArgs()[0];
        String outPath = getScriptArgs()[1];
        Address addr = currentProgram.parseAddress(addrStr);
        Function fn = getFunctionAt(addr);
        DecompInterface di = new DecompInterface();
        di.openProgram(currentProgram);
        DecompileResults r = di.decompileFunction(fn, 300, null);
        String c = r.getDecompiledFunction().getC();
        FileWriter fw = new FileWriter(new File(outPath));
        fw.write(c); fw.close();
        di.dispose();
    }
}
```
Run with:
```bash
/opt/ghidra/support/analyzeHeadless \
  $(pwd)/analysis/ghidra the target \
  -scriptPath $(pwd)/analysis/ghidra/scripts \
  -postScript DecompileByAddress.java 0x46EC30 /tmp/decomp_46EC30.c
```

## Core Function Addresses (all from original EXE)
| Address | Symbol | Description |
|---------|--------|-------------|
| `0x46EC30` | `Ball_GetInputForce` | Reads directional keys at `InputDevice+0x50C..0x518`; returns 2D force vector. NO brake/jump processing. |
| `0x41A9A0` | `Board_GetInputForce3D` | Aggregates input from up to 4 handlers at Board+0x550. Converts 2D→3D via camera projection. Scales by force_scale (keyboard=0.12, mouse=sens×0.16+0.1). See docs/agent-knowledge/INPUT_FORCE_SYSTEM.md |
| `0x422C70` | `Board_GetPlayerInputForce` | Board vtable method. Wraps GetInputForce3D with AI fallback for keyboard-controlled balls |
| `0x423800` | `Board_GetPlayerInputForce2` | Second variant (different AI force constant) |
| `0x4016F0` | `Ball_ApplyForceV2` | Accumulates directional force into ball+0x170/174/178. Applies state multipliers (timer ×0.25, sweat ×0.0, 8-ball ×0.20). |
| `0x442680` | `OptionsMenu_AdjustSlider` | Handles left/right on slider items (SV/MV/TQ/MS). Step=0.1 (DOUBLE at 0x4CF308), clamp [0.0, 1.0]. |
| `0x46E0B0` | `Input_IsKeyDown` | Checks key/butn/gamepad state with per-mode dispatch. |
| `0x46EBD0` | `InputDevice_PollAndRelease` | Polls DI8 keyboard, 4 gamepads, stores to `+0x0C` buffer. |
| `0x428F10` | `Input_CheckKeyCombo` | 50-frame debounced "any key" check for attract-mode. |
| `0x46C050` | `App_CreateInputDevice` | Allocates `InputDevice` (0x91C bytes). |
| `0x46C110` | `App_CreateInputHandler` | Allocates `InputHandler` (0x438 bytes). |
| `0x46DC40` | `App_Ctor` | Full init; calls CreateInputDevice/Handler. |
| `0x466620` | `InputDevice_ctor` | Sets DI8 cooperative level; sets default DIK codes. |
| `0x47C7F0` | `DirectInput8Create` | Only D3D8 DLL import. |
| `0x42E840` | `OptionsMenu_RenderControls` | Renders control icons + duplicate-warning logic. |
| `0x442CE0` | `OptionsMenu_ctor` | Builds Options menu including "REMAP KEYBOARD CONTROLS". |
| `0x42DE50` | `MainMenu_ctor` | Builds main menu with PLAY/OPTIONS/EXIT items. |
| `0x4497F0` | `UIList_AddItem` | Add a named item to a SimpleMenu. |
| `0x449430` | `UIList_AddSpacer` | Add vertical spacing to a menu. |
| `0x449C20` | `UIList_HandleKeyNav` | Keyboard up/down navigation inside a UIList. |
| `0x449750` | `UIList_ActivateCurrentItem` | Click/activate the currently selected menu item. |
| `0x449D40` | `UIList_Render` | Renders the list; skips items with `UIListItem+0x440 != 0`. |
| `0x4280E0` | `App_ShowMainMenu` | Menu command dispatcher (strcmp chain on item ID codes). |
| `0x4284C0` | `App_SaveAllConfig` | Saves all settings (including CONTROL1-4) to registry. |
| `0x429530` | `App_Initialize_Full` | Full game init; creates InputHandler and reads registry. |
| `0x46E250` | `KeyboardDevice_ctor` | Keyboard-only device constructor (DIK defaults). |
| `0x46DFC0` | `InputDevice_SetType` | Sets device type enum (keyboard/mouse/joystick). |
| `0x4692F0` | `Scene_HandleInput` | Dispatches input to active gadgets via vtable. |
| `0x42E910` | `OptionsMenu_RenderControls` (alt name) | Same as 0x42E840 in some builds. |
| `0x41A9A0` | `Board_GetInputForce3D` (input force aggregator) | Iterates input handlers at Board+0x550, finds max force, converts to 3D world-space, applies force scale (keyboard=0.12, mouse=sens×0.16+0.1 — both mouse constants are DOUBLES, see pitfall). |
| `0x4016F0` | `Ball_ApplyForceV2` | Accumulates directional force to ball+0x170/174/178. Applies state-based multipliers (sweat ×0.0, 8-ball ×0.20, timer ×0.25, c4c ×0.75). |
| `0x405E00` | `Ball_Update` | Main per-frame physics. Reads and clears force accumulators (ball+0x170/174/178), runs collision detection, updates position. |
| `0x428160` | `PauseGame` (settings loader) | Reads registry including MouseSensitivity → App+0x84C (default 0.5). Despite the name, this is the settings loader, NOT pause-related. |
| `0x46EE10` | `InputHandler_ctor` | InputHandler constructor — allocates 0x438 bytes, sets up DirectInput8, enumerates joysticks. |

**Additional unnamed functions identified:**
| Address | Name | Description |
|---------|------|-------------|
| `0x41B130` | `Board_UpdateRaceState` | Main per-frame race state machine: countdown (3-2-1-GO), race timer, finish detection, results popup, "Game Over" music. 46 xrefs, called by 6 Board vtable methods. Uses DOUBLE constants at 0x4D03E0 (0.02), 0x4CF538 (0.01), 0x4D03C8 (3.0). board+0x3A4C=countdown done flag (same as jump mod gate). |
| `0x409AF0` | `Graphics_DrawScreenRectF` | Float→int wrapper for Graphics_DrawScreenRect (0x455D60). Takes 5 float args (x,y,w,h,alpha), converts via __ftol2, draws colored D3D triangle strip. Called by 16 UI *_Render functions. |

## Struct Layouts (confirmed by decompilation)
### InputDevice
- **Size:** 0x91C bytes
- **vtable:** `+0x000`
- **key_state_buffer:** `+0x00C` (256-byte DI8 keyboard state array)
- **left_key_dik:** `+0x50C`
- **right_key_dik:** `+0x510`
- **forward_key_dik:** `+0x514`
- **backward_key_dik:** `+0x518`
- **left_butn:** `+0x51C`
- **right_butn:** `+0x520`
- **forward_butn:** `+0x524`
- **backward_butn:** `+0x528`
- **mouse_left:** `+0x52C`
- **mouse_right:** `+0x530`
- **di8_keyboard:** `+0x534`
- **di8_mouse:** `+0x538`
- **4× di8_joystick:** `+0x53C`..`+0x548`
- **hwnd:** `+0x54C`
- **hInstance:** `+0x550`
- **joy_caps:** `+0x554` (0x2D0 each)
- **joy_states:** `+0x794` (0x80 each)

### Player Input Handler (per-player wrapper, NOT the full InputHandler)
Small wrapper structs stored at `Board+0x550 + playerIdx*4` (array of 4 pointers). These are the objects passed to `Ball_GetInputForce`.
- **Size:** ~0x14 bytes (mode-dependent)
- **vtable:** `+0x000`
- **App/Scene pointer:** `+0x004`
- **input mode:** `+0x008` (1=keyboard, 2=mouse, 4-7=gamepad)
- **force_mult:** `+0x00C` (float — scales raw 2D output of Ball_GetInputForce)
- **gamepad state ptr:** `+0x010` (only for modes 4-7)

### InputHandler
- **Size:** 0x438 bytes
- **vtable:** `+0x000`
- **input_device:** `+0x004`
- **left_key:** `+0x008`
- **right_key:** `+0x00C`
- **forward_key:** `+0x010`
- **backward_key:** `+0x014`
- **mouse_sensitivity_x:** `+0x018`
- **mouse_sensitivity_y:** `+0x01C`

### OptionsMenu key_bindings struct
- Static array at `0x4D2B80`, 20 `char[20]` entries → total 0x190 bytes.
- First half (index 0-9): action names
- Second half (index 10+): control object names (e.g., `"MOUSE"`, `"KEYBOARD"`, `"JOYSTICK1"`)

## Control Flow
1. `App_Ctor` → `App_CreateInputDevice` → `InputDevice_ctor` (allocates 0x91C)
2. `App_CreateInputHandler` (allocates 0x438)
3. Each frame: `InputDevice_PollAndRelease` fills 256-byte buffer from DI8
4. `Ball_GetInputForce` reads the 4 directional DIK offsets and converts to Vec2 force
5. Mouse mode: `Input_IsKeyDown` computes absolute screen offset from centre; no delta

## OptionsMenu Slider Mechanism
The OptionsMenu vtable at `0x4D5E30` contains 20 entries. Key entries:
- `[3]` = `UIList_HandleKeyNav` (0x449C20) — up/down navigation
- `[8]` = `UIList_Render` (0x449D40) — renders list items
- `[19]` = `FUN_00442680` (0x442680) — **slider handler** for left/right key presses

When `OptionsMenu+0xE08 = 1` (set during ctor for slider items like "MS"), left/right presses are dispatched to vtable[19] (`FUN_00442680`). This function:
1. Checks `__stricmp(item_id, "SV"/"MV"/"TQ"/"MS")` to find which slider
2. Computes `new_value = current + direction × step` (direction is ±1)
3. Clamps to [0.0, 1.0] for all sliders
4. Writes back to the menu's local float field (e.g., `OptionsMenu+0xDF0` for MS)
5. Sets dirty flag (e.g., `OptionsMenu+0xDFC` for MS)
6. On menu close, `FUN_004284C0` persists the value to `App+0x84C` and registry

### OptionsMenu slider value offsets
| Item | Local offset | Dirty flag offset | App field |
|------|-------------|-------------------|-----------|
| SV (sound) | +0xD10 | +0xD1C | (via App_ReadDisplaySettings) |
| MV (music) | +0xD48 | +0xD54 | (via App_ReadDisplaySettings) |
| TQ (tex quality) | +0xD80 | +0xD8C | (via App_ReadDisplaySettings) |
| MS (mouse sens) | +0xDF0 | +0xDFC | App+0x84C |

## Force Application Pipeline
After `Ball_GetInputForce` produces a 2D force, the force goes through:
1. **Board_GetInputForce3D** (`0x41A9A0`) — selects strongest input, converts 2D→3D world-space via camera projection, normalizes direction, applies force scale
2. **Ball_ApplyForceV2** (`0x4016F0`) — accumulates to `ball+0x170/174/178` with state-based multipliers
3. **Ball_Update** (`0x405E00`) — consumes accumulators and runs collision physics

### Force Scale Values (CORRECTED July 2026)
- Keyboard/gamepad: **0.12** (float, `KeyboardForceScale` at `0x4D03B8`, 4 bytes — genuine float, x86 uses `FLD DWORD`)
- Mouse: **sensitivity × 0.16 + 0.1** (`MouseSensitivityMultiplier` at `0x4D03B0` + `MouseSensitivityOffset` at `0x4D03A8`)
- **CRITICAL**: Both mouse constants are **DOUBLES (8 bytes)**, not floats! Ghidra shows `(float)` casts but x86 uses `FMUL QWORD`/`FADD QWORD`. Reading 4 bytes gives garbage (89128.96, -1.08e-19). See `references/extracting-data-constants.md` in the game-reverse-engineering skill for the full double-as-float pitfall and verification methodology.
- Default mouse sensitivity: **0.5** (at `App+0x84C`, set by `PauseGame` 0x428160)
- Mouse sensitivity range: **0.0 to 1.0** (step 0.1 DOUBLE at `SliderStepSize` `0x4CF308`, via slider in `OptionsMenu_AdjustSlider`)

### Force Magnitudes Summary
| Input Mode | Formula | Magnitude |
|------------|---------|-----------|
| Keyboard | fixed | **0.12** per frame |
| Mouse (min, sens=0.0) | 0.0×0.16+0.1 | **0.10** per frame |
| Mouse (default, sens=0.5) | 0.5×0.16+0.1 | **0.18** per frame |
| Mouse (max, sens=1.0) | 1.0×0.16+0.1 | **0.26** per frame |
| Jump mod | hardcoded | **20.0** (direct to ball+0x174, bypasses Ball_ApplyForceV2) |

### State Multipliers (in Ball_ApplyForceV2)
- Sweat mode (ball+0x324): ×0.0 (completely disabled)
- 8-ball mode (ball+0xC5C): ×0.20
- Timer active (ball+0x2F0≠0): ×0.25
- C4C flag (ball+0xC4C): ×0.75

Full pipeline details: see `references/input-force-application-pipeline.md` and `docs/agent-knowledge/INPUT_FORCE_SYSTEM.md`

## Registry Persistence
- `HKCU\Software\Raptisoft\the target`
- CONTROL1..CONTROL4 → `App+0xB28`..`0xB34` (DWORD each)
- Values: 99=keyboard, 100=mouse, other=joy index

## Default DIK Code Values (from InputDevice_ctor)
- Left = `0xCB` (DIK_LEFT)
- Right = `0xCD` (DIK_RIGHT)
- Up = `0xC8` (DIK_UP)
- Down = `0xD0` (DIK_DOWN)

## Document Commit Workflow
1. Run headless script for each target address → `/tmp/decomp_*.c`
2. Verify struct layouts from decompiled C
3. Write `docs/INPUT_SYSTEM.md` with sections: Overview, Structs, Functions, UI, Registry, Address Table, Modding Notes
4. Commit and push to both remotes:
```bash
git add docs/INPUT_SYSTEM.md analysis/ghidra/scripts/DecompileByAddress.java
git commit -m "docs: comprehensive INPUT_SYSTEM.md — original game input/control remapping reverse-engineering"
git push origin master && git push priv master
```

## Menu System Lifecycle (verified July 2026)

Full document: `docs/MENU_SYSTEM.md` in the the target-re repo.

### Class Hierarchy
```
Gadget (vtable @ 0x4D6A70)
  └─ SimpleMenu (ctor @ 0x448F20 — calls Gadget_ctor, inits AthenaLists)
       └─ OptionsMenu (vtable @ 0x4D5E30, ctor @ 0x442CE0)
       └─ RemapKeyboardMenu (vtable @ 0x4D5F50, ctor @ 0x4431E0)
       └─ MainMenu, TourneyMenu, QuitDialog, etc.
```

### Submenu Create/Destroy Pattern
The game uses a uniform allocate→construct→register→destroy lifecycle for ALL menus:

1. **Create**: `operator_new(size)` → ctor (sets vtable, adds UIList items, stores parent at `+0xCDC`) → `Scene_AddObject(App+0x184, menu)` → set parent's `+0xE09 = 1` (hide parent)
2. **Destroy**: user presses BACK → `vtable[0x10]()` (calls `0x419740` → sets `this+0x2C = 1`) → clear parent's `+0xE09 = 0` → `GameUpdate` (0x469CF0) destroys object next frame

### Key Flags
| Offset | Name | Description |
|--------|------|-------------|
| +0x2C | `destroy_flag` | Set by vtable[16] (0x419740). GameUpdate checks this in pass 2 → removes from AthenaList + calls DeletingDtor + free |
| +0xE09 | `submenu_active` | Set to 1 when creating a submenu. OptionsMenu_Render (0x441800) checks this — skips rendering when set |
| +0xE08 | `layout_initialized` | First-time layout flag, set after initial layout pass |
| +0x874 | `pause_flag` | When set, GameUpdate skips calling Update on this object |

### GameUpdate (0x469CF0) — Two-Pass Loop
- **Pass 1 (Update)**: For each object where `+0x2C == 0 && +0x874 == 0`: call `vtable[1]` (Update)
- **Pass 2 (Destroy)**: For each object where `+0x2C != 0`: clean up references, `AthenaList_Remove`, call `vtable[0](1)` (DeletingDtor with free flag)

### Scene_AddObject (0x469990)
Universal object registration — used for menus, level objects, dialogs, score displays (50+ call sites). Adds to binary data's AthenaList at `+0x04`, sets `obj+0x30 = parent_meshworld`, calls `App->vtable[0x1D]` (mouse hover update) and `obj->vtable[0xE]` (OnAdd callback).

### Safety: Creating New Menus vs Hooking 0x4431E0
Both approaches are safe and used by the game itself:
- **Hook 0x4431E0** (RemapKeyboardMenu_ctor): simpler for modifying existing remap menu (add keys, change labels)
- **Create new menus**: follow the allocate→ctor→Scene_AddObject pattern for entirely new screens. Custom ctor must call `SimpleMenu_ctor(this, app)` first, set vtable, add items, store parent at `+0xCDC`. BACK handler must call `vtable[0x10]()` + clear parent's `+0xE09`.

**CRITICAL — custom menu creation pitfalls** (learned from umans's intermittent crash):
1. **`memset(menu, 0, size)` before ctor** — `operator_new` doesn't zero memory. `SimpleMenu_ctor` misses `+0x880` (alternate font) and other fields. Fresh heap = zeroed (works). Reused heap = garbage (crash in `UIList_Layout`).
2. **Write `+0xCE4` as `int` (4 bytes), NOT `uint8_t`** — `RemapKeyboard_Update` reads it as an `int*` pointer. 1-byte write leaves 3 bytes of garbage → bad pointer → crash.
3. **Vtable RVA = `0xD5F50`** — `0xCF300` is a Vec3 float constant, not a vtable.
4. **Scene_AddObject needs binary data** (`*(app+0x184)`), not `this_ptr + 0xCE4` (that's resolution_x).
5. **Set `+0x87C = *(app+0x320)` (font) and `+0x884 = 1` (visible)** — SimpleMenu_ctor sets these wrong for submenus.
6. **UIList_AddItem needs `Matrix_Scale4x4` before each call** — fills 5-float matrix on stack (params 3-7). `RET 0x20` = 8 stack params.

Full pitfall details + corrected code: `references/menu-system-lifecycle.md` § "CRITICAL: Creating Custom Menus".

### RemapKeyboardMenu Key Offsets
The remap menu stores the DI8 key buffer address for each action:
| Action | Offset from InputDevice+0x434 |
|--------|------------------------------|
| UP | +0x50C |
| DOWN | +0x510 |
| LEFT | +0x514 |
| RIGHT | +0x518 |
| ACTION1 | +0x51C |
| ACTION2 | +0x520 |

When a key is selected for remapping, the menu scans the 256-byte DI8 buffer (`InputDevice+0x434+0x0C`) for any key with the high bit set (`& 0x80`), writes the DIK code to the corresponding offset, and calls `FUN_00442af0` to update the display text.

## Related reference
- `references/menu-system-lifecycle.md` — full vtable analysis, GameUpdate destroy loop disassembly, Scene_AddObject internals, and the complete menu object lifecycle with code examples for creating custom menus.
- `references/options-menu-dynamic-items.md` — adding/removing Options-menu rows at runtime, slider wiring, and the constructor one-shot problem.
- `references/input-force-application-pipeline.md` — complete trace of how raw input becomes ball velocity: Ball_GetInputForce → aggregator → Ball_ApplyForceV2 → Ball_Update. Includes force scale constants, state multipliers, mouse sensitivity, and physics conversion formulas.
- `references/race-state-machine.md` — Board_UpdateRaceState (0x41B130): main per-frame race lifecycle (countdown, timer, finish detection, results popup, "Game Over" music). Documents board offsets for countdown phase, finish triggers, and the race timer.

