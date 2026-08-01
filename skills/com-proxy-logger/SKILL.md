---
name: com-proxy-logger
description: Build a MinGW cross-compiled proxy DLL that intercepts COM interfaces, logs every method call to JSONL, and forwards to the real runtime. Foundation for API surface discovery before building a custom shim.
tags: [reverse-engineering, d3d8, mingw, com-interception, proxy-dll]
---

# D3D8 COM Proxy Logger

## Overview
Build a Windows-compatible proxy `d3d8.dll` that sits next to any D3D8 game EXE,
intercepts `Direct3DCreate8`, wraps every COM interface (IDirect3D8,
IDirect3DDevice8, textures, buffers, surfaces, swapchains), logs all method
calls with arguments to JSONL, and forwards everything to the real system
d3d8.dll so the game still runs normally.

## When to Use
- You need to discover which D3D8 API subset a game uses before building a
  fake/minimal implementation
- You're porting a D3D8 game to WebGL and need exact call sequences
- You need to verify what render states, texture formats, FVF flags, and
  primitive types a game uses

## Step 1: Verify the Game Uses D3D8
```bash
objdump -p Game.exe | grep -i "d3d\\|ddraw\\|dxgi"
strings Game.exe | grep -iE "d3d9\\.dll|d3d9|ddraw\\.dll|dxgi\\.dll"
```
target application confirmed: imports only `Direct3DCreate8` from `d3d8.dll`. All
other calls go through COM vtables. D3D9/ddraw strings are dead code.

## Step 2: Build the Proxy DLL (MinGW Cross-Compile)

### Prerequisites
- `i686-w64-mingw32-g++` (GCC 13-win32 tested)
- `d3d8.h` from MinGW headers at `/usr/i686-w64-mingw32/include/d3d8.h`
- A `.def` file to export `Direct3DCreate8` with correct undecorated name

### Source Files
```
tools/d3d8_proxy_logger/src/
  d3d8_proxy.h          — shared types, log macros, D3DC8_FN typedef
  d3d8_proxy_helpers.cpp — logging, format string helpers, real DLL loading
  d3d8_proxy_d3d8.cpp    — ProxyD3D8 class + Direct3DCreate8 export
  d3d8_proxy_device.cpp  — ProxyDevice8 with all IDirect3DDevice8 methods
  d3d8_proxy_resources.cpp — stub wrappers for textures/buffers/surfaces
  d3d8_proxy.def         — EXPORTS Direct3DCreate8
```

### Build Command (Makefile)
```makefile
CXX = i686-w64-mingw32-g++
SOURCES = src/d3d8_proxy_helpers.cpp src/d3d8_proxy_d3d8.cpp \
          src/d3d8_proxy_device.cpp src/d3d8_proxy_resources.cpp
DEF_FILE = src/d3d8_proxy.def
TARGET = d3d8.dll

CXXFLAGS = -Wall -Wextra -O2
LDFLAGS = -shared -static-libgcc -static-libstdc++ -static
LIBS = -ld3d8 -luser32 -lgdi32

all: $(TARGET)

$(TARGET): $(SOURCES) $(DEF_FILE)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) -o $@ $(SOURCES) $(DEF_FILE) $(LIBS)
```

## Step 3: Run Game with Proxy

### Wine/Xvfb
```bash
cp tools/d3d8_proxy_logger/d3d8.dll originals/installed/extracted/
cd originals/installed/extracted/
Xvfb :99 -screen 0 1024x768x24 &
DISPLAY=:99 WINEDEBUG=-all timeout 60s wine target_binary.exe
```
Key: The proxy goes in the same directory as the EXE. Windows/Wine DLL search
order loads the local d3d8.dll before system32.

### Verify Loading
Check `hb_d3d8_trace.jsonl` exists and has content:
```bash
wc -l hb_d3d8_trace.jsonl
head -20 hb_d3d8_trace.jsonl
```

## Step 4: Analyze the Trace
```bash
python3 tools/hb_trace_analyzer.py hb_d3d8_trace.jsonl
```
Reports: unique methods, call counts, render states, texture formats, FVF
values, primitive types, texture dimensions, buffer sizes.

## Architecture Notes

### WHY THE RAW VTABLE APPROACH (NOT C++ INHERITANCE)
MinGW's `d3d8.h` declares COM interfaces as pure virtual C++ classes (MSVC
uses C-style POD structs with function pointers). This means you CANNOT:

- Declare `IDirect3DDevice8 vt;` as a struct field → abstract class, can't instantiate
- Use `ProxyObject<T>` template base class → T is abstract
- Call `new ProxyD3D8` unless ALL pure virtual methods are implemented (49 methods!)

