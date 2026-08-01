# Batch Decompilation Workflow — Systematic Function Documentation at Scale

When a user asks to decompile and document all (or hundreds of) functions in a binary,
use this workflow to process them efficiently in batches of 10.

## Prerequisites

- GhidraMCP server running on `http://127.0.0.1:8089`
- Git repo with `analysis/ghidra/decompilations/` directory structure
- Two remotes configured (public + private) if the project has both

## Key Endpoints

**PREFERRED — Native MCP tools** (no curl needed when bridge is active):

```
# Decompile multiple functions in one call (comma-separated names or addresses)
tool_call: mcp_ghidra_mcp_batch_decompile
  functions: "CreateBadBall, Input_CheckKeyCombo, MusicPlayer_Render"

# Decompile a single function by address
tool_call: mcp_ghidra_mcp_decompile_function
  address: "0x00401040"

# Get cross-references (callers) for a function
tool_call: mcp_ghidra_mcp_get_bulk_xrefs
  addresses: ["0x00401040"]
```

**FALLBACK — curl via terminal** (if MCP bridge is down):

```bash
# List all functions (paginated, use large limit)
curl -s "http://127.0.0.1:8089/list_functions?offset=0&limit=9999"

# Decompile a function by address
curl -s "http://127.0.0.1:8089/decompile_function?address=0x00401040"

# Get cross-references (callers) for a function
curl -s "http://127.0.0.1:8089/get_function_xrefs?address=0x00401040"
```

## Batch Processing Pattern

### 1. Build the undocumented function list

Fetch the full function list, then diff against already-documented files:

```python
import os, subprocess

r = subprocess.run(["curl", "-s", "http://127.0.0.1:8089/list_functions?offset=0&limit=9999"],
                   capture_output=True, text=True, timeout=30)
func_list = []
for line in r.stdout.strip().split('\n'):
    if ' at ' in line:
        name, addr = line.rsplit(' at ', 1)
        func_list.append((name.strip(), int(addr.strip(), 16)))

# Track which addresses already have analysis files
DECOMP_DIR = os.path.expanduser("~/project/analysis/ghidra/decompilations/batch_auto")
documented = set()
for f in os.listdir(DECOMP_DIR):
    if f.endswith('.c'):
        parts = f.rsplit('_', 1)
        if len(parts) == 2:
            documented.add(parts[1].replace('.c', '').lower())

undocumented = []
for name, addr in sorted(func_list, key=lambda x: x[1]):
    addr_hex = f"0x{addr:08x}"
    if addr_hex.lower() not in documented:
        undocumented.append((name, addr))
```

### 2. For each batch of 10: decompile + get xrefs

```python
for name, addr in undocumented[offset:offset+10]:
    r = subprocess.run(
        ["curl", "-s", f"http://127.0.0.1:8089/decompile_function?address=0x{addr:08x}"],
        capture_output=True, text=True, timeout=60)
    r2 = subprocess.run(
        ["curl", "-s", f"http://127.0.0.1:8089/get_function_xrefs?address=0x{addr:08x}"],
        capture_output=True, text=True, timeout=30)
    # Analyze decompiled C, write analysis file
```

### 3. Write each function as an analysis file with standardized header

```c
/*
 * Function: FunctionName
 * Address: 0x00XXXXXX
 * Signature: <full Ghidra signature with calling convention>
 * Parameters:
 *   param_1: <type and meaning>
 *
 * Description:
 * <1-3 sentences describing what the function does, based on decompiled C>
 *
 * Struct offsets:
 *   +0xNN (field name and meaning)
 *
 * Cross-references:
 *   N calls from <caller names or addresses>
 *
 * Decompiled from <binary> (Athena Engine, PE32 i386)
 */
```

### 4. Maintain a JSON function database

Track all documented functions in a structured JSON file for progress tracking:

```json
{
  "project": "target application RE",
  "binary": "target_binary.exe",
  "total_functions": 3801,
  "total_documented": 300,
  "functions": [
    {
      "name": "FunctionName",
      "address": "0x00401040",
      "signature": "void __fastcall ...(int param_1)",
      "parameters": "param_1: Type* this",
      "description": "What it does",
      "struct_offsets": "+0xNN (field)",
      "xrefs": "N calls from ...",
      "batch": 1
    }
  ]
}
```

### 5. Commit + push every 10 functions

```bash
cd ~/project && git add analysis/ghidra/decompilations/batch_auto/ analysis/ghidra/SQUIBIT_Function_Database.json && \
git commit -m "Add 10 carefully analyzed function decompilations (batch N): <function names>" && \
git push origin master && git push priv master
```

### 6. Send batch update messages

For each batch of 10, send a numbered update to the user's chat platform with:
- A batch number and commit hash
- Each function listed with: name, address, signature, 1-line description
- Progress counter (X done, Y remaining)

## Analysis Quality Rules

1. **Read the decompiled C** — don't just copy the function name. Understand what the code actually does.
2. **Get xrefs** — know who calls each function. A function's purpose is defined by its call chain.
3. **Document struct offsets** — note every `this + 0xNN` access and what field it touches.
4. **Note vtable assignments** — `*this = &PTR_...` reveals object identity.
5. **Identify calling conventions** — `__thiscall` (ECX=this), `__fastcall` (ECX+EDX), `__cdecl` (stack only).
6. **Flag duplicates** — Ghidra sometimes creates duplicate entries for the same function at different addresses.

## Efficiency Tips

- Use `execute_code` to batch-fetch and write 10 functions in one tool call, then commit.
- Large functions (Ball_Update = 43K chars) should be summarized rather than pasted in full.
- For batches of similar functions (e.g., 15 BoardLevel ctors), write a helper that processes them programmatically.
- Track progress with a counter in the JSON database — `total_documented` field.

### Fast Bulk Decompilation (3000+ functions in minutes)

For pure decompilation without per-function analysis, skip the batch-of-10 approach and use a tight `urllib.request` loop inside `execute_code`. This achieves ~3 functions/second.

**Key technique:**
1. Read the full function list from `list_functions` endpoint
2. Build a set of already-decompiled addresses by scanning existing filenames (look for `_0xADDR.c` suffix pattern)
3. Loop: `urllib.request.urlopen("http://127.0.0.1:8089/decompile_function?address=0xADDR")` → write to `batch_auto/FuncName_0xADDR.c`
4. Each `execute_code` call processes ~900 functions before hitting the 5-minute timeout
5. Between iterations, recount remaining and repeat until 0

**Throughput:** ~3300 functions in ~3 minutes across 4 `execute_code` calls.

**Pitfall:** The `execute_code` 5-minute timeout will kill scripts that try to process all 3000+ functions in one call. Break into iterations that each handle ~900, check remaining count between iterations.

**Pitfall:** Some functions (e.g., `Unwind@0x004cdc4c`) have non-standard addresses with `@` in the name. Use the address as-is for the `decompile_function` endpoint — it works fine.

**Pitfall:** Duplicate function names (e.g., `TourneyMenu_Render` at two different addresses, `CreateLimit` at two addresses) are legitimate — Ghidra lists both. Always key by address, not name, when tracking decompilation status.

## Common Function Patterns in Athena Engine (target application)

| Pattern | Identification | Typical Structure |
|---------|---------------|-------------------|
| Scalar deleting dtor | `if (param_1 & 1) _free(this)` | Calls base dtor, then optionally frees |
| Vtable init | `*param_1 = &PTR_..._004dNNNN` | Minimal: sets vtable only |
| AthenaList iteration | `AthenaList_NextIndex` + while loop | Walks list, matches by stricmp |
| operator_new + ctor | `pvVar = operator_new(0xNNN); Class_ctor(pvVar, ...)` | Allocates and constructs sub-object |
| SEH frame | `ExceptionList = &local_c; local_4 = 0xFFFFFFFF` | Win32 structured exception handling |
| SSO string | `if (0xF < capacity) _free(heap_ptr)` | MSVC small-string optimization |
