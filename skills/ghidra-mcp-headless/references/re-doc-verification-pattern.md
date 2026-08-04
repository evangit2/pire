# RE Documentation Verification Script Pattern

When you've written RE documentation (struct layouts, function addresses, float constants),
verify it against the binary with a single Python script before committing. This pattern
catches wrong addresses, misread constants, and fabricated claims.

## What to Verify

1. **Function addresses** — exist in Ghidra's function list
2. **Instruction bytes** — the actual x86 bytes at claimed addresses match the doc
3. **Float constants** — values read from PE `.rdata` match documented claims
4. **Decompilation cross-references** — key fields/offsets appear in decompiled code
5. **String constants** — claimed event names exist in the binary

## Script Template

```python
#!/usr/bin/env python3
"""Ad-hoc verification of RE documentation claims against the binary."""
import subprocess, struct, sys

EXE = '/path/to/game.exe'
GHIDRA = 'http://127.0.0.1:8089'
results = []

def check(label, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    results.append(f"[{status}] {label}" + (f" — {detail}" if detail else ""))

# --- 1. Function addresses exist in Ghidra ---
func_list = subprocess.run(
    ['curl', '-s', f'{GHIDRA}/list_functions?page=1&limit=5000'],
    capture_output=True, text=True, timeout=30).stdout
# NOTE: Ghidra list_functions uses lowercase hex without 0x prefix: "00405190"
for addr, name in expected_funcs.items():
    check(f"Function {name} at 0x{addr}", addr in func_list)

# --- 2. Instruction bytes at claimed addresses ---
disasm = subprocess.run(
    ['objdump', '-d', '-M', 'intel',
     '--start-address=0xADDR', '--stop-address=0xADDR2', EXE],
    capture_output=True, text=True, timeout=15).stdout
check("Instruction matches", "EXPECTED ASM TEXT" in disasm)

# --- 3. Float constants from PE ---
with open(EXE, 'rb') as f:
    f.seek(0x3C); pe_off = struct.unpack('<I', f.read(4))[0]
    f.seek(pe_off + 6); nsec = struct.unpack('<H', f.read(2))[0]
    f.seek(pe_off + 20); opt = struct.unpack('<H', f.read(2))[0]
    tbl = pe_off + 24 + opt; secs = []
    for i in range(nsec):
        f.seek(tbl + i * 40)
        raw = f.read(40)
        vsize = struct.unpack_from('<I', raw, 8)[0]
        vrva = struct.unpack_from('<I', raw, 12)[0]
        rawptr = struct.unpack_from('<I', raw, 20)[0]
        secs.append((vrva, vsize, rawptr))
    def rf(rva):
        for vrva, vs, rp in secs:
            if vrva <= rva < vrva + vs:
                f.seek(rp + (rva - vrva))
                return struct.unpack('<f', f.read(4))[0]
        return None
    v = rf(0xCF524)
    check("Alpha rate = 0.01", v is not None and abs(v - 0.01) < 0.001)

# --- 4. Decompilation cross-references ---
decomp = subprocess.run(
    ['curl', '-s', f'{GHIDRA}/decompile_function?address=0xADDR'],
    capture_output=True, text=True, timeout=30).stdout
check("Field offset in decomp", "0x2f9" in decomp.lower())

# --- 5. String constants ---
strings_out = subprocess.run(['strings', EXE], capture_output=True, text=True, timeout=15).stdout
check("Event string in binary", "E:NODIZZY" in strings_out)

# --- Report ---
print("=" * 70)
print("AD-HOC VERIFICATION (not a test suite)")
print("=" * 70)
for r in results: print(r)
p = sum(1 for r in results if r.startswith("[PASS]"))
f = sum(1 for r in results if r.startswith("[FAIL]"))
print(f"\n{p}/{len(results)} passed, {f} failed")
sys.exit(0 if f == 0 else 1)
```

## Key Pitfalls

- **Address format:** Ghidra `list_functions` returns lowercase hex WITHOUT `0x` prefix
  (e.g., `00405190`, not `0x00405190`). Match accordingly.
- **PE section parsing:** Use `struct.unpack_from('<I', raw, offset)` with correct offsets:
  VirtualSize at +8, VirtualAddress at +12, SizeOfRawData at +16, PointerToRawData at +20.
  **NOT** `f.read(16)[8:]` — that truncates and produces wrong results.
- **Float comparison:** Use `abs(value - expected) < 0.001` for float equality, not `==`.
- **objdump text:** Check for the full instruction mnemonic+operands text, not raw bytes.
- **Curl decompilation:** The REST endpoint returns plain text (not JSON) for
  `decompile_function` — pipe directly, don't try `json.load`.
