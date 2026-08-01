---
name: platform-api-stubbing
description: Remove platform DRM (Steam, etc.) by replacing platform DLLs with minimal stubs or emulators.
---

# Platform API Stubbing

> Adapted from the target-specific RE toolkit for general binary analysis.


# Steamworks DRM Removal Workflow

## Decision: Minimal Stub vs Goldberg vs Steamclient Loader

| Approach | When to use |
|----------|-------------|
| **Minimal C stub** | Game imports ≤20 Steam API calls, basic init/userstats/friends only |
| **Goldberg Steam Emulator** (regular DLL swap) | Heavy Steamworks but no callback-dependent startup gates |
| **Goldberg Steamclient Loader** (injection) | Heavy Steamworks AND the game stalls at "Waiting for stats/user data verification" or other callback-dependent init gates. This keeps the **original** `steam_api.dll` intact and emulates at the IPC layer, which correctly queues callbacks that the game blocks on. |

If `objdump -x steam_api.dll | grep -c "[0-9]*\[[0-9]*\]"` shows hundreds of exports, you need Goldberg (either regular or steamclient_loader mode).

## Phase 1: Identify the game

```bash
objdump -x Game.exe | grep -E "steam_api" -A200 | head -40
strings Game.exe | grep -iE "SteamAPI_|Steam[A-Z]" | sort -u
cat steam_appid.txt   # Note the AppID
```

Record:
- Game name (e.g., `Bohrdom.exe`)
- Steam AppID (e.g., `945530`)
- Architecture (PE32 = x86, PE32+ = x64)
- Number of `steam_api.dll` exports

## Phase 2: Obtain Goldberg Steam Emulator

For heavy Steamworks games, writing a minimal stub is impractical. Use a **prebuilt Goldberg DLL**.

**Source/prebuilt:** `alex47exe/gse_fork` releases (widely compatible fork of Goldberg)

Download the latest release `.7z` (contains x86 and x64 builds):
```bash
wget https://github.com/alex47exe/gse_fork/releases/download/2026_02_16/emu-win-release.7z
```

Extract with p7zip:
```bash
sudo apt-get install -y p7zip-full
7z x emu-win-release.7z -ogse_win -y
```

Pick the correct architecture:
- **x86/PE32** → `gse_win/release/regular/x32/steam_api.dll`
- **x64/PE32+** → `gse_win/release/regular/x64/steam_api.dll`

## Phase 3a: Replace and configure (Goldberg Regular Mode)

This is the default "DLL swap" approach — overwrite `steam_api.dll` with Goldberg's replacement.

```bash
# In the game's root directory
cp /path/to/gse_win/release/regular/x32/steam_api.dll ./steam_api.dll
# (optional) Backup original:
# mv steam_api.dll steam_api.dll.original && cp ... ./steam_api.dll

# Critical: AppID MUST be present
echo "945530" > steam_appid.txt
mkdir -p steam_settings
echo "945530" > steam_settings/steam_appid.txt
```

### steam_settings/steam_interfaces.txt

Goldberg needs interface version strings. Extract them from the **original** DLL:
```bash
strings steam_api.dll.original | grep -iE "^Steam[A-Z]+[0-9]{3}$" | sort -u
```

Write each match on its own line:
```
SteamUserStats011
SteamFriends015
SteamUser019
SteamUtils009
SteamApps008
SteamMatchMaking009
SteamNetworking005
SteamController006
SteamClient017
```

Save as `steam_settings/steam_interfaces.txt`.

## Phase 3b: Steamclient Loader Mode (for games with callback-related init hangs)

Some games block their loading thread on a specific Steam callback delivery (notably `UserStatsReceived_t` at `20.00% completion (loading data)` or similar "Waiting for stats verification" prompts). In these cases, **Goldberg's regular DLL-swap mode** can race the callback against the init loop and cause a permanent hang. The fix is the **steamclient_loader** approach.

The steamclient_loader keeps the **original** `steam_api.dll` untouched and instead injects `steamclient.dll` + overlay DLLs into the running EXE, intercepting Steam's internal IPC calls. This more accurately mimics how a real Steam client delivers callbacks, resolving the race condition.

