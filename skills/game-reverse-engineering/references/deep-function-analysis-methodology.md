# Deep Function Analysis Methodology — Thoroughly Understanding a Single Function

When a user asks to "go through this function three more times to make sure you
understand it" or "take a decent amount of time on longer functions," apply this
systematic multi-pass analysis. This is different from batch misnomer scanning
(see `function-name-verification-methodology.md`) — it produces a detailed
behavioral model of one function, not a pass/fail name check.

## When to Apply

- A function was flagged as a critical misnomer and needs full documentation
- The user asks for detailed parameter input/output analysis
- You need to verify that a function name matches its behavior with high confidence
- Before writing modding docs or reimplementation code based on a function

## The Three-Pass Method

### Pass 1: Structure — Identify the dispatch pattern

Read the full decompilation once. Identify:

1. **Entry condition**: What gates the function? (parameter checks, flags, cooldowns)
2. **Dispatch pattern**: How does it branch? (flat if-chain, switch, vtable dispatch,
   sequential string comparisons)
3. **Resource types**: What categories of side effects does it produce?
   (struct writes, function calls, vtable dispatches, sound playback, rendering)
4. **Exit conditions**: How does it return? (early returns, fall-through, exception cleanup)

**Output of Pass 1**: A bullet list of all branches/dispatches and their high-level purpose.

### Pass 2: Parameters and Offsets — Trace data flow

Read the decompilation a second time. For each branch:

1. **Input parameters**: What fields of `this`, `param_1`, `param_2` are READ?
   - Convert `param_1[N]` int-indexed access to byte offset: `N * 4`
   - Note which parameter each access comes from (this vs param_1 vs param_2)
2. **Output writes**: What fields are WRITTEN? Document the exact offset, type, and value.
3. **Calling convention verification**: Decompile a caller to verify which parameter
   is which struct. Ghidra's `__thiscall` signature shows `this` in ECX, but the
   *meaning* of param_1/param_2 (Ball? Scene? CollisionEvent?) must be verified
   from the call site.
4. **Sub-object pointer chains**: If the function dereferences `param_1[N]` to get
   a sub-object pointer, then accesses offsets on that pointer, document the full
   chain: `Ball → +0x1A4 → CollisionMesh → +0xCA8`

**Output of Pass 2**: A table of struct offsets accessed, with read/write direction
and field meaning.

### Pass 3: Constants and Globals — Resolve unknowns

Read the decompilation a third time. Resolve every `_DAT_`, `PTR_DAT_`, and
hex immediate value:

1. **Global data references**: `PTR_DAT_004cf80c` — read the raw binary at that VA
   to find the actual string or value.
2. **Float immediates**: `0x3B03126F` — convert to float via
   `struct.unpack('<f', struct.pack('<I', 0x3B03126F))` → 0.002
3. **Vtable dispatch offsets**: Group calls by `vtable+N` offset to categorize
   what resource types are being loaded/manipulated.

**Output of Pass 3**: A table of resolved constants with their actual values.

## Resolving Global Data References from the Raw Binary

Ghidra often leaves unresolved global data references like `PTR_DAT_004cf80c`
or `_DAT_004cf370` in decompilations. These are pointers/values in the `.rdata`
or `.data` section that Ghidra couldn't resolve to a named symbol.

### Technique: Read the binary at the VA

```python
import struct

IMAGE_BASE = 0x400000  # typical for Win32 PE executables

with open(exe_path, 'rb') as f:
    # Convert VA to file offset (for most games, RVA = file offset in .text/.rdata)
    rva = 0x004cf80c - IMAGE_BASE  # = 0xCF80C
    f.seek(rva)
    raw = f.read(64)
    
    # Try as null-terminated string
    s = raw.split(b'\x00')[0].decode('ascii', errors='replace')
    print(f'PTR_DAT_004cf80c = "{s}"')
    
    # Try as float
    val = struct.unpack('<f', raw[:4])[0]
    print(f'_DAT_004cf370 = {val} (float)')
```

### Common patterns

| Ghidra Symbol | What It Usually Is | How to Resolve |
|---|---|---|
| `PTR_DAT_004XXXXX` | Pointer to a string in .rdata | Read bytes at VA, interpret as null-terminated ASCII |
| `_DAT_004XXXXX` | Float or int constant | Read 4 bytes at VA, `struct.unpack('<f', ...)` or `'<i'` |
| `DAT_004XXXXX` | Same as above (no underscore prefix) | Same technique |
| `_DAT_005XXXXX` | .data section variable (runtime-modifiable) | Read bytes at VA, may be initialized at runtime |

