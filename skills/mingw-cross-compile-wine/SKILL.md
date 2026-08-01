---
name: mingw-cross-compile-wine
description: Cross-compile Windows binaries with MinGW, test on Wine with OpenGL translation
category: devops
tags: [d3d8, mingw, wine, cross-compile, windows-gaming]
---

# D3D8 Cross-Compilation and Wine Testing Workflow

## Toolchain Setup
```bash
# Install MinGW-w64 cross-compiler
sudo apt install mingw-w64

# Install Wine for testing
sudo apt install wine
```

## Compilation Command
```bash
# CRITICAL: -D_D3D8 is REQUIRED to select D3D8 code paths in dual-build files
# CRITICAL: Do NOT include src/audio/audio.c — it requires SDL2_mixer (not available for Win32)
# CRITICAL: Do NOT include src/core/main.c — that's the Linux/SDL2 entry point
i686-w64-mingw32-gcc -std=c11 -m32 -O2 -D_D3D8 -Iinclude \
  src/core/win32_main.c src/level/meshworld_parser.c src/level/mesh_parser.c \
  src/graphics/texture.c \
  -o target_binary.exe \
  -ld3d8 -ldinput8 -ldsound -ldxguid -lole32 -lwinmm -mwindows
```

### Dual-Build File Guards
Several source files are shared between D3D8 (Win32) and OpenGL (Linux) builds.
They use `#ifdef _D3D8` to switch implementations:

**texture.h** — `texture_t` struct changes:
- D3D8: `IDirect3DTexture8 *d3d_tex` + `texture_set_device(void *device)` must be called before `texture_system_init()`
- OpenGL: `GLuint gl_tex` — no device needed

**texture.c** — Entire implementation split by `#ifdef _D3D8`:
- D3D8: stb_image → CreateTexture + LockRect (NO D3DX dependency)
- OpenGL: stb_image → glGenTextures + glTexImage2D

**NEVER** call `texture_bind(tex, device_ptr)` — the second param is `int stage` (0, 1, 2), NOT a device pointer.

## D3D8 Build Fixes Required

### 1. Header Order (Critical)
```c
// MUST include before dsound.h
#include <mmsystem.h>
#include <dsound.h>
```

### 2. D3DPRESENT_PARAMETERS Field Name
```c
// MinGW uses FullScreen_PresentationInterval, not PresentationInterval
present.FullScreen_PresentationInterval = D3DPRESENT_INTERVAL_IMMEDIATE;
```

### 3. D3DX Math Not in D3D8
```c
// D3DX math functions are NOT in d3d8.lib
// Use standard math:
#define D3DX_PI 3.14159265358979323846
// or manually implement:
D3DXVECTOR3 v = {x, y, z};
```

### 4. Link Flags
```bash
-ld3d8 -ldinput8 -ldsound -ldxguid -lole32 -lwinmm -mwindows
```

## Wine Testing

### Basic Test
```bash
wine ./target_binary.exe
```

### With Debug Output
```bash
WINEDEBUG=+d3d8 wine ./target_binary.exe 2>&1 | grep -i "d3d"
```

### Xvfb for Headless (CI/CD)
```bash
Xvfb :99 -screen 0 1024x768x24 &
export DISPLAY=:99
wine ./target_binary.exe
```

### Screenshot Capture on Wine/Xvfb (CRITICAL LIMITATION)
On Wine + llvmpipe, `scrot` CANNOT capture the D3D8 render surface. The X11 compositor sees only the window frame and title bar — the D3D output goes through a separate D3D → wined3d → OpenGL path that `scrot` misses entirely.

**Evidence**: Screenshot shows solid blue window or only title bar with tiny sliver of geometry, while console output confirms `Render] 179 geoms, 5399 triangles` rendered successfully.

**This does NOT mean the render is broken** — it means `scrot` is the wrong tool for D3D8-on-Wine. Verified by checking console: `Render] N geoms, N triangles` confirms D3D is working.

**Workarounds for visual testing:**
1. On Windows with real GPU: Use DXGI/D3D API capture (e.g., `Present()` hook, Windows.Graphics.Capture API)
2. On Linux: Use `renderdoc` or `apitrace` to capture actual D3D frames
3. For CI regression: use console output (`[Render] N triangles`) as proxy, not screenshots
4. SDL2/Linux builds (not D3D8) render through X11 directly and ARE visible to `scrot`

