---
name: ghidra-mcp-headless
description: Start GhidraMCP headless server with the target_binary.exe project — always do this before any RE work
version: 2026-04-13
---

# GhidraMCP Headless Server Startup

## One-Line Start

Use Hermes `terminal(background=true)` so the process is tracked, then run health checks in a separate call. Do NOT use `nohup` or shell backgrounding (`&`) in a foreground terminal call — Hermes rejects those.

```bash
export GHIDRA_HOME=/opt/ghidra_12.0.4_PUBLIC
MCP_JAR=/home/evan/.config/ghidra/ghidra_12.0.4_PUBLIC/Extensions/GhidraMCP/lib/GhidraMCP-5.2.0.jar
CLASSPATH="$MCP_JAR"
for jar in $GHIDRA_HOME/Ghidra/Framework/*/lib/*.jar; do CLASSPATH="${CLASSPATH}:${jar}"; done
for jar in $GHIDRA_HOME/Ghidra/Features/*/lib/*.jar; do CLASSPATH="${CLASSPATH}:${jar}"; done
for jar in $GHIDRA_HOME/Ghidra/Processors/*/lib/*.jar; do CLASSPATH="${CLASSPATH}:${jar}"; done

java -Xmx4g -XX:+UseG1GC \
    -Dghidra.home=$GHIDRA_HOME -Dapplication.name=GhidraMCP \
    -classpath "$CLASSPATH" \
    com.xebyte.headless.GhidraMCPHeadlessServer \
    --port 8089 --bind 127.0.0.1 \
    --project /home/evan/the target-re/analysis/ghidra/target applicationProject/target application.gpr \
    --program /target_binary.exe \
    > /tmp/ghidra-mcp.log 2>&1
```

Run this via `terminal(background=true, notify_on_complete=true)`, then verify after ~15-20s:

```bash
curl -s http://127.0.0.1:8089/health
```

**Hermes-specific gotcha:** Foreground terminal calls with `nohup ... &` or trailing `&` are rejected by Hermes. Always use `background=true` for daemon-style starts.

## Pitfalls

- **Do NOT use `watch_patterns` when starting the server.** The GhidraMCP headless server prints "Server stopped" immediately after "started on port" when `watch_patterns` is set (likely the watch notification causes Hermes to prematurely close/signal the process). Use `notify_on_complete=true` instead — the server is a long-lived daemon that should never exit, so `notify_on_complete` is a no-op but the process stays alive.
- **`notify_on_complete=true` ALSO kills the server** (sess5828). The server starts, logs "running on port 8089", then immediately logs "Server stopped" and exits. The notification mechanism appears to signal/close the process. **Workaround**: use `background=true` WITHOUT `notify_on_complete=true`, and manually poll with `sleep 18 && curl -s http://127.0.0.1:8089/health` in a separate terminal call. The server is a daemon — it won't exit on its own, so silent background is correct.
- **Shell for-loop syntax gets mangled** when passed inline to `terminal(background=true)`. The `for jar in ...` loop is interpreted as a single string and fails with "syntax error near unexpected token `do'". **Workaround**: write the startup command to a bash script file (e.g. `/tmp/start-ghidra.sh`) and run `bash /tmp/start-ghidra.sh > /tmp/ghidra-mcp.log 2>&1` via `terminal(background=true)`.
- **If `connect_instance` returns "Connection refused"** after starting, the server may have exited. Check `tail -30 /tmp/ghidra-mcp.log` for "Server stopped". If present, kill any zombie processes (`pkill -9 -f GhidraMCPHeadlessServer` may need multiple rounds due to process spawning) and restart using the script-file workaround above.
- After starting, wait ~15-20s before health-checking — Ghidra JVM + project loading takes time.

## Startup Checklist

Before doing ANY RE work:

1. **Verify server is running**: `curl -s http://127.0.0.1:8089/health`
2. **Check program loaded**: `{"status":"healthy","version":"5.12.0-headless","program_loaded":true,"program_name":"target_binary.exe"}`
3. **Verify rename count**: `mcp_ghidra_mcp_compare_programs_documentation` — should be ~75% if restored
4. **If 40%**: project was re-imported, restore from `renames.json` first

## Startup Flags Reference

