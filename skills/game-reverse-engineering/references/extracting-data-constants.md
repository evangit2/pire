# Extracting Data-Section Constants and Named Globals

## Problem

When reversing a game binary, many behavior-tuning values reside in `.data` or `.rdata` as scalar constants accessed via absolute addresses (not immediates). Modders need a catalog so they can patch these at runtime. The challenge is extracting them from thousands of lines of decompiled C.

## What to Look For

In Ghidra decompilations, these appear as:
- `_DAT_00XXXXXX` symbols (e.g., `_DAT_004CF380`)
- Direct `0x00XXXXXX` address literals passed as first argument to math functions (e.g., `FUN_00457de0(0x4f7188, param_1, param_2)` where `0x4f7188` is a `float*` or table base)
- Named globals from `list_globals` (e.g., `g_App @ 004fd680`)

## Step-by-Step Extraction

### 1. Collect Raw `_DAT_` References

```bash
cd analysis/ghidra/decompilations/
grep -roh '_DAT_00[A-F0-9a-f]{6}' . | sort | uniq -c | sort -rn
```

All `_DAT_` references in a given address range belong to the same `.data` bank.

### 2. Distinguish Constants from Pointers from Strings

| Access Pattern | Likely Type | Example |
|---------------|-------------|---------|
| `param_4 = param_4 * _DAT_004CF380;` | `float` multiplier | Hit recovery force |
| `if (dist > _DAT_004CF3EC)` | `float` threshold | Camera min distance |
| `fVar1 = FUN_00457de0(0x4f7188, ...)` | `float*` or table base | Math/atan2 helper |
| `pcVar = FUN_00466c70(0x4f7448, ...)` | `char*` string table | Tokenizer |
| `*(float*)_DAT_004CF3C8 = 1.0f` | `float` constant | UV V-inversion |

### 3. Verify Values In-Process

Ghidra decompilation does not always emit the literal float values. To get ground truth:

```c
// In your mod DLL or Cheat Engine script
float val = *(float*)0x004CF3F0;  // read actual memory
```

### 4. Use `list_globals` for Named Labels

If running GhidraMCP headless, query:
```
curl -s http://127.0.0.1:8089/list_globals | grep -E '004[A-Fa-f]'
```

Manually renamed globals (e.g., `g_App`, `s_BACK`) have higher confidence than raw `_DAT_` symbols and show xref counts.

### 5. Build the Catalog Document

A good catalog doc has:
- **Named globals** table (label, address, type, xref count)
- **Float constants** grouped by subsystem (physics, camera, collision, input, graphics, math)
- **Vtables / jumps** in data section
- **String table bases** in `.rdata`
- **Modding recipes** — exact memory addresses with before/after values
- **Quick-reference table** at the end (every address, one line)

### 6. Cross-Reference Count as Confidence Signal

| Xref Count | Confidence | Action |
|------------|-----------|--------|
| ≥10 | High-confidence global | Document with modding recipe |
| 3–9 | Moderate | Document, note single source |
| 1–2 | Weak | Needs second-function verification |
| 0 (only comments) | Suspect / dead code | Do not document without raw C proof |

## Pitfall: Code Addresses vs Data Addresses

When grepping for `0x00XXXXXX` literals, filter out known code sections (e.g., for target application, `0x00420000–0x00480000` is main executable code; `0x004CF000–0x004D0500` is `.data` constants). If you include code addresses, the list becomes noise.

## Pitfall: Human Comments Are Not Evidence

Decompilation files often contain user-written comments like `// _DAT_004CF3F0 = 0.95f`. The comment may be wrong or outdated. Only the raw C line (the `*` dereference or `if` comparison) counts as proof.

## Template: Catalog Entry

```markdown
| Address | Approx. Value | Function(s) | Description |
|---------|---------------|-------------|-------------|
| 0x004CF380 | ~0.1–0.2 | `Ball_ApplyForce` | Hit-recovery force multiplier |

**Modding recipe:**
```c
float* p = (float*)0x004CF380;
DWORD old; VirtualProtect(p, 4, PAGE_READWRITE, &old);
*p = 1.0f;  // No force reduction on hit
VirtualProtect(p, 4, old, &old);
```
```

## Reading Raw Float/Double Constants from the PE Binary

When GhidraMCP labels a data item as `_DAT_00XXXXXX` (undefined) and you need
its actual numeric value (float, double, int), the GhidraMCP REST server may
not have a working "read bytes" endpoint. Instead, read the value directly
from the original `.exe` file using PE section headers to map VA→file offset.

### Technique

