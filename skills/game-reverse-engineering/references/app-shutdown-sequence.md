# target application App Shutdown / Exit Sequence

Ghidra-decompiled full exit chain. All addresses are image-base-relative (add 0x400000 for absolute).

## WinMain (0x004278E0) — entry point
```c
App_Initialize_Full(&g_App, hInstance, cmdLine);  // 0x00429530
App_Run(&g_App);                                    // 0x0046BD80 — main game loop
App_SetQuitFlag(&g_App);                             // 0x0046BA10 — quit signal + vtable[2]
return 0;
```
g_App is at 0x004FD680 (DAT_004fd680).

### Ghidra function renames (this session)
| Address | Old Ghidra name | Renamed to |
|---------|----------------|------------|
| 0x004279F0 | LoadOrSaveConfig | App_SaveConfigAndDestroy |
| 0x00429430 | FUN_00429430 | App_ScalarDtor_Full |
| 0x0046BA10 | App_Shutdown | App_SetQuitFlag |
| 0x0046DB10 | App_Shutdown (2nd) | App_Dtor |
| 0x00446AE0 | QuitToDesktop_Execute | QuitToMainMenu_Execute |

## App_Run (0x0046BD80) — main loop
Spins on `App+0x159` (quit flag, byte). Loop body:
- Sleep(0) + PeekMessageA/TranslateMessage/DispatchMessageA
- Checks App+0x159 after message pump; if set, breaks to LAB_0046bfc3
- Inner do-while: GetTickCount timing, calls vtable[0x20] (Update), vtable[0x24/0x28/0x2C] (Render frames), Graphics_BeginFrame/PresentOrEnd
- App+0x5B = target FPS (used for frame timing: 1000/FPS)
- App+0x84 = current phase string pointer ("Background", "Update", etc.)
- Timer_Cleanup on exit

## App_SetQuitFlag (0x0046BA10) — quit signal
```c
void __fastcall App_SetQuitFlag(int *app) {
    *(byte*)((int)app + 0x159) = 1;     // set quit flag → breaks App_Run loop
    (**(code**)(*app + 8))();           // call vtable[2] → App_Dtor (destructor)
}
```
Called by: WinMain, App_SaveConfigAndDestroy, App_ScalarDtor, CRT Unwind handlers.

## App_SaveConfigAndDestroy (0x004279F0) — the REAL destructor
Despite its original Ghidra name ("LoadOrSaveConfig"), this is the full teardown. Called via App_ScalarDtor_Full (0x00429430, scalar destructor wrapper). Steps:
1. Sets vtable to PTR_FUN_004d2660
2. Saves config to `DATA\HS.CFG` (via vtable call on App+0x8C)
3. Destroys ~50+ sub-objects (null-checks + virtual dtor calls + zeroing)
4. `_eh_vector_destructor_iterator_` on App+0x173 (4 player score entries, stride 0xA0)
5. **Opens `http://www.raptisoft.com` in browser via ShellExecuteA** — gated by `App+0x80 == '\0'`
6. Calls App_Shutdown(app) to set quit flag

### App+0x80 — "visit website on exit" flag
- `App+0x80 == '\0'` → opens raptisoft.com in browser on exit
- `App+0x80 != '\0'` → skips browser launch
- This is a config flag, likely set during gameplay or from settings

## App_Dtor (0x0046DB10) — actual destructor (vtable[2] target)
```c
void __fastcall App_Shutdown(undefined4 *app) {
    *app = &PTR_App_ScalarDtor_004d9750;    // set vtable to scalar dtor
    // Destroy 5 sub-objects at app[0x61], app[0x5D], app[0x5E], app[0x5F], app[0x60]
    // (virtual dtor with flags=1, then zero the pointer)
    if (app[2] != NULL) {                     // app+0x08 = HWND
        DestroyWindow(app[2]);
        app[2] = NULL;
    }
    if (app[0x15] != NULL) {                  // another sub-object
        (**(code**)*app[0x15])(1);           // virtual dtor
        app[0x15] = NULL;
    }
    CoUninitialize();
    // Free SBO string at app+0x28 (if capacity > 0xF, heap free)
    app[0x0E] = 0; app[0x0F] = 0xF;          // reset string to SBO empty
    *(byte*)(app + 10) = 0;                   // null terminator
}
```

