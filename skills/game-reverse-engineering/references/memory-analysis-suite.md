# Memory Analysis Suite for Live Game Processes

Pattern for adding full read/write/scan/monitor/freeze capabilities to an MCP
test daemon. Built and verified in hbtestd v0.3.0 (the target-re/tools/hbtestd/).

## Architecture

```
MCP client (agent)
    │
    ├── read_memory / write_memory      — typed r/w (u8..i64, float, double, bool, string, vec3)
    ├── read_batch / write_batch        — multiple addresses in one call
    ├── dump_hex                        — hex+ASCII dump
    ├── resolve_address                 — symbol → absolute address
    ├── resolve_pointer_chain           — multi-level dereferencing
    ├── scan_value / scan_next          — Cheat Engine style value search
    ├── scan_float_range                — range-based float search
    ├── find_memory_pattern             — byte pattern with wildcards
    ├── monitor_address / monitor_start — time-series sampling
    ├── freeze_address / unfreeze_all   — background value pinning
    ├── read_app_state / read_ball_state — game-specific convenience tools
    └── list_known_addresses             — all known struct offsets
```

## Core module: MemoryManager

The `MemoryManager` class wraps `process_vm_readv`/`process_vm_writev` (Linux)
with typed helpers, batch ops, and address resolution.

### Typed read/write dispatch

Use a `_TYPE_FORMATS` dict mapping type names to `(struct_char, size)` tuples.
This lets one `read_typed(addr, "u32")` / `write_typed(addr, val, "float")`
dispatcher serve all types:

```python
_TYPE_FORMATS = {
    "u8": ("B", 1), "i8": ("b", 1),
    "u16": ("H", 2), "i16": ("h", 2),
    "u32": ("I", 4), "i32": ("i", 4),
    "u64": ("Q", 8), "i64": ("q", 8),
    "float": ("f", 4), "double": ("d", 8),
}
```

Special types (vec3, string, bool, bytes) need custom handling but also
dispatch through the same `read_typed`/`write_typed` interface.

### vec3 handling

Vec3 = 3 consecutive floats (12 bytes). Accept both list/tuple `[x,y,z]`
and dict `{"x":..,"y":..,"z":..}` on write:

```python
def write_vec3(self, address, x, y, z):
    return self.write_bytes(address, struct.pack("<fff", x, y, z))
```

### Pointer chain resolution

Cheat Engine style multi-level dereferencing — read pointer, add offset,
read again, add offset, etc.:

```python
def resolve_pointer_chain(self, base, offsets):
    addr = base
    for i, offset in enumerate(offsets):
        ptr = self.read_u32(addr)
        if ptr == 0:
            raise ValueError(f"null pointer at chain level {i}")
        addr = ptr + offset
    return addr
```

### Address resolution (symbol specs)

Support multiple address specification formats in one `resolve_address(spec)`
method. This is the key UX feature — callers pass strings, not raw addresses:

| Spec format | Example | Meaning |
|---|---|---|
| `"0x005341E0"` | absolute hex | direct address |
| `"5436128"` | decimal | direct address |
| `"RVA:0x1341E0"` | RVA | module base + RVA |
| `"module:libc.so.6:0x0"` | module-specific | named module base + offset |
| `"g_App"` | known symbol | from addresses.py symbol map |
| `"g_App+0x16C"` | symbol + offset | known address + hex offset |
| `"app.target_fps"` | deref + offset | read g_App pointer, add struct offset |
| `"ptr:0x005341E0"` | dereference | read pointer at address |
| `"chain:0x005341E0,0x10,0x20"` | pointer chain | multi-level dereferencing |
| `"func.Ball_Ctor"` | function address | from FUNCTIONS table |
| `"vtable.Ball"` | vtable address | from VTABLES table |

### Value scanning (Cheat Engine style)

Three-phase approach:
1. `scan_value(value, type)` — first pass, find all addresses containing value
2. `scan_next(new_value, prev_addresses, type)` — narrow results by checking
   which still match a new value (user changed something in-game)