**Files needed from `gse_win/release/steamclient_experimental/`:**
- `steamclient.dll` (x86)
- `steamclient64.dll` (x64, include even for x86 game — loader reads the one matching host arch)
- `GameOverlayRenderer.dll` (x86 overlay)
- `GameOverlayRenderer64.dll` (x64 overlay)
- `steamclient_loader_x32.exe` (32-bit injector) or `steamclient_loader_x64.exe`
- `configs.app.ini`, `configs.main.ini`, `configs.overlay.ini`, `configs.user.ini`

**Setup:**
```bash
cd /path/to/game

# 1. Keep original steam_api.dll — do NOT overwrite or rename it.
cp /path/to/gse_win/release/steamclient_experimental/steamclient.dll .
cp /path/to/gse_win/release/steamclient_experimental/steamclient64.dll .
cp /path/to/gse_win/release/steamclient_experimental/GameOverlayRenderer.dll .
cp /path/to/gse_win/release/steamclient_experimental/GameOverlayRenderer64.dll .
cp /path/to/gse_win/release/steamclient_experimental/steamclient_loader_x32.exe .

# 2. Copy config templates
cp /path/to/gse_win/release/steamclient_experimental/configs.*.ini .

# 3. Remove any old steam_settings directory from regular Goldberg mode
rm -rf steam_settings/

# 4. Write ColdClientLoader.ini alongside the loader EXE
cat > ColdClientLoader.ini << 'EOF'
[SteamClient]
Exe=Game.exe
ExeRunDir=
ExeCommandLine=
AppId=945530
SteamClientDll=steamclient.dll
SteamClient64Dll=steamclient64.dll

[Injection]
ForceInjectSteamClient=1
ForceInjectGameOverlayRenderer=0
DllsToInjectFolder=
IgnoreInjectionError=1
IgnoreLoaderArchDifference=1

[Persistence]
Mode=0
EOF
```

The user launches the game by running `steamclient_loader_x32.exe` (or `_x64.exe` for x64 games), NOT `Game.exe` directly.

**When to use steamclient_loader over regular Goldberg:**
- Game shows a progress bar stalling at "Waiting for stats verification", "Waiting for user data", or "Initializing Steam" indefinitely.
- The hang occurs at exactly the same percentage every time (e.g. `20.00% complete`).
- Regular Goldberg DLL swap produces identical hang.
- The game imports SteamUserStats but you see no visible achievement/unlock progression — it's waiting for a `UserStatsReceived_t` callback that Goldberg's regular wrapper doesn't deliver in time.

### What NOT to do with steamclient_loader

- **Do NOT rename or remove the original `steam_api.dll`** — the loader depends on it. The game will crash immediately if it's missing.
- **Do NOT leave `steam_settings` from regular Goldberg mode** — steamclient_loader uses `configs.*.ini` beside the loader, not the `steam_settings/` directory.
- **Do NOT mix offline.txt with steamclient_loader** — config templates already have proper offline defaults.

## Phase 4: Validate

### On Wine (diagnostic):
```bash
Xvfb :99 -screen 0 1280x720x24 &
DISPLAY=:99 timeout 15s wine Game.exe
```

**Success criteria:** No Steam-related errors. ALSA audio warnings are fine. If the process runs for 5+ seconds then crashes, the emulator passed Steam checks — the crash is likely Wine/SDL2 display, not Steam.

### On real Windows (definitive):
Double-click `Game.exe` (regular Goldberg) or `steamclient_loader_x32.exe` (steamclient mode). It should launch without Steam client.

### Identifying the type of hang:
If the game window appears but freezes at a specific percentage with "Waiting for stats verification":
1. You've confirmed regular Goldberg reached that point but hung.
2. Switch to steamclient_loader mode — this is the fix.

### Diagnosing stub crashes in Wine with IAT+export mapping
When a custom/stub DLL crashes with a page fault reading address `0x00000008` or similar, the game may be dereferencing a `CSteamAPIContext` field at a specific IAT slot:

