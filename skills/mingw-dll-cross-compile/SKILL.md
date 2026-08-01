---
name: mingw-dll-cross-compile
description: Compile DLL mods with MinGW that match Visual Studio's vtable layout — no VS installation needed
version: 1.0
---

# Compiling the application API Mods with MinGW (Not Visual Studio)

## Problem
MinGW and MSVC have different C++ vtable layouts for virtual destructors:
- **MSVC**: 1 destructor slot + 16 virtual functions = **17 vtable entries** (the application v2.0/v2.1)
- **MinGW**: 2 destructor slots + 16 virtual functions = **18 vtable entries** (the application v2.0/v2.1)

The extra slot shifts ALL virtual functions by 1 position. When the application calls `vtable[6]` (Initialize), it hits the wrong function → crash at `Initialize(26)` / `fonts\showcardgothic28`.

**the application v2.0 added `onCycleOptionChange` at vtable slot [10]**, shifting all callbacks after `onSliderChange` by +1. A 16-entry vtable (v1.0 layout) → `onLevelStart` at slot [16] reads past the array → crash at `Initialize(26)`.

**the application v2.1** (released 2026-07-13, `TARGET_API_VERSION 3`) did NOT add new virtual functions — the vtable layout is identical to v2.0 (17 entries). v2.1 changes are struct-level only: `CustomSubmenu.parentID` field and `Ball` struct padding fix (removed `burning_flag`). Mods must still be recompiled with the new header for `TARGET_API_VERSION 3`.

**All future the application mods target v2.1.** Use `TARGET_API_VERSION 3` and the v2.1 header at `~/the target-re/docs/agent-knowledge/target applicationAPI.h`. v1.0/v2.0 mods must be recompiled with the new header.

## Solution: Manual Vtable Construction

Don't inherit from `target applicationAPI`. Instead, manually construct a **17-entry vtable** with raw function pointers. This works for both v2.0 and v2.1 (identical vtable layout).

### Step 1: Create nocrt.h
Provides CRT functions using Win32 HeapAlloc only (no msvcrt.dll dependency):

```c
#ifndef NOCRT_H
#define NOCRT_H
#include <windows.h>

#ifdef __cplusplus
extern "C" {
#endif
void* nc_malloc(size_t size);
void nc_free(void* ptr);
void* nc_memcpy(void* dst, const void* src, size_t count);
void* nc_memset(void* dst, int val, size_t count);
size_t nc_strlen(const char* s);
int nc_strcmp(const char* a, const char* b);
char* nc_strncpy(char* dst, const char* src, size_t n);
int nc_snprintf(char* buf, size_t size, const char* fmt, ...);
#ifdef __cplusplus
}
#endif

// C++ operator new/delete
void* __cdecl operator new(size_t size);
void __cdecl operator delete(void* ptr);
void __cdecl operator delete(void* ptr, size_t);
#endif
```

### Step 2: Create nocrt.cpp
Implement all CRT functions using Win32 only + DllMain:

```cpp
#include "nocrt.h"
extern "C" {
void* nc_malloc(size_t size) { return HeapAlloc(GetProcessHeap(), 0, size ? size : 1); }
void nc_free(void* ptr) { if (ptr) HeapFree(GetProcessHeap(), 0, ptr); }
// ... memcpy, memset, strlen, strcmp, strncpy, snprintf (use wvsprintfA from user32)
}
// Standard-named wrappers (static would conflict with windows.h extern decls)
void* __cdecl memset(void* d, int v, size_t n) { return nc_memset(d,v,n); }
// ... memcpy, strlen, strcmp, strncpy, malloc, free
// operator new/delete
void* __cdecl operator new(unsigned int size) { return nc_malloc(size); }
void __cdecl operator delete(void* ptr) { nc_free(ptr); }
BOOL APIENTRY DllMain(HMODULE, DWORD, LPVOID) { return TRUE; }
```

### Step 3: Main mod file with manual vtable

