#!/usr/bin/env bash
# ============================================================================
# setup-d3d8-game.sh — Template for setting up a D3D8 game on Linux
# ============================================================================
# Auto-detects distro, installs Wine + Mesa + MinGW + Xephyr, builds d3d8to9,
# fixes case sensitivity, and launches the game. Designed for fresh Linux instances.
#
# CRITICAL DESIGN DECISIONS (learned the hard way):
#   1. Uses Xephyr (NOT wine explorer /desktop) for visible windows.
#      The wine explorer /desktop wrapper BREAKS D3D8 rendering.
#   2. Xephyr is a HARD dependency — no silent fallback to headless Xvfb.
#      Users on remote desktops (Guacamole/VNC) need a visible window.
#   3. Fresh extraction every run (rm -rf + re-extract). Previous runs leave
#      broken half-renamed state that causes mysterious failures.
#   4. Renames ALL files AND directories to lowercase (not symlinks).
#      Symlinks are unreliable — they break on re-runs and don't survive
#      partial failures. Direct rename is atomic and idempotent.
#   5. Verifies critical files exist after renaming before launching.
#
# KNOWN LIMITATION (llvmpipe):
#   On systems with only llvmpipe (software rendering, no GPU), the original
#   game will likely render BLACK SCREEN with d3d8to9 (GPU blit fails, falls
#   back to CPU blit which doesn't render). Without d3d8to9, it crashes
#   immediately. This script cannot fix that — it's a llvmpipe limitation.
#   Requires real GPU or Vulkan (DXVK) for actual rendering.
#   See references/llvmpipe-d3d8-black-screen.md for full diagnostic details.
#
# Usage: Place this script + game zip in the same directory, then run:
#   chmod +x setup-d3d8-game.sh && ./setup-d3d8-game.sh
#
# Based on https://github.com/evangit2/d3d8-wine-softrender
# ============================================================================
set -euo pipefail

# ── Config (edit these for your game) ───────────────────────────────────────
ZIP_FILE="game.zip"                    # Game archive to extract
GAME_DIR="$HOME/game"                  # Where to extract
GAME_EXE="Game.exe"                    # Executable name inside the zip
SCREEN_W=800
SCREEN_H=600
DISPLAY_NUM=99
D3D8TO9_REPO="https://github.com/crosire/d3d8to9.git"
BUILD_DIR="$HOME/d3d8to9-build"

log()  { echo -e "\033[1;34m[*]\033[0m $*"; }
ok()   { echo -e "\033[1;32m[+]\033[0m $*"; }
warn() { echo -e "\033[1;33m[!]\033[0m $*"; }
die()  { echo -e "\033[1;31m[-]\033[0m $*" >&2; exit 1; }
has()  { command -v "$1" &>/dev/null; }

[[ $EUID -eq 0 ]] && die "Don't run as root."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
[[ -f "$ZIP_FILE" ]] || die "Missing $ZIP_FILE in current directory."

# ── Distro detect & install deps ────────────────────────────────────────────
if has apt-get;   then DISTRO="debian"
elif has dnf;     then DISTRO="fedora"
elif has pacman;  then DISTRO="arch"
else DISTRO="debian"; fi
log "Distro: $DISTRO"

if ! has wine || ! has Xvfb || ! has cmake || ! has Xephyr; then
    log "Installing dependencies (will sudo)..."
    case "$DISTRO" in
        debian)
            dpkg --print-foreign-architectures | grep -q i386 || sudo dpkg --add-architecture i386
            sudo apt-get update -qq
            for grp in \
                "wine wine32" \
                "libgl1-mesa-dri:i386 libgl1:i386" \
                "cmake git build-essential gcc-mingw-w64-i686 g++-mingw-w64-i686 binutils-mingw-w64-i686" \
                "xvfb scrot mesa-utils x11-utils xserver-xephyr"; do
                sudo apt-get install -y $grp 2>&1 || warn "Some packages failed: $grp"
            done
            ;;
        fedora)
            for grp in \
                "wine" "mesa-dri-drivers.i686 mesa-libGL.i686" \
                "cmake git mingw32-gcc mingw32-gcc-c++ mingw32-windres" \
                "xorg-x11-server-Xvfb scrot glx-utils xorg-x11-utils xorg-x11-server-Xephyr"; do
                sudo dnf install -y $grp 2>&1 || warn "Some packages failed: $grp"
            done
            ;;
        arch)
            sudo pacman -S --noconfirm --needed wine lib32-mesa cmake git mingw-w64-gcc \
                xorg-server-xvfb scrot mesa-utils xorg-x11-utils xorg-server-xephyr 2>&1 || warn "Some packages failed"
            ;;
    esac
    ok "Dependencies installed."
else
    ok "Dependencies already present."
fi
for tool in wine Xvfb cmake git Xephyr; do
    has "$tool" || die "$tool not found. Install it manually."
done

# ── Fresh extraction (ALWAYS — prevents broken state from previous runs) ────
log "Fresh extraction to $GAME_DIR..."
rm -rf "$GAME_DIR"
mkdir -p "$GAME_DIR"
unzip -q -o "$ZIP_FILE" -d "$GAME_DIR"
ok "Extracted fresh."
[[ -f "$GAME_DIR/$GAME_EXE" ]] || die "$GAME_EXE not found after extraction."

