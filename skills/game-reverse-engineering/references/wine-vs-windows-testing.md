# Wine vs Real Windows Testing

Wine/Xvfb crash tests are NECESSARY but NOT SUFFICIENT for DLL mods that
hook game code or run background threads. Multiple crashes in the
mkn_level_system mod (v6.8, v6.8.1, v6.9) passed hbtestd on Wine but
crashed on real Windows within 6-7 seconds.

## Key Differences

1. **Menu navigation code paths** — Wine handles menu rendering
   differently from real Windows D3D8. FrameUpdate hooks and ADD
   trampolines that work on Wine crash on Windows during menu MouseDown.

2. **Memory layout differences** — Non-board objects during menus may
   have different vtable pointers on Wine vs Windows, causing dispatch
   threads to match/not-match custom vtables differently. A dispatch
   thread that safely skips non-board objects on Wine may call Summon
   functions on garbage data on Windows.

3. **D3D8 device state** — The D3D8 device state during FrameUpdate is
   different on Wine vs Windows. SceneObject creation that works on
   WineD3D may crash on real d3d8.dll.

## Crash Signatures That Only Appear on Real Windows

```
CRASH_ADDRESS: 0001:00052BDA
CURRENTOBJECT: Time Trial Menu
CURRENTOPERATION: MouseDown
RUNTIME: 00:00:06-07
```

This crash at 0x452BDA (CALL [EAX] on invalid vtable) appears when:
- FrameUpdate epilogue hook corrupts execution during menus
- ADD command trampoline interferes with menu code
- Dispatch thread calls Summon functions on non-board objects

## Debugging Checklist

When a mod passes Wine testing but crashes on real Windows:

1. **Dispatch thread safety** — Does the dispatch thread run during menus?
   Add board signature check: `board+0x878 == *(DWORD*)0x5341E0`
2. **Code hooks** — Does the mod patch any game code (FrameUpdate, etc.)?
   Remove it and use vtable replacement instead
3. **Trampolines** — Does the mod use the ADD command?
   Replace with `VTABLE <level> <slot> <func>` (direct vtable replacement)
4. **D3D8 creation** — Does the mod create D3D8 objects from non-setup code?
   Move to vtable[32] (Board_Setup) replacement that calls original first

## Safe vs Unsafe Patterns

| Pattern | Wine | Real Windows |
|---|---|---|
| VTABLE slot replacement (direct func ptr) | ✅ | ✅ |
| Extended slots 36-127 (material writes) | ✅ | ✅ (with board signature check) |
| ADD command (trampoline) | ✅ | ❌ Crashes during menus |
| FrameUpdate epilogue hook | ✅ | ❌ Crashes during menus |
| D3D8 creation from FrameUpdate | ✅ | ❌ Crashes |
| D3D8 creation from VTABLE 32 | ✅ | ✅ |