| Flag | Required | Notes |
|------|----------|-------|
| `--port 8089` | Yes | Default port |
| `--bind 127.0.0.1` | Yes | Localhost only |
| `--project /path/target application.gpr` | Yes | Must end in `.gpr` |
| `--program /target_binary.exe` | Yes | Leading slash required |
| `-Xmx4g` | Recommended | Min 4GB heap |
| `-Dghidra.home` | Yes | Ghidra installation path |

## If Extension JAR Is Missing

Error: `Could not find or load main class com.xebyte.headless.GhidraMCPHeadlessServer` / `ClassNotFoundException`:

The GhidraMCP extension JAR must exist at `~/.config/ghidra/ghidra_12.0.4_PUBLIC/Extensions/GhidraMCP/lib/`. If the `Extensions/GhidraMCP/` directory is empty or missing, the extension was never installed into the Ghidra config (common after fresh Ghidra install or OS migration — the bridge process at `/opt/ghidra-mcp/bridge_mcp_ghidra.py` can be running WITHOUT the JAR being installed, since the bridge doesn't need the JAR, only the Java server does).

**Fix — copy from the local build:**

```bash
# Step 1: Check what's available
ls /home/evan/.config/ghidra/ghidra_12.0.4_PUBLIC/Extensions/GhidraMCP/lib/ 2>/dev/null
# If empty or "No such file", the JAR is missing

ls /opt/ghidra-mcp/target/GhidraMCP-*.jar 2>/dev/null
# Should show: GhidraMCP-5.2.0.jar

# Step 2: Create the directory and copy
mkdir -p ~/.config/ghidra/ghidra_12.0.4_PUBLIC/Extensions/GhidraMCP/lib/
cp /opt/ghidra-mcp/target/GhidraMCP-5.2.0.jar \
   ~/.config/ghidra/ghidra_12.0.4_PUBLIC/Extensions/GhidraMCP/lib/

# Step 3: Verify the main class exists in the JAR
jar tf ~/.config/ghidra/ghidra_12.0.4_PUBLIC/Extensions/GhidraMCP/lib/GhidraMCP-5.2.0.jar | \
  grep GhidraMCPHeadlessServer
# Should show: com/xebyte/headless/GhidraMCPHeadlessServer.class
```

**Version mismatch note:** The startup script references `GhidraMCP-5.2.0.jar`
(the locally built version at `/opt/ghidra-mcp/target/`). An older version of
this skill referenced `GhidraMCP-5.12.0.jar` — that JAR does NOT exist in the
local build. Always check `/opt/ghidra-mcp/target/` for the actual built JAR
name and update the `MCP_JAR` variable in the startup script accordingly.

If the JAR doesn't exist at `/opt/ghidra-mcp/target/` either, build it from
the GhidraMCP source (`cd /opt/ghidra-mcp && mvn package`) or download from
the GitHub releases page (see "Updating the GhidraMCP Extension" below).

After copying, restart the server. Verify with:
```bash
curl -s http://127.0.0.1:8089/health
# Should show: "version":"5.2.0-headless","program_loaded":true
```

## If Program Not Loaded

Error: `program_loaded: false` or `Error loading program`:

1. Check log: `tail -20 /tmp/ghidra-mcp.log`
2. If "No .gpr file found": wrong project path, must end in `.gpr`
3. If "Absolute path must begin with '/'": missing leading slash on `--program`
4. If "Import requires GUI mode": binary file path wrong, use `--file` for direct binary load

## If Import Needed (Fresh Binary)

```bash
# Use analyzeHeadless to import first
export GHIDRA_HOME=/opt/ghidra_12.0.4_PUBLIC
$GHIDRA_HOME/support/analyzeHeadless \
    ~/the target-re/analysis/ghidra/target applicationProject \
    target application \
    -import ~/the target-re/originals/installed/extracted/target_binary.exe \
    -overwrite \
    2>&1 | tail -10
# Then start MCP server with --program flag
# IMPORTANT: After re-import, ALL previous renames are LOST.
# Run ghidra-restore-renames skill to restore from FUNCTION_MAP.md
```

## Server Maintenance

- **Stop server**: `kill $(pgrep -f GhidraMCPHeadlessServer)`
- **Check logs**: `tail -f /tmp/ghidra-mcp.log`
- **Restart if hung**: kill, wait 2s, restart

## Updating the GhidraMCP Extension

The skill references a JAR version (currently `GhidraMCP-5.2.0.jar`, verified working on Ghidra 12.0.4 as of June 2026). To update to a newer release:

### 1. Check current vs. latest

```bash
# Current version
curl -s http://127.0.0.1:8089/health | jq -r '.version'

# Latest release (check GitHub)
curl -s https://api.github.com/repos/benethington/ghidra-mcp/releases/latest | jq -r '.tag_name'
```

### 2. Download and install new extension

```bash
mkdir -p /tmp/ghidra-mcp-update && cd /tmp/ghidra-mcp-update
curl -sLO https://github.com/benethington/ghidra-mcp/releases/latest/download/GhidraMCP.zip
curl -sLO https://github.com/benethington/ghidra-mcp/releases/latest/download/bridge_mcp_ghidra.py
curl -sLO https://github.com/benethington/ghidra-mcp/releases/latest/download/requirements.txt

# Backup old extension
mv ~/.config/ghidra/ghidra_12.0.4_PUBLIC/Extensions/GhidraMCP \
   ~/.config/ghidra/ghidra_12.0.4_PUBLIC/Extensions/GhidraMCP.bak.v$(date +%s)

# Install new
unzip -q GhidraMCP.zip -d ~/.config/ghidra/ghidra_12.0.4_PUBLIC/Extensions/GhidraMCP

# Update bridge script
cp bridge_mcp_ghidra.py /opt/ghidra-mcp/

# Update this skill's JAR path reference (grep-replace in skill markdown)
```

### 3. Restart server (critical)

```bash
kill $(pgrep -f GhidraMCPHeadlessServer)
sleep 2
# Re-run the startup command from "One-Line Start" above
```

### 4. Verify

```bash
curl -s http://127.0.0.1:8089/health | jq '{version, program_loaded}'
curl -s http://127.0.0.1:8089/compare_programs_documentation | jq '.programs[0].documentation_percent'
# Should show ~99% — renames are preserved across extension updates
```

### Extension compatibility note

The extension's `extension.properties` may claim `version=12.1` (or higher) even though it works on Ghidra 12.0.4. This is normal — the version field indicates the minimum or target Ghidra version, not a strict compatibility gate. If the server starts healthy and `program_loaded: true`, the extension is working regardless of what `extension.properties` says.

## Reference Files

- [`references/rest-api-patterns.md`](references/rest-api-patterns.md) — Exact `curl` recipes for decompilation, listing, batch scripts, and Hermes bridge config.
- [`references/data-and-global-analysis.md`](references/data-and-global-analysis.md) — Listing globals and data items, getting xrefs to data addresses (POST `get_bulk_xrefs`), resolving xref addresses to function names, and MCP tool discovery. **CRITICAL:** `get_function_xrefs` only works for functions — use POST `get_bulk_xrefs` for data addresses.
- [`references/verification-commands.md`](references/verification-commands.md) — Five-step smoke test (health, coverage, listing, decompile, pattern search) to confirm the server is fully operational after startup or restart.
- [`references/vtable-discovery-pipeline.md`](references/vtable-discovery-pipeline.md) — Find vtable-dispatched functions Ghidra missed: read vtable bytes → check against `list_functions` → `create_function` for unknowns → decompile. Includes full Python pipeline script and verified results for Ball/Scene vtables.
- [`references/ghidra-verification-methodology.md`](references/ghidra-verification-methodology.md) — Systematic workflow for verifying function addresses, calling conventions (via RET instruction), vtable entries (via raw memory reads), field offsets, and field writers. Use whenever correcting or confirming documentation against the binary.
- [`references/objdump-fallback-disassembly.md`](references/objdump-fallback-disassembly.md) — When GhidraMCP is down, use `objdump` on the original EXE for immediate disassembly. PE crash address conversion, limitations vs GhidraMCP, and server restart troubleshooting.
- [`references/re-doc-verification-pattern.md`](references/re-doc-verification-pattern.md) — Python script template for ad-hoc verification of RE documentation: checks function addresses (Ghidra), instruction bytes (objdump), float constants (PE .rdata), decompilation cross-refs, and string constants in one pass.

## MCP Tool Quick Reference

| Task | Tool |
|------|------|
| List functions | `mcp_ghidra_mcp_list_functions_enhanced` |
| Rename function | `mcp_ghidra_mcp_rename_function_by_address` |
| Batch rename | `mcp_ghidra_mcp_batch_rename_function_components` |
| Search functions | `mcp_ghidra_mcp_search_functions_enhanced` |
| Get function info | `mcp_ghidra_mcp_analyze_function_complete` |
| Decompile (single) | `mcp_ghidra_mcp_decompile_function` |
| Decompile (batch) | `mcp_ghidra_mcp_batch_decompile` |
| Disassemble | `mcp_ghidra_mcp_disassemble_function` |
| Disassemble bytes | `mcp_ghidra_mcp_disassemble_bytes` |
| Create function | `mcp_ghidra_mcp_create_function` |
| Set comment | `mcp_ghidra_mcp_set_decompiler_comment` |
| Batch comments | `mcp_ghidra_mcp_batch_set_comments` |
| Get xrefs | `mcp_ghidra_mcp_get_bulk_xrefs` |
| Check progress | `mcp_ghidra_mcp_compare_programs_documentation` |

### Batch Decompilation

**PREFERRED — native MCP tool (single call):** Use `mcp_ghidra_mcp_batch_decompile` with a comma-separated list of function names or addresses. Returns all decompilations in one structured response — no curl loop needed.

**For 50+ functions:** Use `execute_code` with `hermes_tools.terminal` + curl batches of 5. This is **125× faster** than individual MCP calls (105 functions in 28s vs 18 functions in 600s for a subagent — sess5887). See `references/rest-api-patterns.md` → "Batch Decompilation via execute_code" for the exact pattern. Key tips:
- Use `curl -s -m 30` per function (large functions like Ball_Update at 43KB complete in ~8s)
- Save each to `analysis/ghidra/decompilations/<category>/decomp_0x<ADDR>_<Name>.c` with a header comment
- Filter by `len(code) > 50` to detect failures

**For 100+ functions (sess6037 pattern):** Batch 5 addresses per curl call, separated by ` ; `, with `===START_addr===` / `===END_addr===` markers for parsing. Get function info (name + body range) separately via `/get_function_by_address?address=0xADDR`. 105 functions (info + decompile) completed in ~28s via `execute_code` with `hermes_tools.terminal`.

**Finding undecompiled functions:** Use `execute_code` to compare `list_functions` output against existing files in `analysis/ghidra/decompilations/`. Parse filenames for addresses (format: `<Name>_<addr>.c`), diff against the full function list, filter by keyword (Scene_, Ball_, Mesh_, etc.) to find interesting targets.

## How to Call MCP Tools

The GhidraMCP headless server logs **"Registered 191 REST API endpoints"** on startup, but these are **NOT** standard MCP/SSE/JSON-RPC endpoints. Every call to `/` (GET or POST) returns `404 Not Found`. The actual endpoints are custom REST routes implemented inside the JAR.

### Discovering endpoints from the JAR

Since the server returns 404 for all guessed paths, extract the endpoint definitions from the JAR classes:

```bash
# List endpoint handler classes
jar tf /home/evan/.config/ghidra/ghidra_12.0.4_PUBLIC/Extensions/GhidraMCP/lib/GhidraMCP-5.2.0.jar | grep -i "endpoint\|handler\|rest"

# Inspect the EndpointRegistry class for route mappings
javap -c -classpath "$MCP_JAR" com.xebyte.core.EndpointRegistry | head -100
```

Key classes found in the JAR:
- `com/xebyte/core/EndpointRegistry.class` — route registration
- `com/xebyte/core/EndpointDef.class` — endpoint definitions
- `com/xebyte/headless/HeadlessEndpointHandler.class` — headless handler dispatch

### Three ways to use the tools (in priority order)

1. **Native Hermes MCP tools** (PREFERRED): The `mcp_servers` bridge at `/opt/ghidra-mcp/bridge_mcp_ghidra.py` auto-discovers `mcp_ghidra_mcp_*` tools. Call them directly like any other Hermes tool — no terminal or curl needed. This is the fastest, most token-efficient path. Available tools include: `mcp_ghidra_mcp_decompile_function`, `mcp_ghidra_mcp_disassemble_function`, `mcp_ghidra_mcp_batch_decompile`, `mcp_ghidra_mcp_create_function`, `mcp_ghidra_mcp_disassemble_bytes`, and more. Use `tool_search(query="ghidra")` to discover all available tools.
2. **Direct REST via curl** (fallback): If the MCP bridge is down, use `curl` via terminal to hit `http://127.0.0.1:8089` endpoints directly. See "Direct REST API" section below.
3. **Browser** (NEVER): GhidraMCP is a REST API returning JSON, not a webpage. NEVER use `browser_navigate`/`browser_snapshot` to interact with it. This wastes context tokens on DOM snapshots for what should be a one-line tool call or curl.

### How to verify native tools are available

```bash
hermes tools list | grep ghidra
# Should show: ghidra-mcp  all tools enabled
```

If that line appears, native MCP tools are available and preferred. Use `tool_search(query="ghidra decompile")` to find exact tool names, then `tool_describe` to get the schema, then call directly.

### If neither native tools nor JAR inspection works

- Confirm server health: `curl -s http://127.0.0.1:8089/health`
- Check log for binding errors: `tail -20 /tmp/ghidra-mcp.log`
- The server logs "Registered 191 REST API endpoints" on startup — if this line is missing, the jar or classpath is wrong

## Direct REST API (Fallback — use only if MCP bridge is down)

The headless server exposes a custom REST API on `http://127.0.0.1:8089`. Use this only when `hermes tools list | grep ghidra` returns nothing. In normal operation, prefer the native `mcp_ghidra_mcp_*` tools described above.

### Working GET endpoints (tested v5.2.0-headless and v5.12.0-headless)

| Endpoint | Example | Returns |
|----------|---------|---------|
| `/health` | `curl -s http://127.0.0.1:8089/health` | JSON: `status`, `version`, `program_loaded`, `program_name` |
| `/compare_programs_documentation` | `curl -s http://127.0.0.1:8089/compare_programs_documentation` | JSON rename coverage percent |
| `/decompile_function?address=0x405E00` | `curl -s "http://127.0.0.1:8089/decompile_function?address=0x405E00"` | **Full C decompilation** |
| `/decompile_function?name=Ball_Update` | `curl -s "http://127.0.0.1:8089/decompile_function?name=Ball_Update"` | **Full C decompilation** |
| `/disassemble_function?address=0x409C60` | `curl -s "http://127.0.0.1:8089/disassemble_function?address=0x409C60"` | **Plain text disassembly**, one `ADDR: instruction` per line |
| `/read_memory?address=0x4CF300&length=64` | `curl -s "http://127.0.0.1:8089/read_memory?address=0x4CF300&length=64"` | JSON: `address`, `length`, `data` (byte array), `hex` (hex string) |
| `/list_functions?page=1&limit=5000` | `curl -s "http://127.0.0.1:8089/list_functions?page=1&limit=5000"` | **Plain text** (not JSON), one `Name at 00XXXXXX` per line |

### Disassemble function (`/disassemble_function`)

Returns raw x86 disassembly as plain text. Essential for:
- **Counting parameters** via `RET N`: `RET 0x3C` = 60 bytes = 15 stack params (×4 bytes each). For `__thiscall`, add 1 for ECX (`this`).
- **Verifying calling conventions**: `MOV ESI,ECX` in prologue = `__thiscall`; `PUSH EBP; MOV EBP,ESP` = `__stdcall`/`__cdecl`.
- **Tracing push sequences at call sites**: Pushes are in reverse parameter order. `SUB ESP,0x14` blocks reserve stack space for by-value struct parameters (5 DWORDs = 20 bytes).

```bash
curl -s "http://127.0.0.1:8089/disassemble_function?address=0x409C60"
# Output: "00409c60: PUSH -0x1\n00409c62: PUSH 0x4c9500\n..."
```

### Read memory (`/read_memory`)

Reads raw bytes at any virtual address. Essential for:
- **Reading vtable entries**: Read 4 bytes per slot, parse as little-endian DWORD (function pointer).
- **Decoding float constants**: Read 4 bytes, unpack with `struct.unpack('f', bytes)`.
- **Reading string data**: Read N bytes at a .rdata address.

```bash
# Read vtable at 0x4D8E10 (8 slots = 32 bytes)
curl -s "http://127.0.0.1:8089/read_memory?address=0x4d8e10&length=32"
# Returns: {"hex":"70684500c064450080624500d06c450010614500206145004061450090684500207a4500"}
# Parse: vtable[0]=0x456870, vtable[1]=0x4564C0, vtable[2]=0x456280, ...

# Decode float constant
python3 -c "import struct; print(struct.unpack('f', bytes([23,183,209,56]))[0])"
# → 9.999999747378752e-05 (≈0.0001)
```

### Create function (`/create_function`)

**POST with JSON body** — creates a function at an address Ghidra hasn't auto-detected. Essential when a vtable slot points to code that Ghidra hasn't recognized as a function (common for virtual dispatch targets).

```bash
# POST with JSON body — NOT query params
curl -s -X POST "http://127.0.0.1:8089/create_function" \
  -H "Content-Type: application/json" \
  -d '{"address":"0x456890"}'
# Returns: {"success":true,"address":"00456890","function_name":"FUN_00456890",...}
# Then decompile it:
curl -s "http://127.0.0.1:8089/decompile_function?address=0x456890"
```

**When to use:** After reading a vtable with `read_memory` and finding a slot that points to an address not in `list_functions`, use `create_function` to make it decompilable. This is the only way to decompile vtable-dispatched functions that Ghidra missed.

### Important quirks

- **POST to `/decompile_function` fails** with `{"error":"Address or function name is required"}` — the server only reads query parameters on GET, not JSON body on POST.
- **`/list_functions` returns plain text**, not JSON. Pipe through `grep` for filtering.
- **Function name lookup is unreliable** — `?name=CreateBadBall` returns `{"error":"Address or function name is required"}` for many renamed functions. Always use `?address=0x40BCA0` instead. The `?name=` param only works for a subset of functions (likely those with single-word non-hyphenated names). When debugging, check the function map or `list_functions` output for the exact address, then decompile by address.
- **Address lookup** works via `address=0x405E00` query param; `name` and `address` can both be provided.
- **For batch decompilation**, loop over known addresses with `curl -s "http://127.0.0.1:8089/decompile_function?address=$addr"`.

## Cross-References (Xrefs)

### Function xrefs (GET)

Endpoint tested on v5.12.0-headless:

```bash
curl -s "http://127.0.0.1:8089/get_function_xrefs?address=0x4597B0&limit=300"
```

Output is **plain text**, one caller per line:

```text
From 0040cd2d in DispatchCollisionEvents [UNCONDITIONAL_CALL]
From 0040ce43 in DispatchCollisionEvents [UNCONDITIONAL_CALL]
From 00466a69 in SoundDevice_UpdateChannels [UNCONDITIONAL_CALL]
```

### Data xrefs (POST — CRITICAL)

`get_function_xrefs` does NOT work for data addresses (globals, vtables,
string pointers). Use `get_bulk_xrefs` with POST + JSON body instead:

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"addresses": ["0x004fd680", "0x005341cc"], "limit": 300}' \
  http://127.0.0.1:8089/get_bulk_xrefs