1. **Get crash address and instruction**: In Wine output, note the failing address (e.g., `0x42E0EF`) and instruction (`mov 0x8(%eax),%eax`).
2. **Map IAT slot to import ordinal**: Use `i686-w64-mingw32-objdump -d Game.exe | grep -E "call.*0x400000|dword ptr"` to find what import slot was called just before the crash.
3. **Map ordinal to exported name**: Use a Python script to decode the thunk table and `.idata` section, mapping ordinal numbers to export names from the stub DLL:
```python
import struct
base = 0x400000  # ImageBase
data = open('Game.exe','rb').read()
# Parse IMAGE_THUNK_DATA (32-bit RVA array) in .idata
# Find ordinal number N, then map to export ordinals in stub DLL via
# objdump -x steam_api.dll | grep "Ordinal.*Name.*Hint"
```
4. **Check if the imported function is returning a wrapper struct**: If the crash is `mov 8(%eax),%eax` with `%eax` being the return value of a `steam_api.dll` import, the game likely expects `SteamInternal_ContextInit` or `SteamInternal_CreateInterface` to return a pointer where `[return+4]` is valid. A minimal stub returning `&g_userStats` will produce `null` at `+4` because the first member of `g_userStats` is a vtable pointer, and `+4` is not initialized.
5. **Resolution**: Either fix the stub to return a proper `CSteamAPIContext` (two-word struct), or switch to Goldberg emulator.

## Phase 5: Package for redistribution

Create a clean zip:
```bash
cd /tmp
zip -r9 Game-no-steam.zip Game-no-steam/
```

**Typical size ranges:**
- Games with only regular Goldberg replacement: ~2-10 MB overhead on top of game assets.
- Games with **both approaches included** (original DLL + regular Goldberg + steamclient_loader + configs + overlay DLLs): adds ~40-50 MB of overhead. A music-heavy game can reach **90+ MB**.

**If using steamclient_loader mode, include in the final package:**
- `steamclient_loader_x32.exe` (or `_x64.exe`)
- `steamclient.dll` (x86)
- `steamclient64.dll` (x64)
- `GameOverlayRenderer.dll` (x86)
- `GameOverlayRenderer64.dll` (x64)
- `ColdClientLoader.ini`
- `configs.app.ini`, `configs.main.ini`, `configs.overlay.ini`, `configs.user.ini`
- **Original** `steam_api.dll` (keep it)
- `steam_api.goldberg.dll` (optional fallback if user wants to try regular mode)
- `steam_appid.txt`
- `README-no-steam.txt` describing both launch methods

### Delivering the package (messaging platforms)

Telegram bot uploads are limited to **50 MB**. Many file hosts (0x0.st, file.io, transfer.sh, gofile.io, oshi.at, catbox.moe) have been disabled, rate-limited, or unreliable for large automated uploads.

**Best approach for >50 MB archives: split and send natively**

Create parts under the platform limit:
```bash
# Split into 45 MB chunks (leaves headroom)
cd /tmp
split -b 45M Game-no-steam.zip Game-no-steam.zip.part.
```

Send each part. The user rejoins:

**Windows:**
```cmd
copy /b Game-no-steam.zip.part.aa + Game-no-steam.zip.part.ab Game-no-steam.zip
```

**Linux/macOS:**
```bash
cat Game-no-steam.zip.part.aa Game-no-steam.zip.part.ab > Game-no-steam.zip
```

Verify before extracting:
```bash
cat Game-no-steam.zip.part.* > Game-verify.zip
cmp Game-verify.zip Game-no-steam.zip && echo "MATCH"
unzip -t Game-no-steam.zip
```

## When even steamclient_loader fails (hard Steam dependency)

For some games (e.g. **Bohrdom.exe**, AppID 945530), **both** regular Goldberg DLL-swap **and** steamclient_loader injection hang at exactly the same progress percentage (`20.00% complete, waiting for stats verification`) on real Windows. On Wine, steamclient_loader may progress further (to 40%) before crashing on display init, but on real Windows it still stalls at the same callback gate.

This means the game has a **hard dependency on the real Steam backend** delivering `UserStatsReceived_t` or another specific callback with valid server-side data that Goldberg cannot synthesize. These are **unemulated callback-dependent init gates**.

### Last resort: binary patch the EXE to skip the gate

When no emulator can fake the callback, patch the game's own check. This is more invasive but works when the hang is a simple conditional branch.