### Case Study: Resolving ZIP event string

In `DispatchCollisionEvents` (0x0040C5D0), line 261:
```c
iVar4 = __stricmp((char *)(*(int *)(param_2[1] + 0x864) + 2), (char *)&PTR_DAT_004cf80c);
```

Reading the binary at 0xCF80C revealed consecutive null-terminated strings:
```
0xcf80c: "ZIP"
0xcf810: "POPOUT"
0xcf818: "PIPEBONK"
0xcf824: "DROPIN"
```

So `PTR_DAT_004cf80c` = `"ZIP"` — the function was checking for a `ZIP` event
(by comparing `event+2`, skipping the 2-char prefix).

## Converting Hex Immediates to Float

Ghidra decompilations often show float values as hex integers (because they're
stored in general-purpose registers as bit patterns):

```python
import struct

# E:JUMP velocity X: param_1[0xA7] = 0x3B03126F
val = struct.unpack('<f', struct.pack('<I', 0x3B03126F))[0]
# → 0.0020000000949949026 ≈ 0.002

# N:MOUSETRAP velocity Y: 0x41700000
val = struct.unpack('<f', struct.pack('<I', 0x41700000))[0]
# → 15.0
```

### Common float-as-hex values in target application

| Hex | Float | Meaning |
|---|---|---|
| 0x3F800000 | 1.0 | Identity scale, unit velocity |
| 0x41700000 | 15.0 | MOUSETRAP deflection velocity |
| 0x3B03126F | 0.002 | E:JUMP X-drift |
| 0x41A00000 | 20.0 | MOUSETRAP velocity scale factor |
| 0x40000000 | 2.0 | DROPIN min velocity threshold |

## Vtable Dispatch Categorization

When a function makes many `(**(code**)(*ptr + OFFSET))(dest, args)` calls,
group them by vtable offset to understand what resource types are being loaded:

```python
import re
from collections import defaultdict

by_offset = defaultdict(list)
for offset, dest, args in vtable_calls:
    # Categorize by argument content
    if 'fonts' in args: rtype = "FONT"
    elif 'Meshes' in args: rtype = "MESH"
    elif 'Levels' in args: rtype = "LEVEL"
    elif 'sounds' in args: rtype = "SOUND"
    elif '.png' in args or '.bmp' in args: rtype = "TEXTURE"
    else: rtype = "UNKNOWN"
    by_offset[offset].append(rtype)
```

### Case Study: TimerDisplay vtable mapping

| vtable Offset | Resource Type | Count |
|---|---|---|
| +0x48 | Texture (with flags) | 37 |
| +0x4C | Mesh | 24 |
| +0x50 | Level | 7 |
| +0x54 | Level alias (copy) | 4 |
| +0x58 | Texture (simple) | 59 |
| +0x5C | Font | 3 |
| +0x60 | Sound | 61 |
| **Total** | | **195** |

This immediately revealed that `TimerDisplay` loads 195 game resources —
it's the master asset preloader, not a timer.

## Output Document Template

After completing the three-pass analysis, produce a structured document:

```markdown
## Function: [Name] (0x[ADDRESS])

### Misnomer Summary
| Field | Value |
|---|---|
| Current name | ... |
| Correct name | ... |
| Severity | CRITICAL/MODERATE |
| Evidence | ... |

### Calling Convention
```c
void __thiscall FunctionName(void *this, int *param_1, int *param_2);
```
- `this` (IN): [struct type and purpose]
- `param_1` (IN/OUT): [struct type, what's read and written]
- `param_2` (IN): [struct type, what's read]

### Struct Offsets Accessed
| Offset | Type | Field | Access | Used By |
|---|---|---|---|---|
| +0xNNN | float | field_name | READ/WRITE | branch name |

### Event/Dispatch Branches
| # | Trigger | Condition | Action | Points |
|---|---|---|---|---|
| 1 | "EVENT_NAME" | gate condition | what it does | +N |

### Verified Constants
| Address | Value | Type | Used By |
|---|---|---|---|
| 0x004CF370 | 20.0 | float | velocity scale |

### Call Sites
List of xrefs with containing function names.
```