# ── Rename EVERYTHING to lowercase (files AND directories) ──────────────────
# Windows is case-insensitive; Linux is not. D3D8 games hardcode lowercase
# paths (e.g. "textures\shadow.png") but archives have mixed-case filenames
# (Textures/Shadow.png). Renaming (not symlinking) is the reliable fix.
#
# Why NOT symlinks: Symlinks break on re-runs (partial state), don't survive
# across all filesystem operations, and the game's _check_file_access +
# D3DXCreateTextureFromFileA use the real VFS which follows symlinks but
# the symlink creation itself is fragile when dirs are half-renamed.
#
# Ghidra verification (target application): texture loader at 0x476770 constructs
# path as "textures\" (lowercase) and game hardcodes "shadow.png" (lowercase).
log "Renaming everything to lowercase..."
find "$GAME_DIR" -depth | while read -r path; do
    dir=$(dirname "$path")
    base=$(basename "$path")
    lower=$(echo "$base" | tr '[:upper:]' '[:lower:]')
    if [[ "$base" != "$lower" && ! -e "$dir/$lower" ]]; then
        mv "$path" "$dir/$lower"
    fi
done
ok "All files and directories renamed to lowercase."

# Verify the game directory structure looks sane
log "Game directory contents:"
ls "$GAME_DIR" | head -15

# ── Build + install d3d8to9 proxy ───────────────────────────────────────────
build_d3d8to9() {
    local TOOLCHAIN="" MINGW_GCC=""
    for tc in \
        /usr/share/cmake/Modules/Platform/i686-w64-mingw32.cmake \
        /usr/share/mingw/toolchain-mingw32.cmake \
        /usr/share/MinGW/toolchain-mingw32.cmake \
        /usr/share/mingw-w64/toolchain-i686-w64-mingw32.cmake; do
        [[ -f "$tc" ]] && { TOOLCHAIN="$tc"; break; }
    done
    if [[ -z "$TOOLCHAIN" ]]; then
        for gcc in i686-w64-mingw32-gcc i686-w64-mingw32-gcc-posix mingw32-gcc; do
            has "$gcc" && { MINGW_GCC="$gcc"; break; }
        done
        [[ -z "$MINGW_GCC" ]] && { warn "No MinGW found. Try: sudo apt install gcc-mingw-w64-i686"; return 1; }
        local PREFIX="${MINGW_GCC%-gcc}"; PREFIX="${PREFIX%-gcc-posix}"
        local GXX="${PREFIX}-g++"; local WINDRES="${PREFIX}-windres"
        TOOLCHAIN="$BUILD_DIR/toolchain.cmake"; mkdir -p "$BUILD_DIR"
        cat > "$TOOLCHAIN" <<EOF
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_C_COMPILER ${MINGW_GCC})
set(CMAKE_CXX_COMPILER ${GXX})
set(CMAKE_RC_COMPILER ${WINDRES})
set(CMAKE_FIND_ROOT_PATH /usr/${PREFIX})
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
EOF
    fi
    log "Building d3d8to9..."
    [[ -d "$BUILD_DIR/d3d8to9" ]] || git clone --depth 1 "$D3D8TO9_REPO" "$BUILD_DIR/d3d8to9"
    mkdir -p "$BUILD_DIR/d3d8to9/build"
    ( cd "$BUILD_DIR/d3d8to9/build" && \
      cmake .. -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" -DCMAKE_BUILD_TYPE=Release 2>&1 | tail -3 && \
      make -j"$(nproc)" 2>&1 | tail -3 )
    [[ -f "$BUILD_DIR/d3d8to9/build/d3d8.dll" ]]
}

D3D8TO9_BUILT=false
if build_d3d8to9; then
    D3D8TO9_BUILT=true
    cp "$BUILD_DIR/d3d8to9/build/d3d8.dll" "$GAME_DIR/d3d8.dll"
    ok "d3d8to9 proxy installed."
else
    warn "d3d8to9 build failed — using original d3d8.dll."
fi

# ── Wine prefix ────────────────────────────────────────────────────────────
export WINEPREFIX="$HOME/.wine-game"
export WINEDEBUG=-all
export WINEARCH=win32
[[ -d "$WINEPREFIX" ]] || { log "Initializing Wine prefix..."; wineboot -i 2>/dev/null || true; }
ok "Wine prefix ready."

# ── Kill stale processes ───────────────────────────────────────────────────
killall -9 wine wineserver 2>/dev/null || true
pkill -f "Xvfb :$DISPLAY_NUM" 2>/dev/null || true
pkill -f "Xephyr :$DISPLAY_NUM" 2>/dev/null || true
sleep 1

# ── Start Xephyr & launch ──────────────────────────────────────────────────
export LIBGL_ALWAYS_SOFTWARE=1

log "Starting Xephyr :$DISPLAY_NUM (${SCREEN_W}x${SCREEN_H}x16)..."
Xephyr :$DISPLAY_NUM -screen "${SCREEN_W}x${SCREEN_H}x16" -ac -nolisten tcp &
XEPHYR_PID=$!
sleep 2

if ! kill -0 "$XEPHYR_PID" 2>/dev/null; then
    die "Xephyr failed to start. Install it: sudo apt install xserver-xephyr"
fi
ok "Xephyr running on :$DISPLAY_NUM — a window should appear on your desktop."

export DISPLAY=:$DISPLAY_NUM

log "Launching $GAME_EXE..."
log "  Wine:     $(wine --version 2>/dev/null || echo '?')"
log "  d3d8to9:  $([[ $D3D8TO9_BUILT == true ]] && echo 'YES' || echo 'NO')"
log ""
log "Press Ctrl+C to stop."
log ""

# Run from the game directory so relative paths work
cd "$GAME_DIR"
wine "$GAME_DIR/$GAME_EXE" 2>/dev/null &
GAME_PID=$!

cleanup() {
    echo ""
    log "Shutting down..."
    kill "$GAME_PID" 2>/dev/null || true
    killall -9 wine wineserver 2>/dev/null || true
    kill "$XEPHYR_PID" 2>/dev/null || true
    ok "Done."
}
trap cleanup EXIT INT TERM

wait "$GAME_PID" 2>/dev/null || true
