# Ghidra Verification Methodology for target application RE

Systematic workflow for verifying claims about function addresses, calling
conventions, vtable layouts, and field offsets. Use this whenever you need
to confirm or correct documentation against the actual binary.

## Core Principle

**Never trust a prior doc's offset without a decomp cross-reference.**
Function names are hypotheses; xrefs and disassembly are proof. Patch
addresses are claims; disassembly is proof.

## Step 1: Verify Function Exists

```bash
# Search by name pattern
curl -s "http://127.0.0.1:8089/search_functions?name_pattern=Tournament" | head

# Decompile by address (preferred — names can be ambiguous)
curl -s "http://127.0.0.1:8089/decompile_function?address=0x427080" | head -20
```

## Step 2: Verify Calling Convention (RET Instruction)

Decompilation alone is NOT sufficient — Ghidra sometimes mislabels
`__thiscall` as `__fastcall`. Always verify by checking the RET instruction:

```bash
# Disassemble the function and find its RET
curl -s "http://127.0.0.1:8089/disassemble_function?address=0x427080" | grep RET
```

- `RET` (plain) = no stack params cleaned → `__fastcall` or `__thiscall` with 0 stack params
- `RET 0x4` = 1 stack param (4 bytes) cleaned by callee → `__thiscall` with 1 stack param
- `RET 0x8` = 2 stack params → `__thiscall` with 2 stack params
- `RET 0x14` = 5 stack params (20 bytes) → `__thiscall` with 5 stack params

For `__thiscall`: ECX = `this`, stack params follow. RET N means N/4 stack params.
For `__fastcall`: ECX = param_1, EDX = param_2 (if 2 params), rest on stack.

### Ghidra __fastcall vs __thiscall Confusion

Ghidra often labels `__thiscall` functions as `__fastcall` in decompilation.
The difference: `__thiscall` passes `this` in ECX and cleans stack params
(RET N). `__fastcall` passes first 2 params in ECX/EDX.

To distinguish: look for `MOV ESI,ECX` or `MOV EDI,ECX` in the prologue —
this saves `this` for later use, confirming `__thiscall`. If ECX is used
directly as a data pointer without saving, it's likely `__fastcall`.

Example: `App_StartRace` (0x4287C0) — Ghidra says `__fastcall` but the
prologue has `MOV ESI,ECX` (saving App pointer) and RET 0x4, confirming
`__thiscall` with 1 stack param.

## Step 3: Verify Calling Convention at Call Site

Check what registers/stack the CALLER sets up before the CALL:

```bash
# Disassemble the caller and look at instructions before the CALL
curl -s "http://127.0.0.1:8089/disassemble_function?address=0x4288B0" | grep -B5 "CALL.*4287c0"
```

- PUSH before CALL = stack param
- MOV ECX before CALL = this/first param
- No PUSH + MOV ECX = `__thiscall` with 0 stack params

## Step 4: Verify Vtable Entries (Read Raw Memory)

Vtable entries in decompilation use named fields (e.g., `flRadius`),
not raw offsets. To verify which function is at a vtable slot, read
raw memory:

```python
import subprocess, json, struct

def read_vtable(addr, count=40):
    r = subprocess.run(
        ['curl', '-s', '-m', '10',
         f'http://127.0.0.1:8089/read_memory?address=0x{addr:X}&length={count*4}'],
        capture_output=True, text=True, timeout=15
    )
    data = json.loads(r.stdout)
    hex_str = data.get('hex', '')
    entries = []
    for i in range(0, len(hex_str), 8):
        byte_hex = hex_str[i:i+8]
        if len(byte_hex) == 8:
            b = bytes.fromhex(byte_hex)
            val = struct.unpack('<I', b)[0]  # little-endian DWORD
            entries.append(val)
    return entries

# Read Scene vtable at 0x4D0260
entries = read_vtable(0x4D0260, 36)
for i, v in enumerate(entries):
    print(f"  vtable[{i:2d}] (0x{i*4:02X}): 0x{v:08X}")
```

### Vtable End Detection

Vtables are followed by embedded data (strings, floats). Detect the end
by checking if values fall outside the code address range (0x401000–0x500000
for target_binary.exe). Values like 0x3F800000 (1.0f) or ASCII strings indicate
the vtable has ended.

### Level Subclass Vtable Overrides

Each target application level has its own subclass vtable. To find which vtable a
level uses, decompile the level's Board ctor and look for the vtable
assignment:

```bash
curl -s "http://127.0.0.1:8089/decompile_function?address=0x41CA40" | grep "PTR_"
# → *(undefined ***)this = &PTR_BoardLevel1_WarmUp_dtor_004d04a8;
```

Then read that vtable to verify which slots are overridden. Key insight:
vtable[32] (Scene_SpawnBallsAndObjects) is shared across ALL level vtables,
while vtable[18] (level load) is overridden per level.

## Step 5: Verify Field Offsets

