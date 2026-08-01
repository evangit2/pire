# Function Name Verification Methodology — Detecting Misnomers at Scale

When batch-decompiling hundreds or thousands of functions, Ghidra's auto-generated and even manually-assigned function names can be misleading or outright wrong. This reference documents the systematic heuristics for detecting mismatches between a function's name and its actual behavior.

## When to Apply

- After batch-decompiling functions, before trusting names for documentation
- When a user says "double check the names" or "names can be misleading"
- Before writing function descriptions or modding docs based on names alone

## Heuristics (Ordered by Signal Strength)

### 1. Constructor Call Counting (for `Create*` functions)

Count distinct `_ctor` calls inside the function body. If a function named `CreateX` calls 3+ different constructors, it's a **multi-object factory**, not a single-object creator.

```python
ctor_calls = [c for c in calls if '_ctor' in c or '_Ctor' in c]
unique_ctors = list(set(ctor_calls))
if len(unique_ctors) >= 3:
    # MISNOMER: Named after one object type but creates many
```

**Confirmed examples from target application:**
| Function Name | Actual Creates | Misnomer Severity |
|---|---|---|
| `CreateSawblade` | Bonk, TowerLevel, Sawblade, Spinner, Gear, Tipper (6 types) | MODERATE |
| `CreateSpeedCylinder` | Rotator_sound, Rotator_nosound, Pendulum (3 types) | MODERATE |
| `CreateSpinner` | RumbleScore + handles 8 event types | MODERATE |
| `CreateLevelObjects` | Tipper, Gluebie, Blockdawg, BreakBridge, PopCylinder, Catapult, Bonk (8 types) | OK (name is general) |

### 2. Rendering Call Detection (for `Tick`/`Update` functions)

If a function named `Tick` or `Update` contains heavy rendering calls (Matrix_Scale4x4, UI_DrawTextCentered, Graphics_DrawScreenRect), it's actually a **render function** mislabeled as a tick.

```python
if ('Tick' in func_name or 'Update' in func_name):
    render_calls = calls.count('Matrix_Scale4x4')
    ui_calls = calls.count('UI_DrawTextCentered') + calls.count('UI_DrawTextShadow')
    if render_calls >= 3 or ui_calls >= 3:
        # MISNOMER: Named Tick/Update but does rendering
```

**Confirmed example:** `RaceGoalReached_Tick` has 56 Matrix_Scale4x4 calls and 14 UI_DrawTextCentered calls — it's actually `RaceResultsScreen_Render`.

### 3. String Literal Mismatch

Extract all string literals from the decompiled C. If the function name suggests one concept but the strings tell a completely different story, the name is wrong.

```python
str_refs = re.findall(r'"([^"]+)"', content)
all_strings = ' '.join(str_refs).upper()
# Example: TimerDisplay contains 199 strings for fonts/textures/meshes, only 1 mentions "timer"
```

**Confirmed example:** `TimerDisplay` has 199 string literals loading fonts (showcardgothic28/72), textures (hammy1-3.png, blueblot.png, goal.png), and meshes — it's actually `LoadingScreenGadget_Factory` (or `App_ResourceLoader`). Verified: allocates 0x3628 bytes for LoadingScreenGadget, loads 195 resources via 7 vtable methods (59 simple textures, 37 flagged textures, 5 fonts, 24 meshes, 7 levels, 4 level aliases, 61 sounds). Full deep analysis with vtable offset mapping in `CRITICAL_FUNCTION_ANALYSIS.md` in the repo.

### 4. Event Handler Detection (for `Create*` functions)

If a function named `CreateX` has zero `operator_new` or `malloc` calls but has many `__stricmp`/`__strnicmp` calls, it's an **event handler**, not a factory.

```python
if func_name.startswith('Create') and size > 1000:
    has_alloc = 'operator_new' in calls or 'malloc' in calls
    stricmp_count = calls.count('__stricmp') + calls.count('__strnicmp')
    if not has_alloc and stricmp_count >= 5:
        # MISNOMER: Named Create but is a string-dispatch event handler
```

**Confirmed example:** `DispatchCollisionEvents` has 18 `__stricmp`/`__strnicmp` calls, 0 constructor calls, and handles 18 event types (N:SECRET, N:UNLOCKSECRET, E:NODIZZY, E:SAFESWITCH, E:LIMIT, E:BREAK, E:JUMP, E:ACTION, E:TRAJECTORY, N:NOCONTROL, N:WATER, N:TARPIT, N:GOAL, N:MOUSETRAP, DROPIN, PIPEBONK, POPOUT, ZIP). It's actually `LevelCollisionEventHandler`. Called from 28 sites including `Level_HandleCollision` as a fall-through. Full deep analysis with all 18 branches, ball struct offsets, and verified constants in `CRITICAL_FUNCTION_ANALYSIS.md` in the repo.