## Verification Steps
1. ✅ D3D8 device creation succeeds
2. ✅ DInput8 keyboard/mouse initialized  
3. ✅ Level loads from asset path
4. ✅ Game loop runs at ~30fps
5. ✅ Wine translates D3D8 → OpenGL silently

## Original Game API Comparison

### Comparison Test Script
```bash
./scripts/test_api_compare.sh :99
```
Runs both original target_binary.exe and reimpl target_binary.exe under Wine with
WINEDEBUG=+d3d8,+dinput,+dsound tracing, captures traces and screenshots.

### Key Finding: Original Game Fails on Xvfb
- Original `target_binary.exe` (1.4MB PE32 i386) requires **D3DCREATE_HARDWARE_VERTEXPROCESSING**
- On Xvfb (no GPU): `D3DERR_NOTAVAILABLE` — HAL device can't create without real GPU
- Our reimpl uses **SOFTWARE_VERTEXPROCESSING fallback** → succeeds on Xvfb
- For full original game testing: need real Windows GPU or GPU passthrough

### What Each Shows on Xvfb
| Build | D3D8 Device | Window | 3D Scene |
|-------|-------------|--------|----------|
| Original (target_binary.exe) | ❌ D3DERR_NOTAVAILABLE | Error dialog only | None |
| Reimpl (target_binary.exe) | ✅ SW vertex processing | Level geometry visible | Floor/pink materials, needs fixes |

### Original Game on Wine + llvmpipe — REQUIRES DELETING GAME'S d3d8.dll

**VERIFIED July 2026 (sessions 1658, 2374):** The original target_binary.exe CAN render on Wine + llvmpipe software rendering, but ONLY if the game's own `d3d8.dll` is deleted from the game directory. The game ships a hardware-only d3d8.dll (112KB PE32) that Wine loads preferentially — this DLL cannot do software rendering and causes black screen or crash. Without it, Wine falls back to its own builtin D3D8 → wined3d → OpenGL → llvmpipe, which works.

#### The Critical Fix: Delete Game's d3d8.dll

```bash
# After extracting the game:
rm -f "$GAME_DIR/d3d8.dll"
# Now Wine uses its builtin D3D8 (wined3d → OpenGL → llvmpipe)
```

#### Results Matrix (Updated July 2026)

| Config | d3d8.dll in game dir? | D3D8 Device | 3D Scene | Notes |
|--------|----------------------|-------------|----------|-------|
| Wine builtin D3D8 (hidra) | ❌ Deleted | ✅ Creates | ✅ RENDERS | 4007 unique colors, title screen visible. Wine 9.0, Mesa 25.2.8, llvmpipe LLVM 20.1.2 |
| Wine builtin D3D8 (vm3) | ❌ Deleted | ✅ Creates | ⚠️ Crashes | Game shows "Unexpected Error" dialog. Same Wine/Mesa versions as hidra — difference unknown. |
| With d3d8to9 proxy | ✅ Game's d3d8.dll replaced | ✅ Creates | ❌ BLACK SCREEN | GPU blit fails on llvmpipe → CPU blit fallback → no pixels |
| With d3d8to9 + DXVK + lavapipe | ✅ | ✅ Creates | ❌ BLACK SCREEN | DXVK can't render without real GPU |
| Wine builtin + DXVK DLLs in prefix | ❌ Deleted | ✅ Creates | ❌ CRASH | DXVK d3d8.dll in prefix system32 crashes on 32-bit Wine |

#### Why It Renders on hidra But Crashes on vm3

Both machines have identical Wine (9.0~repack-4build3) and Mesa (25.2.8) packages. The difference is NOT yet identified. Possible factors:
- hidra has `wine64` + `libwine:amd64` installed (64-bit Wine alongside 32-bit); vm3 only has 32-bit Wine
- hidra's `~/.wine` prefix has been used extensively (has DXVK DLLs in system32, but NO DllOverrides set — Wine ignores them)
- vm3's fresh Wine prefixes may be missing initialization that a used prefix has

**TODO:** Test installing `wine64` on vm3 to see if that fixes the crash.

#### Key Diagnostic: Check for Error Dialogs