Ghidra decompilation shows field access as either:
- `param_1[0xNNN]` — DWORD index (multiply by 4 for byte offset)
- `*(type*)((int)param_1 + 0xNNN)` — direct byte offset (already correct)

**Common pitfall**: `param_1[0xB3]` means offset 0xB3 × 4 = 0x2CC, NOT
0xB3. Always multiply array index by 4 to get the x86 byte offset.

To verify a float value at a known offset, read the raw bytes and unpack:

```python
import struct
# 0x41d80000 → what float is this?
print(struct.unpack('f', struct.pack('I', 0x41d80000))[0])  # → 27.0
```

## Step 6: Verify Who Writes a Field

To find all writers of a specific struct field (e.g., ball+0x14C):

1. Decompile the suspected setter functions
2. Search the decompiled C code for the hex offset
3. Cross-reference with disassembly to confirm the exact write address

```python
import subprocess

def ghidra_decompile(addr):
    r = subprocess.run(
        ['curl', '-s', '-m', '30',
         f'http://127.0.0.1:8089/decompile_function?address={addr}'],
        capture_output=True, text=True
    )
    return r.stdout

# Check which functions write to ball+0x14C
for name, addr in [
    ("Ball_ctor2", "0x4039E0"),
    ("Scene_StartCountdown", "0x437130"),
    ("Scene_HandleRaceEnd", "0x41B130"),
    ("RumbleBoard_Update", "0x421FE0"),
]:
    code = ghidra_decompile(addr)
    for line in code.split('\n'):
        if '0x14c' in line:
            print(f"  {name}: {line.strip()}")
```

## Step 7: Verify Xrefs (Who Calls This Function)

```bash
# Function xrefs (GET)
curl -s "http://127.0.0.1:8089/get_function_xrefs?address=0x427080&limit=100"

# Data address xrefs (POST — GET returns empty)
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"addresses":["0x004fd680"], "limit":300}' \
  http://127.0.0.1:8089/get_bulk_xrefs
```

High xref count (60+) usually means the function is called from many
unrelated contexts — NOT a good hook point for race-start or other
specific-event detection.

## Step 6b: Binary-Wide Write Search (objdump)

When you need to find ALL writes to a specific struct offset across the
entire binary (not just in known functions), use objdump + grep:

```bash
# Find ALL writes to [reg+0x5DC] (e.g., checking if App+0x5DC is ever written)
objdump -d -M intel --no-show-raw-insn target_binary.exe | \
  grep '+0x5dc]' | grep 'mov.*DWORD PTR' | \
  awk -F',' '{print $1}' | grep '0x5dc]'
```

This catches writes that Ghidra's decompiler might miss (struct copies,
pointer arithmetic patterns). If zero writes are found for a field that
code reads, the field is either:
- Set via memset/memcpy on a larger struct block
- Never written (always zero/NULL — likely dead code or removed feature)
- Set via indirect pointer arithmetic the grep can't pattern-match

**Proven use case**: Used to verify that App+0x5DC has zero writes in the
entire target_binary.exe binary, confirming it's never explicitly set by
any function (likely populated via struct copy during initialization).

### Endian-Aware Byte Search (fallback)

When objdump grep is insufficient, search the raw binary for the 4-byte
little-endian encoding of the target offset:

```python
import struct

with open("target_binary.exe", "rb") as f:
    data = f.read()

target = struct.pack('<I', 0x5DC)  # DC 05 00 00 in bytes
pos = 0
while True:
    pos = data.find(target, pos)
    if pos == -1: break
    va = pos + 0x400000  # rough VA estimate (adjust for PE sections)
    if 0x400000 <= va <= 0x4E0000:
        # Check preceding bytes for write opcodes (0x89 = MOV [mem], reg)
        if pos >= 2 and data[pos-2] == 0x89:
            modrm = data[pos-1]
            if (modrm & 0xC0) == 0x80:  # mod=10 = disp32
                print(f"WRITE at VA 0x{va-2:08X}")
    pos += 1
```

## Common Verification Pitfalls

1. **EAX after CALL**: After a `CALL` instruction, EAX is caller-saved
   and may be clobbered by the callee. Never assume EAX holds a specific
   value after a CALL without checking the next instruction that sets it.

2. **Ghidra struct named fields**: Ghidra decompilation uses struct field
   names (e.g., `flRadius`, `flMax_speed_float`) which may not match the
   actual offset you expect. Always cross-reference with the struct
   definition comment or raw disassembly.

3. **Field override chains**: A constructor may set a field to value X,
   but the caller may override it to value Y after the constructor returns.
   Always check both the ctor AND the calling function for field writes.
   Example: Ball_ctor2 sets radius=27.0, but Scene_SpawnBallsAndObjects
   overrides it to 26.0 after Ball_ctor2 returns.

