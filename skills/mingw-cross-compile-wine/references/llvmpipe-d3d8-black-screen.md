# llvmpipe D3D8 Rendering — Diagnostic Evidence

## Summary

The original target_binary.exe (V3.6.c) CAN render on Wine + llvmpipe software rendering,
but ONLY when the game's own `d3d8.dll` is deleted from the game directory. The game ships
a hardware-only d3d8.dll that Wine loads preferentially, causing black screen or crash.

## The Critical Discovery (Session 2374, July 2026)

**The game ships its own `d3d8.dll` (112KB PE32, hardware-only).** When this file exists
in the game directory, Wine loads it instead of its own builtin D3D8. The game's d3d8.dll
requires a real GPU and cannot do software rendering → black screen or crash.

**Fix: Delete the game's d3d8.dll so Wine uses its builtin D3D8:**
```bash
rm -f "$GAME_DIR/d3d8.dll"
# Wine now uses builtin D3D8 → wined3d → OpenGL → llvmpipe → RENDERS
```

## Verified Results

### Renders Successfully (hidra — our dev machine)
- Wine 9.0 (Ubuntu 9.0~repack-4build3), Mesa 25.2.8, llvmpipe (LLVM 20.1.2, 256 bits)
- Xvfb 16-bit at 800x600
- Game's d3d8.dll deleted, NO d3d8to9, NO DXVK, NO DllOverrides
- Result: **4007 unique colors**, title screen with colorful target application logo visible
- Screenshot confirmed via PIL pixel analysis (extrema: R=0-255, G=0-255, B=0-255)

### Crashes (vm3 — user's VM, same packages)
- Identical Wine 9.0 and Mesa 25.2.8 packages
- Same config (d3d8.dll deleted, no overrides)
- Game creates D3D device successfully (WINEDEBUG=+d3d confirms adapter init, GL renderer llvmpipe)
- But game shows "target application - Unexpected Error" crash dialog
- Crash dialog keeps process alive — `kill -0 $PID` returns true even after crash
- **Difference from hidra NOT yet identified.** Possible factors:
  - hidra has `wine64` + `libwine:amd64` (64-bit Wine); vm3 only has 32-bit Wine
  - hidra's `~/.wine` prefix is well-used (has DXVK DLLs in system32, but no overrides set)
  - vm3's fresh Wine prefixes may lack initialization

## Test Matrix (Complete)

| Config | d3d8.dll in game dir? | D3D8 Device | 3D Scene | Notes |
|--------|----------------------|-------------|----------|-------|
| Wine builtin D3D8 (hidra) | ❌ Deleted | ✅ Creates | ✅ RENDERS | 4007 colors, title screen visible |
| Wine builtin D3D8 (vm3) | ❌ Deleted | ✅ Creates | ⚠️ Crashes | Error dialog, same packages as hidra |
| With d3d8to9 proxy | ✅ Replaced with proxy | ✅ Creates | ❌ BLACK SCREEN | GPU blit fails on llvmpipe |
| With d3d8to9 + DXVK + lavapipe | ✅ | ✅ Creates | ❌ BLACK SCREEN | DXVK can't render without real GPU |
| Wine builtin + DXVK DLLs in prefix | ❌ Deleted | ✅ Creates | ❌ CRASH | DXVK d3d8.dll crashes on 32-bit Wine |
| Wine builtin (vm3, no deletion) | ✅ Game's original | ✅ Creates | ❌ BLACK SCREEN | Game's d3d8.dll can't do software rendering |

## Diagnostic Evidence

### D3D Trace Confirms Engine Running
WINEDEBUG=+d3d output on vm3 shows:
- `wined3d_adapter_gl_init` succeeds
- `GL_RENDERER: "llvmpipe (LLVM 20.1.2, 256 bits)"`
- `GL_VERSION: "4.5 (Core Profile) Mesa 25.2.8-0ubuntu0.24.04.2"`
- Pixel formats enumerated: `RGBA=5/6/5/0, depth=24, stencil=8` (16-bit R5G6B5)
- No errors in D3D initialization

### Crash Detection
The game's crash dialog ("target application - Unexpected Error") keeps the process alive.
To detect crashes, check for the error dialog window:
```bash
DISPLAY=:89 xwininfo -tree -root 2>/dev/null | grep -i "Unexpected Error"
```

### Screenshot Capture on 16-bit Xvfb
`scrot` on 16-bit Xvfb captures all-black even when windows are present.
Use `xwd` + `convert` or `ffmpeg`:
```bash
DISPLAY=:89 xwd -root -silent -out /tmp/hb.xwd && convert /tmp/hb.xwd screenshot.png
DISPLAY=:89 ffmpeg -f x11grab -video_size 800x600 -i :89 -frames:v 1 screenshot.png -y
```

## Key Lessons

1. **Always delete the game's d3d8.dll** when running on Wine/llvmpipe. The game ships
   a hardware-only d3d8.dll that prevents Wine's builtin D3D8 from being used.

2. **d3d8to9 is NOT needed and makes things worse** — it causes GPU blit failure on
   llvmpipe. Wine's builtin D3D8 (wined3d → OpenGL) works when the game's d3d8.dll
   is removed.

3. **DXVK is NOT needed** — Wine's builtin wined3d handles D3D8 → OpenGL translation
   natively. DXVK adds complexity and doesn't help on software renderers.

4. **The game CAN render on llvmpipe** — previous claims that it can't were wrong.
   The issue was the game's own d3d8.dll shadowing Wine's builtin.

5. **Same packages can produce different results** — hidra and vm3 have identical
   Wine/Mesa versions but different outcomes. The difference may be wine64 presence
   or Wine prefix initialization state.
