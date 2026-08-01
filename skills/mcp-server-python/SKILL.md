---
name: mcp-server-python
category: software-development
description: Build and troubleshoot MCP servers in Python using FastMCP, with SSE transport, lifecycle tools, and runtime testing patterns.
tags: [mcp, fastmcp, python, sse, server]
---

# MCP Server Development in Python

## When to use this skill

You are building or debugging a Python MCP server that exposes tools over HTTP/SSE
(typically using `mcp.server.fastmcp.FastMCP`). This covers binding configuration,
client testing, common pitfalls, and verification workflows.

## FastMCP server binding

### ⚠️ `host=` and `port=` kwargs are ignored in current FastMCP

Constructing `FastMCP("name", host=..., port=...)` does **not** set the bind address.
Use explicit assignment on `mcp.settings` instead:

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("my_server")
mcp.settings.host = "127.0.0.1"
mcp.settings.port = 8777

@mcp.tool()
def example_tool() -> dict:
    return {"ok": True}

if __name__ == "__main__":
    mcp.run(transport="sse")
```

Verify with:
```bash
curl -s http://127.0.0.1:8777/sse | head -c 200
ss -tlnp | grep 8777
```

## Typical project layout

```
my_mcp_server/
├── pyproject.toml
├── run_server.sh          # . .venv/bin/activate && python -m my_mcp_server
└── my_mcp_server/
    ├── __init__.py
    ├── server.py          # FastMCP setup + tool decorators
    ├── config.py          # dataclass / env-var config
    ├── gamemgr.py         # process lifecycle if applicable
    ├── telemetry.py       # external process reading, etc.
    └── capture.py         # screenshots, etc.
```

## Testing an SSE MCP server

### Quick health check

```bash
# Should print the initial endpoint event
curl -s -m 3 http://127.0.0.1:8777/sse | head -c 300
```

### Full client smoke test

```python
import asyncio
from mcp import ClientSession
from mcp.client.sse import sse_client

async def main():
    async with sse_client('http://127.0.0.1:8777/sse') as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            print([t.name for t in tools.tools])
            result = await session.call_tool('get_status', {})
            print(result.content[0].text)

asyncio.run(main())
```

### What to check after a fix

- [ ] Server process starts without bind errors
- [ ] `curl http://host:port/sse` returns an `event: endpoint` with a session ID
- [ ] POST to `/messages/?session_id=...` returns tool results, not `Invalid session ID`
- [ ] Tools return the expected JSON shape and no silent exceptions
- [ ] Background server can be killed cleanly and the port is freed

## Common pitfalls

### "address already in use" after a background restart

A previously started background process may still hold the port. Before restarting:

```bash
pkill -9 -f "python -m my_mcp_server"  # or the module name
pkill -9 -f "uvicorn"
sleep 1
ss -tlnp | grep 8777 || echo "port free"
```

### Terminal `&` backgrounding is blocked

Use `terminal(background=True)` for long-lived MCP servers, then run health checks in
separate calls. Do not use shell `&` in foreground terminal calls.

### Shell `source` fails inside `execute_code` subprocess

`subprocess.Popen(['source', ...])` fails because `source` is a bash builtin. Either:
- Use `executable='/bin/bash'` and pass the command string with `. .venv/bin/activate && ...`
- Or run `bash -c ". .venv/bin/activate && python -m my_mcp_server"`

### Testing memory tools requires 32-bit addressable memory

When testing `MemoryManager` (which uses 32-bit u32 pointer reads) against the
self-process on a 64-bit host, `mmap` returns addresses above `0xFFFFFFFF`. Use
`MAP_32BIT` (0x40) to force allocation in the low 2GB:

```python
test_mem = libc.mmap(None, 65536, PROT_READ|PROT_WRITE,
                     MAP_PRIVATE|MAP_ANONYMOUS|MAP_32BIT, -1, 0)
```

Without this, `struct.pack("<I", addr)` raises `struct.error: 'I' format
requires 0 <= number <= 4294967295` because the address doesn't fit in u32.

### `resolve_address` must fall through to `_parse_addr` on None

