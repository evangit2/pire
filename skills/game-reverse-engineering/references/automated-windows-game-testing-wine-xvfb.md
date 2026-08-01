# Automated Windows Game Testing Under Wine/Xvfb via MCP

Pattern for running a Windows game binary under Wine on a headless Linux host,
exposing lifecycle, input, telemetry, screenshots, and logs through an MCP server.

## Use case

- Regression-test a Windows game after binary patches or DLL mods.
- Capture screenshots for vision-model comparison (e.g., does the level render correctly?).
- Verify that a runtime patch (FPS cap, input hook, etc.) actually took effect by
  reading process memory.
- Automate input sequences and observe game state.

## Architecture

```
┌─────────────────┐     SSE/MCP      ┌─────────────────────────────┐
│   MCP client    │◄────────────────►│  Python FastMCP server      │
│  (Hermes agent) │                  │  (hbtestd pattern)          │
└─────────────────┘                  └──────────────┬──────────────┘
                                                    │
                                 ┌──────────────────┼──────────────────┐
                                 ▼                  ▼                  ▼
                            Xvfb display      game process       xdotool/scrot
                            (:99)             (Wine → EXE)       input/screenshots
```

## Key implementation points

### FastMCP binding

```python
from mcp.server.fastmcp import FastMCP
mcp = FastMCP("mytestd")
mcp.settings.host = "127.0.0.1"
mcp.settings.port = 8777
```

Do NOT pass `host=`/`port=` to `FastMCP(...)` — they are ignored.

### Lifecycle tools

| Tool | Responsibility |
|------|----------------|
| `start_game` | Start Xvfb if needed, launch `wine game.exe`, return PID |
| `stop_game` | Kill game, wineserver, Xvfb; restore any mod files |
| `restart_game` | Stop then start |
| `get_status` | Is the game running? PID, memory, runtime |
| `get_health` | Full server/display/dependency/ptrace status |

### Input

Use `xdotool` against the virtual display. Resolve the window ID first so you
know input is targeted:

```bash
xdotool search --name "GameWindowTitle"
xdotool key --window <id> <key>
xdotool keydown --window <id> <key> ; sleep 0.5 ; xdotool keyup --window <id> <key>
```

Expose friendly key names that map to xdotool names.

### Screenshots

`scrot --silent --overwrite /tmp/screenshot.png` on the target `DISPLAY`.
Add a `validate_screenshot` tool that checks the PNG header, dimensions, and
flags tiny files as possibly blank.

### Telemetry from Windows struct

Wine runs the PE as a Linux process; use `process_vm_readv` to read memory
via offsets from the image base. You need ptrace access (`/proc/sys/kernel/yama/ptrace_scope`).

```python
import ctypes, struct
libc = ctypes.CDLL("libc.so.6")
# ... Iovec setup ...
app_ptr = struct.unpack("<I", read(pid, 0x005341E0, 4))[0]
target_fps = struct.unpack("<i", read(pid, app_ptr + 0x16C, 4))[0]
```

### Runtime FPS estimation

If the game stores a `GetTickCount()` value in its struct, poll it to estimate
real loop FPS more accurately than timing screenshots:

```python
def estimate_runtime_fps(pid, app_ptr, samples=10, interval=0.1):
    ticks = []
    for _ in range(samples + 1):
        t = time.time()
        tick = struct.unpack("<I", read(pid, app_ptr + 0x164, 4))[0]
        ticks.append((t, tick))
        time.sleep(interval)
    # deltas ... fps = 1000 / ms_per_tick
```

### Mod files

If the server can install a mod DLL proxy, keep install/uninstall logic in a
separate module. Restore originals in `stop_game` even if launch failed.

## Verification smoke test

```python
import asyncio
from mcp import ClientSession
from mcp.client.sse import sse_client

async def main():
    async with sse_client('http://127.0.0.1:8777/sse') as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            print(await session.call_tool('get_health', {}))
            print(await session.call_tool('start_game', {}))
            await asyncio.sleep(8)
            print(await session.call_tool('get_telemetry', {}))
            print(await session.call_tool('screenshot', {}))
            print(await session.call_tool('stop_game', {}))

asyncio.run(main())
```

## Common pitfalls

- **Port 8777 still bound** after a crash: `pkill -9 -f hbtestd.server; pkill -9 -f uvicorn`
- **Server won't bind**: check `mcp.settings.host/port` are assigned, not passed to constructor.
- **Memory read fails**: `ptrace_scope` may be `1` or `2`; the server can still report
  process status but memory tools will fail.
- **Screenshot is blank**: Xvfb resolution may be wrong, or the game window never appeared.
  `get_status` should report a PID and `validate_screenshot` should detect tiny files.
- **Input has no effect**: ensure `xdotool` is running on the same `DISPLAY` and the
  window ID is resolved.

## Full memory analysis (v0.3.0+)

The basic telemetry pattern above (reading a few u32 values) extends to a full
memory analysis suite with typed r/w, pointer chains, value scanning, monitoring,
and freezing. **See `references/memory-analysis-suite.md`** for the complete
pattern including:

- `MemoryManager` class with typed read/write (u8–i64, float, double, bool, string, vec3)
- Batch read/write operations
- Cheat Engine style value scanning (scan_value / scan_next / scan_float_range)
- Pointer chain resolution (multi-level dereferencing)
- Address symbol registry (resolve `"app.target_fps"` → absolute address)
- `AddressMonitor` (time-series sampling) and `FreezeManager` (value pinning)
- Game-specific convenience tools (read_app_state, read_ball_state)
- Testing patterns (MAP_32BIT for 32-bit test memory on 64-bit hosts)

## Reference implementation

`the target-re/tools/hbtestd/` — target application test daemon using this pattern.
v0.3.0 adds 26 memory MCP tools (54 total), 103 unit tests, addresses.py with
known struct layouts, and monitor.py for live monitoring/freezing.