### 5. Struct Size Sanity Check (for `*Connection*` / `*Network*` / `*Manager*` functions)

Check the `operator_new` allocation size before the constructor call. If the allocation size is tiny (≤ 32 bytes), the object is too small to be a network connection, game state manager, or complex subsystem — it's likely a simple data wrapper.

```python
# In decompiled code, look for:
#   pvVar = operator_new(0xNN);
#   pvVar = NetworkConnection_Ctor(pvVar, ...);
# If 0xNN is small (0x14=20, 0x18=24, 0x1C=28), it's a trivial struct
```

**Confirmed example:** `NetworkConnection_Ctor` (0x0046dfa0) sounds like network multiplayer. Actually allocates 0x14 (20 bytes) — the InputDevice base struct (name ptr + parent ptr + type int + sensitivity float + device_data ptr). "Not Connected" = no gamepad plugged in, not a network status. `InputDevice_SetType` (0x0046dfc0) configures it as keyboard/mouse/gamepad 1-4.

**Lesson:** When a function name suggests a major subsystem (networking, multiplayer, AI manager), always check the allocation size first. A 20-byte struct cannot be a TCP connection handler.

### 6. PE Import Table Verification (for networking/multiplayer claims)

When investigating whether a game has online features, don't rely on string searches alone — parse the PE import table to see which DLLs are actually imported, then trace which code uses those imports.

```python
# Parse PE import table to find imported DLLs and their functions
import struct
e_lfanew = struct.unpack_from('<I', content, 0x3C)[0]
opt_hdr_offset = e_lfanew + 24
import_dir_rva = struct.unpack_from('<I', content, opt_hdr_offset + 104)[0]
# Parse IMAGE_IMPORT_DESCRIPTOR entries, resolve names via RVA-to-file-offset
```

**Key distinction:** WS2_32.dll (winsock) imports in a game binary do NOT necessarily mean online multiplayer. Common non-game uses of winsock:
- DRM/activation systems (eSellerate, Steamworks) — HTTP to license servers
- Crash reporters — HTTP POST of error reports to developer servers
- Auto-updaters — version check HTTP requests

To determine which code path uses winsock, search for the imported function addresses in the code section and trace back to the calling function.

**Confirmed example:** target application imports socket, connect, send, recv from WS2_32.dll — but ALL are used exclusively by embedded eSellerate DRM (talks to `store.esellerate.net`) and the Raptisoft crash reporter. Zero game-state networking code exists. The `MPMenu` ("MP Menu") offers local-only modes (Party Race 2P, Rodent Rumble 1-4P).

### 7. Xref Context Verification

Check who calls the function. If a function is called from 28+ different sites across unrelated subsystems, it's likely a **general-purpose handler** mislabeled as specific.

```bash
curl -s "http://127.0.0.1:8089/get_function_xrefs?address=0xADDR"
```

**Confirmed example:** `DispatchCollisionEvents` is called from 28 sites including `Level_HandleCollision`, `Arena_HandleCollision`, `CreateSpinner`, `CreateLimit`, `SinkPlatform_OnCollision` — clearly a general collision handler, not a "create NoDizzy" function.

## False Positive Awareness

### "Render" functions with no named draw calls — USUALLY CORRECT

Many `Render` functions use D3D8 vtable dispatches (`(**code**)(...)` patterns) instead of direct named function calls. These do NOT show up as `Matrix_Scale4x4` or `Graphics_DrawScreenRect` in the call list. **Do not flag these as misnomers.**

Detection: check if the function body contains `(**(code**)` or `(**(int**)` patterns — these are vtable dispatches that perform rendering without appearing as named calls.

### Library functions with generic names — USUALLY CORRECT

CRT functions (scanf, printf, pow, RaiseException), codec functions (IDCT, IMDCT, Inflate, Vorbis), and D3DX functions (CreateTextureFromFile, CreateMeshFromFormat, OptimizeMesh, WeldVertices) are correctly named — they're bundled library code, not game logic.

### `NoOp` with large file size — USUALLY CORRECT

A `NoOp` function that appears large in bytes is likely just heavily commented. Check the actual code body — if it's just `return;`, the name is correct.

## Batch Processing Script