```cpp
#include "nocrt.h"
#include "target applicationAPI.h"

// Function pointer typedefs
typedef void* (__thiscall *dtor_t)(void* thisptr, int flags);
typedef const char* (__thiscall *get_name_t)(void*);
// ... all 15 virtual functions

static IModAPI* g_api = nullptr;

// Implementations
static void* __thiscall sc_dtor(void* thisptr, int flags) {
    if (flags & 1) operator delete(thisptr);
    return thisptr;
}
static const char* __thiscall get_mod_name(void*) { return "MyMod"; }
// ... etc

// 17-entry vtable matching MSVC layout (the application v2.0/v2.1)
// v2.0 added onCycleOptionChange at [10], shifting everything after by +1
// v2.1 did NOT change the vtable — identical layout to v2.0
static void* g_vtable[17] = {
    (void*)sc_dtor,        // [0] scalar deleting destructor
    (void*)get_mod_name,   // [1] GetModName
    (void*)get_author,     // [2] GetAuthorName
    (void*)get_version,    // [3] GetApiVersion
    (void*)get_contributors,// [4] GetContributors
    (void*)init_impl,      // [5] Initialize
    (void*)ball_update,    // [6] onBallUpdate
    (void*)render_apply,   // [7] onRenderApply
    (void*)button_toggle,  // [8] onButtonToggle
    (void*)slider_change,  // [9] onSliderChange
    (void*)cycle_change,   // [10] onCycleOptionChange (NEW in v2.0)
    (void*)game_update,    // [11] onGameUpdate
    (void*)event_collide,  // [12] onEventPlaneCollide
    (void*)text_render,    // [13] onTextRenderLoop
    (void*)ball_bump,      // [14] onBallBump
    (void*)scene_end,      // [15] onSceneEnd
    (void*)level_start,    // [16] onLevelStart
};

extern "C" __declspec(dllexport) target applicationAPI* CreateModInstance() {
    void* obj = operator new(8);  // 8 bytes: vtable ptr + IModAPI* member
    *(void**)obj = g_vtable;
    *(void**)((char*)obj + 4) = nullptr;  // api = nullptr
    return (target applicationAPI*)obj;
}
```

### Step 4: Compile

```bash
i686-w64-mingw32-g++ -shared -o plus_mymod.dll MyMod.cpp nocrt.cpp \
  -I. -O2 -msse2 -mfpmath=sse -mwindows \
  -fno-exceptions -fno-rtti -fno-threadsafe-statics \
  -fno-asynchronous-unwind-tables -fno-unwind-tables \
  -nostdlib -nostartfiles \
  -lkernel32 -luser32 \
  -Wl,-e,_DllMain@12 -Wl,--enable-stdcall-fixup \
  -Wl,--image-base,0x10000000 -Wl,--gc-sections \
  -ffunction-sections -fdata-sections \
  -fpermissive -fno-builtin \
  -Wl,--exclude-symbols,_strcmp -Wl,--exclude-symbols,_strlen \
  -Wl,--exclude-symbols,_memcpy -Wl,--exclude-symbols,_memset \
  -Wl,--exclude-symbols,_malloc -Wl,--exclude-symbols,_free
```

### Verification