**Solution**: Raw `void* vt[N]` function pointer arrays for device wrapper,
and a full C++ class with all 49 methods for ProxyD3D8.

### ProxyDevice8 Structure
```cpp
struct ProxyDevice8 {
    IDirect3DDevice8* real;   // pointer to real device (offset 0)
    void*             vt[81]; // raw vtable slots (offset 4)
};
```

The game calls through `vt[0]` which expects `_this == &vt[0]`. The `GET_REAL`
macro subtracts `offsetof(ProxyDevice8, vt)` to recover the struct:

```cpp
#define GET_REAL \
    ProxyDevice8* me = (ProxyDevice8*)((char*)_this - offsetof(ProxyDevice8, vt)); \
    IDirect3DDevice8* real = me->real
```

CRITICAL: Use `_this` NOT `this` — these are static C functions, not member methods.

### ProxyD3D8 Class
Must be a real C++ class implementing ALL pure virtual methods (49 total
including IUnknown). Missing even one method (like `GetAdapterMonitor`) causes
"invalid new-expression of abstract class type" at link time.

### Real DLL Loading
```cpp
typedef IDirect3D8* (WINAPI *D3DC8_FN)(UINT);
extern D3DC8_FN g_real_Direct3DCreate8;  // NOT FARPROC

bool load_real_d3d8() {
    char syspath[MAX_PATH];
    GetSystemDirectoryA(syspath, MAX_PATH);
    strcat(syspath, "\\d3d8.dll");
    g_real_d3d8 = LoadLibraryA(syspath);
    if (!g_real_d3d8)
        g_real_d3d8 = LoadLibraryA("d3d8.dll");  // Wine fallback
    if (!g_real_d3d8) return false;
    g_real_Direct3DCreate8 = (D3DC8_FN)GetProcAddress(g_real_d3d8, "Direct3DCreate8");
    return g_real_Direct3DCreate8 != nullptr;
}
```

### Log Format
JSONL (one JSON object per line):
```json
{"t":12345,"cat":"d3d8","msg":"CreateDevice(0,HAL,hwnd=0x10050,flags=0x40)"}
{"t":12346,"cat":"device","msg":"SetRenderState(D3DRS_LIGHTING,1)"}
{"t":12347,"cat":"matrix","name":"WORLD","m":[1.0,0.0,0.0,...]}
```

## CRITICAL: D3D8 Vtable Index Verification (LEARNED THE HARD WAY)

**NEVER guess D3D8 vtable indices.** Count them from the MinGW header.
Wrong indices cause instant crashes (corrupting unrelated vtable entries).

### How to verify vtable indices
```bash
# Count STDMETHOD declarations in the interface block
sed -n '/DECLARE_INTERFACE_(IDirect3DDevice8/,/^};/p' /usr/i686-w64-mingw32/include/d3d8.h \
  | grep 'STDMETHOD' | nl -ba | grep -i 'MethodName'
```
The `nl -ba` number is 1-indexed. Subtract 1 for 0-indexed vtable position.

### Verified D3D8 vtable indices (MinGW d3d8.h, 0-indexed)
| Method | IDirect3D8 | IDirect3DDevice8 |
|--------|-----------|-----------------|
| QueryInterface | [0] | [0] |
| AddRef | [1] | [1] |
| Release | [2] | [2] |
| CreateDevice | [15] | N/A |
| SetTransform | N/A | [37] |
| GetTransform | N/A | [38] |
| BeginScene | N/A | [34] |
| EndScene | N/A | [35] |
| Clear | N/A | [36] |
| DrawPrimitive | N/A | [70] |
| DrawIndexedPrimitive | N/A | [71] |
| DrawPrimitiveUP | N/A | [72] |
| DrawIndexedPrimitiveUP | N/A | [73] |
| SetStreamSource | N/A | [83] |
| SetIndices | N/A | [85] |
| SetRenderState | N/A | [50] |
| SetTexture | N/A | [61] |
| GetTexture | N/A | [60] |

### Common mistakes (ALL caused crashes)
- Using [44] for SetTransform (should be [37]) — counted wrong, included IUnknown offset
- Using [1] for CreateDevice (should be [15]) — [1] is AddRef in IDirect3D8
- Using [168]/[171] for DrawPrimitive/DrawIndexedPrimitive (should be [70]/[71])

## CRITICAL: Save Original Function Pointers Before Patching

**NEVER dereference fake proxy structs in hook functions.** The previous
ProxyD3D8/ProxyDevice approach caused crashes because hook functions tried
to recover proxy structs from `This` pointers that were actually real D3D
objects — dereferencing garbage memory.