```python
import os, re
from collections import Counter

def scan_misnomers(decomp_dir):
    """Scan all decompiled .c files for potential name/behavior mismatches."""
    findings = []
    
    for fname in os.listdir(decomp_dir):
        if not fname.endswith('.c'):
            continue
        fpath = os.path.join(decomp_dir, fname)
        size = os.path.getsize(fpath)
        if size < 500:
            continue
        
        with open(fpath) as f:
            content = f.read()
        
        func_name = re.sub(r'_0x[0-9a-fA-F]+\.c$', '', fname)
        calls = re.findall(r'(\w+)\(', content)
        str_refs = re.findall(r'"([^"]+)"', content)
        call_counts = Counter(calls)
        
        issues = []
        
        # Heuristic 1: Create* with multiple ctors
        if func_name.startswith('Create') and not func_name.startswith('CreateBad'):
            ctor_calls = [c for c in calls if '_ctor' in c or '_Ctor' in c]
            if len(set(ctor_calls)) >= 3:
                issues.append(f"Creates {len(set(ctor_calls))} different types: {list(set(ctor_calls))[:5]}")
        
        # Heuristic 2: Tick/Update with rendering calls
        if ('Tick' in func_name or 'Update' in func_name):
            if call_counts.get('Matrix_Scale4x4', 0) >= 3:
                issues.append(f"Named Tick/Update but has {call_counts['Matrix_Scale4x4']} Matrix_Scale4x4 calls")
        
        # Heuristic 3: Create* with no allocation but many stricmp
        if func_name.startswith('Create') and size > 1000:
            has_alloc = 'operator_new' in calls or 'malloc' in calls
            stricmp_count = call_counts.get('__stricmp', 0) + call_counts.get('__strnicmp', 0)
            if not has_alloc and stricmp_count >= 5:
                issues.append(f"Named Create but is string-dispatch handler ({stricmp_count} stricmp calls)")
        
        # Filter out vtable-dispatch false positives for "Render" functions
        # (only flag Render functions if they ALSO have stricmp dispatch)
        if 'Render' in func_name and size > 1000:
            stricmp_count = call_counts.get('__stricmp', 0) + call_counts.get('__strnicmp', 0)
            if stricmp_count < 3:
                continue  # likely a real render function using vtable dispatch
        
        if issues:
            findings.append((fname, func_name, size, issues, str_refs[:5]))
    
    findings.sort(key=lambda x: x[2], reverse=True)
    return findings
```

## Confirmed Misnomers (target_binary.exe)

| Address | Current Name | Correct Name | Severity | Key Evidence |
|---|---|---|---|---|
| 0x004298c0 | TimerDisplay | LoadingScreenGadget_Factory | CRITICAL | Allocates 0x3628B gadget, loads 195 resources via 7 vtable methods (59+37 textures, 5 fonts, 24 meshes, 7 levels, 61 sounds). Only 1 of 199 strings mentions "timer". |
| 0x0040c5d0 | DispatchCollisionEvents | LevelCollisionHandler | CRITICAL | 0 ctors, 18 stricmp/strnicmp, 28 xrefs, handles 18 event types. Called as fall-through from Level_HandleCollision and Arena_HandleCollision. |
| 0x00447920 | RegisterDialog_Render | PurchaseScreen_Render | MODERATE | "REGISTER PRODUCT!", "CLICK HERE TO BUY!", "CUSTOMER NAME:", "SERIAL NUMBER:", "UNLOCK!" |
| 0x0044df70 | RaceGoalReached_Tick | RaceResultsScreen_Render | MODERATE | 56 Matrix_Scale4x4, 14 UI_DrawTextCentered. Displays "BEST RACE TIME:", "BROKEN BALLS:", "SILVER TIME:" etc. |
| 0x0040e250 | CreateSawblade | CreateMechanicalObjects2 | MODERATE | 6 distinct _ctor calls (Bonk, TowerLevel, Sawblade, Spinner, Gear, Tipper) |
| 0x004117b0 | CreateSpeedCylinder | CreateRotatorsAndPendulums | MODERATE | Creates Rotator_sound, Rotator_nosound, Pendulum (not SpeedCylinder) |
| 0x00412850 | CreateSpinner | CreateArenaObjects | MODERATE | Handles 8 event types (SPINNER, BUMPER, LAUNCH, HAMMER, etc.), only 1 ctor |
| 0x0046dfa0 | NetworkConnection_Ctor | InputDevice_Ctor | CRITICAL | Allocates 0x14 (20 bytes). "Not Connected" = no gamepad, not network. InputDevice_SetType configures as keyboard/mouse/gamepad. WS2_32 imports used by eSellerate DRM + crash reporter only. |
