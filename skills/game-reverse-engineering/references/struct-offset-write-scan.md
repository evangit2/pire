# §24 Systematic Struct-Offset Write Scan

When you need to find **all code paths** that write to a specific struct field, don't rely on
Ghidra xrefs alone — Ghidra may not have all functions defined, especially for large unanalyzed
regions. Use `objdump` to scan the entire binary for the byte-displacement pattern.

## The Technique

```bash
# Find all writes to ball+0x2F9 (byte field, byte-displacement in ASM)
objdump -d -M intel target_binary.exe | grep "mov.*byte.*\[.*0x2f9\].*,"

# Find all writes to ball+0x2E8 (byte field)
objdump -d -M intel target_binary.exe | grep "mov.*byte.*\[.*0x2e8\].*,"

# Find all writes to ball+0x808 (dword field)
objdump -d -M intel target_binary.exe | grep "mov.*dword.*\[.*0x808\].*," | grep -v "0x8080\|0x8084"
```

## Why This Works

- `objdump -d` disassembles the ENTIRE .text section, including code Ghidra hasn't defined as functions.
- Struct field accesses in x86 use `[reg+offset]` displacement encoding, which is searchable.
- Byte fields use `MOV BYTE PTR [esi+0x2F9], val` — distinctive opcode pattern.
- Dword fields use `MOV DWORD PTR [esi+0x808], val` — also distinctive.

## Filtering Pitfalls

- **Adjacent offsets:** `grep "0x2f9"` will also match `0x2f90`, `0x2f98`, etc. Filter with `\]`
  after the offset to match the closing bracket: `grep "0x2f9\]"`.
- **Read vs write:** Add a trailing `,` to match writes only (`mov ..., val`), not reads
  (`mov reg, [...]`).
- **Byte vs dword:** Use `byte` or `dword` in the grep to distinguish field sizes.

## When to Use This

1. **Tracing trigger paths:** When you need ALL functions that set a flag (e.g., "what triggers
   is_falling?"). Ghidra xrefs only work for defined functions — objdump catches everything.

2. **Verifying completeness:** After finding writers via Ghidra, run objdump to confirm you didn't
   miss any in undefined code regions.

3. **Finding Ghidra-undiscovered functions:** If objdump finds a write at an address not in Ghidra's
   function list, use `create_function` to define it, then decompile.

## Case Study: Dizzy System (Session 21627, CORRECTED Session 22054)

Searching for all writers to `ball+0x2F9` (is_stunned) revealed:
```
403cb7:  mov BYTE PTR [esi+0x2f9], bl     ← Ball_ctor2 (init to 0)
405d5b:  mov BYTE PTR [esi+0x2f9], 0x1     ← FindClosestRespawnPoint (THE trigger)
406693:  mov BYTE PTR [esi+0x2f9], 0x0     ← Ball_Update (clear stun)
```

Only 3 writes in the entire binary — confirming the stun trigger chain was fully traced.
Ghidra had `Ball_FindClosestRespawnPoint` but NOT the function at 0x4031B0
(Ball_SpecialFallUpdate), which was found via objdump and then `create_function`'d.

### CORRECTION (Session 22054): The "dizzy" trigger was NOT in the initial scan

The initial dizzy analysis claimed dizzy was triggered only by E:TRAJECTORY events.
The user corrected: "This dizzy effect can happen literally anywhere." The actual
trigger was found by a different approach — backward tracing from the end-screen
display string "DIZZIED BALLS:" (see `references/ui-display-to-trigger-tracing.md`).

The dizzy COUNTER lives at `App + pIdx*0xA0 + 0x5F8` (NOT on the ball struct).
Searching for writes to ball+0x2F0 (impact_count) found the E:TRAJECTORY trigger,
but missed the bounce-triggered path in Ball_Update at 0x406BEA where
`ball+0x2EC >= 2` calls Ball_ApplyTrajectory from ANY collision. The lesson:
struct-offset scans find writes to a specific struct field, but the TRIGGER
mechanism may use a different field entirely (bounce_count at +0x2EC, not
impact_count at +0x2F0).

## Cross-Reference: Reading Float Constants from PE

When you find float comparisons in decompiled code (`_DAT_004cf524`, `_DAT_004cf310`, etc.),
read the actual values from the PE file directly:

```python
import struct
with open(EXE, 'rb') as f:
    f.seek(0x3C); pe_off = struct.unpack('<I', f.read(4))[0]
    f.seek(pe_off + 6); nsec = struct.unpack('<H', f.read(2))[0]
    f.seek(pe_off + 20); opt = struct.unpack('<H', f.read(2))[0]
    tbl = pe_off + 24 + opt
    for i in range(nsec):
        f.seek(tbl + i * 40)
        raw = f.read(40)
        vsize = struct.unpack_from('<I', raw, 8)[0]
        vrva = struct.unpack_from('<I', raw, 12)[0]
        rawptr = struct.unpack_from('<I', raw, 20)[0]
        if vrva <= RVA < vrva + vsize:
            f.seek(rawptr + (RVA - vrva))
            return struct.unpack('<f', f.read(4))[0]
```

This lets you resolve constants like `_DAT_004cf524 = 0.01` without guessing from hex.