```python
import struct

exe_path = 'path/to/game.exe'
IMAGE_BASE = 0x400000

with open(exe_path, 'rb') as f:
    # Parse PE headers
    f.seek(0x3C)
    pe_offset = struct.unpack('<I', f.read(4))[0]
    f.seek(pe_offset + 6)
    num_sections = struct.unpack('<H', f.read(2))[0]
    f.seek(pe_offset + 0x14)
    opt_header_size = struct.unpack('<H', f.read(2))[0]
    section_start = pe_offset + 0x18 + opt_header_size

    sections = []
    for i in range(num_sections):
        f.seek(section_start + i * 40)
        name = f.read(8).rstrip(b'\x00').decode()
        vsize, vaddr, rawsize, rawptr = struct.unpack('<IIII', f.read(16))
        f.read(16)  # skip rest of section header
        sections.append({'name': name, 'vaddr': vaddr, 'vsize': vsize,
                         'rawptr': rawptr, 'rawsize': rawsize})

    def va_to_file(va):
        rva = va - IMAGE_BASE
        for s in sections:
            if s['vaddr'] <= rva < s['vaddr'] + s['vsize']:
                return s['rawptr'] + (rva - s['vaddr'])
        return None

    # Read a float at a VA
    def read_float(va):
        off = va_to_file(va)
        f.seek(off)
        return struct.unpack('<f', f.read(4))[0]

    # Read a double at a VA
    def read_double(va):
        off = va_to_file(va)
        f.seek(off)
        return struct.unpack('<d', f.read(8))[0]
```

### Determining float vs double — THREE verification methods

Ghidra's `(float)_DAT_00XXXXXX` cast syntax is ambiguous — it may be reading
a double and casting to float. Use all three methods below for high confidence:

#### Method 1: Raw byte inspection

- If 4 bytes form a sensible float (e.g., `0x3D17B426` = 0.037037 = 1/27), it's a `float`.
- If 8 bytes form a sensible double (e.g., `0x3FA5C9882B931057` = 0.042553 = 2/47), it's a `double`.
- Read a range of 16+ bytes around the address and decode at both 4-byte and 8-byte
  alignments to determine which makes sense.

**CRITICAL TRAP:** Some doubles have low 4 bytes of `00 00 00 00` (float 0.0).
For example, the IEEE 754 double 0.5 is stored as `00 00 00 00 00 00 E0 3F`.
The first 4 bytes read as float 0.0, which is completely misleading. If you
read only 4 bytes and get 0.0, ALWAYS read 8 bytes to check if it's actually
a double with zero low bytes. This caused a major documentation error in
target application physics: four critical constants (0x4CF3E0=0.5, 0x4CF440=0.25,
0x4CF458=1.5, 0x4CF4D0=1.25) were all documented as 0.0 because their low
4 bytes are all zeros.

**ANOTHER CRITICAL TRAP:** Some doubles produce large garbage values when
read as 4-byte floats. For example, the double 0.16 at `0x4D03B0` is stored
as `7B 14 AE 47 E1 7A C4 3F`. Reading only the first 4 bytes as float gives
89128.96, which looks like a plausible (but absurdly large) physics constant.
Similarly, the double 0.1 at `0x4D03A8` reads as -1.08e-19 as a 4-byte float.
**Rule: when a physics constant from Ghidra looks nonsensical (extremely
large or tiny), ALWAYS verify via x86 disassembly (Method 3 below) before
using it.** This was the root cause of the July 2026 input force analysis
error where mouse force was initially reported as 89128.96 instead of 0.16.

Known instances (as of July 2026):

| Address | 4-byte float (wrong) | 8-byte double (correct) | Used by |
|---------|---------------------|------------------------|---------|
| 0x4D03B0 | 89128.96 | 0.16 | MouseSensitivityMultiplier |
| 0x4D03A8 | -1.08e-19 | 0.1 | MouseSensitivityOffset |
| 0x4CF308 | -1.59e-23 | 0.1 | SliderStepSize |
| 0x4CF4F8 | 0.0 | 2.0 | Ball death distance check |
| 0x4CF3E0 | 0.0 | 0.01 | Collision velocity factor |
| 0x4CF440 | ~0 | 0.01 | Trail particle threshold |
| 0x4CF528 | 0.0 | 0.5 | Ball Y offset |
| 0x4CF3E0 | 0.0 | 0.5 | Sweat gravity_scale |
| 0x4CF440 | 0.0 | 0.25 | Sweat climbing force |
| 0x4CF458 | 0.0 | 1.5 | Sweat factor |
| 0x4CF4D0 | 0.0 | 1.25 | Sweat grounded force |