4. **Ghidra C-index vs byte-offset**: `param_1[0xNNN]` uses 4-byte stride.
   `*(int*)((int)param_1 + 0xNNN)` uses direct byte offset. Convert: byte_offset = C_index × 4.

5. **Ghidra variable merging**: Ghidra's decompiler may merge unrelated
   variables that share the same register into one decompiled variable,
   producing confusing code like comparing a pointer with an integer.
   Example: Scene_Update's physics gate decompiles as
   `if ((iVar6 != 1) || (*(char*)(iVar6 + 0x14c) == '\0'))` where iVar6
   is first the list size (from AthenaList_GetSize) then a ball pointer
   (from App+0x5DC). The disassembly shows these are separate registers.
   Always cross-reference decomp with disasm for complex conditionals.

6. **objdump for binary-wide pattern search**: When you need to find ALL
   writes to a specific struct offset across the entire binary, use:
   ```bash
   objdump -d -M intel --no-show-raw-insn target_binary.exe | \
     grep '+0x5dc]' | grep 'mov.*DWORD PTR' | \
     awk -F',' '{dst=$1; if (match(dst, /0x5dc\]/)) print}'
   ```
   This catches writes Ghidra's decompiler might miss. Proven use case:
   verifying App+0x5DC has zero writes in the entire binary.

## Step 8: CEA Script Verification (Ad-Hoc)

CEA scripts reference many hardcoded addresses (hook points, string
constants, function addresses, alloc sizes, board slot offsets). Before
sending a CEA to a user, run an ad-hoc verification script that
cross-checks every address against the live binary via GhidraMCP.

### What to verify:
1. **Hook point bytes** — read 6 bytes at 0x405E22, confirm they match
   `8B 86 5C 0C 00 00` (mov eax, [esi+0x0C5C])
2. **String addresses** — read memory at each string address, confirm the
   null-terminated string matches the expected path
3. **Function addresses** — disassemble each function address, confirm it
   returns valid instructions (not an error)
4. **Calling conventions** — find the RET instruction in each ctor's
   disassembly, confirm RET N matches the expected parameter count
5. **CEA file structure** — check for [ENABLE], [DISABLE], alloc, dealloc,
   registersymbol, original_code, jmp 00405E28, restore bytes
6. **Alloc sizes** — search CEA text for `push 0xNNNN` matching expected
   allocation sizes for each object type
7. **Board slot offsets** — search CEA text for 0x436C, 0x4370, etc.
8. **Call site presence** — count occurrences of `call 00457AD0` (Timer_Init)
   and `call 00457A40` (Timer_Cleanup) — should appear once per spawned object

### Bug caught by this method (June 2026):
The GlobalImpossible.CEA initially had 5 spawned objects but ZERO
Timer_Init/vtable[0x58]/vtable[0x54]/Timer_Cleanup blocks. The ad-hoc
script checked for `call 00457AD0` count >= 5 and found 0, catching the
bug before it reached the user. Without these blocks, objects allocate
and register in board lists but never render or animate.

### Script pattern:
```python
import subprocess, json, os, sys

def ghidra_get(path):
    r = subprocess.run(f'curl -s "http://127.0.0.1:8089{path}"',
        shell=True, capture_output=True, text=True, timeout=15)
    return r.stdout.strip()

def read_mem(addr, length=64):
    raw = ghidra_get(f"/read_memory?address={addr}&length={length}")
    try:
        d = json.loads(raw)
        return bytes.fromhex(d.get('hex',''))
    except: return b''

def disasm(addr):
    return ghidra_get(f"/disassemble_function?address={addr}")

# Check hook bytes
hook = read_mem("0x405E22", 6)
expected = bytes([0x8B, 0x86, 0x5C, 0x0C, 0x00, 0x00])
assert hook == expected, f"Hook mismatch: {hook.hex()}"

# Check strings
for addr, expected_str in string_map.items():
    raw = read_mem(addr, 64)
    actual = raw.split(b'\x00')[0].decode('ascii')
    assert actual == expected_str, f"String {addr}: {actual}"

# Check RET N for each ctor
for addr, (name, exp_retn) in ctors.items():
    lines = disasm(addr).strip().split('\n')
    for line in lines:
        if 'RET' in line and '0x' in line:
            found = int(line.split('RET')[1].strip().split()[0], 16)
            assert found == exp_retn, f"{name}: RET {hex(found)} != {hex(exp_retn)}"

# Check CEA file for required call sites
cea = open(cea_path).read()
assert cea.count('call 00457AD0') >= 5, "Missing Timer_Init calls"
assert cea.count('call 00457A40') >= 5, "Missing Timer_Cleanup calls"
assert cea.count('call dword [eax+0x58]') >= 5, "Missing CallUpdate calls"
assert cea.count('call dword [eax+0x54]') >= 5, "Missing CallRender calls"
```

This is ad-hoc verification (not a test suite). It catches structural
errors but does NOT verify runtime behavior — that requires testing on
Cheat Engine with the real game.
