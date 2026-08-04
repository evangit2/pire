---
name: headless-mod-testing
description: Headless test server pattern for automated binary mod testing — screenshot verification and CI/CD integration.
---

# Headless Mod Testing

> Adapted from the target-specific RE toolkit for general binary analysis.


# hbtestd DLL Mod Testing

## When to use
After compiling ANY the target DLL mod (target.dll, d3d8.dll, dsound.dll, dinput8.dll proxy), run `test_dll_mod` BEFORE sending the DLL to the user. This catches crash-on-startup issues without needing a vision model or manual screenshot inspection.

## MCP Tools (hbtestd on port 8777)
- `test_dll_mod(mod_dll_path, target_dll="target.dll", timeout=8.0)` — Main test tool
- `restore_dlls()` — Restore all original DLLs from backups
- `list_dll_backups()` — List all DLL backups created by testing

## Test Results
- **OK**: Game survived the timeout period. DLL is safe to ship.
- **CRASH**: Game exited early. `exit_code` and `runtime_seconds` show when/how it crashed.
  - exit_code=5: DLL load failure (DllMain returned FALSE)
  - exit_code=1: DLL function called ExitProcess
  - Other codes: Wine exception handling

## Performance
- Good DLL: ~9 seconds (6s timeout + 3s startup/restore)
- Bad DLL: ~4 seconds (crash detected within 1-2s, plus restore)
- Originals always restored, even on crash