**Workflow:**
1. Find the UI string in the EXE: `strings Game.exe | grep "Waiting for stats"`
2. Map its file offset to virtual address using PE section headers.
3. Search the `.text` section for a `push <str_va>` instruction to locate the code that displays the string.
4. Trace backwards for the conditional branch that guards the wait screen. Typical pattern:
   ```
   call SteamUserStats::RequestCurrentStats   ; or equivalent
   test al, al                               ; 84 c0
   jne  skip_wait                            ; 0f 85 XX XX XX XX
   ; ... show "Waiting for stats verification" ...
   skip_wait:
   ```
5. Change `jne` to an unconditional `jmp` (or NOP the whole branch) so execution always falls through to the success path.

**Real example — Bohrdom.exe (AppID 945530):**
- String "Waiting for stats verification" at file offset `0xB5B04` (VA `0x004B7504`)
- Only code reference: `push 0x4B7504` at VA `0x426865`
- Guarding branch: `jne` at VA `0x426825` (file offset `0x25C25`), bytes `0f 85 b7 00 00 00`
- Target of branch = `0x426825 + 6 + 0xB7 = 0x4268DE`
- Patch: change `0f 85 b7 00 00 00` → `e9 b8 00 00 00 90` (`jmp rel32` + NOP)
- Result: game skips the stats wait screen entirely, proceeds to main menu.

This bypasses the callback gate at the cost of disabling online stats/achievements.

Python patch script template:
```python
import struct

data = bytearray(open('Game.exe','rb').read())
# Find and replace the jne with jmp
old = b'\x0f\x85\xb7\x00\x00\x00'  # jne 0xB7  (Bohrdom-specific)
# For generic: search for bytes around the push instruction
new = b'\xe9\xb8\x00\x00\x00\x90'  # jmp rel32 + nop
assert data[0x25C25:0x25C25+6] == old
data[0x25C25:0x25C25+6] = new
open('Game.exe','wb').write(data)
```

**Important:** The exact bytes differ per game. You must disassemble around the string reference to find the correct branch. Common conditional patterns to look for:
- `test al, al` / `jne` — jump if stats request succeeded
- `test eax, eax` / `jz` or `jnz` — jump based on return value
- `cmp ebx, 0` / `je` — jump based on counter

### Diagnostic checklist when both approaches fail

1. **Binary patch the EXE** (see above) — this is the ultimate fallback for unemulated callback gates.
2. **Ensure `steam_settings/achievements.json` and `steam_settings/stats.json` exist** (regular mode only).
   Download `achievements.json` and `stats.json` from the original SteamDB or game cache.
3. **Toggle `offline` flag**:
   - Remove `steam_settings/offline.txt` / `disable_networking.txt` entirely (forces online emulation path).
   - Or explicitly create `offline.txt` and set `configs.main.ini` offline=1 (some games check both).
4. **Check for `steam_settings/user_steam_id.txt`** — some games validate the user ID format before unlocking callbacks. Set a valid-looking 64-bit Steam ID.
5. **Try SmartSteamEmu** (older, pre-2016 Steamworks — sometimes handles different callback timing).
6. **Try CreamAPI** if the hang is DLC-related rather than base-game.
7. **Accept failure** — if the game validates Steam Cloud data or runs server-side matchmaking checks during init, no current emulator can bypass it.

## When the minimal stub IS enough

If the game is extremely light on Steamworks (just init + shutdown + a couple getters):

```c
#include <windows.h>
#include <stdint.h>
#define EXPORT __declspec(dllexport)

EXPORT int SteamAPI_Init(void) { return 1; }
EXPORT void SteamAPI_Shutdown(void) { }
EXPORT void SteamAPI_RunCallbacks(void) { }
EXPORT int SteamAPI_IsSteamRunning(void) { return 1; }
EXPORT int SteamAPI_RestartAppIfNecessary(uint32_t id) { (void)id; return 0; }

EXPORT void* SteamUserStats(void) { static char d[64]; return d; }
EXPORT void* SteamApps(void)      { static char d[64]; return d; }
EXPORT void* SteamUtils(void)      { static char d[64]; return d; }
EXPORT void* SteamFriends(void)    { static char d[64]; return d; }

BOOL WINAPI DllMain(HINSTANCE h, DWORD r, LPVOID v) { return TRUE; }
```

Compile:
```bash
i686-w64-mingw32-gcc -shared -O2 steam_api.c -o steam_api.dll -Wl,--kill-at
```

## Pitfalls

