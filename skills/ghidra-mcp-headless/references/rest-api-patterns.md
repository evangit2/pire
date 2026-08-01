# GhidraMCP REST API — Working Patterns (v5.2.0-headless)

Tested against live target_binary.exe project, 2025-06-05. Updated 2026-06-20 with disassembly, memory read, and function creation endpoints.

## Health & Diagnostics

**PREFERRED: Native MCP tools** (when `hermes tools list | grep ghidra` shows the bridge is active):

```
tool_call: mcp_ghidra_mcp_compare_programs_documentation
  → Returns rename coverage percent directly
```

**FALLBACK: curl via terminal:**

```bash
# 1. Server health
curl -s http://127.0.0.1:8089/health | jq .
# Expected: {"status":"healthy","version":"5.2.0-headless","program_loaded":true,"program_name":"target_binary.exe"}

# 2. Rename coverage
curl -s http://127.0.0.1:8089/compare_programs_documentation | jq .
# Expected: {"programs":[{"name":"target_binary.exe","total_functions":3801,"documented":3782,"documentation_percent":99.5}]}
```

## Decompilation

**PREFERRED — native MCP tools:**

```
# Single function by address
tool_call: mcp_ghidra_mcp_decompile_function
  address: "0x405E00"

# Multiple functions at once (comma-separated names or addresses)
tool_call: mcp_ghidra_mcp_batch_decompile
  functions: "CreateBadBall, Input_CheckKeyCombo, MusicPlayer_Render"
```

The `batch_decompile` response is a JSON object: `{"FunctionName": "<decompiled C>", ...}`.
Parse it programmatically, annotate with struct offset comments, and write each
to `analysis/ghidra/decompilations/<category>/<FuncName>_<addr>.c`.

**FALLBACK — curl via terminal:**

```bash
# By address — preferred (names can be ambiguous)
curl -s "http://127.0.0.1:8089/decompile_function?address=0x405E00" > decomp.c

# By name — works if renamed
curl -s "http://127.0.0.1:8089/decompile_function?name=Ball_Update" > decomp.c

# IMPORTANT: Only GET works. POST with JSON body returns:
#   {"error":"Address or function name is required"}
```

## Disassembly

```bash
# Full disassembly of a function — plain text, one "ADDR: instruction" per line
curl -s "http://127.0.0.1:8089/disassemble_function?address=0x409C60"
```

Essential for:
- **Counting parameters via RET N**: `RET 0x3C` = 60 bytes = 15 stack params (x4 bytes each). For `__thiscall`, add 1 for ECX (`this`).
- **Verifying calling conventions**: `MOV ESI,ECX` in prologue = `__thiscall`; `PUSH EBP; MOV EBP,ESP` = `__stdcall`/`__cdecl`.
- **Tracing push sequences at call sites**: Pushes are in reverse parameter order. `SUB ESP,0x14` blocks reserve stack space for by-value struct parameters (5 DWORDs = 20 bytes each).

## Memory Reading

```bash
# Read raw bytes at any virtual address — returns JSON with data[] and hex fields
curl -s "http://127.0.0.1:8089/read_memory?address=0x4CF300&length=32"
# Returns: {"address":"004cf300","length":32,"data":[112,104,69,0,...],"hex":"70684500..."}
```

Essential for:
- **Reading vtable entries**: Read 4 bytes per slot, parse as little-endian DWORD (function pointer). Each DWORD is a vtable slot — if the value is in the 0x401000-0x4CF000 range, it's a code pointer (function). Values outside that range (e.g., 0x3F800000 = 1.0f) indicate the vtable has ended and you're reading embedded float data.
- **Decoding float constants**: Read 4 bytes at a data address, unpack with Python: `struct.unpack('f', bytes([b0,b1,b2,b3]))[0]`
- **Reading string data**: Read N bytes at a .rdata address to get string literals.

```bash
# Example: read 8 vtable slots (32 bytes) at 0x4D8E10
curl -s "http://127.0.0.1:8089/read_memory?address=0x4d8e10&length=32"
# Parse hex into DWORDs (little-endian):
#   vtable[0]=0x456870, vtable[1]=0x4564C0, vtable[2]=0x456280, ...
```

## Creating Missing Functions

When `read_memory` reveals a vtable slot pointing to an address that `list_functions` doesn't show (Ghidra didn't auto-detect it), create it:

```bash
# POST with JSON body — NOT query params (GET returns 404)
curl -s -X POST "http://127.0.0.1:8089/create_function" \
  -H "Content-Type: application/json" \
  -d '{"address":"0x456890"}'
# Returns: {"success":true,"address":"00456890","function_name":"FUN_00456890",...}

# Now it can be decompiled:
curl -s "http://127.0.0.1:8089/decompile_function?address=0x456890"
```

**When to use:** After reading a vtable and finding a slot pointing to an address not in `list_functions`, use `create_function` to make it decompilable. This is the only way to decompile vtable-dispatched functions that Ghidra missed. The function will be named `FUN_<address>` and can be renamed later.

### Pitfall: `batch_decompile` returns "Function not found" for unregistered addresses

When `batch_decompile` returns `"Error: Function not found"` for an address, Ghidra hasn't registered it as a function. This happens frequently with factory addresses read from vtables — the code exists but Ghidra's auto-analysis didn't create a function entry.

**Fix:** POST to `/create_function` for each missing address first, then retry `batch_decompile`:

```python
import subprocess, json

# Step 1: Create functions at addresses that batch_decompile couldn't find
missing_addrs = ["0x0040A550", "0x0040A5F0", "0x0040D7C0"]
for addr in missing_addrs:
    subprocess.run([
        "curl", "-s", "-X", "POST", "-m", "10",
        "-H", "Content-Type: application/json",
        "-d", json.dumps({"address": addr}),
        "http://127.0.0.1:8089/create_function"
    ], capture_output=True, text=True, timeout=15)

# Step 2: Now batch_decompile will work for those addresses
```

This is especially common when verifying vtable-dispatched factory functions — Ghidra may have the vtable data but not have auto-detected the code at the target address as a function.

## Listing Functions

```bash
# Plain text output, NOT JSON. One line per function: "Name at 00XXXXXX"
curl -s "http://127.0.0.1:8089/list_functions?page=1&limit=5000" | grep "Ball_"

# Extract address for a known function
curl -s "http://127.0.0.1:8089/list_functions?page=1&limit=5000" | grep "Ball_Update"
# → Ball_Update at 00405E00
```

## Cross-References (Xrefs)

### Function xrefs (GET)

```bash
curl -s "http://127.0.0.1:8089/get_function_xrefs?address=0x4597B0&limit=300"
# Plain text, one caller per line:
# From 0040cd2d in DispatchCollisionEvents [UNCONDITIONAL_CALL]
```

### Data xrefs (POST — CRITICAL)

`get_function_xrefs` does NOT work for data addresses. Use POST + JSON body:

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"addresses": ["0x004fd680", "0x005341cc"], "limit": 300}' \
  http://127.0.0.1:8089/get_bulk_xrefs
```

GET requests to `get_bulk_xrefs` return empty `{}` — must use POST.

## Endpoint Summary

| Endpoint | Method | Format | Purpose |
|----------|--------|--------|---------|
| `/health` | GET | JSON | Server status |
| `/compare_programs_documentation` | GET | JSON | Rename coverage % |
| `/decompile_function?address=` | GET | C code | Decompile function |
| `/disassemble_function?address=` | GET | Plain text | Raw x86 disassembly |
| `/read_memory?address=&length=` | GET | JSON | Read raw bytes (vtables, floats, strings) |
| `/create_function` | POST (JSON body) | JSON | Create function at undetected address |
| `/list_functions?page=&limit=` | GET | Plain text | Function name+address list |
| `/get_function_xrefs?address=` | GET | Plain text | Who calls this function |
| `/get_bulk_xrefs` | POST (JSON body) | JSON | Xrefs for data addresses (globals, vtables) |

## Batch Decompilation Script

```bash
#!/bin/bash
# decomp_batch.sh — batch-decompile known functions
mkdir -p decomps
functions=(
  "Ball_Update:0x405E00"
  "Ball_ctor2:0x4039E0"
  "Ball_Render:0x402DE0"
  "Ball_GetInputForce:0x46EC30"
)
for entry in "${functions[@]}"; do
  IFS=: read -r name addr <<< "$entry"
  curl -s "http://127.0.0.1:8089/decompile_function?address=$addr" > "decomps/${name}.c"
  size=$(wc -c < "decomps/${name}.c")
  echo "$name ($addr): ${size} bytes"