3. `scan_float_range(low, high)` — range scan for approximate values

Implementation: read memory in 4MB chunks, search for packed bytes. Return
list of `{"address": int, "value": value}` dicts.

### Batch operations

Single-call multi-address read/write for efficiency:

```python
# Read multiple addresses
reads = [
    {"label": "ball_x", "address": "0x...", "type": "float"},
    {"label": "ball_y", "address": "0x...", "type": "float"},
]
results = mm.read_batch(reads)
# → [{"label": "ball_x", "address": "0x...", "value": 1.5, "ok": True}, ...]
```

Each result includes `ok: True/False` so partial failures don't lose data.

## Address symbol registry: addresses.py

Encode known game struct offsets as Python dicts, with a `resolve_symbol()`
function that dereferences pointers and applies offsets:

```python
APP = {
    "target_fps": 0x16C,
    "render_fps": 0x170,
    "last_frame_tick": 0x164,
    "difficulty": 0x23C,
}

BALL = {
    "position": 0x014,   # Vec3
    "velocity": 0x020,    # Vec3
    "radius": 0x03C,     # float
    "max_speed": 0x284,   # float
    "is_8ball": 0x31D,    # bool
}
```

`resolve_symbol(mm, "app.target_fps")` reads the g_App pointer, adds the
offset, and returns the absolute address. This lets MCP callers use
human-readable strings instead of raw hex.

## Monitoring and freezing: monitor.py

### AddressMonitor

Time-series sampling of memory addresses. Supports both manual
`sample_once()` and background `start()`/`stop()` with configurable interval.

```python
mon = AddressMonitor(mm, interval=0.25)
mon.add_watch("ball_x", addr, "float")
mon.start()  # background thread samples every 0.25s
# ... later ...
history = mon.get_history("ball_x", count=50)
```

### FreezeManager

Continuously re-writes a value to an address every N ms, preventing the game
from changing it. Background thread, daemon=True so it dies with the process.

```python
fz = FreezeManager(mm, interval_ms=20)
fz.freeze("inf_speed", addr, 999.0, "float")
# ... game tries to write 5.0, but within 20ms it's back to 999.0 ...
fz.unfreeze("inf_speed")
```

Write count tracking lets you verify the freeze thread is actually running.

## Game-specific convenience tools

Build high-level tools that resolve pointer chains and read entire structs
in one call:

- `read_app_state()` — dereference g_App, read all known fields (FPS,
  difficulty, scores, controls)
- `read_ball_state(ball_index)` — follow Scene→ball_list→ball[i], read
  position/velocity/radius/is_8ball etc.
- `patch_game_fps(target, render)` — write App+0x16C/0x170 directly

These wrap multiple MemoryManager calls and return rich JSON.

## Testing

Use `MAP_32BIT` (x86_64) to allocate test memory in the low 2GB so 32-bit
pointer operations work on a 64-bit test process:

```python
libc.mmap(None, 65536, PROT_READ|PROT_WRITE,
          MAP_PRIVATE|MAP_ANONYMOUS|MAP_32BIT, -1, 0)
```

Test coverage should include: all typed reads, all typed writes, typed
dispatcher round-trip, vec3 (list and dict), read_struct (multi-field),
pointer chains (multi-level), batch read (with intentional bad address),
batch write, value scanning (exact match + scan_next narrowing), float
range scan, hex dump, address resolution (all spec formats), monitoring
(manual + background thread), freezing (holds value + unfreeze allows change),
pattern search (exact + wildcard), edge cases (0 bytes, bad address).

hbtestd v0.3.0 achieved 103/103 test coverage with this pattern.

## FPS mod note

Runtime memory patching (`patch_game_fps`) is preferable to DLL proxy
swapping — no file operations, no restore-on-stop needed, and it works
even after the game is already running. Default `start_game(fps_mod=False)`
and use the memory patch tool instead.