1. **Architecture mismatch** — Using x64 Goldberg on a PE32 game causes instant silent exit. Always match architecture.
2. **Missing steam_interfaces.txt** — Goldberg may crash or return wrong interface versions. Always populate this file from the original DLL.
3. **Missing steam_appid.txt** — Must exist at root **and** inside `steam_settings/`.
4. **Wine Xvfb crash ≠ stub failure** — SDL2/OpenGL context creation fails in headless Wine. Test on real Windows for final verdict.
5. **Minimal stub on heavy game** — If the game imports 800+ exports, a minimal stub will crash instantly with missing export errors. Switch to Goldberg.
6. **File hosts unreliable for >50 MB automated uploads** — 0x0.st, transfer.sh, catbox.moe, and file.io have all disabled or broken automated upload endpoints. gofile.io API endpoints change frequently. For bots with size limits (Telegram: 50 MB), use `split -b 45M` and deliver native multi-part files instead.
7. **`offline.txt` can cause callback hangs** — In regular Goldberg mode, adding `steam_settings/offline.txt` or `disable_networking.txt` can make callback-dependent games (e.g., those that stall at "Waiting for stats verification") retry their Steam checks forever in an offline-restart loop. If the game hangs at exactly the same progress percentage every time (e.g., `20.00%`), remove offline/networking flags and switch to steamclient_loader mode.

8. **`SteamInternal_ContextInit` / `CreateInterface` return value ABI** — Many games expect these functions to return a pointer to a `CSteamAPIContext`-like wrapper struct, **not** the raw interface object. Specifically, the game may do `mov 4(%eax), %ecx` (or equivalent) where `%eax` is the return value from `SteamInternal_ContextInit` / `SteamInternal_CreateInterface`. `%ecx` then receives what was at `offset 4` in the pointed-to struct, and the game treats that as the interface vtable pointer. If your minimal stub returns `&g_userStats` (raw object pointer), offset `+4` is likely `.vtable` (null), causing a crash at `mov 8(%eax), %eax` (double-dereference of null). **Fix:** Return a static two-pointer array or `struct CSteamAPIContext { void* hSteamUser; void* hSteamPipe; void* pSteamUserStats; ... }` so that the `+4` offset yields a valid pointer. When in doubt, use Goldberg instead of writing a custom stub.

9. **IAT slot mapping for `SteamInternal_CreateInterface` vs context wrappers** — On Bohrdom.exe (AppID 945530), the import slot at `0x4B5390` (ordinal 853 / hint 853) is `SteamInternal_CreateInterface` (or `SteamInternal_ContextInit`, depending on SDK version). The game pushes interface version strings (e.g., `"STEAMUSERSTATS_INTERFACE_VERSION015"`) and expects a return pointer where `[return+4]` is the `ISteamUserStats*` interface pointer. If your stub exports this function but returns a raw `ISteamUserStats*` directly, `+4` walks into adjacent global data and yields an invalid pointer, causing a page fault at `0x00000008` when the game dereferences it as a vtable. **Real example traceback:**
   - Crash: `mov 0x8(%eax),%eax` with `%eax = 0`, page fault at `0x00000008`
   - Root: `%eax` came from `call *0x4B5390` (imported `SteamInternal_CreateInterface`)
   - Game then did `mov 0x4(%eax),%ecx` which loaded a null pointer because `+4` was uninitialized
   - The original Goldberg DLL avoids this by returning a proper context wrapper.
   **Fix:** Return a `static void* ctx[2] = { nullptr, userStatsObject };` from `SteamInternal_CreateInterface` so that `+4` points to a valid object. If you are writing a **custom minimal stub**, ensure all `SteamInternal_*` helpers return multi-word wrapper structs that match expected field offsets. Otherwise, switch to Goldberg.

## Ethical boundary

- **DO**: Provide the DRM-removal tooling and instructions. The user applies it to their own legally-obtained copy.
- **DO NOT**: Upload a complete cracked game to public distribution channels. The zip should only contain the modified files + instructions, not a full re-upload of copyrighted assets if the user already owns them. In this workflow the user owns the original and applies the patch themselves.

## Alternatives

- **SmartSteamEmu**: Older, sometimes simpler for pre-2016 Steamworks
- **Proton**: Linux players may not need any of this — Proton includes its own Steam stub
- **CreamAPI**: For DLC unlock scenarios (different problem)
