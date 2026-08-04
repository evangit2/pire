# Wine Display Strategies for D3D8 Games

## The `wine explorer /desktop` Trap

**TL;DR: Never use `wine explorer /desktop=<name>,<size>` for D3D8 games. It breaks D3D rendering.**

### What Happens

The Wine virtual desktop wrapper (`wine explorer /desktop`) creates a Windows-style
virtual desktop inside a Wine window. While this prevents fullscreen hijack on remote
desktops (Apache Guacamole, VNC, RDP), it **interferes with D3D8 device creation**:

1. The D3D8 device creation inside the virtual desktop negotiates a different pixel format
2. Games crash with `D3DFMT_R5G6B5` (16-bit) even when the host display is 32-bit
3. Textures fail to load — "TEXTURE LOADING: shadow.png" dialogs appear even when the
   file exists and case-sensitivity is correct
4. The game crashes at texture loading code (observed at RVA 0xC65D9 in target application)

### Evidence

Tested with target_binary.exe (V3.6.c) under Wine 9.0 + d3d8to9 + llvmpipe:

| Method | Result |
|--------|--------|
| `wine explorer /desktop=game,800x600 game.exe` | ❌ Crash: D3DFMT_R5G6B5, texture loading error |
| `wine explorer /desktop=game,1024x768 game.exe` | ❌ Same crash |
| `wine explorer /desktop=game,800x600 game.exe` + Wine registry `DesktopDepth=32` | ❌ Same crash (registry ignored by /desktop) |
| Direct on Xvfb `:99` (headless) | ✅ Works (hbtestd approach) |
| Direct on Xephyr `:99` (visible window) | ✅ Works |

### Correct Approach: Xephyr

Xephyr is a nested X server that runs as a normal window on your desktop. The game
runs directly on the Xephyr display (no Wine wrapper), so D3D works correctly:

```bash
sudo apt install xserver-xephyr
Xephyr :99 -screen 800x600x16 -ac -nolisten tcp &
sleep 1
DISPLAY=:99 LIBGL_ALWAYS_SOFTWARE=1 wine game.exe
```

The game goes fullscreen inside the Xephyr window but cannot affect the host display.

### Xvfb Fallback (Headless)

For CI/crash-testing where no visible display is needed:

```bash
Xvfb :99 -screen 0 800x600x16 -ac -nolisten tcp &
sleep 1
DISPLAY=:99 LIBGL_ALWAYS_SOFTWARE=1 wine game.exe
```

Use `scrot` for periodic screenshots to verify rendering.

### If Display is Already Hijacked

If a fullscreen D3D8 game already hijacked your display (Guacamole/VNC session broken):

```bash
killall -9 wine wineserver target_binary.exe 2>/dev/null
DISPLAY=:0 xrandr -s 1024x768   # reset resolution
```

## Case Sensitivity Fix

Windows filesystems are case-insensitive; Linux (ext4, etc.) is case-sensitive.
D3D8 games hardcode lowercase paths (verified via Ghidra decompilation):

- target application texture loader (0x476770) constructs path as `"textures\"` (lowercase dir)
- Game hardcodes `"shadow.png"` (lowercase) at 0x4D2AAC
- File on disk in the archive: `Textures/Shadow.png` (mixed case)
- Result on Linux: file not found → "TEXTURE LOADING" dialog → crash

### Fix: Rename Everything to Lowercase (NOT Symlinks)

**IMPORTANT**: Use direct rename (`mv`), NOT symlinks. Symlinks are unreliable:
they break on re-runs when the directory state is partially modified, and they
don't handle cases where both the file AND its containing directory need renaming.

```bash
# Rename ALL files AND directories to lowercase (recursive, depth-first)
find /path/to/game -depth | while read -r path; do
    dir=$(dirname "$path")
    base=$(basename "$path")
    lower=$(echo "$base" | tr '[:upper:]' '[:lower:]')
    if [[ "$base" != "$lower" && ! -e "$dir/$lower" ]]; then
        mv "$path" "$dir/$lower"
    fi
done
```

**ALWAYS do a fresh extraction before renaming.** Previous runs may have left the
directory in a broken half-renamed state. Delete and re-extract from the archive:

```bash
rm -rf /path/to/game
mkdir -p /path/to/game
unzip -q game.zip -d /path/to/game
# THEN rename to lowercase
```

### Why Symlinks Fail (Session Evidence)

| Approach | Result |
|----------|--------|
| Recursive symlinks (files only) | ❌ `shadow.png` dialog persists — dir `Textures/` not renamed, game wants `textures/` |
| Recursive symlinks (files + dirs) | ❌ Symlinks conflict on re-runs, partial state from previous attempts |
| Direct rename (files only, keeping dirs) | ❌ `Textures/` dir still uppercase, game requests `textures/` |
| Fresh extraction + rename ALL (files + dirs) | ✅ `textures/shadow.png` exists, game loads correctly |

The game's texture loader uses `_check_file_access` (GetFileAttributesA wrapper) which
follows symlinks, but the issue is that symlink creation itself fails silently when
the target name already exists or the parent directory is a symlink to itself.

## 16-bit Color Depth

16-bit color (`R5G6B5`) works fine for D3D8 games on Wine/Xvfb — hbtestd uses it
reliably for crash-testing. The `D3DFMT_R5G6B5` in crash reports is NOT caused by
16-bit depth itself; it's caused by the `wine explorer /desktop` wrapper breaking
D3D device creation.

If 32-bit is needed (some games require it), use Xephyr with 32-bit depth:
```bash
Xephyr :99 -screen 800x600x32 -ac -nolisten tcp &
```

## llvmpipe Black Screen (CRITICAL)

**d3d8to9 does NOT render on llvmpipe.** The game engine runs (D3D states,
matrices, textures all load correctly per WINEDEBUG trace), but the screen
is black. Root cause: GPU blit fails on llvmpipe ("resources not GPU
accessible"), falls back to CPU blit, which doesn't render pixels.

Without d3d8to9, Wine's native D3D8 crashes immediately (RUNTIME 00:00:00).

**This is a llvmpipe limitation, not a configuration issue.** No amount of
display setup, color depth, or registry tweaks will fix it. Requires:
- Real GPU, OR
- DXVK (Vulkan-based D3D translation, needs Vulkan support)

See `references/llvmpipe-d3d8-black-screen.md` for full diagnostic evidence.

## Debian 2025+ Package Name Mapping

Newer Debian renamed several packages. The binary names are unchanged — only
the apt package names changed:

| Old Package Name | New Package Name | Binary Provided |
|-----------------|-----------------|-----------------|
| `libgl1-mesa-glx:i386` | `libgl1:i386` | (32-bit GL lib) |
| `i686-w64-mingw32-gcc` | `gcc-mingw-w64-i686` | `i686-w64-mingw32-gcc` |
| `i686-w64-mingw32-g++` | `g++-mingw-w64-i686` | `i686-w64-mingw32-g++` |
| `i686-w64-mingw32-windres` | `binutils-mingw-w64-i686` | `i686-w64-mingw32-windres` |

Always `dpkg --add-architecture i386 && apt-get update` before installing 32-bit packages.

## `set -euo pipefail` with apt-get

`set -euo pipefail` causes the script to exit on the FIRST apt-get error. If one
package in a combined `apt-get install` command is unavailable, the entire install
aborts. Fix: install packages in groups, and use `|| warn` per group:

```bash
for grp in "wine wine32" "libgl1-mesa-dri:i386 libgl1:i386" ...; do
    sudo apt-get install -y $grp 2>&1 || warn "Some packages failed: $grp"
done
```