When `resolve_symbol` returns `None` for an unrecognized spec, the
`resolve_address` method must fall through to `_parse_addr(spec)` rather than
returning `None`. Otherwise, valid absolute hex addresses that don't match any
symbol pattern will silently fail:

```python
# WRONG — returns None for "5436128" (decimal with no 0x prefix)
from .addresses import resolve_symbol
return resolve_symbol(self, spec)

# CORRECT — falls through if symbol lookup fails
result = resolve_symbol(self, spec)
if result is not None:
    return result
# fall through to _parse_addr
```

### Tool-guard decorator must handle sync and async tools

FastMCP accepts both sync and async tool functions. A single `tool_guard` decorator
should detect coroutines with `asyncio.iscoroutinefunction(fn)` and return the correct
wrapper, otherwise async tools throw `TypeError: cannot unpack non-iterable coroutine object`.

```python
import asyncio
import traceback
from functools import wraps
from typing import Any, Callable

def tool_guard(fn: Callable[..., Any]) -> Callable[..., dict[str, Any]]:
    @wraps(fn)
    def sync_wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            return {"success": False, "error": f"{type(exc).__name__}: {exc}"}

    @wraps(fn)
    async def async_wrapper(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except Exception as exc:
            return {"success": False, "error": f"{type(exc).__name__}: {exc}"}

    return async_wrapper if asyncio.iscoroutinefunction(fn) else sync_wrapper
```

### Naming collisions between a tool and its imported helper

If a tool function is named `get_health` and it calls a helper also named `get_health`,
the local name shadows the helper inside the tool body, causing `TypeError` or infinite
recursion. Rename the helper on import (`from .health import get_health as _get_health`)
or name the tool differently.

### FastMCP runs `uvicorn` in a subprocess

The module import (`from .server import mcp`) already constructs the server. When testing,
use `exec python -m my_mcp_server` inside the subprocess to avoid double interpreter overhead.

## Tool implementation tips

- Keep tools synchronous unless they need `asyncio` (FastMCP handles both).
- Return plain Python dicts / JSON-serializable structures.
- For filesystem artifacts (screenshots, logs), return the absolute path so clients can
  optionally fetch or display them.
- Add a `wait(seconds)` tool for simple timing in agent-driven workflows.
- When a tool argument changes the server's mutable config (e.g. enabling a mod flag for
  the next `start_game`), set it on the shared `cfg` object immediately inside the tool
  function; do not rely on callers to also mutate config via side channels.
- Use `mcp.run(transport="sse")` to serve. The FastMCP object itself is constructed at
  module import time, so avoid doing heavy work (like starting subprocesses) during
  import; defer that to tool handlers or background threads spawned from `main()`.

## Memory analysis tools (for game/process inspection)

When building an MCP server that controls an external process, add a
`MemoryManager` class wrapping `process_vm_readv`/`process_vm_writev` (Linux)
or `ReadProcessMemory`/`WriteProcessMemory` (Windows). This enables live
inspection and modification of the target's memory.

### Address symbol registry

Encode known struct offsets as Python dicts and provide a `resolve_symbol()`
function so MCP callers can pass human-readable strings like
`"app.target_fps"` instead of raw hex addresses. This is the key UX feature —
it bridges the gap between RE knowledge (struct layouts) and runtime testing.

### Typed read/write dispatcher

Use a `_TYPE_FORMATS` dict mapping type names to `(struct_char, size)` tuples
so one `read_typed(addr, "u32")` / `write_typed(addr, val, "float")` dispatcher
serves all primitive types. Handle vec3, string, bool, and bytes as special cases.

### Value scanning and freezing

Implement Cheat Engine style tools:
- `scan_value(value, type)` — first-pass search
- `scan_next(new_value, prev_addresses, type)` — narrow results
- `freeze_address(addr, value, type)` — background thread re-writes every N ms
- `monitor_address(addr, type)` — time-series sampling

### Testing memory tools on the self-process

Use `MAP_32BIT` (0x40) on x86_64 to allocate test memory in the low 2GB
address space so 32-bit pointer operations work correctly when testing
against the Python process itself:

```python
libc.mmap(None, 65536, PROT_READ|PROT_WRITE,
          MAP_PRIVATE|MAP_ANONYMOUS|MAP_32BIT, -1, 0)
```

### When to prefer runtime patching over DLL mods

Runtime memory writes (patching struct fields via the global pointer) are
preferable to DLL proxy swapping — no file operations, no restore-on-stop
needed, and it works even after the game is already running. Default to
`start_game(fps_mod=False)` and expose a `patch_game_fps` memory tool instead.

See `game-reverse-engineering` skill → `references/memory-analysis-suite.md`
for the full worked pattern.

## Verification checklist for a game-test MCP server

- [ ] `start_game` launches the process and returns a PID
- [ ] `get_status` reports running/not-running accurately
- [ ] `get_telemetry` reads process memory / metrics without ptrace scope errors
- [ ] `screenshot` writes a valid image file and returns its path
- [ ] `stop_game` terminates game, helper servers, and virtual display cleanly
- [ ] All endpoints work through the MCP client (not just raw HTTP)

## Modding via MCP: test fixtures that mutate the game directory

When the server needs to install/remove mod files (e.g. a DLL proxy) before launching,
keep all file operations in a dedicated helper module (`fpsmod.py`) rather than inside
the lifecycle manager. Benefits:
- Clear separation between process management and filesystem mutation
- Easy to unit-test install/uninstall in isolation
- Avoids importing `shutil` directly into `gamemgr.py` and complicating its logic

Pattern:
```python
# fpsmod.py
from .config import Config

def install_mod(cfg: Config) -> tuple[bool, list[str] | str]:
    ...

def uninstall_mod(cfg: Config) -> None:
    ...
```

Expose modding through the tool schema so callers can request it explicitly:
```python
@mcp.tool()
async def start_game(fps_mod: bool = False, target_fps: int = 144) -> dict:
    if fps_mod:
        cfg.fps_mod_enabled = True
        fpsmod.write_mod_ini(cfg, target_fps=target_fps)
    return await mgr.start_game()
```

Always restore the original game files on `stop_game`, even if the launch failed.

## Runtime FPS estimation from a Windows game tick counter

When testing a Windows game under Wine, the in-game `GetTickCount()` value is often
exposed in the `App` struct. Polling it gives a much more accurate real-time FPS
estimate than timing screenshot captures.

```python
APP_LAST_FRAME_TIME = 0x164  # offset inside App struct (game-specific)

def estimate_runtime_fps(self, pid: int, app_ptr: int, samples=10, interval=0.1):
    ticks = []
    for _ in range(samples + 1):
        t0 = time.time()
        frame_bytes = self._read_process_memory(pid, app_ptr + APP_LAST_FRAME_TIME, 4)
        tick = struct.unpack("<I", frame_bytes)[0]
        ticks.append((t0, tick))
        time.sleep(interval)

    deltas = []
    for (t1, tick1), (t2, tick2) in zip(ticks, ticks[1:]):
        dt = t2 - t1
        d_tick = (tick2 - tick1) & 0xFFFFFFFF
        if 0 < d_tick < 0x7FFFFFFF and dt > 0:
            deltas.append((dt, d_tick))

    total_real = sum(d[0] for d in deltas)
    total_ticks = sum(d[1] for d in deltas)
    ms_per_tick = total_real / total_ticks * 1000.0 if total_ticks else 0
    fps = 1000.0 / ms_per_tick if ms_per_tick else 0
    return {"estimated_fps": round(fps, 1), "ms_per_tick": round(ms_per_tick, 3)}
```

## Telemetry and history

Keep a rolling history of telemetry samples in memory (e.g. `collections.deque(maxlen=60)`)
so callers can inspect trends without re-polling. Expose it as `get_telemetry_history(count)`.

## Input abstractions

For game automation, normalize friendly key names to xdotool key names and support:
- single keypress
- held key
- combo (multiple keys together)
- repeated tap pattern
- listing valid key names

Return the resolved window ID when available so callers know input targeted the right window.
