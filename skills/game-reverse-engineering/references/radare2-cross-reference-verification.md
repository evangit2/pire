# Radare2 Cross-Reference Verification — Independently Checking Ghidra Decompilation

Ghidra's decompiler is good but not infallible. When documenting a complex function
for modding, reimplementation, or API reference, verify the decompiled C against the
**raw binary** using a different disassembler. Radare2 (r2) is ideal: it's fast,
scriptable, and produces clean output for batch analysis.

## When to Apply

- Documenting a large/complex function (>1000 lines decompiled C) for official reference
- User asks to "cross-reference" or "verify the decompiled code is correct"
- Writing modding docs based on decompiled offsets that haven't been binary-verified
- After batch decompilation when you need to confirm call targets and offset mappings

## Step 1: Disassemble the Function with r2

```bash
# Disable colors for clean text output
r2 -q -e scr.color=0 -c 's 0x00405e00; af; pdf' target_binary.exe > /tmp/func_disasm.txt
```

- `s 0xADDR` — seek to function address
- `af` — analyze function
- `pdf` — print disassembled function
- `-q` — quiet mode (no interactive prompts)
- `-e scr.color=0` — strip ANSI codes

Result: a text file with every instruction, address, and raw bytes.

## Step 2: Parse and Extract Key Structures

Use Python to parse the r2 output into structured data:

```python
import re

with open('/tmp/func_disasm.txt') as f:
    raw = f.read()

parsed = []
for line in raw.split('\n'):
    m = re.match(r'.*?(0x[0-9a-f]+)\s+([0-9a-f ]+?)\s{2,}(.+)', line)
    if m:
        addr = int(m.group(1), 16)
        bytes_hex = m.group(2).strip()
        instr = m.group(3).strip()
        parsed.append((addr, bytes_hex, instr))

print(f"Parsed {len(parsed)} instructions")
print(f"Address range: 0x{parsed[0][0]:08X} - 0x{parsed[-1][0]:08X}")
```

## Step 3: Verify Call Targets

Extract all `call` instructions and map them to known function addresses:

```python
call_list = []
for addr, bytes_hex, instr in parsed:
    if instr.startswith('call ') and '0x' in instr:
        target_str = instr.replace('call ', '').strip().split()[0]
        call_list.append((addr, target_str, instr))
    elif 'call dword' in instr:
        call_list.append((addr, 'VTABLE', instr))  # indirect vtable call

# Cross-reference each target against your known function address table
known = {
    0x458ee0: "Sound_Play3DAtPosition",
    0x4ba57b: "operator_new",
    0x428ed0: "Difficulty_GetTimeModifier",
    0x419fa0: "Scene_SetCamera",
    # ... etc
}

for addr, target_str, instr in call_list:
    if target_str.startswith('0x'):
        target = int(target_str, 16)
        name = known.get(target, f"unknown_{target_str}")
        print(f"0x{addr:08X}  {name}")
```

**Verification criterion:** Every direct call in the decompiled C should have a
matching `call 0xADDR` in the disassembly. If the decompiled C references a
function call that doesn't appear in the r2 disassembly, either Ghidra inlined
it (check xrefs separately) or the decompilation is wrong.

## Step 4: Verify Offset Mappings (The int* Trap)

Ghidra decompiles struct pointers as `int*`, so `param_1[N]` means **byte offset
N × 4**, not byte offset N. This is the most common source of confusion when
reading decompiled C.

**Build the verification table:**

```python
offset_checks = [
    # (decompiled_index, expected_byte_offset, description)
    (0x314, 0xC50, "spin_timer"),
    (0x059, 0x164, "pos_x"),
    (0x05A, 0x168, "pos_y"),
    (0x05B, 0x16C, "pos_z"),
    (0x0A1, 0x284, "radius"),
    (0x069, 0x1A4, "scene_obj"),
    (0x005, 0x014, "scene"),
    (0x006, 0x018, "player_index"),
]

# Find all [esi + 0xNNN] references (ESI typically holds 'this' in __fastcall)
esi_offsets = set()
for addr, bytes_hex, instr in parsed:
    matches = re.findall(r'\[esi \+ (0x[0-9a-f]+)\]', instr)
    for m in matches:
        esi_offsets.add(int(m, 16))

for idx, expected, desc in offset_checks:
    found = expected in esi_offsets
    print(f"param_1[0x{idx:03X}] → 0x{expected:04X} {'✓' if found else '✗'}  {desc}")
```

**Byte-access fields:** Some fields are accessed as bytes, not dwords. In the
decompiled C these appear as `*(char *)((int)param_1 + 0x31D)` — the cast
means **byte offset 0x31D**, NOT int-index 0x31D (which would be 0xC74).