```

Returns JSON: `{"0x004fd680": [{"from": "004278ea", "type": "DATA"}, ...]}`

GET requests to `get_bulk_xrefs` return empty `{}` — must use POST.
Batch multiple addresses in one call for efficiency.

See `references/data-and-global-analysis.md` for full details including
listing globals, resolving xref addresses to function names, and MCP
tool discovery.

### Hermes MCP bridge setup

If `hermes tools list | grep ghidra` returns nothing, the Python bridge between Hermes and the GhidraMCP REST server is not configured:

```bash
# Check if mcp_servers section is commented out in ~/.hermes/config.yaml
grep -A10 "mcp_servers:" ~/.hermes/config.yaml
# If you see `# mcp_servers:` or no output, the bridge is disabled.
```

Enable it by uncommenting (or adding):

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

> **Note**: The bridge script ships with GhidraMCP at `/opt/ghidra-mcp/bridge_mcp_ghidra.py`. It is a Python MCP↔REST multiplexer. It does NOT need to run as a daemon — Hermes spawns it per session. If the path does not exist, the GhidraMCP extension was not installed correctly.

## Key Gotchas

1. **NEVER start a session without checking `program_loaded: true`**
2. **NEVER assume renames survived a project re-import**
3. The project path must end in `.gpr` (e.g., `target application.gpr` not `target applicationProject`)
4. Program name must have leading slash: `/target_binary.exe` not `target_binary.exe`
5. Import via `analyzeHeadless` before starting MCP server for a new binary
6. **NEVER guess REST endpoint paths** — the server does NOT use standard MCP/SSE/JSON-RPC. Inspect the JAR or use native Hermes MCP tools only.
7. If native `mcp_ghidra_mcp_*` tools are missing from Hermes, the server is running but not bridged. Check `~/.hermes/config.yaml` for the `mcp_servers:` block (see "Hermes MCP bridge setup" above).
8. **POST for decompilation/listing is broken** — use GET with query params for `/decompile_function` and `/list_functions`. However, **POST IS REQUIRED for `/get_bulk_xrefs`** (data address xrefs) — GET returns empty `{}`. This is the only known POST endpoint that works.