# DLL Proxy Forwarding Patterns — v1/v2/v3 Tradeoffs

> Adapted from the target-specific RE toolkit for general binary analysis.

## Pitfall: Stub Return Values Cause False Negatives (CRITICAL)

Headless tests on Wine/Xvfb may report "OK" for a proxy that uses stub returns (e.g. `Init` returns `TRUE`, `Load` returns `NULL`) even though the same DLL crashes on real Windows.

**Why:** Wine handles NULL gracefully for some APIs. Real Windows dereferences broken pointer chains and crashes.

**Detection:** If the mod source has `return TRUE;` for init and `return NULL;` for load (no `GetProcAddress` forwarding), the Wine test gives a false negative.

**Fix:** Always use the v3 lazy-loading pattern (below). Init must return `FALSE` if `target_real.dll` is missing (honest failure → no crash).

## The Problem

The target binary imports a fixed set of functions from a target DLL at startup (verified via PE import table parsing). To inject mod code, we replace the target DLL with a proxy that forwards calls to the original (renamed `target_real.dll`) while also installing hooks.

## v1: LoadLibraryA in DllMain (BROKEN)
- `init_proxy()` called from `DllMain` → `LoadLibraryA("target_real.dll")`
- **Emulators**: may work fine (lenient loader lock)
- **Real Windows**: `LoadLibraryA` inside `DllMain` deadlocks due to the Windows loader lock.

## v2: .def File Forwarders (BROKEN when target_real.dll missing)
- `.def` file: `TargetFunc = target_real.TargetFunc`
- OS loader resolves forwarders at load time — no C proxy code needed.
- **Works**: IF `target_real.dll` exists in the target directory.
- **Crashes**: if `target_real.dll` is missing — loader cannot resolve forwarded exports → target exits before `DllMain` even runs. No graceful fallback.

## v3: Lazy C Proxy with Stub Fallback (CORRECT)
- C wrappers call `LoadLibraryA("target_real.dll")` on **first target call** (NOT in DllMain — loader lock safe).
- `g_tried_load` flag prevents repeated `LoadLibraryA` calls.
- If `target_real.dll` exists: all functions forwarded correctly.
- If `target_real.dll` is **missing**: stubs return safe defaults (feature disabled, but target doesn't crash).
- **Works on**: Emulators, real Windows, with or without `target_real.dll`.

## Macro Pattern for v3

```c
static HMODULE g_hRealTarget = NULL;
static int g_tried_load = 0;

static void load_real_target(void) {
    if (g_tried_load) return;
    g_tried_load = 1;
    char path[MAX_PATH];
    GetModuleFileNameA(NULL, path, MAX_PATH);
    char* slash = strrchr(path, '\\');
    if (slash) strcpy(slash + 1, "target_real.dll");
    else strcpy(path, "target_real.dll");
    g_hRealTarget = LoadLibraryA(path);
}

#define DEFINE_FORWARDED(name, ret_type, params, args, stub_ret) \
    typedef ret_type (__stdcall *name##_t) params; \
    static name##_t real_##name = NULL; \
    __declspec(dllexport) ret_type __stdcall name params { \
        if (!g_tried_load) load_real_target(); \
        if (g_hRealTarget && !real_##name) \
            real_##name = (name##_t)GetProcAddress(g_hRealTarget, #name); \
        if (real_##name) return real_##name args; \
        return stub_ret; \
    }
```

## Compile Command (v3 — no .def file needed)
```bash
i686-w64-mingw32-gcc -shared -o target.dll mod.c -lwinmm \
  -Wl,--enable-stdcall-fixup -O2 -static -static-libgcc \
  -Wl,--add-stdcall-alias
```