#### Method 2: Ghidra `_DAT` vs `__DAT` naming convention

Ghidra uses a naming convention to distinguish data sizes at the same address:

- `_DAT_004CF3E0` (single underscore) → Ghidra labels this as a **4-byte float** at 0x4CF3E0
- `__DAT_004CF3E0` (double underscore) → Ghidra labels this as an **8-byte double** at 0x4CF3E0

When Ghidra shows `(float)_DAT_004cf3e0` in decompiled code, it means:
- The code reads the 8-byte double (`__DAT_`) at that address
- Ghidra casts it to float for comparison with a float variable
- The `(float)` cast is the decompiler's representation, NOT the storage type

**WARNING:** Ghidra's "Globals starting with '_' overlap smaller symbols at the
same address" message confirms this overlap. The `_DAT` (4-byte) symbol is the
low 4 bytes of the `__DAT` (8-byte) double. Reading `_DAT` gives you only half
the value.

#### Method 3: x86 instruction opcode verification (authoritative)

The x86 opcode prefix definitively determines whether the instruction reads
4 bytes (float) or 8 bytes (double) from memory:

| Opcode prefix | FPU instruction | Data size | Type |
|---------------|----------------|-----------|------|
| `D8` | `FMUL dword ptr [addr]` | 4 bytes | float |
| `D8` | `FADD dword ptr [addr]` | 4 bytes | float |
| `D8` | `FDIV dword ptr [addr]` | 4 bytes | float |
| `D8` | `FCOMP dword ptr [addr]` | 4 bytes | float |
| `DC` | `FMUL qword ptr [addr]` | 8 bytes | double |
| `DC` | `FADD qword ptr [addr]` | 8 bytes | double |
| `DC` | `FDIV qword ptr [addr]` | 8 bytes | double |
| `DC` | `FCOMP qword ptr [addr]` | 8 bytes | double |
| `D9` | `FLD dword ptr [addr]` | 4 bytes | float (load) |
| `DD` | `FLD qword ptr [addr]` | 8 bytes | double (load) |

**How to verify:** Read raw bytes at the instruction address via GhidraMCP
`read_memory`, then decode the opcode:

```python
# Example: instruction at 0x406E71 in target_binary.exe
# Raw bytes: DC 1D E0 F3 4C 00
# DC = qword (8-byte) FPU operation
# 1D = ModRM byte: mod=00, reg=011 (FCOMP), rm=101 (disp32)
# E0 F3 4C 00 = little-endian address 0x004CF3E0
# → FCOMP qword ptr [0x4CF3E0] = reads 8-byte DOUBLE

# Example: instruction at 0x407ACB
# Raw bytes: DC 0D 58 F4 4C 00
# DC = qword (8-byte) FPU operation
# 0D = ModRM: mod=00, reg=001 (FMUL), rm=101 (disp32)
# 58 F4 4C 00 = address 0x004CF458
# → FMUL qword ptr [0x4CF458] = reads 8-byte DOUBLE
```

This is the **only authoritative method** — Ghidra's decompiler may mislabel
the type, and byte inspection alone can be misleading when the low 4 bytes
happen to be zero.

### Case Study: target application Render Scale Constants

Ghidra showed `Ball_Render` using `*(float*)(ball+0x284) * _DAT_004cf39c`
without revealing the constant's value. The data items list didn't include
`_DAT_004CF39C`. Reading the raw PE binary:

| Address | Bytes (hex) | Type | Value | Meaning |
|---------|-------------|------|-------|---------|
| 0x4CF388 | 5710932b88c9a53f | double | 0.042553 (2/47) | Shadow scale |
| 0x4CF390 | f6285c8fc2f5f43f | double | 1.31 | Sprite scale factor 2 |
| 0x4CF398 | a10eea3c | float | 0.028571 (1/35) | Sprite scale factor 1 |
| 0x4CF39C | 26b4173d | float | 0.037037 (1/27) | Mesh render scale |

These normalize the ball model (authored for radius 27) so it scales
proportionally when the per-ball radius field changes.

### When to Use This

- GhidraMCP `read_memory` or `get_bytes` endpoints return 404
- Data item is labeled `_DAT_` with no type info
- You need the actual numeric value of a `.rdata` or `.data` constant
- The decompiled code shows `_DAT_00XXXXXX * variable` and you need to know
  what the multiplier is

## Related

- `references/multi-file-offset-verification.md` — For struct field offsets (not .data constants)
- `references/automated-struct-verification.md` — For large-scale struct verification via GhidraMCP
