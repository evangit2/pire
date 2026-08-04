# GhidraMCP Unrecognized Function Workaround — Raw Byte Disassembly

When GhidraMCP returns `{"error":"No function found for 0xADDR"}` or
`{"error":"No function found at or containing address 0xADDR"}` but the address
is clearly valid (e.g., it's a vtable entry pointing to code), Ghidra hasn't
created a function at that address. This happens when code exists between two
recognized functions but Ghidra's auto-analysis didn't detect it.

## When This Happens

- Vtable entries pointing to addresses between recognized functions
- Compiler-inserted helper functions or inlined code blocks
- Functions that are very short or lack standard prologues
- Addresses obtained from vtable reads or manual binary inspection

## Workaround: Read Raw Bytes + Manual Disassembly

### Step 1: Read raw bytes from the EXE

```python
import struct

EXE_PATH = "originals/installed/extracted/target_binary.exe"
IMAGE_BASE = 0x400000  # PE image base

def read_bytes(va, count=256):
    """Read raw bytes at a virtual address from the EXE."""
    with open(EXE_PATH, 'rb') as f:
        f.seek(va - IMAGE_BASE)
        return f.read(count)
```

### Step 2: Identify the function prologue

Common x86 function prologues:
- `83 EC 0C` — `SUB ESP, 0xC` (stack allocation)
- `55 8B EC` — `PUSH EBP; MOV EBP, ESP`
- `56 8B F1` — `PUSH ESI; MOV ESI, ECX` (thiscall)
- `53 56 57` — `PUSH EBX; PUSH ESI; PUSH EDI`

### Step 3: Manually trace the assembly

Read the raw bytes and decode each instruction. Focus on:
- `8B 86 XX XX 00 00` → `MOV EAX, [ESI+0xXXXX]` (struct field read)
- `89 86 XX XX 00 00` → `MOV [ESI+0xXXXX], EAX` (struct field write)
- `8A 86 XX XX 00 00` → `MOV AL, [ESI+0xXXXX]` (byte field read)
- `C6 86 XX XX 00 00 00` → `MOV BYTE [ESI+0xXXXX], 0` (byte field write)
- `D9 86 XX XX 00 00` → `FLD [ESI+0xXXXX]` (float field read)
- `D9 9E XX XX 00 00` → `FSTP [ESI+0xXXXX]` (float field write)
- `FILD XX XX XX 00 00` → `FILD [ESI+0xXXXX]` (int→float load)
- `0F 85 XX XX XX XX` → `JNZ +offset` (conditional jump)
- `E8 XX XX XX XX` → `CALL +offset` (function call)

### Step 4: Read constants from .rdata

```python
def read_float(va):
    """Read a float constant from .rdata."""
    raw = read_bytes(va, 4)
    return struct.unpack('<f', raw)[0]

def read_int(va):
    """Read an int32 from .rdata."""
    raw = read_bytes(va, 4)
    return struct.unpack('<I', raw)[0]
```

## Case Study: Gear_Update @ 0x434B60

This function is the vtable[11] entry for the Gear/Judge class (vtable 0x4D52B8).
Ghidra recognized `Gear_Level_Dtor` at 0x434B50 (16 bytes) and `Judge_Reset`
at 0x434C40, but NOT the ~224-byte function at 0x434B60 sitting between them.

By reading raw bytes at 0x34B60 (file offset = VA - 0x400000):

```
00434B60: 83 EC 0C           SUB ESP, 0xC
00434B63: 56                 PUSH ESI
00434B64: 8B F1              MOV ESI, ECX          (thiscall: ESI = this)
00434B66: 8A 86 F4 10 00 00  MOV AL, [ESI+0x10F4]  (read active flag)
00434B6C: 84 C0              TEST AL, AL
00434B6E: 0F 85 A4 00 00 00  JNZ 0x434C18          (if active, skip to return)
00434B74: 8B 8E FC 10 00 00  MOV ECX, [ESI+0x10FC] (read countdown)
00434B7A: 49                 DEC ECX
00434B7B: 89 8E FC 10 00 00  MOV [ESI+0x10FC], ECX (write countdown-1)
00434B85: 0F 8F 8D 00 00 00  JG 0x434C18           (if >0, skip to return)
...
00434C18: D9 86 E4 10 00 00  FLD [ESI+0x10E4]      (load rotation)
00434C1E: B0 01              MOV AL, 1
00434C20: D8 05 8C F4 4C 00  FADD [0x4CF48C]       (add 2.0)
00434C26: D9 9E E4 10 00 00  FSTP [ESI+0x10E4]     (store rotation)
00434C2C: 5E                 POP ESI
00434C2D: 83 C4 0C           ADD ESP, 0xC
00434C30: C3                 RET
```

This revealed the complete Gear_Update function: a countdown timer with
display value decay (×0.8 per step) and a continuous rotation increment
(+2.0 per frame). The function was NOT recognized by Ghidra because it lacks
a standard SEH frame and sits in a gap between auto-analyzed functions.

## SEH Prologue Scanning for Undefined Functions (via GhidraMCP read_memory)

When xrefs point to CALL instructions at addresses NOT inside any defined function, use `read_memory` to dump 512-byte chunks backward from the call site and scan hex for function prologues.

### Pattern: SEH prologue
```
6A FF 64 A1 00 00 00 00   PUSH -1 / MOV EAX, FS:[0]
68 xx xx xx xx            PUSH handler
50                        PUSH EAX
64 89 25 00 00 00 00      MOV FS:[0], ESP
```

Search the hex string for `"6aff64a100000000"` to find SEH prologue starts.

### Pattern: RET + NOP padding (function boundary)
Look for `C3` (RET) followed by 3+ `90` (NOP) bytes — the next non-NOP byte is a new function start.

### Workflow:
1. `get_xrefs_to(target_func_addr)` → returns CALL addresses
2. `read_memory` in 512-byte chunks backward from each CALL address
3. Scan hex for SEH prologue or RET+NOP boundaries
4. `create_function` at the discovered prologue address (NOT at the CALL address itself)
5. `decompile_function` at the created function address
6. Verify the function body_size covers the original CALL address

**Pitfall:** `disassemble_bytes` via MCP returns success but no instruction text — use `read_memory` + manual hex decoding instead.

**Pitfall:** `create_function` at the CALL instruction address (instead of the function prologue) creates a bogus function. Always find the actual prologue first.

**Case study:** Ball_Shatter (0x408D70) had 2 CALL xrefs at 0x43F722 and 0x43FE36, both in undefined code. Scanning backward found SEH prologues at 0x43F3C0 (Breaker_Update) and 0x43F930 (Bonkbash_Update). Both are vtable slot[3] methods for scene object subclasses.

## Reading Vtable Entries from the Binary

When you have a vtable address (e.g., 0x4D52B8), read it directly:

```python
def read_vtable(va, max_entries=30):
    """Read function pointers from a vtable in .rdata."""
    data = read_bytes(va, max_entries * 4)
    entries = []
    for i in range(max_entries):
        val = struct.unpack('<I', data[i*4:(i+1)*4])[0]
        if val == 0:
            break
        entries.append(val)
    return entries
```

Then decompile each entry via GhidraMCP. If an entry fails (unrecognized
function), apply this workaround.