done
```

## Batch Decompilation via execute_code

When decompiling many functions at once, use `execute_code` with `hermes_tools.terminal` to batch curl calls. This is **dramatically faster** than individual MCP tool calls — 105 functions decompiled in ~28s vs 600s+ timeout for a subagent doing individual MCP calls (sess5887).

### Fast batch pattern (5-at-a-time, 105 functions in ~28s)

```python
from hermes_tools import terminal
import json

# Unique function addresses to decompile
unique_list = [0x409d90, 0x409da0, 0x40c5d0, ...]  # up to 105 addresses

# Get function info (name, body range) for all addresses via batched curl
# Process 10 at a time using ||| delimiters
func_info = {}
for batch_start in range(0, len(unique_list), 10):
    batch = unique_list[batch_start:batch_start+10]
    cmds = []
    for addr in batch:
        hex_addr = hex(addr)
        cmds.append(
            f'printf "|||{hex_addr}|||" && '
            f'curl -s "http://127.0.0.1:8089/get_function_by_address?address={hex_addr}&program=target_binary.exe"'
        )
    cmd = " && ".join(cmds)
    r = terminal(cmd, timeout=30)
    # Parse using ||| delimiter...
    # (store name + body_start + body_end per address)

# Decompile 5 at a time using === markers
decompiled = {}
for batch_start in range(0, len(unique_list), 5):
    batch = unique_list[batch_start:batch_start+5]
    cmds = []
    for addr in batch:
        hex_addr = hex(addr)
        cmds.append(
            f'echo "===START_{hex_addr}===" && '
            f'curl -s "http://127.0.0.1:8089/decompile_function?address={hex_addr}&program=target_binary.exe" && '
            f'echo "===END_{hex_addr}==="'
        )
    cmd = " ; ".join(cmds)
    r = terminal(cmd, timeout=60)
    output = r.get('output', '')
    # Parse between START/END markers
    for addr in batch:
        hex_addr = hex(addr)
        start_marker = f"===START_{hex_addr}==="
        end_marker = f"===END_{hex_addr}==="
        if start_marker in output and end_marker in output:
            s = output.index(start_marker) + len(start_marker)
            e = output.index(end_marker)
            decompiled[hex_addr] = output[s:e].strip()
```

### Why NOT to use delegate_task for Ghidra batch decompilation

A subagent dispatched to decompile 105 functions via individual `mcp_ghidra_mcp_decompile_function` calls **timed out after 600s** having completed only 18 API calls (sess5887). Each MCP tool call has overhead (bridge serialization, JSON parsing, Ghidra decompiler invocation). Using `execute_code` + `hermes_tools.terminal` + curl batches 5 functions per shell call, eliminating MCP bridge overhead entirely. Result: 105 functions in 28 seconds vs 18 functions in 600 seconds — a **125× speedup**.

### Legacy subprocess pattern (still works)

```python
import subprocess

targets = [
    (0x401040, "Vec3_Init"),
    (0x401920, "Ball_RenderShadow"),
    (0x405E00, "Ball_Update"),
]

for addr, name in targets:
    url = f"http://127.0.0.1:8089/decompile_function?address=0x{addr:X}"
    r = subprocess.run(
        ['curl', '-s', '-m', '30', url],
        capture_output=True, text=True, timeout=35
    )
    code = r.stdout
    if code and len(code) > 50:
        print(f"✓ 0x{addr:06X} {name}: {len(code)} bytes")
    else:
        print(f"✗ 0x{addr:06X} {name}: FAILED")
```

**Tips:**
- Use `-m 30` (30s timeout) on curl for safety — large functions (43KB+) still complete in ~8s
- Filter by `len(code) > 50` to detect failures (empty or error responses)
- Save each decompilation with a header comment containing function name, address, and date
- Organize files into subdirectories by category: `ball/`, `scene/`, `collision/`, `camera/`, etc.
- For 50+ functions, use the `hermes_tools.terminal` batch pattern above — it's 100× faster than subprocess or individual MCP calls

## Hermes MCP Bridge Config

Path: `~/.hermes/config.yaml`

```yaml
mcp_servers:
  ghidra-mcp:
    command: python3
    args:
      - /opt/ghidra-mcp/bridge_mcp_ghidra.py
    env:
      GHIDRA_SERVER_URL: http://127.0.0.1:8089/
    timeout: 180
    connect_timeout: 30
```

Verify bridge is active:
```bash
hermes tools list | grep ghidra
```

If nothing appears, the `mcp_servers:` block is commented out or the bridge script path is wrong.
