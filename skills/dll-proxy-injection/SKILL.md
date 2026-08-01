---
name: dll-proxy-injection
title: DLL Proxy Injection Mods
description: Build, package, and troubleshoot DLL proxy mods that replace a target DLL with a forwarding wrapper to intercept API calls and run custom code.
tags: [reverse-engineering, dll-proxy, injection, mingw, modding]
---

# DLL Proxy Injection Mods

> Adapted from the target-specific RE toolkit for general binary analysis.

This skill covers building DLL proxy mods that replace a target DLL with a forwarding wrapper. The proxy intercepts API calls, runs custom per-frame logic via hooks, and forwards everything else to the real library (renamed to `<original>_real.dll` or similar).

## When to use this skill

Use this for mods that:
- Must run without a mod loader (e.g. standalone installs, emulators).
- Need to hook low-level game functions, audio APIs, or renderer Present calls.
- Follow the DLL proxy convention where the mod DLL takes the exact name of the original target DLL.

## Build environment

- Cross-compiler: `i686-w64-mingw32-gcc` (or `x86_64-w64-mingw32-gcc` for 64-bit targets).
- `Makefile` target produces the proxy DLL.
- The `.def` export definition file MUST be a positional argument to `gcc` (not `-Wl,--def=`), and it must list the real target DLL as the forwarding target.
- Typical flags: `-O2 -Wall -m32 -static -static-libgcc -shared -lwinmm -lshlwapi -Wl,--enable-stdcall-fixup -Wl,--add-stdcall-alias`.

## Output filename rule

The compiled DLL must be named **exactly** like the original target DLL inside the final zip.

- Do NOT ship a second file with a different name.
- The mod's source folder can have any name; the DLL delivered to the user must match the target DLL's name.

## Packaging rule

Each zip must contain only:
1. The proxy DLL (named like the original target DLL).
2. `README.md`
3. Optional config `.txt` / `.jsonc` if the mod uses one.
4. The renamed original DLL (e.g. `target_real.dll`) so the proxy can forward to it.

Strip any legacy/duplicate DLLs before zipping.

## Lazy-loading forwarder pattern (recommended)

Calling `LoadLibraryA` inside `DllMain` deadlocks on real Windows due to the loader lock. Use lazy loading on first API call instead:

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

## Common hook bugs

### Naked `__thiscall` hooks and stack layout

For `__thiscall` functions with no stack arguments, the original `ECX` is the only parameter. A naked hook that pushes registers must pass `ECX` directly, not read it from the stack.

Bad:
```c
"pushl %%eax\n"
"pushl %%ecx\n"
"pushl %%edx\n"
"movl 16(%%esp), %%eax\n"  // wrong — after 3 pushes, 16(esp) is return address
"pushl %%eax\n"
"call _hook_impl\n"
```

Good:
```c
"pushl %%eax\n"
"pushl %%ecx\n"
"pushl %%edx\n"
"pushl %%ecx\n"            // original ECX (this pointer) still valid
"call _hook_impl\n"
"addl $4, %%esp\n"
"ret\n"
```

For `__thiscall` with one stack argument, after saving `eax/ecx/edx`:
- `[esp+16]` is the stack argument
- `ECX` (original) is `this`

### Hook cleanup in `DLL_PROCESS_DETACH`

Every installed hook must have a matching restore function, and every restore function must be called from `DLL_PROCESS_DETACH`. Missing restores leave JMPs pointing at freed stubs when the DLL unloads.

Required restores:
- JMP detour hooks → restore original bytes.
- Code-cave hooks → restore original bytes at patch address.
- Frame hooks → restore the patched epilogue bytes.

### Memory protection

Always use `PAGE_EXECUTE_READWRITE` when patching executable code. `PAGE_READWRITE` can fail or leave the page non-executable.

## Crash testing

Before shipping:
1. Build the proxy DLL.
2. Copy it into a test directory alongside `target_real.dll`.
3. Run `timeout 45s wine target_binary.exe` (or on Windows directly).
4. Verify exit code 0 and no crash in output.

This catches most hook-address and init crashes without needing the full target environment.

## Versioning

Keep a numeric version fixed and only advance a letter suffix (`v1a` → `v1b`) unless the user explicitly says to bump the number. Embed the version string in the DLL binary and verify it with `strings proxy.dll | grep "Mod Version"`.

## See Also

- `dll-mod-authoring` — broader DLL modding reference with build workflows
- `headless-mod-testing` — automated crash testing via headless servers
- `multi-phase-patch-architecture` — organizing multiple hooks into init/runtime/cleanup phases