## File Backup
- Original DLLs backed up with `.hbtestd_orig` suffix
- `bass_real.dll` also backed up if present (for bass proxy mods)
- Backups persist across tests (only created if they don't exist)
- `restore_dlls()` restores all backups at once

## Architecture
- `dlltester.py`: DllTester class — backup, swap, launch, detect, restore
- `server.py`: MCP tool wrappers (test_dll_mod, restore_dlls, list_dll_backups)
- Systemd service: `hbtestd.service` (auto-starts, restart-on-failure)
- Config: hbtestd registered in `~/.hermes/config.yaml` under `mcp_servers`

## Pitfall: Xvfb must be running
The game exits immediately with code 0 if no X display is available. This causes false crash detections. The `test_dll_mod` tool auto-starts Xvfb if it's not running, but if you're testing manually, ensure `Xvfb :99` is running first.

## Pitfall: restart_game overwrites custom target.dll (CRITICAL)
`mcp_hbtestd_restart_game` (and `start_game` with `fps_mod=True`) installs the FPS mod's `target.dll` (226KB) into the game directory, silently **overwriting** any custom modded `target.dll` (e.g. pinball mode, 89KB) you placed there. The mod will appear to "not work" with no error.

**Fix**: After calling `restart_game`, re-copy your custom mod `target.dll` into the game directory BEFORE the game finishes loading:
```
cp ~/the target-re/mods/<mod_name>/target.dll ~/the target-wasm/boxedwine-package/the target/target.dll
```
Alternatively, launch the game manually via `terminal(background=true)` instead of using `restart_game`:
```
cd ~/the target-wasm/boxedwine-package/the target
DISPLAY=:99 LIBGL_ALWAYS_SOFTWARE=1 wine target_binary.exe 2>/dev/null &
```
Also remove `the target_fps.ini` if present — it's the FPS mod marker that `restart_game` creates.

## Pitfall: start_game(fps_mod=False) does NOT overwrite target.dll
Unlike `restart_game`, `start_game(fps_mod=False)` (the default) does NOT install
the FPS mod. The `fps_mod_enabled` flag in `config.py` defaults to `"0"`, so
`start_game` only installs the FPS mod DLL when `fps_mod=True` is explicitly passed.

**However**, `load_level` calls `start_game` internally if the game isn't running.
If you've already placed your mod DLL in the game directory, `load_level` will
preserve it (as long as `fps_mod_enabled` is not stuck from a previous call — see
the `fps_mod_enabled` persistence pitfall above).

**To verify your mod DLL is in place after start_game:**
```bash
md5sum ~/the target-wasm/boxedwine-package/the target/target.dll ~/the target-re/mods/<mod_name>/target.dll
```
If the MD5s don't match, your mod was overwritten.

## Pitfall: restart_game(fps_mod=True) persists fps_mod_enabled flag (CRITICAL)

Calling `mcp_hbtestd_restart_game(fps_mod=True)` sets `cfg.fps_mod_enabled = True` in
the hbtestd Python process. This flag **persists** across ALL subsequent calls — every
later `start_game()` or `load_level()` will try to install the FPS mod, failing with:

```
"fps mod install failed: bass_real.dll already exists; mod may already be installed"
```

**Fix**: Kill and restart the hbtestd process to reset the flag:
```bash
kill -9 $(pgrep -f hbtestd.server)
cd ~/the target-re/tools/hbtestd && .venv/bin/python -m hbtestd.server &
```

**WARNING**: After restarting hbtestd, the MCP client connection breaks
(`ClosedResourceError: ClosedResourceError()`). The Hermes session cannot reconnect
to the new hbtestd process without a session restart. If you need hbtestd after
restarting it, use one of these fallback approaches:

**Option A — Direct Python API (preferred, no MCP needed):**
```python
from hbtestd.dlltester import DllTester
from hbtestd.config import Config
cfg = Config()
dt = DllTester(cfg)
result = dt.test_dll('/path/to/target.dll', 'target.dll', 8.0)
print(f'ok={result.ok}, crash={result.crash}, runtime={result.runtime_seconds:.1f}s')
```
This calls the DllTester directly — same logic as `test_dll_mod` but without
the MCP transport layer. Works even when the MCP client bridge is broken.
**Key differences from MCP API:** method is `test_dll()` (not `test_dll_mod`),
call is synchronous (not async), returns `TestResult` with `.ok`/`.crash`/
`.runtime_seconds`/`.restored` (no `.verdict`/`.exit_code`/`.detail`).

**Option B — Terminal-based wine launch (manual crash test):**
```bash
cd ~/the target-wasm/boxedwine-package/the target
DISPLAY=:99 LIBGL_ALWAYS_SOFTWARE=1 wine target_binary.exe 2>/dev/null &
sleep 35
ps aux | grep -v grep | grep target_binary.exe && echo "ALIVE" || echo "CRASHED"
```

**Restarting the hbtestd server itself:**
Do NOT use `nohup ... &` in a foreground terminal call — Hermes blocks
shell-level background wrappers. Use `terminal(background=true)` instead:
```
terminal(command="cd ~/the target-re/tools/hbtestd && source .venv/bin/activate && python -m hbtestd.server", background=true)
```
Then verify with `curl -s http://127.0.0.1:8777/` (returns "Not Found" for
bare path, which means the server is up — only specific MCP endpoints respond).

## Pitfall: mod DLL with stdio file I/O breaks keyboard input on Wine (CRITICAL)

A target.dll proxy that includes `<stdio.h>` and uses `fopen_s`/`fprintf` for logging
(e.g. writing `ref_loader_log.txt` to the game directory) will cause the game to
become **completely unresponsive to all X11 input** — xdotool, xte, mouse clicks,
nothing registers. The game process stays alive but never advances past the title
screen. The DLL loads fine (hook installs, log file is created), but no keyboard
or mouse events reach the game.

**Root cause:** Including `<stdio.h>` in a MinGW-compiled target.dll proxy pulls in
the C runtime's file I/O layer, which interferes with Wine's input event dispatch
when the DLL is loaded during `DllMain`. The game uses DirectInput8, and the CRT
initialization somehow blocks the XInput2 → DirectInput8 bridge.

**Fix:** Use `OutputDebugStringA` (from `windows.h`, no extra includes) instead of
`fopen_s`/`fprintf` for DLL logging. This does NOT interfere with input:

```c
static void log_ref(const char* refName, const char* result, const char* factory)
{
    char buf[256];
    lstrcpyA(buf, "REFLOAD\t");
    lstrcatA(buf, refName);
    lstrcatA(buf, "\t");
    lstrcatA(buf, result);
    lstrcatA(buf, "\t");
    lstrcatA(buf, factory ? factory : "(null)");
    lstrcatA(buf, "\r\n");
    OutputDebugStringA(buf);
}
```

OutputDebugString messages are captured by Wine and can be read via `WINEDEBUG`
(not `WINEDEBUG=-all` which hbtestd sets by default). They do NOT appear in the
hbtestd log file unless WINEDEBUG is configured to capture them.

**Do NOT add `#include <stdio.h>` to a target.dll proxy.** The DLL size jump from
~94KB to ~229KB is a visible indicator that stdio was linked in.

**Alternative for logging without stdio:** Use `OutputDebugStringA` (from
`windows.h`, no extra includes). However, OutputDebugString messages are
only visible if Wine is run WITHOUT `WINEDEBUG=-all` (hbtestd sets `-all`
by default). For debugging, launch Wine manually with
`WINEDEBUG=+relay wine target_binary.exe 2>&1 | grep REFLOAD` instead of
using hbtestd's `start_game`.

**⚠ ALL file I/O in target.dll breaks llvmpipe rendering (CRITICAL — updated June 2026):**

Both CRT stdio (`fopen_s`/`fprintf`) AND Win32 API (`CreateFileA`/`WriteFile`)
break rendering on Wine/llvmpipe when called from inside the hook function.
The game process stays alive but the screen goes completely black (screenshot
= ~1.5KB), making navigation via `load_level` impossible. The hook fires
correctly (verified by reading `/proc/PID/mem` at 0x0040C4BA) but the game
can't navigate to a race because it can't see the menu.

**Root cause:** Any file I/O during DllMain or the hook function disrupts
Wine's D3D rendering pipeline on llvmpipe. This is NOT a CRT-specific issue
— it affects Win32 API calls too.

**Safe logging options (in order of preference):**
1. **No logging at all** — rely on crash-testing + user's real-Windows testing.
2. **OutputDebugStringA** — does NOT interfere with rendering/input, but
   messages are only visible with `WINEDEBUG` (hbtestd sets `-all` by default).
3. **In-memory flag** — write a known value to a fixed address in the game's
   .data section, then read it back via `/proc/PID/mem` to verify the hook
   fired. Example: `*(volatile int*)0x4FD8B0 = 0xDEAD;`

**NEVER use `CreateFileA`, `WriteFile`, `fopen_s`, or `fprintf` in a
target.dll proxy hook.** The DLL size jump from ~94KB to ~98KB+ (even without
stdio) is an indicator that Win32 file I/O was linked in.

## Pitfall: load_level works with original target.dll, NOT with mod DLLs that break input

`load_level` sends key presses via `xdotool` to navigate the game menu to a race.
With the ORIGINAL target.dll, `load_level` works correctly on Wine/llvmpipe — the
game navigates menus and enters races despite rendering black (screenshots show
the race once loaded — the Intermediate Race screenshot was 91KB, not black).

With a MOD target.dll that includes stdio (see pitfall above), `load_level` fails
silently: keys don't register, screenshot stays ~1.5KB black, game never advances.

**Verification:** To test if `load_level` is working, check the screenshot size:
- ~1.5KB = game stuck at title/menu (input not registering)
- >10KB = game entered a race (navigation succeeded)

**To test a mod DLL with load_level:** Remove all `fopen_s`/`fprintf` logging
from the DLL source, rebuild, then use `load_level`. The mod DLL without stdio
(94KB) still causes black screen on llvmpipe but does NOT break input — the game
process survives race loading, which is sufficient for crash testing.

## load_level tool
`load_level(level_name="Beginner", wait_title=18.0, key_delay=3.0)` — starts the game and navigates to a Time Trial race automatically. Verified key sequence (confirmed via vision model step-by-step):
1. Enter — title → main menu (LET'S PLAY highlighted)
2. Enter — LET'S PLAY → CHOOSE A GAME (TOURNAMENT highlighted)
3. Down — TOURNAMENT → TIME TRIALS
4. Enter — TIME TRIALS → race selection (Warm-Up Race highlighted)
5. Down × N — navigate to target race (0=Warm-Up, 1=Beginner, 2=Intermediate, ...)
6. Enter — Start race

Uses direct xdotool subprocess calls (NOT `inputs.send_key()` which uses `--window` flag — unreliable on Wine). Returns screenshot of in-game race state.

**How to verify navigation worked:** Check the screenshot size from the returned
result:
- ~1.5KB = game stuck at title/menu (input not registering — see "mod DLL with
  stdio file I/O breaks keyboard input" pitfall above)
- >10KB = game entered a race (navigation succeeded)

With the original target.dll, `load_level` works correctly on Wine/llvmpipe — the
game navigates menus and enters races. Screenshots show actual game content
(e.g. "INTERMEDIATE RACE" banner, "GO!" countdown). With a mod DLL that includes
stdio, input breaks and `load_level` cannot reach a race.

## Common crash causes caught
1. **LoadLibraryA in DllMain (v1 pattern)**: Deadlocks on real Windows (loader lock). Wine is lenient so this passes Wine tests but crashes on real Windows at `RUNTIME: 00:00:01` during `App.Initialize(7)`. Fix: use lazy C proxy loading (v3 pattern) — see below.
2. **`.def` file forwarders without bass_real.dll (v2 pattern)**: If bass_real.dll doesn't exist on the user's system, the OS loader fails to resolve forwarded exports and the game crashes instantly (`RUNTIME: 00:00:00`). Fix: use lazy C proxy loading with stub fallback (v3 pattern).
3. **Wrong BASS param count**: `BASS_MusicLoad` takes 6 params (QWORD=8B), not 4. Wrong count = stack corruption = crash at `App.Initialize(7)`.
4. **Missing exports**: The game PE import table has exactly **10 BASS functions**
   (verified June 2026 by parsing the PE import table):
   `BASS_Stop, BASS_ChannelSetAttributes, BASS_Free, BASS_Init, BASS_Start,
   BASS_SetConfig, BASS_ChannelStop, BASS_MusicPlayEx, BASS_ErrorGetCode,
   BASS_MusicLoad`. The DLL should export all 10 PLUS extras for safety
   (BASS_ChannelPlay, BASS_SampleLoad, BASS_StreamCreateFile, etc. — 20 total).
   Wine aborts with `unimplemented function BASS.dll.BASS_Start` if any are missing.
   **Verify by parsing the PE import table** (not guessing): see
   `references/pe-import-table-verification.md` for the Python script.
   Note: `BASS_ChannelSetAttributes` (plural) is different from
   `BASS_ChannelSetAttribute` (singular) — export BOTH.
5. **bass_real.dll is a proxy itself**: If `bass_real.dll` is the FPS mod's target.dll
   (97336 bytes) instead of the true original (89710 bytes), the proxy chain corrupts.
   Always verify bass_real.dll is the genuine BASS audio library, not another mod.
6. **BASS stub returns lie to the game (CRITICAL — discovered June 2026)**: Stubs
   that return `TRUE` for `BASS_Init` but `NULL` for `BASS_MusicLoad` cause a
   crash on real Windows at `Initialize(25)`. The game stores a broken music
   pointer at `App+0x534` → `Audio_PlayMusicAtSpeed` dereferences it → crash at
   `0x46A443`. **Wine does NOT crash** (handles NULL audio gracefully) — this is
   a Wine false negative. Fix: use v3 lazy-loading forwarders. `BASS_Init` must
   return `FALSE` when `bass_real.dll` is missing (honest failure, no crash).

## BASS proxy patterns — what to use and what to avoid

### ❌ v1: LoadLibraryA in DllMain (BROKEN)
Calls `LoadLibraryA("bass_real.dll")` inside `DllMain`. Works on Wine, **deadlocks on real Windows** due to loader lock. Crash at `RUNTIME: 00:00:01`.

### ❌ v2: .def file forwarders (BROKEN when bass_real.dll missing)
Uses `.def` file: `BASS_Init = bass_real.BASS_Init`. OS loader resolves at load time. Works IF bass_real.dll exists. **Crashes instantly** (`RUNTIME: 00:00:00`) if bass_real.dll is missing — no graceful fallback.

### ✅ v3: Lazy C proxy with stub fallback (CORRECT)
C wrappers that call `LoadLibraryA("bass_real.dll")` on **first BASS call** (NOT in DllMain — avoids loader lock). If bass_real.dll exists, all calls forwarded. If missing, stubs return success (no audio, but no crash). Use a macro:
```c
#define DEFINE_BASS_FORWARDED(name, ret_type, params, args, stub_ret) \
    typedef ret_type (__stdcall *name##_t) params; \
    static name##_t real_##name = NULL; \
    __declspec(dllexport) ret_type __stdcall name params { \
        if (!g_bass_tried_load) load_real_bass(); \
        if (g_hRealBass && !real_##name) \
            real_##name = (name##_t)GetProcAddress(g_hRealBass, #name); \
        if (real_##name) return real_##name args; \
        return stub_ret; \
    }
```
Compile WITHOUT .def file: `i686-w64-mingw32-gcc -shared -o target.dll mod.c -lwinmm -Wl,--enable-stdcall-fixup -O2 -static -static-libgcc -Wl,--add-stdcall-alias`

## Pitfall: BASS stub return values — Wine false negative (CRITICAL)

`test_dll_mod` reports "OK" for a BASS proxy with stub returns (BASS_Init
returns TRUE, BASS_MusicLoad returns NULL) because Wine handles NULL audio
gracefully. **Real Windows crashes** — the game dereferences the broken
music pointer during `Initialize(25)` at `Audio_PlayMusicAtSpeed` (crash
at `0x46A443`, `CRASH_ADDRESS: 0001:00069443`).

**Detection:** Check the mod source for `return TRUE` / `return NULL` BASS
stubs without `GetProcAddress` forwarding. If found, the Wine crash test
gives a false negative.

**Fix:** Use v3 lazy-loading forwarders (see
`the target-dll-modding/references/bass-proxy-v3-pattern.md`). `BASS_Init`
must return `FALSE` (not TRUE) when `bass_real.dll` is missing.

## Pitfall: test_dll_mod false negatives — game crash handler keeps process alive (CRITICAL)

`test_dll_mod` reports "OK" if the game **process** is still alive after the timeout.
But the target has its own crash handler that catches exceptions and shows a crash
dialog (the target Error Report). The **process stays alive** even after crashing.

This means a DLL that crashes the game at `RUNTIME: 00:00:02` (showing crash dialog)
will still be reported as "OK" by `test_dll_mod` because the process is still running
at the 8-20s timeout check.

**How to verify after test_dll_mod reports OK:**
1. Check `/tmp/hbtestd.log` for `wine: Call from ... to unimplemented function` lines
2. Take a screenshot: `DISPLAY=:99 scrot /tmp/check.png` — if it shows a crash dialog
   (not the title screen), the DLL is broken despite "OK" verdict
3. Screenshot size heuristic: ~1.5KB = black screen, ~8-10KB = crash dialog, >10KB = game content
4. The crash report shows `RUNTIME: 00:00:02` and `CURRENTOBJECT: App` for early crashes

**Example**: A BASS proxy missing the `BASS_Start` export passed `test_dll_mod` (OK, 24.56s)
but the game showed a crash dialog at 2 seconds. The process stayed alive showing the dialog,
fooling the timeout check.

## Pitfall: Wine doesn't catch real-Windows crashes from code cave hooks (CRITICAL)

Code cave hooks (JMP patches at game function epilogues, detours, etc.)
can pass Wine/Xvfb crash tests for 100+ seconds with full level
navigation, then crash on real Windows within 6 seconds during menu
interaction. This happens because Wine's execution path for menu
rendering differs from real Windows D3D8 — hooks that are safe during
Wine's menu path corrupt execution on real Windows.

**Concrete example (mkn_level_system v6.8, sess_XXX):**
- FrameUpdate epilogue hook at 0x0046C1F1 (5-byte JMP to code cave)
- Wine/Xvfb: 117s survival, full Warm-Up level navigation, no crash
- Real Windows: crash at 0x452BDA during MouseDown on Time Trial Menu, RUNTIME 00:00:06
- The crash happened BEFORE any level loaded — during menu click

**Detection:** This class of crash cannot be caught by `test_dll_mod`
or `load_level` on Wine. The only detection is real-Windows testing by
the user. If a mod uses code cave hooks (JMP patches at function
epilogues, not just vtable swaps), explicitly state: "Wine crash test
passed, but code cave hooks may behave differently on real Windows."

**Prevention:** Avoid code cave hooks on the target when possible.
Prefer vtable trampolines (ADD command) and dispatch thread (slot 36)
which don't patch game code. If a code cave hook is unavoidable, test
on real Windows before shipping.

**UPDATE (v6.9, sess_XXX): The ADD command trampoline ALSO crashes on
real Windows.** Use `VTABLE <level> <slot> <function>` (direct vtable
entry replacement) instead of ADD or code cave hooks. VTABLE writes a
function pointer to a custom vtable in VirtualAlloc'd memory — the
same safe mechanism used by all other VTABLE commands. No trampoline,
no code patching, no crash.

**Also add a board signature check in the dispatch thread** to prevent
calling Summon functions on non-board objects during menus:
```c
if (IsBadReadPtr((void*)(board + 0x878), 4)) { Sleep(16); continue; }
DWORD board_app = *(DWORD*)(board + 0x878);


... [OUTPUT TRUNCATED - 714 chars omitted out of 50,644 total] ...

K, 38.66s runtime, no crash

**Rule**: When `test_dll_mod` reports CRASH with `runtime < 3s` and `exit_code=0`, re-run the test once before treating it as a real crash. If the second run also crashes, then it's a real DLL issue. If the second run passes, it was a flaky Wine startup.

**Why this happens**: Wine's X display initialization races with the game's window creation. If Xvfb isn't fully ready when the game tries to create its D3D window, the game exits cleanly (code 0) without ever loading the DLL's hooks. This is a Wine/Xvfb timing issue, not a mod bug.

## User workflow rules
- **Use `tmpcli`** for file uploads/downloads, NOT curl/wget. User explicitly corrected this.
- **Rebuild the zip** after updating any DLL mod file. The zip in `mods/<name>/` must always contain the latest compiled DLL + source.
- **Test before shipping**: always run `test_dll_mod` after compiling, before uploading to the user.
- **Retest on flaky crash**: if the first test crashes in <3s with exit_code=0, run it again before concluding the DLL is broken.
- **NEVER use hbtestd's start_game/navigate_to_race/load_level for non-FPS mod testing** (CRITICAL — user corrected sess_XXX). hbtestd is specifically built for the FPS mod. Its `start_game` installs the FPS mod's `target.dll`, overwriting any custom mod DLL. Its `navigate_to_race` and `load_level` tools use the FPS mod's game directory, not your mod's directory. When testing a non-FPS mod, launch the game manually via `terminal(background=true)` on `DISPLAY=:99` instead. The ONLY hbtestd tool safe for non-FPS mod testing is `test_dll_mod` (which backs up and restores originals).

## Pitfall: Xvfb lock files break everything after kill (CRITICAL)

When you kill Xvfb manually (via `pkill -9 Xvfb`), the lock files at
`/tmp/.X99-lock` and `/tmp/.X11-unix/X99` are NOT automatically removed.
The next Xvfb instance fails to start with:

```
Server is already active for display 99
If this server is no longer running, remove /tmp/.X99-lock
```

This causes a cascade of failures:
- hbtestd's `restart_game` starts its own Xvfb → fails silently
- Game launches but renders nothing (screenshot = 1.5KB black)
- `load_level` navigation fails (game can't render menus)
- Wine reports `nodrv_CreateWindow: Application tried to create a window, but no driver could be loaded`

**Fix:** After killing Xvfb, ALWAYS remove lock files:
```bash
pkill -9 -f Xvfb; sleep 2
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
```

**Best practice:** Let hbtestd manage Xvfb entirely. Don't start your own
Xvfb instance — it conflicts with hbtestd's. If you need to restart the
display, kill everything (including game + wineserver + Xvfb), remove lock
files, then call `restart_game` which starts a fresh Xvfb.

**Nuclear reset** (when rendering is completely broken):
```bash
# Use pgrep -x (exact match) — NOT pkill -f "wine" which kills your shell!
for pid in $(pgrep -x "target_binary.exe"); do kill -9 "$pid"; done
for pid in $(pgrep -x "wine-preloader" 2>/dev/null); do kill -9 "$pid"; done
for pid in $(pgrep -x "wine64-preloader" 2>/dev/null); do kill -9 "$pid"; done
for pid in $(pgrep -x "wineserver" 2>/dev/null); do kill -9 "$pid"; done
for pid in $(pgrep -x "Xvfb" 2>/dev/null); do kill -9 "$pid"; done
sleep 3
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
# Then call restart_game — hbtestd starts fresh Xvfb
```

## Reference: d3d8to9 proxy and DINPUT8 input on Wine/Xvfb

For the full investigation of d3d8to9 proxy DLL usage, WINEDLLOVERRIDES
configuration, and why DINPUT8 blocks all keyboard input on Wine/Xvfb
(including what was tried and why it worked before but not now), see
`references/d3d8to9-and-dinput8-on-wine.md`.

## Pitfall: Xvfb resolution matters

hbtestd starts Xvfb at **800x600x24** (configurable via `the appTESTD_RESOLUTION`).
The game renders correctly at this resolution. If you start your own Xvfb at
a different resolution (e.g. 1024x768), the game may not render correctly
even if everything else is fine.

**If the game renders black (all pixels zero):** First check if the game
directory has a `d3d8.dll` — deleting it is the #1 fix (see above). If that
doesn't help, check if D3D8 device creation is failing due to
`NtUserChangeDisplaySettings` returning -2 on Xvfb. See
`references/wine-d3d8-display-mode-fixes.md` for the full investigation
of display mode fixes (10 approaches tried — #0 deleting d3d8.dll is the
one that works on some VMs).

## Pitfall: Manual game launch must use DISPLAY=:99 (CRITICAL)

When launching the game manually via `terminal(background=true)`, you MUST
use `DISPLAY=:99` (where Xvfb is running). Using `DISPLAY=:1` or any other
display produces a completely black screenshot (~1.5KB) because no X server
is running there.

**Correct manual launch:**
```bash
cd ~/the target-wasm/boxedwine-package/the target
DISPLAY=:99 LIBGL_ALWAYS_SOFTWARE=1 WINEDEBUG=-all wine target_binary.exe 2>/dev/null
```

**Verify Xvfb is running first:**
```bash
ps aux | grep Xvfb | grep -v grep
# Should show: Xvfb :99 -screen 0 800x600x24
```

If Xvfb is NOT running, start it:
```bash
Xvfb :99 -screen 0 800x600x24 +extension RANDR -noreset -nolisten tcp &
```

## Pitfall: Try simple approaches FIRST — don't over-engineer Wine fixes

When the game renders black or crashes on Wine, ALWAYS try the simplest fix
before escalating to complex approaches. Follow this checklist IN ORDER:

0. **Verify the mod isn't causing the crash** — Remove the mod DLL entirely
   and test with the vanilla game (original `target.dll`, no `bass_real.dll`,
   no `LevelFeatures.txt`). If the vanilla game ALSO crashes/renders black,
   the issue is the Wine environment, not your mod. (User correction sess_XXX:
   "Did you try opening the game without the level features mod enabled?")
1. **Delete the game's own d3d8.dll** — The game ships a hardware-only
   `d3d8.dll` (~112KB PE32) that Wine loads preferentially. This DLL cannot
   do software rendering and causes `D3DERR_NOTAVAILABLE` or black screen.
   Deleting it forces Wine to use its builtin D3D8 → wined3d → OpenGL →
   llvmpipe, which CAN render. **This is the #1 fix for black screens.**
   Cross-reference: `d3d8-cross-compile-wine` skill documents this was
   verified on some VMs (hidra) but may crash on others (vm3).
   ```bash
   rm -f $GAME_DIR/d3d8.dll
   ```
2. **Windowed mode** — Patch the game binary (offset 0x1B405: 0x00→0x01,
   NOP `dec [edi+0x1C]` at 0x1B3EB). May or may not help depending on
   Wine version — Wine 9.0 still calls NtUserChangeDisplaySettings even
   with Windowed=TRUE.
3. **Fresh Wine prefix** — `rm -rf ~/.wine && wineboot --init`
4. **Different Xvfb resolution/depth** — try matching the game's requested mode
5. **wined3d.dll binary patch** — last resort, device creates but game may crash

**User correction (sess_XXX):** When asked for a screenshot, I spent enormous
effort on user32 proxy, wined3d patching, DXVK, and binary patching before
trying windowed mode. The user said: "Why don't you simply run the game in
windowed mode instead of fullscreen?" — always try the obvious simple fix first.

**User correction (sess_XXX):** I spent hours on 8+ approaches (user32 proxy,
wined3d patching, DXVK, virtual desktop, multiple Wine prefixes) and declared
the environment broken — but NEVER tried deleting the game's d3d8.dll, which
is documented in the `d3d8-cross-compile-wine` skill as the working fix.
The user said: "The game *can* run. You've been able to send us screenshots
before. Keep trying." — **Do not declare the environment broken until you have
tried deleting the game's d3d8.dll AND checked the `d3d8-cross-compile-wine`
skill for rendering fixes.**

**User correction (sess_XXX):** When the game renders black and keyboard
input doesn't work, ALWAYS search session history for previous working
configurations before giving up. The `load_level` tool was built specifically
to navigate the game menu — it was found via `session_search("navigate
the target menu load_level")`. The user said: "You can't even navigate?
Try to figure out how to navigate. You used to be able to do that." —
**Use `session_search` to find previous working approaches before declaring
something impossible.** The tool or technique you need probably already exists.

**User correction (sess_XXX):** When asked to test whether a mod crashes
the game, ALWAYS test with the vanilla game (no mod) FIRST to establish a
baseline. The user asked: "Did you try opening the game without the level
features mod enabled? Maybe the mod is making it crash." — isolate mod vs
environment issues before debugging the mod.

**User correction (sess_XXX):** When the user asks "Can you revert to the
older version?", use `git log --oneline -- <file>` to find the commit that
last worked, then `git checkout <commit> -- <file>` to restore it. Do NOT
manually re-type the code. After reverting, test immediately — if it still
doesn't work, the problem is NOT the code version but the environment
(Wine/Mesa/llvmpipe). Do NOT toggle the setting back and forth multiple
times — reverting gamemgr.py's `WINEDLLOVERRIDES` was tried and did NOT
fix rendering or input. See `references/d3d8to9-and-dinput8-on-wine.md`
for the full version history.

## The game CAN render on Wine/llvmpipe — BUT depends on D3D8 device creation (CONDITIONAL)

**When it works:** The game renders full 3D content — title screen, menus, and in-game
races all produce visible screenshots (>10KB, pixel mean 50-200+) — IF the D3D8 device
creation succeeds.

**When it DOESN'T work (CRITICAL — discovered sess_XXX, July 2026):** Wine's d3d8
`swapchain_init` calls `NtUserChangeDisplaySettings` to set the display mode. On Xvfb
(headless X server), this fails with `DISP_CHANGE_BADMODE` (-2) because Xvfb doesn't
support display mode changes. The D3D8 device creation fails with `D3DERR_NOTAVAILABLE`
(0x8876086a), and the game shows a crash dialog or renders black forever.

**This is NOT a fixed property of the environment.** It depends on:
- Wine version (different versions handle the fallback differently)
- Mesa/llvmpipe version (GPU driver updates can change behavior)
- Xvfb configuration (resolution, depth, RANDR support)
- Whether the game is in fullscreen vs windowed mode

**If the game renders black (0 non-black pixels in screenshot):**
0. **Remove the mod** — test with vanilla game first to isolate mod vs environment
1. **Delete game's d3d8.dll** — the game ships a hardware-only d3d8.dll that
   Wine loads preferentially, causing D3DERR_NOTAVAILABLE on llvmpipe. Deleting
   it forces Wine to use its builtin D3D8 which CAN do software rendering.
   This is the #1 fix. See `d3d8-cross-compile-wine` skill for details.
2. Check Wine log for `NtUserChangeDisplaySettings ... returned -2` or
   `Failed to create wined3d swapchain, hr 0x8876086a`
3. If present, the D3D8 device creation is failing — see
   `references/wine-d3d8-display-mode-fixes.md` for all attempted fixes.
   **Do NOT declare the environment broken until you have tried deleting
   the game's d3d8.dll AND checked the `d3d8-cross-compile-wine` skill.**

**Taking screenshots of game content (when D3D8 device creation succeeds):**
```bash
DISPLAY=:99 scrot /tmp/hb_screenshot.png
python3 -c "
from PIL import Image
import numpy as np
img = Image.open('/tmp/hb_screenshot.png')
arr = np.array(img)
print(f'Mean: {arr.mean():.1f}')
print('HAS CONTENT' if arr.max() > 0 else 'ALL BLACK')
"
```

**Navigating menus with xdotool (when rendering works):**
```bash
WID=$(DISPLAY=:99 xdotool search --name "the target" 2>/dev/null | head -1)
DISPLAY=:99 xdotool key --window $WID --delay 200 space
DISPLAY=:99 xdotool key --window $WID --delay 200 Return
DISPLAY=:99 xdotool key --window $WID --delay 200 Down
```

**Screenshot size heuristic (updated):**
- ~1.5KB = black screen (wrong display OR D3D8 device creation failed)
- 8-10KB = crash dialog visible
- >10KB = game content visible (title, menu, or race)

## Pitfall: target.dll proxy conflict with FPS mod (CRITICAL)

Only ONE target.dll proxy can be active at a time. The LevelSpecials_Loader
mod and the hbtestd FPS mod are both target.dll proxies — they cannot coexist.

**When testing a target.dll proxy mod:**
1. Do NOT use `start_game(fps_mod=True)` — it installs the FPS mod's target.dll,
   overwriting your mod
2. Install your mod manually:
   ```bash
   cd ~/the target-wasm/boxedwine-package/the target
   cp target.dll bass_real.dll    # Save original as bass_real.dll
   cp ~/the target-re/mods/<mod>/target.dll target.dll  # Install mod
   ```
3. Launch manually via `terminal(background=true)` on `DISPLAY=:99`
4. Do NOT call `start_game` — it will try to install the FPS mod and fail
   with "bass_real.dll already exists"

**When done testing:**
```bash
# Restore original target.dll
cp bass_real.dll target.dll
rm -f bass_real.dll
```

## Pitfall: start_game(fps_mod=False) does NOT reset fps_mod_enabled (FIXED)

If the hbtestd server was started with `the appTESTD_FPS_MOD_ENABLED=1`, calling
`start_game(fps_mod=False)` does NOT override `cfg.fps_mod_enabled` back to
False. Every `start_game` call will try to install the FPS mod.

**Fix (applied to server.py July 2026):** `start_game` and `restart_game`
now set `cfg.fps_mod_enabled = False` when `fps_mod=False` is passed.

**WARNING:** Restarting the hbtestd server to pick up code changes breaks
the MCP client connection (`ClosedResourceError`). After restarting, use
direct terminal commands instead of MCP tools for hbtestd interaction.

## Pitfall: Zombie processes fool hbtestd's start_game (CRITICAL)

When a game process crashes but the parent (wine wrapper) doesn't reap it,
the process becomes a zombie (state `Z`, shown as `[target_binary.exe] <defunct>`).
hbtestd's `start_game` checks if the PID is alive via `kill -0 $PID` — which
returns true for zombies. hbtestd reports "game was already running; reused
existing process" and doesn't start a new game.

**Symptoms:**
- `start_game` returns the zombie PID instead of starting fresh
- `get_status` returns `"error": "PID still exists but it's a zombie"`
- `read_app_state` / `read_ball_state` fail with tracebacks (can't read zombie memory)
- `load_level` "succeeds" but screenshot stays 1491 bytes (black)

**Fix:** Kill the zombie AND its parent:
```bash
ZOMBIE=$(ps aux | grep target_binary.exe | grep defunct | awk '{print $2}')
PARENT=$(ps -o ppid= -p $ZOMBIE 2>/dev/null | tr -d ' ')
kill -9 $PARENT 2>/dev/null
kill -9 $ZOMBIE 2>/dev/null
sleep 2
# Also kill hbtestd and restart it
pkill -9 -f hbtestd.server
```

Then restart hbtestd and call `start_game` again. The new hbtestd instance
won't have the stale PID cached.

**Prevention:** Always fully kill the game's parent process when stopping
the game, not just the game itself. Use `stop_game` (which kills wineserver
too), not just `kill $GAME_PID`.

`pgrep -f "target_binary.exe"` returns ALL matching PIDs including zombie (defunct)
processes from previous test runs. Using `head -1` picks the zombie (lowest PID)
instead of the actual live process. This causes:
- `/proc/PID/mem` reads fail with "Permission denied" (zombie has no memory maps)
- Hook verification reports `READ_FAILED` when the hook IS actually installed
- All subsequent levels reuse the same zombie PID — test never actually restarts

**Fix:** Filter out zombies explicitly:
```bash
# WRONG — returns zombie PID 113920 every time:
PID=$(pgrep -f "target_binary.exe" | head -1)

# CORRECT — filters defunct processes:
PID=$(ps aux | grep -i "target_binary.exe" | grep -v grep | grep -v defunct | awk '{print $2}' | head -1)
```

Or better, use the process with the largest RSS (the actual game, not the wrapper):
```bash
PID=$(ps aux --sort=-rss | grep target_binary.exe | grep -v grep | head -1 | awk '{print $2}')
```

## Pitfall: pkill -f "wine" kills your own shell (CRITICAL)

`pkill -9 -f "wine"` matches any process with "wine" in its command line or path —
including the bash shell running the test script if the working directory contains
"wine" (e.g. `/home/evan/the target-wasm/boxedwine-package/...`). The shell
receives SIGKILL and the test aborts silently.

**Fix:** Use `pgrep -x` (exact process name match) and kill individual PIDs:
```bash
# WRONG — kills the test script itself:
pkill -9 -f wine

# CORRECT — kills only actual wine processes by exact name:
for pid in $(pgrep -x "wine-preloader" 2>/dev/null); do kill -9 "$pid"; done
for pid in $(pgrep -x "wine64-preloader" 2>/dev/null); do kill -9 "$pid"; done
for pid in $(pgrep -x "wineserver" 2>/dev/null); do kill -9 "$pid"; done
for pid in $(pgrep -x "target_binary.exe" 2>/dev/null); do kill -9 "$pid"; done
```

Also use `disown` after launching wine in the background to prevent shell signals
from propagating to the game process.

## Pitfall: xdotool needs --delay for the target menu navigation

Standard `xdotool key Return` often doesn't register in the target's menu under Wine. The game needs a slight delay between key events. Use `--delay 100` (or `--delay 200`) on ALL xdotool key commands:

```bash
# WRONG — key often doesn't register:
DISPLAY=:99 xdotool key Return

# CORRECT — registers reliably:
DISPLAY=:99 xdotool key --delay 100 Return
```

This affects ALL menu navigation: Enter (LET'S PLAY), Down (TIME TRIALS), Enter (select mode), Down/Enter (race selection). Without `--delay`, you'll see the game stuck on the title screen or wrong menu item despite "sending" the right keys.

## Pitfall: Clean test directory vs stale hbtestd game dir

The hbtestd game directory (`~/the target-wasm/boxedwine-package/the target/`) accumulates stale files from previous sessions: old target.dll mods, LevelData.txt, lfdebug.log, TOURNAMENT.SAV with wrong unlock state. These cause false crashes (e.g. `0x478EDD` on all levels).

**Fix:** Use a clean test directory at `/tmp/hb-clean-test/`:
```bash
CLEAN_DIR="/tmp/hb-clean-test"
rm -rf "$CLEAN_DIR" && mkdir -p "$CLEAN_DIR"
SRC=~/the target-re/originals/installed/extracted
cp "$SRC/target_binary.exe" "$CLEAN_DIR/"
# Copy game data dirs (Levels, Textures, Music, Sounds, etc.)
for d in Levels Textures Music Sounds Meshes Fonts Data Ghosts; do
    cp -r "$SRC/$d" "$CLEAN_DIR/" 2>/dev/null
done
# Install true original target.dll (bass_real.dll IS the original — 97KB, 4 PE sections)
cp "$SRC/bass_orig_backup.dll" "$CLEAN_DIR/bass_real.dll"
# Install modded target.dll
cp ~/the target-re/mods/<mod>/target.dll "$CLEAN_DIR/target.dll"
```

**CRITICAL: bass_real.dll must exist alongside your proxy target.dll.** Without it, all BASS function forwards fail and the game crashes at `RUNTIME: 00:00:02` in ntdll.dll. The true original target.dll is `bass_real.dll` (97KB, md5 `fd5ec122...`). Do NOT use `target.dll.hbtestd_orig` (439KB) — that's an older LevelFeatures_Loader mod, not the original.

## Pitfall: target.dll.hbtestd_orig is NOT the original target.dll

`target.dll.hbtestd_orig` (439KB, 18 PE sections) is a stale LevelFeatures_Loader mod from a previous session, NOT the original game target.dll. The true original is `bass_real.dll` (97KB, 4 PE sections, md5 `fd5ec122f4dd201b3c3ef19e3058af81`). Always verify by file size: ~97KB = original, ~439KB = old mod.

## Pitfall: Always restart the game between level swaps (CRITICAL)

When testing multiple DATA_FILE swaps (e.g. warm-up slot swap test), the game
MUST be fully killed and restarted between each level. If you only swap the
DATA_FILE file without restarting, the game keeps running with the old level
data in memory — the swap has no effect and every level reports "PASS" with
the same PID.

**Correct sequence for each level:**
1. Kill ALL processes (game + wine + wineserver + Xvfb)
2. Remove X lock files
3. Swap DATA_FILE file
4. Delete .cached files
5. Start fresh Xvfb
6. Launch game with `wine target_binary.exe`
7. Wait 20s for startup
8. Verify the hook via `/proc/PID/mem` (must be `E8`, not `FF`)
9. Wait 15 more seconds (35s crash test)
10. Kill everything for next iteration

See `scripts/warmup-slot-swap-test.sh` for the corrected script that handles
all these cases.

## Verifying hook installation via /proc/PID/mem (Linux only)

When the mod DLL causes a black screen (can't navigate to a race), you can
still verify the hook is installed by reading the game process memory:

```python
import struct
pid = <the target_pid>
with open(f"/proc/{pid}/mem", "rb") as f:
    f.seek(0x0040C4BA)
    data = f.read(6)
    if data[0] == 0xE8:  # CALL rel32
        print("HOOK INSTALLED ✅")
        rel32 = struct.unpack('<i', data[1:5])[0]
        target = 0x0040C4BA + 5 + rel32
        print(f"Hook target: 0x{target:08X}")
    elif data[0] == 0xFF:  # original CALL [EAX+0x84]
        print("Hook NOT installed ❌ (original bytes)")
```

This reads the 6 bytes at the hook site. Original = `FF 90 84 00 00 00`
(CALL [EAX+0x84]). Patched = `E8 XX XX XX XX 90` (CALL rel32 + NOP).

**Finding the correct PID:** `pgrep -f target_binary.exe` returns multiple
PIDs (the wine wrapper + the actual game process). Use the one with the
largest RSS (`ps aux --sort=-rss | grep the target`).

**Checking if the game entered a race** (without visual verification):
Read `App+0x10EC` (the `race_active` flag, set by `Scene_SetRaceActive`):
```python
with open(f"/proc/{pid}/mem", "rb") as f:
    f.seek(0x4FD680 + 0x10EC)  # App singleton at 0x4FD680
    race_active = struct.unpack('<I', f.read(4))[0]
    # 0 = not in race (title/menu), non-zero = in race
```

## Pitfall: hbtestd game directory depends on the appTESTD_GAME_DIR (CRITICAL)

hbtestd runs the game from whatever directory `the appTESTD_GAME_DIR` points to.
This is set in `hbtestd/config.py` and can be overridden via environment variable.

**Default (from config.py):** `~/the target-wasm/boxedwine-package/the target/`
**This session used:** `~/the target-re/originals/installed/extracted/` (set via
`the appTESTD_GAME_DIR` env var when starting hbtestd server)

**ALWAYS check which directory hbtestd is using before installing mods:**
```bash
# Check the hbtestd process environment
cat /proc/$(pgrep -f hbtestd.server)/environ | tr '\0' '\n' | grep the appTESTD_GAME_DIR
```

If `the appTESTD_GAME_DIR` is not set, it defaults to the config.py value.
**All DLL installations, level swaps, and cached file deletions must target
the hbtestd game directory**, not the originals directory. Installing a mod
DLL in the wrong directory means the hook never loads (verified by reading
`/proc/PID/mem` — original bytes `FF 90 84 00 00 00` instead of `E8`).

**When starting hbtestd manually**, always set `the appTESTD_GAME_DIR` explicitly:
```bash
the appTESTD_GAME_DIR=/home/evan/the target-re/originals/installed/extracted \
DISPLAY=:99 python -m hbtestd.server
```

**Always verify which DLL is in the hbtestd game directory:**
```bash
md5sum ~/the target-wasm/boxedwine-package/the target/target.dll
```

**bass_real.dll in the hbtestd directory may be a different file** (89710 bytes,
the true original) than in the originals directory (97336 bytes, which is
actually the FPS mod proxy). Always check sizes and MD5s.

**Runtime DLLs required:** The hbtestd game directory needs `libgcc_s_dw2-1.dll`,
`libstdc++-6.dll`, and `libwinpthread-1.dll` (copied from `~/the target-re/reimpl/`)
for the d3d8.dll proxy (d3d8to9) to load. If these are missing, Wine silently
falls back to builtin d3d8, which may or may not render correctly depending
on Wine prefix state.

## Pitfall: Always verify which DLL is actually in the game directory (CRITICAL)

Before running ANY test, verify via MD5 that the DLL in the game directory
is the one you intend to test — especially after `test_dll_mod` (which
restores originals) or after other agents/sessions placed a different DLL:

```bash
md5sum ~/the target-re/originals/installed/extracted/target.dll ~/the target-re/mods/<mod_name>/target.dll
```

**Real-world failure (June 2026):** An entire warm-up slot swap test session
ran with the **rsks-jit v4** DLL in the game directory instead of the
**universal-ref-loader v3** DLL. The MD5s were completely different
(`1a69210c...` vs `2548904c...`). All "pass" results were testing the
wrong mod. The mistake was only discovered by reading `ref_loader_log.txt`
which showed `"BUILD: rsks-jit v4 INJECTION MODE"` instead of the expected
universal-ref-loader header.

**ALSO check the log file header** if the DLL writes one — it identifies
which mod is loaded:
```bash
head -5 ~/the target-re/originals/installed/extracted/ref_loader_log.txt
```

## Pitfall: Crash survival ≠ functional verification (CRITICAL)

`test_dll_mod` and the warm-up slot swap test only verify that the game
**process stays alive** — they do NOT verify that objects loaded correctly,
rendered at the right positions, or behave as expected.

- **Crash test = necessary but not sufficient.** It catches stack
  corruption, wrong hook addresses, null pointer derefs.
- **Functional verification** requires either:
  - Real Windows with a GPU (user tests visually), OR
  - Wine with a working renderer (rare — llvmpipe renders black for
    mod DLLs that hook the render path), OR
  - Log-based verification: the DLL writes per-ref results (loaded/failed/
    factory used) to a log file or via OutputDebugStringA.

**Never claim "objects loaded correctly" or "the mod doesn't crash the game"
based on crash survival alone.** State explicitly: "crash test passed, but
level-loading code paths were not exercised — functional verification pending."

**User correction (sess_XXX, July 2026):** "You can't say the mod doesn't
crash the game when none of the code that would crash the game is ever tested."
The game sitting on the title screen with the mod loaded only tests DllMain
and the patch thread — it does NOT test vtable hooks, UniversalConstructor,
board ctor logic, or feature application. Those code paths only fire when
the game actually loads a level. If you can't navigate to a race (DINPUT8
blocking input), you MUST tell the user that level-loading code paths were
not tested, not claim the mod is safe.

## Static verification (before crash test)

After compiling and BEFORE crash-testing, run the static verification script
to catch missing exports, wrong PE format, and compiler warnings without
needing Wine:

```bash
python3 ~/.hermes/skills/devops/hbtestd-dll-mod-testing/scripts/verify-dll-mod.py \
    ~/the target-re/tools/<mod_name>/<source>.c \
    ~/the target-re/tools/<mod_name>/target.dll \
    ~/the target-re/mods/<mod_name>/target.dll
```

This checks: clean `-Wall -Wextra` compile, valid PE32 i386, all 10 BASS
exports with `@N` decoration, source pattern checks, and tools/mods MD5 match.
Run this FIRST, then crash-test. See `scripts/verify-dll-mod.py`.

## Workflow

### Standard crash test (DLL startup safety)
1. Compile DLL mod with `-Wall -Wextra`: `i686-w64-mingw32-gcc -shared -o target.dll mod.c -lwinmm -Wl,--enable-stdcall-fixup -O2 -static -static-libgcc -Wl,--add-stdcall-alias -Wall -Wextra`
2. Run static verification: `python3 scripts/verify-dll-mod.py <source.c> <target.dll> [mods_target.dll]`
3. Run `test_dll_mod(mod_dll_path="/path/to/target.dll", target_dll="target.dll")`
4. Check result: if `verdict == "CRASH"`, fix the issue before shipping
5. If `verdict == "OK"`, rebuild the zip: `zip <mod_name>.zip target.dll <mod_source>.c README.md`
6. Upload via `tmpcli up <file> -s catbox -q`

### Warm-up slot swap test (cross-level ref loading)
Tests whether a mod's universal ref loader can load objects in a level
where the board constructor doesn't pre-load their meshes. Each race
level's DATA_FILE is swapped into the Level1 (Warm-Up) slot.

**CRITICAL: All operations target the hbtestd game directory:**
```
GAME_DIR=~/the target-wasm/boxedwine-package/the target
LEVELS=$GAME_DIR/Levels
```
NOT `~/the target-re/originals/installed/extracted/`.

1. Back up original Level1: `cp $LEVELS/Level1.DATA_FILE $LEVELS/Level1.DATA_FILE.orig_backup`
2. Install mod DLL: `cp target.dll $GAME_DIR/target.dll` (and verify MD5!)
3. Copy runtime DLLs if missing: `cp ~/the target-re/reimpl/libgcc_s_dw2-1.dll $GAME_DIR/`
4. For each level to test (L2–L15, all 14 excluding Level1=target slot):
   a. Swap: `cp $LEVELS/<target>.DATA_FILE $LEVELS/Level1.DATA_FILE`
   b. Delete caches: `rm -f $LEVELS/*.cached`
   c. Nuclear reset (use pgrep -x, NOT pkill -f — see pitfall above):
      ```bash
      for pid in $(pgrep -x target_binary.exe); do kill -9 $pid; done
      for pid in $(pgrep -x wine-preloader 2>/dev/null); do kill -9 $pid; done
      for pid in $(pgrep -x wineserver 2>/dev/null); do kill -9 $pid; done
      for pid in $(pgrep -x Xvfb 2>/dev/null); do kill -9 $pid; done
      sleep 3; rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
      ```
   d. Call `mcp_hbtestd_restart_game` (starts fresh Xvfb + game)
   e. Wait 18s for title screen
   f. Verify hook via `/proc/PID/mem` read at 0x0040C4BA (should be E8)
   g. Call `mcp_hbtestd_load_level(level_name="Warm-Up", wait_title=18, key_delay=3)`
   h. Check screenshot size: >5KB = rendering works, ~1.5KB = black screen (mod DLL issue)
   i. Verify race_active via memory read (App+0x10EC at 0x4FD680+0x10EC)
   j. If alive after 35s → crash test PASS
5. Restore: `cp $LEVELS/Level1.DATA_FILE.orig_backup $LEVELS/Level1.DATA_FILE`
6. Restore original target.dll: `cp $GAME_DIR/bass_real.dll $GAME_DIR/target.dll`

**⚠ Limitation: mod DLLs that hook the render path cause black screen on
llvmpipe.** Even without any file I/O, the hook at 0x0040C4BA prevents
D3D rendering on Wine/llvmpipe. `load_level` navigation fails because
the game can't render menus. Only crash-testing (game process survives
35s with hook installed) is possible on Linux. Functional verification
of object loading requires real Windows with a GPU.

**Hook verification without screenshots (Linux):**
Read `/proc/PID/mem` at 0x0040C4BA — if first byte is 0xE8, hook is
installed. Read App+0x10EC (at address 0x4FD680+0x10EC) — if non-zero,
the game entered a race (Scene_CreateDynamicObjects was called, hook
fired, refs were processed).