1. **Vtable count = 17** (not 16, not 18) — the application v2.0/v2.1 have 17 entries (v2.1 didn't change vtable)
2. **Only KERNEL32.dll import** (no msvcrt)
3. **PE32 GUI** (not console)
4. **No .eh_frame section** (use `-fno-asynchronous-unwind-tables`)
5. **No global CRT symbols** (use `--exclude-symbols`)
6. **Object size = 8 bytes** (vtable ptr + IModAPI* member)

### Fix 3: Manual IModAPI Dispatch (mod → the application calls)

The vtable mismatch also affects calls FROM the mod TO the application's IModAPI.
MinGW generates vtable indices shifted by +1, so `api->CreateToggleButton()`
hits `CreateSlider()` instead. No crash — just silent wrong behavior
(toggle buttons appear as sliders in ModConfig.ini).

**Solution**: Create an `hbplus_api.h` wrapper that manually indexes the
IModAPI vtable with correct VS offsets. Replace `api->Method()` with
`the appAPI(api).Method()`.

```cpp
// hbplus_api.h — manual IModAPI vtable dispatch
static inline void* hbplus_vtable(void* obj, int index) {
    void** vtable = *(void***)obj;
    return vtable[index];
}

struct the appPlusAPI {
    void* ptr;
    void CreateToggleButton(const CustomButton& btn, void* modInstance) {
        typedef void (__attribute__((thiscall)) *fn_t)(void*, void*, void*);
        ((fn_t)hbplus_vtable(ptr, 10))(ptr, (void*)&btn, modInstance);
    }
    void CreateSlider(const CustomSlider& slider, void* modInstance) {
        typedef void (__attribute__((thiscall)) *fn_t)(void*, void*, void*);
        ((fn_t)hbplus_vtable(ptr, 11))(ptr, (void*)&slider, modInstance);
    }
    // ... see full file in mods/-BROKEN/plus_netplay/hbplus_api.h
};
#define the appAPI(api) the appPlusAPI{api}
```

**VS IModAPI vtable indices** — DIFFER between v1.0 and v2.0/v2.1 because v2.0 added new methods (CreateCycleOption, CreateSubmenu, RegisterConfig*, GetConfig*, GetCycleOptionState) that shifted all indices after CreateSlider.

**v2.0/v2.1 IModAPI vtable indices** (verified from working mkn_plus_local_gravity mod):

| Index | Method |
|-------|--------|
| 0 | ~IModAPI (deleting destructor) |
| 1 | RegisterCustomHook |
| 10 | CreateToggleButton |
| 11 | CreateSlider |
| 29 | GetButtonState |
| 30 | GetSliderState |
| 32 | GetPlayer |
| 38 | GetScene |
| 40 | GetApp |

**v1.0 IModAPI vtable indices** (OLD — do NOT use for v2.0+):

| Index | Method |
|-------|--------|
| 10 | CreateToggleButton |
| 11 | CreateSlider |
| 21 | GetButtonState |
| 22 | GetSliderState |
| 23 | GetPlayer |
| 29 | GetScene |
| 31 | GetApp |

**CRITICAL**: When porting a v1.0 mod to v2.0/v2.1, you MUST update the
`hbplus_api.h` vtable indices. A v1.0 `hbplus_api.h` will compile fine but
call the WRONG IModAPI methods at runtime (e.g. GetButtonState at index 21
hits a different method entirely). This is a SILENT failure — no crash,
just wrong behavior.

**Verification**: Tested on Wine with real the application framework. Without the fix,
`TEST_BUTTON` appeared in `[Sliders]` section of ModConfig.ini. With the fix,
it appears in `[Toggle Buttons]`. The `onButtonToggle` callback also fired
correctly.

**IModAPI vtable index reference**: See `references/imodapi-vtable-indices.md` for the complete v1.0 vs v2.0/v2.1 index mapping and migration checklist.

**Three fixes required** (all three, in order):
1. nocrt — eliminates msvcrt.dll dependency (crash at loading screen)
2. Manual mod vtable — fixes the application calling into mod (crash at Initialize). **Must be 17 entries for the application v2.0/v2.1** (16 entries worked for v1.0 but crashes in v2.0+ because onLevelStart reads past the array)
3. Manual IModAPI dispatch — fixes mod calling into the application (silent wrong behavior)

### Wine the application Test Harness

Test the application mods on Wine with the REAL the application framework (not just LoadLibrary):

1. Copy game files to test directory
2. Install real BASS audio library as `bass_real.dll` (from game installer, NOT a mod)
3. Copy the application `bass.dll` from release zip
4. Create `Mods/` folder with test mod DLL
5. Set `ShowConsole=1` in `ModConfig.ini`
6. Run: `DISPLAY=:99 WINEDEBUG=-all timeout 15 wine target_binary.exe`
7. Check `ModConfig.ini` for toggle buttons in `[Toggle Buttons]` section

**CRITICAL**: `bass_real.dll` must be the REAL BASS audio library (PE32 GUI,
4 sections, imports WINMM/MSACM32), NOT another mod DLL. If bass_real.dll
is a mod, the application forwards BASS calls to the mod instead of the audio library.

### Gravity Modding

See `references/ball-gravity-offsets-and-debugging.md` for:
- Verified gravity offsets (ball+0x278, ball+0x2A4, phys+0xC8C/C90/C94, phys+0x1C0)
- Ball_SetTiltedGravity / Ball_SetFlatGravity decompiled behavior
- Working reference: plus_low_gravity mod pattern
- Debugging approach: strip to minimal test, confirm, then add config
- Config file location: DLL's own folder via VirtualQuery
- the application toggle state: check GetButtonState every frame (not cached)

### Pitfalls

- **Renaming a mod: update ALL string literals, not just filenames.** When renaming a mod (e.g. `plus_local_gravity` → `mkn_plus_local_gravity`), the config filename is embedded as string literals in BOTH the VS source (`LocalGravity.cpp`) AND the MinGW source (`LocalGravity_MinGW.cpp`), plus `build.sh`, `README.md`, and `.vcxproj` files. Missing any one means the mod silently fails to find its config file at runtime. Use `grep -rnP '(?<!mkn_)plus_local_gravity'` (negative lookbehind) to verify no old-name remnants remain — a plain grep for the old name will false-positive on the new name (since `mkn_plus_local_gravity` contains `plus_local_gravity` as a substring).
- **the application v2.0/v2.1 vtable MUST be 17 entries** (not 16). See `references/hbplus-v2-vtable-layout.md` for the complete slot map and migration guide. v2.1 has the same 17-entry layout as v2.0.
- **`-fno-rtti` required**: Without it, MinGW adds RTTI data that changes object layout
- **`-fno-exceptions` required**: Exception handling tables add .eh_frame section
- **Static_asserts in v2.1 header fail under MinGW**: `target applicationAPI.h` has
  `static_assert(offsetof(...))` checks that MinGW's `<cstddef>` may fail due to
  `#pragma pack` differences. Disable with
  `sed -i 's/static_assert(/\/\/ static_assert(/g' target applicationAPI.h` on the
  LOCAL copy only — do not commit this change to the repo.
- **`--exclude-symbols` required**: Without it, global `strcmp`/`strlen`/etc override the game's msvcrt versions → crash
- **`-mwindows` required**: Console subsystem DLLs crash the game's loading screen
- **`-nostdlib -nostartfiles` required**: MinGW's CRT initialization corrupts the game's heap during font loading
- **`sqrtf` and other libm functions unavailable with `-nostdlib`**: Linking `-lm` doesn't work with `-nostdlib`. Replace `sqrtf` with inline SSE2 asm: `static inline float portal_sqrtf(float x) { float r; __asm__ __volatile__("sqrtss %1, %0" : "=x"(r) : "x"(x)); return r; }`. Other common math replacements: `fabsf` → `x < 0 ? -x : x`, `fminf`/`fmaxf` → ternary. Don't name your replacement `sqrtf` (conflicts with MinGW builtin) — use a custom prefix like `portal_sqrtf` or `nc_sqrtf`.
- **Operator new/delete**: Must be non-inline in nocrt.cpp (inline versions get stripped by `--gc-sections`)
- **snprintf**: Use `wvsprintfA` from user32.dll (no `%f` support — cast to int for FPS display)
- **`sizeof` on incomplete-type static arrays**: `static const T s_patches[] = {...};` declared in-class and defined out-of-line causes `sizeof(s_patches)` to fail with "incomplete type" under MinGW. Fix: declare a `static constexpr int NUM_PATCHES = N;` constant alongside the array and use that for the loop bound instead of `sizeof(s_patches)/sizeof(s_patches[0])`. This pattern is needed when the array size is known at authoring time but the definition is separated from the declaration (common in header+impl splits).
- **DrawCustomText vtable index [40] is UNVERIFIED**: Calling `DrawCustomText` via `hbplus_vtable(api, 40)` crashes during `Meshes\Sphere+Tar` loading. Do NOT use `DrawCustomText` from MinGW-compiled mods until the correct vtable index is verified. The `onTextRenderLoop` callback should be a no-op or only do non-API work.
- **Game-state access from `text_render` crashes during race loading**: Even with direct memory reads (not IModAPI vtable calls), accessing board/ball pointers from `text_render` during race loading crashes because board/ball pointers are reallocated during the loading screen. The `g_gameReady` flag (120 frames) is NOT sufficient — it only checks frame count, not whether a race is actually active. Need proper "in-race" detection (e.g. checking if `getP1Ball()` returns a valid ball with correct vtable) before accessing game state.
- **Python relay `thread.join()` returns `None`**: `if not thread.join(timeout=60)` is always `True` — the relay thinks it timed out even after connecting. Use `threading.Event` instead: `event.wait(timeout=60)`.
- **Config file loading — use GetModuleFileNameA, NOT relative path**: `CreateFileA("netplay.txt")` opens relative to the process CWD, which on Windows may NOT be the game directory. Use `GetModuleFileNameA(NULL, path, MAX_PATH)` to find the game exe directory, strip the filename, append the config filename. Also skip UTF-8 BOM (0xEF 0xBB 0xBF) and leading whitespace when parsing. Parse first line for IP, optional `:port` suffix (e.g. `100.71.119.98:5029`). Set slider defaults from the loaded values so the user doesn't have to manually set IP each time.
- **Matchmaking UI — use a single slider, not two toggle buttons**: Two separate HOST/GUEST toggle buttons are not mutually exclusive — the user can enable both at once. Use a single `NETPLAY_MODE` slider (0=Off, 1=Host, 2=Guest) instead. The the application API has `GetButtonState(id)` but no `SetButtonState(id)`, so you can't programmatically toggle off the other button. A slider is inherently single-valued and solves this elegantly.
