# Vtable-Dispatched Function Discovery Pipeline

When all Ghidra-recognized functions are already decompiled, vtable-dispatched
functions that Ghidra missed can be found by reading vtable memory directly.

## Why This Matters

Ghidra's auto-analysis recognizes direct-call functions but frequently misses
virtual dispatch targets — functions only reachable through vtable indirection.
These show up as "UNKNOWN" when reading vtable slots against `list_functions`.
Without `create_function`, they cannot be decompiled at all.

## Full Pipeline (execute_code script)

```python
import subprocess, json, struct

def read_memory(addr_str, length):
    r = subprocess.run(
        ['curl', '-s', f'http://127.0.0.1:8089/read_memory?address={addr_str}&length={length}'],
        capture_output=True, text=True, timeout=15
    )
    data = json.loads(r.stdout)
    return bytes.fromhex(data.get('hex', ''))

def get_known_addrs():
    r = subprocess.run(
        ['curl', '-s', 'http://127.0.0.1:8089/list_functions?page=1&limit=5000'],
        capture_output=True, text=True, timeout=30
    )
    known = set()
    for line in r.stdout.strip().split('\n'):
        if ' at ' in line:
            addr = line.rsplit(' at ', 1)[1].strip().lower()
            known.add(addr)
    return known

def create_function(addr_int):
    r = subprocess.run(
        ['curl', '-s', '-X', 'POST', 'http://127.0.0.1:8089/create_function',
         '-H', 'Content-Type: application/json',
         '-d', json.dumps({"address": f"0x{addr_int:X}"})],
        capture_output=True, text=True, timeout=15
    )
    return json.loads(r.stdout.strip())

def discover_vtable(vtable_addr, max_slots=20, code_range=(0x401000, 0x500000)):
    """Read a vtable, find unknown code pointers, create + decompile them."""
    known = get_known_addrs()
    raw = read_memory(f"0x{vtable_addr:X}", max_slots * 4)

    results = []
    for i in range(max_slots):
        val = struct.unpack_from('<I', raw, i * 4)[0]
        # Stop at null or float data (vtable ended)
        if val == 0 or val < code_range[0] or val > code_range[1]:
            break
        addr_str = f"{val:08x}"
        status = "KNOWN" if addr_str in known else "UNKNOWN"
        results.append((i, val, status))
        print(f"  vtable[{i:2d}] = 0x{val:08X} → {status}")

    # Create unknown functions
    for i, val, status in results:
        if status == "UNKNOWN":
            result = create_function(val)
            name = result.get('function_name', '???')
            success = result.get('success', False)
            print(f"  {'✓' if success else '⚠'} 0x{val:06X}: {name}")

    return results
```

## Usage

```python
# Discover Ball vtable functions
discover_vtable(0x4CF3A0)  # Ball vtable

# Discover Scene vtable functions
discover_vtable(0x4D0260)  # Scene vtable
```

## End-of-Vtable Detection

Vtables in target application are followed by embedded float data (physics constants).
Detect the end by checking if the DWORD value falls outside the code address range
(typically 0x401000–0x500000 for this binary):

- `0x3F800000` = 1.0f → vtable ended, this is float data
- `0x3FF00000` = 2.0f → same
- `0x00000000` = null padding → vtable ended

## Batch Decompilation After Discovery

Once `create_function` has registered the new functions, batch decompile them:

```python
# Via native MCP tool (preferred):
# tool_call: mcp_ghidra_mcp_batch_decompile
#   functions: "Ball_InitPhysicsDefaults, Ball_DrawRumbleScoreText"

# Via curl fallback:
for name, addr in new_functions.items():
    r = subprocess.run(
        ['curl', '-s', f'http://127.0.0.1:8089/decompile_function?address={addr}'],
        capture_output=True, text=True, timeout=30
    )
    # Save to analysis/ghidra/decompilations/<category>/<name>_<addr>.c
```

## Verified Results (2026-06-21)

Ball vtable (0x4CF3A0): 6 previously undetected slots discovered and created:
- vtable[1] 0x405100 → Ball_InitPhysicsDefaults
- vtable[3] 0x402A70 → Ball_DrawRumbleScoreText
- vtable[4] 0x408390 → Ball_AI_ChaseNearest
- vtable[5] 0x401590 → SceneObj_CallVtable18
- vtable[7] 0x402C10 → Ball_RenderWithCollision
- vtable[8] 0x409480 → Ball_SplitAndExplode

Scene vtable (0x4D0260): 10 previously undetected slots discovered and created:
- 0x469220 → Scene_ActivateCurrentItem
- 0x4130A0 → Scene_vmethod5
- 0x469280 → Scene_SelectCurrentItem
- 0x409D90 → Scene_NoOp
- 0x40B400 → Level_RenderDynamicObjects
- 0x4692A0 → Scene_ClearCurrentItem
- 0x409DA0 → Scene_DestroyScene
- 0x469430 → Scene_NotifyObjects
- 0x419740 → Scene_SetDestroyed
- 0x4692B0 → Scene_SaveAndCleanup