### Correct pattern: save + call through saved pointers
```c
// Global: save original function pointers BEFORE patching vtable
static SetTransform_t g_orig_SetTransform = NULL;
static CreateDevice_t g_orig_CreateDevice = NULL;

// In Hooked_CreateDevice, BEFORE patching device vtable:
g_orig_SetTransform = (SetTransform_t)real_vt[37];
// Then patch:
real_vt[37] = (void*)Hooked_SetTransform;

// In hook function, call through saved pointer:
return g_orig_SetTransform(This, State, pMatrix);
```

### WRONG pattern (causes crash)
```c
// NEVER do this — ProxyD3D8 was never created
ProxyD3D8* proxy = (ProxyD3D8*)((char*)This - offsetof(ProxyD3D8, vt));
proxy->real->CreateDevice(...);  // CRASH: proxy->real is garbage

// NEVER do this — g_device is a flag, not a pointer
g_device->real->SetTransform(...);  // CRASH: g_device is (ProxyDevice*)1
```

## Targeted Mesh Rotation via DrawIndexedPrimitive Hook

To rotate a SPECIFIC mesh (not the entire level), hook
`DrawIndexedPrimitive` instead of `SetTransform`:

1. Hook `DrawIndexedPrimitive` (vtable[71])
2. Check `NumVertices` parameter — if it matches the target mesh's vertex count,
   apply rotation
3. Save current world matrix via `GetTransform`, set rotated matrix via
   `SetTransform`, draw, then restore original matrix

This rotates ONLY the target mesh — all other draw calls pass through untouched.

### Communication between bass.dll and d3d8.dll proxy
Use shared memory (memory-mapped file):
```c
// In bass.dll: write rotation angle + center
HANDLE shm = CreateFileMappingA(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE,
                                0, sizeof(RotatorState), "target application_Rotator");
RotatorState* state = MapViewOfFile(shm, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(RotatorState));
state->angle += 0.02f;  // ~69°/sec at 60fps

// In d3d8.dll: read rotation angle + center
HANDLE shm = CreateFileMappingA(..., "target application_Rotator");
RotatorState* state = MapViewOfFile(...);
if (state->active && NumVertices == state->rotator_vertex_count) { apply rotation }
```

## Pitfalls

### MinGW-Specific
1. **Pure virtual interfaces**: MinGW d3d8.h uses C++ abstract classes. You
   CANNOT hold `IDirect3DDevice8` as a struct field. Use `void* vt[N]` arrays.
2. **GetAdapterMonitor**: This method exists in D3D8 spec but is easy to miss.
   ProxyD3D8 must implement it or `new` fails at compile time.
3. **SetDepthStencilSurface missing**: MinGW's d3d8.h doesn't declare this
   method. Use `real->SetRenderTarget(nullptr, ds)` as workaround for logging.
   The real vtable call still works regardless.
4. **D3DSAMPLERSTATETYPE is D3D9-only**: Don't try to use it. Remove any
   `GetSamplerState`/`SetSamplerState` stubs — they don't exist in D3D8.
5. **`this` vs `_this`**: Static C functions receive the vtable pointer as
   `_this`, NOT `this`. The GET_REAL macro must use `_this`.
6. **`#include <cstddef>` required**: `offsetof` needs this header. Without it,
   you get "offsetof was not declared in this scope".
7. **D3DC8_FN typedef**: Must be in the SHARED HEADER (d3d8_proxy.h), not just
   in one .cpp file. All files need it.
8. **Globals use D3DC8_FN not FARPROC**: `extern D3DC8_FN g_real_Direct3DCreate8`
   for type safety.
9. **`--def` flag not recognized by MinGW ld**: Use `-Wl,--export-all-symbols`
   instead of `-Wl,--def,file.def`.

### General
- The proxy DLL MUST export `Direct3DCreate8` with the EXACT undecorated name.
  Use a `.def` file or `-Wl,--export-all-symbols`, not `__declspec(dllexport)`.
- On 64-bit systems, the proxy must be 32-bit (match the game). Use
  `i686-w64-mingw32-g++`, NOT `x86_64-w64-mingw32-g++`.
- Wine may still load builtin d3d8 if the proxy isn't co-located with the EXE.
  Always put the proxy DLL in the EXE's directory.
- `-static-libgcc` and `-static-libstdc++` are needed so the DLL doesn't
  depend on MinGW runtime DLLs.
- `-static` in LDFLAGS ensures the DLL has zero external dependencies beyond
  kernel32/user32.

## Tested Build Status
- Code: 1501 lines across 4 source files (all MinGW-compatible)
- Compilation: passes all type checks after MinGW fixes
- Runtime: not yet tested with original EXE on Wine
- Remaining work: deploy alongside target_binary.exe, capture trace, analyze