```python
# Search for byte-level access patterns
for addr, bytes_hex, instr in parsed:
    if 'byte [esi + 0x31d]' in instr.lower():
        print(f"  0x{addr:08X}  {instr}")
# Output: mov byte [esi + 0x31d], 1  ← byte offset 0x31D, confirmed
```

## Step 5: Verify Collision/Dispatch Type Comparisons

For functions with type-dispatch loops (collision types, event types, etc.),
find every `cmp` instruction with small immediate values:

```python
# Find all cmp with immediate 1, 2, 5 (collision types)
for addr, bytes_hex, instr in parsed:
    if re.match(r'cmp\s+\w+,\s+([125])\s*$', instr):
        idx = next(i for i, p in enumerate(parsed) if p[0] == addr)
        ctx = parsed[max(0,idx-3):idx+4]
        print(f"0x{addr:08X}  {instr}")
        for a, b, i in ctx:
            print(f"  0x{a:08X}  {i}")
```

This verifies the decompiled C's `if (type == 1)`, `if (type == 2)`, `if (type == 5)`
branches match the binary's actual comparison instructions.

## Step 6: Verify Arithmetic Expressions

The decompiled C often shows complex address calculations. Verify them by
reading the actual instruction sequence:

**Example — score address `App + 0x5E4 + pidx * 0xA0`:**

```asm
mov eax, dword [esi + 0x18]      ; eax = player_index
lea eax, [eax + eax*4]            ; eax = pidx * 5
shl eax, 5                         ; eax = pidx * 5 * 32 = pidx * 160 = pidx * 0xA0
lea edi, [eax + edx + 0x5e4]      ; edi = App + 0x5E4 + pidx * 0xA0
```

The `lea + shl` pattern is a common compiler idiom for multiplication by
non-power-of-2 constants. `pidx * 0xA0` = `pidx * 160` = `pidx * 5 * 32`,
which the compiler implements as `lea (eax+eax*4)` then `shl 5`.

## Step 7: Verify the Epilogue

Check that the function epilogue matches the decompiled C's cleanup:

```asm
call 0x453250          ; Vec3List_Free (final cleanup)
mov ecx, dword [var]   ; restore SEH chain
pop edi                ; restore callee-saved registers
pop esi
pop ebp
mov dword fs:[0], ecx  ; restore SEH handler
pop ebx
add esp, 0x938          ; restore stack frame
ret
```

Verify: (1) final cleanup call matches decompiled C, (2) SEH restore present,
(3) register restore order correct, (4) stack adjustment matches prologue's
`sub esp` amount, (5) `ret` is the last instruction.

## Step 8: Verify Mislabeled Decompilation Files

A common problem: multiple decompilation files share the same function name
but correspond to **different addresses**. Verify by checking the entry pattern:

```bash
# Disassemble the suspected function
r2 -q -e scr.color=0 -c 's 0x00405190; af; pdf' target_binary.exe | head -20

# Check what calls it
r2 -q -e scr.color=0 -c 'aaa; s 0x405190; axt' target_binary.exe
```

If the xrefs show the function is called from completely different code than
expected (e.g., scene code instead of ball physics), the decompilation file
is mislabeled — it decompiles a different function than its name suggests.

**Case study:** `decomp_ball_update.c` was labeled as `Ball_Update` but
actually decompiled function `0x405190` (a checkpoint/target-finding function
called from scene code at 0x41B5CF, 0x41B652, 0x41D7C2, 0x421042), NOT
`0x405E00` (the actual Ball_Update physics tick). The entry pattern
(`mov al, byte [esi + 0x324]`) confirmed it was a different function.

## Verification Summary Checklist

| Check | Method | Pass Criterion |
|-------|--------|----------------|
| Calling convention | `mov esi, ecx` in prologue | ECX = this, confirmed __fastcall |
| Function size | First to last instruction address | Matches Ghidra's reported size ±5 bytes |
| Call targets | Extract all `call 0xADDR` | Every direct call in decompiled C has a match |
| Offset mappings | `[esi + 0xNNN]` in disasm | Every `param_1[N]` in decompiled C = `[esi + N*4]` |
| Byte-access fields | `byte [esi + 0xNNN]` in disasm | Matches `*(char*)(param_1 + 0xNNN)` in decompiled C |
| Type dispatch | `cmp dword [reg], N` | Matches `if (type == N)` in decompiled C |
| Arithmetic idiom | `lea` + `shl` sequences | Matches decompiled C's multiplication |
| Epilogue | Final `call` + `ret` | Cleanup call + SEH restore + stack adjust present |
| File labeling | Entry pattern + xrefs | Entry instruction matches expected function |