## QuitToMainMenu_Execute (0x00446AE0) — MISLEADINGLY NAMED (was "QuitToDesktop_Execute")
Does NOT quit to desktop! Actually means "quit race → back to main menu":
1. Calls some vtable cleanup on App+0x115C
2. Sets gfx+0x7D2 = 0, calls Gfx_SetCullMode
3. Sets gfx+0x708 = 3
4. Calls App_StartRace, App_ShowResults(false), App_ShowMainMenu
5. Returns — game continues running

## QuitRace / QuitRaceMenu (0x0042FAD0 / 0x0042E6F0)
Pause menu constructor — adds menu items: RESUME, RESTART RACE, OPTIONS, QUIT THIS RACE.
"QUIT THIS RACE" maps to action code 0x42fbb7.

## QuitDialog_ctor (0x00443E30)
Dialog gadget for quit confirmation. Stores itself at board+0x420 (via App+0x184+0x420).
Position: floats at this+4/8/0xC/0x10 (0x42E20000, 0x43160000, 0x440FC000, 0x43960000).

## Key Offsets
| Offset | Field | Notes |
|--------|-------|-------|
| App+0x159 | quit_flag (byte) | 0=running, 1=exit requested. Breaks App_Run loop. |
| App+0x80 | website_gate (byte) | 0=open raptisoft.com on exit, nonzero=skip |
| App+0x08 | HWND | Game window handle, DestroyWindow'd on shutdown |
| App+0x5B | target_fps | Frame timing divisor (1000/FPS) |
| App+0x84 | phase_string | Current phase label ("Background", "Update", etc.) |

## Hook Points for Mods
- **Pre-exit hook**: Detour App_Shutdown (0x0046BA10) entry — fires before quit flag is set. Can read game state before destruction begins.
- **Post-cleanup hook**: Detour LoadOrSaveConfig end (before App_Shutdown call) — game objects still alive but config saved.
- **Browser launch gate**: Write App+0x80 = 1 to suppress the raptisoft.com browser launch.
- **Window destruction**: App+0x08 (HWND) is destroyed in App_Shutdown #2 — hook DestroyWindow to intercept.
- **Quit flag direct write**: Write App+0x159 = 1 to force-exit the game from any code path.

## Practical Application: Self-Destruct Timer Mod

A bass.dll proxy mod that closes the game after a random delay (0.5-3s). Uses a background thread to write the quit flag directly:

```c
static DWORD WINAPI self_destruct_thread(LPVOID lpParam) {
    DWORD delay = MIN_MS + rng % (MAX_MS - MIN_MS + 1);
    Sleep(delay);
    BYTE *quitFlag = (BYTE *)((DWORD)hExe + 0xFD680 + 0x159);
    *quitFlag = 1;  // breaks App_Run loop → clean shutdown
    return 0;
}
```

Key points:
- App struct RVA = 0x000FD680, quit flag offset = 0x159, so absolute address = 0x004FD7D9
- Thread created in DllMain (after init_bass_proxy), no patches needed
- Exit code 0 = clean exit (not a crash). The full shutdown chain runs: config save → object destruction → DestroyWindow → CoUninitialize
- test_dll_mod reports "CRASH" because process exits before timeout — check exit_code==0 to confirm clean exit
- Full shutdown chain takes ~3-5 seconds after flag is set (LoadOrSaveConfig destroys ~50 objects)
- Mod source: `~/the target-re/mods/self_destruct/mod.c`