The game's crash dialog ("target application - Unexpected Error") keeps the process alive — `kill -0 $PID` returns true even after a crash. To detect crashes, check for the error dialog window:

```bash
# Check if the game crashed (error dialog appears)
DISPLAY=:89 xdotool search --name "Unexpected Error" 2>/dev/null
# Or check window list
DISPLAY=:89 xwininfo -tree -root 2>/dev/null | grep -i "error\|the target"
```

#### Screenshot Capture on 16-bit Xvfb

`scrot` on 16-bit Xvfb captures an all-black image even when windows are present — the D3D render surface isn't composited to the root window. Use `xwd` + ImageMagick `convert` instead:

```bash
DISPLAY=:89 xwd -root -silent -out /tmp/hb.xwd && convert /tmp/hb.xwd screenshot.png
```

Note: `convert` may produce a 1-bit bilevel image from 16-bit Xvfb. For reliable capture, use `ffmpeg`:
```bash
DISPLAY=:89 ffmpeg -f x11grab -video_size 800x600 -i :89 -frames:v 1 screenshot.png -y
```

**What DOES work reliably:**
- Real Windows with real GPU ✅
- Wine + llvmpipe + builtin D3D8 (game's d3d8.dll deleted) — ✅ on hidra, ⚠️ crashes on some VMs

### Screenshots
Screenshots and comparison docs: `analysis/screenshots/comparison/`

### Reference: Wine Display Strategies
For detailed docs on why `wine explorer /desktop` breaks D3D8, how to use Xephyr
instead, case-sensitivity fixes, and Debian package name mapping, see:
`references/wine-display-strategies.md`

### Reference: llvmpipe D3D8 Black Screen Diagnostic
For the full diagnostic evidence (WINEDEBUG trace, GPU blit failure, d3d8to9 vs native D3D8
comparison) proving the original game renders black on llvmpipe, see:
`references/llvmpipe-d3d8-black-screen.md`

### Pitfalls
- **DO NOT use `wine explorer /desktop` for D3D8 games** — it breaks D3D device creation. Use Xephyr (visible) or Xvfb (headless) instead. See `references/wine-display-strategies.md`.
- **Case sensitivity** — Linux is case-sensitive, Windows isn't. Create recursive lowercase symlinks after extracting game files. See `references/wine-display-strategies.md`.
- **Original game fails on Xvfb**: D3D8 HAL needs real GPU, use real hardware or GPU passthrough
- **D3DX functions unavailable**: Use manual math or link d3dx8.lib separately
- **PresentationInterval field name**: MinGW uses FullScreen_PresentationInterval
- **Header order**: mmsystem.h before dsound.h for WAVEFORMATEX
- **32-bit only**: Must use -m32 for D3D8 COM interface compatibility
- **EXE not in git**: Original target_binary.exe and bass.dll gitignored from public repo.
  Get from your share link (files.rsks.lol) and place in originals/installed/extracted/
- **SDL2 files don't work for Win32**: audio.c uses SDL2_mixer — exclude from D3D8 build
- **Must define _D3D8**: Without `-D_D3D8` flag, shared files use OpenGL code paths which won't compile

### Debian/Ubuntu Package Name Changes (2025+)
Newer Debian renamed several packages. The old names fail with `E: Unable to locate package`:

| Old Name | New Name | Purpose |
|----------|----------|---------|
| `libgl1-mesa-glx:i386` | `libgl1:i386` | 32-bit OpenGL library |
| `i686-w64-mingw32-gcc` | `gcc-mingw-w64-i686` | MinGW C cross-compiler |
| `i686-w64-mingw32-g++` | `g++-mingw-w64-i686` | MinGW C++ cross-compiler |
| `i686-w64-mingw32-windres` | `binutils-mingw-w64-i686` | MinGW resource compiler |

The binary names (`i686-w64-mingw32-gcc`, etc.) are UNCHANGED — only the apt package names changed. Always `dpkg --add-architecture i386 && apt-get update` before installing 32-bit packages on Debian.

### Fullscreen Wine on Remote Desktop (Apache Guacamole) — CRITICAL

D3D8 games launched fullscreen on a real X display will **hijack the display**, change resolution, and break Apache Guacamole / VNC / RDP sessions.

**DO NOT use `wine explorer /desktop` to prevent this** — the Wine virtual desktop wrapper BREAKS D3D8 rendering. Games crash with `D3DFMT_R5G6B5` errors or show "TEXTURE LOADING: shadow.png" dialogs even when textures exist. The `wine explorer /desktop` wrapper interferes with D3D device creation and color depth negotiation.

**CORRECT FIX: Use Xephyr** (nested X server) instead. Xephyr creates a visible window on your desktop that is itself a real X display, so the game runs directly on it (no Wine wrapper) and D3D works correctly:

```bash
# Install Xephyr
sudo apt install xserver-xephyr        # Debian/Ubuntu
sudo dnf install xorg-x11-server-Xephyr # Fedora

# Start Xephyr as a visible nested X window
Xephyr :99 -screen 800x600x16 -ac -nolisten tcp &
sleep 1

# Run the game DIRECTLY on the Xephyr display (no wine explorer wrapper)
DISPLAY=:99 LIBGL_ALWAYS_SOFTWARE=1 wine ~/the target/target_binary.exe
```

The game goes fullscreen inside the Xephyr window but cannot affect the host display. You can move/resize the Xephyr window itself.

**If Xephyr is unavailable** (headless SSH, CI), fall back to Xvfb:
```bash
Xvfb :99 -screen 0 800x600x16 -ac -nolisten tcp &
DISPLAY=:99 LIBGL_ALWAYS_SOFTWARE=1 wine ~/the target/target_binary.exe
```
The game runs invisibly — use `scrot` for periodic screenshots to verify rendering, or check console output.

**If the display is already hijacked**, recover with:
```bash
killall -9 wine wineserver target_binary.exe 2>/dev/null
DISPLAY=:0 xrandr -s 1024x768   # reset resolution
```

### 16-bit Color Depth is Fine (R5G6B5)
The game crash report showing `DXDISPLAY: D3DFMT_R5G6B5` (16-bit) is NOT caused by 16-bit depth itself — hbtestd runs the game at 16-bit depth reliably. The crash is caused by `wine explorer /desktop` breaking D3D device creation. Running directly on Xvfb or Xephyr at 16-bit works correctly.

### Case Sensitivity (Linux vs Windows)
Windows is case-insensitive; Linux is not. D3D8 games hardcode lowercase paths (verified via Ghidra: target application's texture loader at 0x476770 constructs `"textures\"` + `"shadow.png"`, all lowercase). But the archive has mixed-case (`Textures/Shadow.png`). This causes "TEXTURE LOADING" dialogs and crashes.

**Fix: Fresh extraction + direct rename (NOT symlinks).** Symlinks are unreliable — they break on re-runs when directory state is partially modified from previous attempts. Always delete and re-extract, then rename:

```bash
# 1. Fresh extraction (prevents broken state from previous runs)
rm -rf "$GAME_DIR"
mkdir -p "$GAME_DIR"
unzip -q game.zip -d "$GAME_DIR"

# 2. Rename ALL files AND directories to lowercase (depth-first)
find "$GAME_DIR" -depth | while read -r path; do
    dir=$(dirname "$path")
    base=$(basename "$path")
    lower=$(echo "$base" | tr '[:upper:]' '[:lower:]')
    if [[ "$base" != "$lower" && ! -e "$dir/$lower" ]]; then
        mv "$path" "$dir/$lower"
    fi
done
```

**Why symlinks fail:** Symlink creation fails silently when the target name already exists or the parent directory is a symlink to itself. On re-runs, half-renamed state from a previous attempt causes the symlink approach to miss files. Direct `mv` is atomic and idempotent. See `references/wine-display-strategies.md` for the full evidence table.

### Display Detection (Real X vs Xephyr vs Xvfb)
When writing setup scripts for Wine games, use this priority:

1. **Xephyr** (if real `$DISPLAY` exists + Xephyr installed) → visible nested window, D3D works
2. **Xvfb** (headless fallback) → invisible, use for CI/crash-testing

```bash
if has Xephyr && [[ -n "${DISPLAY:-}" ]] && xdpyinfo &>/dev/null; then
    # Xephyr: visible nested X window
    Xephyr :99 -screen 800x600x16 -ac -nolisten tcp &
    export DISPLAY=:99
else
    # Xvfb: headless
    Xvfb :99 -screen 0 800x600x16 -ac -nolisten tcp &
    export DISPLAY=:99
fi
# Run game DIRECTLY on the virtual display — NO wine explorer /desktop wrapper
wine ~/the target/target_binary.exe &
```

On Apache Guacamole sessions, `DISPLAY` is typically `:0` or `:1` and `xdpyinfo` succeeds. On SSH-only sessions, `DISPLAY` is empty and Xvfb is the correct fallback.

## Automated Game Setup Script Template

A complete setup script template for running D3D8 games on fresh Linux instances is available at `templates/setup-d3d8-game.sh`. It handles:

- Distro detection (Debian/Fedora/Arch/openSUSE) with fallback
- Debian 2025+ package name mapping (`libgl1-mesa-glx` → `libgl1`, `i686-w64-mingw32-gcc` → `gcc-mingw-w64-i686`)
- d3d8to9 build with MinGW toolchain auto-detection (handles both old and new binary names)
- **Fresh extraction every run** (`rm -rf` + re-extract) — prevents broken half-renamed state from previous attempts
- **Direct rename to lowercase** (NOT symlinks) — renames ALL files AND directories. Symlinks are unreliable on re-runs.
- **Xephyr as hard dependency** (no `wine explorer /desktop` — that breaks D3D). No silent fallback to headless Xvfb.
- 16-bit color depth at 800x600 (matches hbtestd, known to work)
- Runs from game directory (`cd $GAME_DIR`) so relative paths resolve correctly
- Cleanup trap for Wine + Xephyr processes

Copy and customize the `ZIP_FILE`, `GAME_DIR`, and `GAME_EXE` variables at the top of the script for the target game.

## Wine/llvmpipe D3D8 Rendering Bugs (CRITICAL)

On Xvfb + llvmpipe software rendering, D3D8 has two critical bugs:

### Bug 1: Hardware Lighting Silently Broken
- `D3DRS_LIGHTING=TRUE` + `D3DFVF_NORMAL` vertex format — normals are silently ignored
- Result: flat, unlit surfaces regardless of light direction, material ambient/diffuse, or scene ambient
- WINEDEBUG trace shows SetLight/LightEnable succeed, but lighting calculations produce no result
- **Workaround**: Software per-vertex lighting using `D3DFVF_DIFFUSE` + `D3DRS_LIGHTING=FALSE`

### Bug 2: Textures Don't Render
- `SetTexture`, `SetTextureStageState`, `DrawPrimitiveUP` all succeed (WINEDEBUG confirms)
- But textured triangles render as if no texture was set (solid material color only)
- **No workaround on llvmpipe** — textures work on real Windows GPU

### Software Per-Vertex Lighting Workaround
When D3D8 hardware lighting fails, compute diffuse color per-vertex in your own code:

```c
// Use D3DFVF_DIFFUSE instead of D3DFVF_NORMAL
#define SW_VERTEX_FVF (D3DFVF_XYZ | D3DFVF_DIFFUSE | D3DFVF_TEX1)

typedef struct {
    float x, y, z;
    DWORD diffuse;   // computed per-vertex lighting
    float u, v;
} SW_Vertex;

// Per-vertex lighting function
static DWORD compute_lighting(float nx, float ny, float nz,
                               float r, float g, float b) {
    // Two directional lights + ambient
    // Light1: from above-left (0.4, 0.8, 0.4), weight 0.55
    float d1 = nx*0.4f + ny*0.8f + nz*0.4f;
    if (d1 < 0) d1 = 0;
    // Light2: fill from below-right (-0.3, -0.7, -0.3), weight 0.20
    float d2 = nx*(-0.3f) + ny*(-0.7f) + nz*(-0.3f);
    if (d2 < 0) d2 = 0;
    // Ambient: 0.25 base
    float intensity = 0.25f + 0.55f * d1 + 0.20f * d2;
    if (intensity > 1.0f) intensity = 1.0f;
    DWORD dr = (DWORD)(r * intensity * 255); if (dr>255) dr=255;
    DWORD dg = (DWORD)(g * intensity * 255); if (dg>255) dg=255;
    DWORD db = (DWORD)(b * intensity * 255); if (db>255) db=255;
    return D3DCOLOR_ARGB(255, dr, dg, db);
}
```

This gives a brightness range of 0.25 (deep shadow) to 1.0 (fully lit) with
clear shading contrast visible on walls, floors, and objects.

### Textured Geometry Tint
When textures don't render, tint textured floor geoms with a soft color
(e.g., pink-white 0.92/0.88/0.94 for PinkChecker) so floors are visually distinct
from walls even without the actual texture image.

### Pitfalls
- **Do NOT rely on D3DRS_LIGHTING on Wine/llvmpipe** — it silently fails
- **D3DFVF_NORMAL + hardware lighting works on real GPU** — only use SW lighting as fallback
- **Textures work on real Windows GPU** — the texture bug is llvmpipe-specific

### Isometric Camera Implementation (confirmed from original decomp)
The original uses CameraLookAt (0x413280) with these parameters:
```
orbit_dist = 800.0f   // Distance from target
orbit_tilt = 0.9f    // Y component of orbit direction (gives ~42° from horizontal)
orbit_angle = 0.7854f // PI/4 = 45° rotation for isometric view
```
Camera target can blend between arena center (CAMERALOOKAT object) + ball position for arena vs race modes.

### Camera Bugs Discovered (Session 68)

#### Sign Bug
The original `Scene_SetCamera` (0x419FA0) computes `orbit_dir = (cos_a, 0.9, sin_a)` then calls `Camera_SetView(dir, dist)`. The dir vector points FROM target TOWARD camera, meaning `eye = target + normalize(dir) * dist`.

Some levels (Level3) have geometry mostly on the -Z side of the ball, making the camera placement ambiguous. Adaptive sign heuristics (sample vertices, pick majority) fail for levels with geometry on both sides of the ball globally.

**Correct fix**: Always use `eye = target + dir * dist` matching original. Never compute sign from vertex distribution.

#### Distance Bug
Dynamic distance based on level bounds (e.g., `dist = diag * 0.12`) causes clipping into walls for small levels and excessive distance for large levels.

**Correct fix**: Fixed distances — `400` for race tracks, `500` for arena levels. This matches the original's consistent isometric feel across all levels.

### Spawn Bugs Discovered (Session 68)

#### Countdown Snap Loop
Placing ball at `START.y + radius` then running collision every frame during countdown causes the ball to jitter downward each frame, eventually falling through the floor.

**Correct fix**: Snap to surface ONCE on the first frame of countdown using a static flag, not every frame.

#### Level3 Spawn Below Geometry
Level3 START at Y=-85 has no nearby geometry within 1000 units (the track is further away). The ball at Y=-85 + radius has nothing to collide with.

**Correct fix**: When no collision at spawn, sweep upward from below (`for scan_y = ball_y - 50; scan_y > ball_y - 1000; scan_y -= 25`) to find the floor surface. This handles levels where START is positioned above or inside the track envelope.

#### Arena Forced Low Spawn
Forcing `ball.y = radius + 2.0f` for arena levels breaks levels (like Arena-Party) that have a specific START position.

**Correct fix**: Always respect START object position. Let countdown snap handle any slight offset.

### Build Verification on Wine/llvmpipe

```bash
# Quick build + test cycle
cd ~/the target-re/reimpl
i686-w64-mingw32-gcc -std=c11 -m32 -O2 -D_D3D8 -Iinclude \
  src/core/win32_main.c src/level/meshworld_parser.c src/level/mesh_parser.c \
  src/graphics/texture.c -o target_binary.exe \
  -ld3d8 -ldinput8 -ldsound -ldxguid -lole32 -lwinmm -mwindows

# Run with timeout
DISPLAY=:99 timeout 10 wine ./target_binary.exe 2>&1 | grep -E "(Render|Camera|Spawn|Checkpoint|Collision)"
```

Expected output:
```
[Load] Level1: 30 objects, 9161 vertices, 0 materials
[Camera] Eye=(267.6,334.8,-223.8) At=(57.3,67.2,-13.6)
[Render] 179 geoms, 5399 triangles, 9161 vertices (software lighting)
[Checkpoint] SAFESPOT 10 at (134.2,40.1,-28.8)
[Collision] nhits=0 pos=(57.3,68.3,-15.9)  // countdown — no collision
```

This confirms the game is rendering correctly even though `scrot` can't capture it.
