---
name: wine-differential-analysis
description: Native vs Wine API call logging and behavioral divergence identification.
---

# Wine Differential Analysis

> Adapted from the target-specific RE toolkit for general binary analysis.


# Wine API Comparison Test

## Purpose
Run both the original the target EXE and our reimplementation under Wine with
API tracing to compare D3D8/DInput/DSound call sequences. This validates that our
reimplementation makes the same WinAPI calls as the original game.

## Prerequisites
- Wine 9.0+ installed
- Xvfb for headless testing (no GPU needed for reimpl)
- Original EXE: `originals/installed/extracted/target_binary.exe`
- Reimpl EXE: `reimpl/target_binary.exe`
- Test script: `scripts/test_api_compare.sh`

## Running the Comparison

### Quick Test (Xvfb, headless)
```bash
# Start Xvfb
Xvfb :99 -screen 0 1024x768x24 -ac &
sleep 2

# Run comparison script (5 seconds each)
DISPLAY=:99 ./scripts/test_api_compare.sh :99
```

### Manual Original Game Test
```bash
cd ~/the target-re/originals/installed/extracted
DISPLAY=:99 WINEDEBUG=+d3d8,+dinput wine target_binary.exe 2>&1 | tee /tmp/orig_trace.log
# Game will show D3DERR_NOTAVAILABLE on Xvfb (needs real GPU)
```

### Manual Reimpl Test
```bash
cd ~/the target-re/reimpl
DISPLAY=:99 wine ./target_binary.exe 2>&1 | tee /tmp/reimpl_trace.log
# Works on Xvfb: D3D8 device creates, level loads, clear screen renders
```

## Analyzing Traces

### Key D3D8 Calls to Compare
1. **Direct3DCreate8** — SDK version must match
2. **GetAdapterDisplayMode** — resolution/format query
3. **CreateDevice** — compare params: DeviceType, BehaviorFlags, BackBufferWidth/Height
4. **SetRenderState** — sequence of render states after device creation
5. **SetLight/LightEnable** — light setup
6. **SetTransform** — view/projection/world matrix setup
7. **CreateVertexBuffer** — geometry buffer creation
8. **DrawPrimitive/DrawIndexedPrimitive** — actual rendering calls
9. **Present** — frame presentation

### Extracting API Calls from Wine Trace
```bash
# D3D8 calls only
grep -i "trace:d3d8" /tmp/trace.log | head -100

# Focus on CreateDevice params
grep -i "CreateDevice" /tmp/trace.log

# Count render state changes
grep -c "SetRenderState" /tmp/trace.log
```

## Known Differences (Original vs Reimpl)

| Aspect | Original | Reimpl |
|--------|----------|--------|
| CreateDevice | D3DCREATE_HARDWARE_VERTEXPROCESSING | Falls back to SOFTWARE_VERTEXPROCESSING |
| Window | Fullscreen 800x600 (original) | Windowed 1024x768 (our default) |
| Audio | BASS.dll for music, DirectSound for SFX | DirectSound stubbed (non-fatal) |
| Geometry | DATA_FILE vertex buffer rendering (SpawnPlatform 34v) | Placeholder sphere + colored cubes |
| Textures | D3DXCreateTextureFromFile (PNG/TGA) | No texture loading yet |
| Scene System | 8-pass render pipeline | Single-pass clear + ball + objects |
| Input | DInput8 + BASS for polling | DInput8 keyboard + mouse polling |

## Screenshots

Screenshots are stored in `analysis/screenshots/comparison/`:
- `original_fullscreen.png` — D3DERR_NOTAVAILABLE error dialog on Xvfb
- `reimpl.png` — Clear color screen (purple-gray) with no geometry
- README.md — Detailed comparison notes

## Full GPU Testing
For testing with real GPU rendering (original game works):
- Use a Windows machine with DirectX 8 runtime
- Or use GPU passthrough in a VM
- Or use a Linux system with Mesa D3D8 state tracker

