# Data Items, Globals, and Data Xrefs

Patterns for listing global variables, finding data items, and getting
cross-references to data addresses (not just functions). Tested against
v5.12.0-headless with target_binary.exe.

## Listing Globals

The `list_globals` endpoint returns labeled global variables (symbols
marked as `[Label]`). Output is plain text, one per line:

```bash
curl -s "http://127.0.0.1:8089/list_globals?page=1&limit=5000"
```

Format: `Name @ 00XXXXXX [Label] (type) xrefs=N`

Includes system TEB entries (`0xFFDFF000-0xFFDFFFFF`), resource data
(`Rsrc_*`), and game globals. Filter by address range to isolate:

```bash
# Game globals only (exclude TEB 0xFFDFF*, exclude Rsrc_*)
curl -s "http://127.0.0.1:8089/list_globals?page=1&limit=5000" | grep -v "^Rsrc_\|@ ffdff"
```

## Listing All Data Items

The `list_data_items` and `list_data_items_by_xrefs` endpoints list
ALL data items (labeled and auto-named `DAT_`/`PTR_`), sorted by xref
count (the `_by_xrefs` variant) or by address (plain `list_data_items`):

```bash
# Sorted by xref count (most-referenced first)
curl -s "http://127.0.0.1:8089/list_data_items_by_xrefs?page=1&limit=5000"

# By address
curl -s "http://127.0.0.1:8089/list_data_items?page=1&limit=5000"
```

Format: `Name @ 00XXXXXX [type] (N bytes) - M xrefs`

This returns thousands of items. Use categorization to filter:

| Category | Filter Pattern | Example |
|----------|---------------|---------|
| IAT import thunks | `PTR_*` at `0x004CF0XX-0x004CF2XX` | `PTR_MessageBoxA_004cf290` |
| String constants | `s_*` with type `[string]` | `s_LOCKED_004d3fbc` |
| Vtable dtor pointers | `PTR_*Dtor*`, `PTR_*dtor*`, `PTR_*ScalarDtor*` | `PTR_Level_DeletingDtor_004d8fb0` |
| RTTI | `RTTI_*`, `TypeDescriptor`, `PTR_RTTI_*` | `RTTI_Type_Descriptor` |
| Exception tables | type starts with `FuncInfo`, `UnwindMap`, `HandlerType` | `FuncInfo_004ee834` |
| .data section | address in `0x004F7000-0x00536AF3` | Mutable globals |
| .rdata section | address in `0x004CF000-0x004F6FFF` | Read-only data |
| TEB | address `0xFFDFF000-0xFFDFFFFF` | Thread environment block |

## Getting Xrefs to Data Addresses (CRITICAL)

### `get_function_xrefs` does NOT work for data addresses

```bash
# This returns "No references found to function: null"
curl -s "http://127.0.0.1:8089/get_function_xrefs?address=0x004fd680"
```

The `get_function_xrefs` endpoint only resolves references to *functions*.
For data addresses (global variables, vtables, string pointers), use
`get_bulk_xrefs` with **POST + JSON body**:

### `get_bulk_xrefs` with POST (works for data)

```bash
# Single address
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"addresses": ["0x004fd680"], "limit": 300}' \
  http://127.0.0.1:8089/get_bulk_xrefs
```

Returns:
```json
{
  "0x004fd680": [
    {"from": "004278ea", "type": "DATA"},
    {"from": "004278f4", "type": "DATA"},
    {"from": "004278fe", "type": "DATA"}
  ]
}
```

**Batch multiple addresses** in one call:

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"addresses": ["0x004fd680", "0x005341cc", "0x004f7360"], "limit": 300}' \
  http://127.0.0.1:8089/get_bulk_xrefs
```

### Xref types

| Type | Meaning |
|------|---------|
| `DATA` | Address is referenced as a data pointer |
| `READ` | Address is read from |
| `WRITE` | Address is written to |
| `READ_WRITE` | Both read and written |
| `INDIRECTION` | Called through as function pointer |

### GET does NOT work for bulk xrefs

```bash
# Returns empty {} — GET query params are ignored
curl -s "http://127.0.0.1:8089/get_bulk_xrefs?addresses=0x004fd680&limit=100"
```

Always use POST with JSON body.

## Resolving Xref Addresses to Function Names

Bulk xrefs return raw addresses (`from: "004278ea"`), not function names.
To resolve, build an address→name map from `list_functions` and binary-search:

```python
import subprocess, json

# Build function address map
r = subprocess.run(
    ['curl', '-s', '-m', '30', 'http://127.0.0.1:8089/list_functions?page=1&limit=5000'],
    capture_output=True, text=True, timeout=35
)

func_addrs = []
for line in r.stdout.strip().split('\n'):
    parts = line.rsplit(' at ', 1)
    if len(parts) == 2:
        addr = int(parts[1].strip(), 16)
        func_addrs.append((addr, parts[0].strip(), parts[1].strip()))

func_addrs.sort()  # Sort by address for binary search

def find_containing_func(addr_hex):
    """Find the function containing the given address"""
    addr = int(addr_hex, 16)
    result = None
    lo, hi = 0, len(func_addrs) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if func_addrs[mid][0] <= addr:
            result = func_addrs[mid]
            lo = mid + 1
        else:
            hi = mid - 1
    if result:
        offset = addr - result[0]
        return f"{result[1]}+0x{offset:x}"
    return f"sub_{addr_hex}"
```

## MCP Tool Discovery

The GhidraMCP server registers ~183 tools across 12 groups. Use the
MCP bridge tools to discover and load them:

```python
# Connect to the running instance
mcp_ghidra_mcp_connect_instance(project="target application")

# List all tool groups
mcp_ghidra_mcp_list_tool_groups()

# Check if specific tools exist (by name)
mcp_ghidra_mcp_check_tools(tools=["list_globals", "list_data_items", "get_bulk_xrefs"])

# Load a tool group to make its tools callable
mcp_ghidra_mcp_load_tool_group(group="listing")
```

### Tool groups (v5.12.0)

| Group | Key Tools |
|-------|-----------|
| `listing` | `list_functions`, `list_globals`, `list_data_items`, `list_data_items_by_xrefs`, `list_strings`, `list_segments`, `list_imports`, `list_exports` |
| `xref` | `get_function_xrefs`, `get_bulk_xrefs` |
| `function` | `decompile_function`, `analyze_function_complete`, `rename_function_by_address` |
| `comment` | `set_decompiler_comment`, `batch_set_comments` |
| `datatype` | `create_struct`, `add_struct_field` |
| `program` | `read_memory`, `write_memory` |
| `symbol` | `search_functions`, `search_strings` |

### Direct REST as fallback

When native MCP tools aren't available (bridge not configured), use
direct curl to the REST endpoints. All listing endpoints work via GET;
`get_bulk_xrefs` requires POST with JSON body.

## Segments

```bash
curl -s "http://127.0.0.1:8089/list_segments"
```

Typical output for a PE32 binary:
```
Headers: 00400000 - 00400fff
.text: 00401000 - 004cefff
.rdata: 004cf000 - 004f6fff
.data: 004f7000 - 00536af3
.data1: 00537000 - 00537fff
.rsrc: 00538000 - 0058ffff
tdb: ffdff000 - ffdfffff
```

Use segment ranges to categorize globals by section. The `.data` section
holds mutable globals; `.rdata` holds vtables, strings, IAT, and RTTI.
