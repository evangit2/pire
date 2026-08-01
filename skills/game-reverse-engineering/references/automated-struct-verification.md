# Automated Struct Offset Verification Script

A Python script that decompiles key functions via GhidraMCP REST API and cross-checks documented offsets against raw decompiled C. Used in Session 50 to verify 56 Scene struct offsets.

## Purpose

When a user challenges struct field accuracy ("verify the scene struct"), manual grep across decompilations is error-prone. This script automates:

1. **Function selection** — pick the struct's constructor, update, render, and 5-10 related functions
2. **Decompilation** — call GhidraMCP `decompile_function` for each address
3. **Offset extraction** — regex-scan raw C for `param_1 + 0xNNNN`, `(int)this + 0xNNNN`, `param_1[0xXXX]` patterns
4. **Confidence scoring** — count distinct functions referencing each offset
5. **Report generation** — markdown table with ✅ (≥2 functions), ⚠️ (1 function), ❓ (0 functions)

## Script Skeleton

```python
#!/usr/bin/env python3
"""
verify_struct_offsets.py — Automated struct field verification via GhidraMCP

Usage: python3 verify_struct_offsets.py > verify_report.md
"""
import re, json, urllib.request

GHIDRA_MCP_URL = "http://127.0.0.1:8089"

# --- CONFIG: edit per verification target ---
STRUCT_NAME = "Scene"
FUNCTIONS_TO_DECOMPILE = [
    (0x419C00, "Scene_Update"),
    (0x419FA0, "Scene_SetCamera"),
    (0x419B30, "Scene_dtor"),
    (0x41A5B0, "Scene_Render"),
    (0x41B2C0, "Level_UpdateAndRender"),
    (0x4564C0, "Ball_AdvancePositionOrCollision"),
    (0x405E00, "Ball_Update"),
    (0x4039E0, "Ball_ctor2"),
    (0x41C000, "Arena_HandleCollision"),
    (0x41D500, "Level_HandleCollision"),
]

# Byte offsets claimed in the documentation
CLAIMED_OFFSETS = {
    0x000: "vtable",
    0x004: "Gadget base",
    0x14C: "display_string",
    0x29D4: "ball_array",
    0x3620: "frame_counter",
}

# --- ENGINE ---

def decompile(addr):
    req = urllib.request.Request(
        f"{GHIDRA_MCP_URL}/decompile_function",
        data=json.dumps({"address": addr}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"error": str(e)}

def extract_offsets(c_code):
    offsets = set()
    for m in re.finditer(r'\(int\)(?:param_1|this) \+ (0x[0-9a-fA-F]+)', c_code):
        offsets.add(int(m.group(1), 16))
    for m in re.finditer(r'(?:param_1|this)\[(0x[0-9a-fA-F]+)\]', c_code):
        idx = int(m.group(1), 16)
        offsets.add(idx * 4)
    for m in re.finditer(r'\(int \*\)\((?:int )?(?:param_1|this) \+ (0x[0-9a-fA-F]+)\)', c_code):
        offsets.add(int(m.group(1), 16))
    return offsets

def main():
    print(f"# {STRUCT_NAME} Struct Verification Report")
    offset_refs = {}
    for addr, name in FUNCTIONS_TO_DECOMPILE:
        result = decompile(addr)
        if "error" in result:
            print(f"- **{name}** (0x{addr:06X}): ❌ {result['error']}")
            continue
        c_code = result.get("decompiled_code", "")
        offsets = extract_offsets(c_code)
        for off in offsets:
            offset_refs.setdefault(off, {})[name] = 1
        print(f"- **{name}** (0x{addr:06X}): {len(offsets)} unique offsets")
    print("\n## Claimed Offset Verification")
    print("\n| Offset | Name | Refs | Marker |")
    print("|--------|------|------|--------|")
    for off, name in sorted(CLAIMED_OFFSETS.items()):
        refs = offset_refs.get(off, {})
        count = len(refs)
        marker = "✅" if count >= 2 else ("⚠️" if count == 1 else "❓")
        print(f"| +0x{off:04X} | {name} | {count} | {marker} |")
    unclaimed = {off: refs for off, refs in offset_refs.items() if off not in CLAIMED_OFFSETS}
    print("\n## Unclaimed Offsets (Potential New Fields)")
    for off in sorted(unclaimed.keys()):
        print(f"- +0x{off:04X}: {len(unclaimed[off])} refs — {', '.join(unclaimed[off].keys())}")

if __name__ == "__main__":
    main()
```

## Key Design Decisions

1. **Three regex patterns** cover Ghidra's output variants: direct `+ 0xNNNN`, array-index `[0xNNN]` (×4), and dereference-chain `*(int *)(param_1 + 0xNNNN)`.
2. **Int-indexed conversion** is critical — Ghidra uses `param_1[0x5C]` where `0x5C * 4 = 0x170`. Missing this conversion is the #1 cause of offset misidentification.
3. **Ref-count scoring** — an offset referenced by 2+ functions is ✅; 1 function is ⚠️; 0 is ❓.
4. **Unclaimed offset discovery** — the script also prints offsets found in decomp but NOT in the documentation, revealing undocumented fields.

## Session 50 Results (Scene struct)

- 56 offsets: **VERIFIED** in raw C
- 11 offsets: **NOT found** in raw C (likely AthenaList embedded sub-fields)
- 195 offsets: **Undocumented** — present in decompilations but not in any doc

## When to Use

- User says "verify the X struct" and you need systematic evidence
- Existing documentation has conflicting offsets
- You need confidence markers (✅/⚠️/❓) for a new modding doc
- After updating docs, you want a reproducible verification step

## Pitfall: Don't Trust Comments

The script extracts from `result["decompiled_code"]` — Ghidra's raw C body. It does NOT parse the human-written `/* ... */` header block. Keep regex focused on actual C statements.
