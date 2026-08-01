# PE Import/Export Verification

> Adapted from the target-specific RE toolkit for general binary analysis.

## Why This Matters

A target binary imports functions from a proxy DLL at load time via the PE import table. If the proxy DLL is missing ANY imported function, the loader aborts with an unimplemented function error.

## Workflow

1. Parse the target binary's PE import table to find all functions imported from the proxy DLL.
2. Verify the proxy DLL exports ALL of them (plus extras for safety).
3. Automated verification scripts catch missing exports after every compile.

## Python Script to Parse PE Import Table

```python
import struct

with open('target_binary.exe', 'rb') as f:
    data = f.read()

pe_off = struct.unpack_from('<I', data, 0x3C)[0]
opt_hdr = pe_off + 24
magic = struct.unpack_from('<H', data, opt_hdr)[0]

if magic == 0x10b:  # PE32
    import_rva = struct.unpack_from('<I', data, opt_hdr + 104)[0]
elif magic == 0x20b:  # PE32+
    import_rva = struct.unpack_from('<I', data, opt_hdr + 120)[0]

opt_hdr_size = struct.unpack_from('<H', data, pe_off + 0x14)[0]
num_sections = struct.unpack_from('<H', data, pe_off + 0x06)[0]
section_off = pe_off + 0x18 + opt_hdr_size

sections = []
for i in range(num_sections):
    s = section_off + i * 40
    name = data[s:s+8].rstrip(b'\x00').decode('ascii', errors='replace')
    vaddr = struct.unpack_from('<I', data, s+12)[0]
    vsize = struct.unpack_from('<I', data, s+8)[0]
    rawoff = struct.unpack_from('<I', data, s+20)[0]
    rawsize = struct.unpack_from('<I', data, s+16)[0]
    sections.append((name, vaddr, vsize, rawoff, rawsize))

def rva_to_offset(rva):
    for name, va, vs, ro, rs in sections:
        if va <= rva < va + max(vs, rs):
            return ro + (rva - va)
    return None

imp_off = rva_to_offset(import_rva)
i = 0
while True:
    desc = imp_off + i * 20
    name_rva = struct.unpack_from('<I', data, desc + 12)[0]
    if name_rva == 0:
        break
    name_off = rva_to_offset(name_rva)
    if name_off is None:
        i += 1; continue
    dll_name = data[name_off:data.index(b'\x00', name_off)].decode('ascii', errors='replace')

    if 'target' in dll_name.lower():
        print(f'=== {dll_name} ===')
        oft_rva = struct.unpack_from('<I', data, desc)[0]
        iat_rva = struct.unpack_from('<I', data, desc + 16)[0]
        thunk_rva = oft_rva if oft_rva else iat_rva
        thunk_off = rva_to_offset(thunk_rva)
        j = 0
        while True:
            thunk_val = struct.unpack_from('<I', data, thunk_off + j * 4)[0]
            if thunk_val == 0:
                break
            if thunk_val & 0x80000000:
                print(f'  Ordinal: {thunk_val & 0xFFFF}')
            else:
                func_off = rva_to_offset(thunk_val)
                if func_off:
                    fname = data[func_off+2:data.index(b'\x00', func_off+2)].decode('ascii', errors='replace')
                    print(f'  {fname}')
            j += 1
    i += 1
```

## Verifying DLL Exports Match

```bash
i686-w64-mingw32-objdump -p proxy.dll | grep TargetFunc | awk '{print $NF}' | sort
```

Compare the export list against the target binary's imports. Every import must appear in the proxy's export list.

## Automated Verification

Create a post-compile verification script that:
1. Recompiles with `-Wall -Wextra`
2. Validates PE32 format
3. Checks all required exports with plain and decorated names
4. Verifies source contains expected patterns (lazy loading, `__stdcall`, etc.)
5. Compares `tools/` and `mods/` copies via MD5

## Common Mismatches

- Plural vs singular API names (e.g. `GetAttributes` vs `GetAttribute`). Export both.
- Zero-parameter functions that are easy to overlook.
- Missing `@N` decorated names — ensure `-Wl,--add-stdcall-alias` is used.
